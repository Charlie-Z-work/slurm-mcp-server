#!/usr/bin/env node
/**
 * SLURM MCP Server — Direct SSH/SLURM/tmux for Claude Code CLI
 * Zero-dependency, single-file, TTY-aware job watching with desktop notifications.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execSync, execFileSync, spawnSync, execFile as execFileCb } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, renameSync, rmdirSync, rmSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { randomBytes } from 'crypto';
import { homedir, hostname } from 'os';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const __dirname = join(fileURLToPath(import.meta.url), '..');

const execFileAsync = promisify(execFileCb);

// --- Required env var helper ---
function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    process.stderr.write(`[slurm-mcp-server] ERROR: Missing required env var ${name}\n`);
    process.exit(1);
  }
  return val;
}

// Why: HPC_HOST / HPC_USER / SLURM_ACCOUNT are interpolated into remote
// commands (`sacct -u USER`), #SBATCH headers and local ssh argv. A typo like
// "mp m3" or a stray quote must stop the server at startup with a clear error
// instead of producing broken or injectable commands later.
// A leading "-" is never allowed: every value may end up as an argv element of
// ssh/rsync/tmux, where it would be parsed as an option (-oProxyCommand=...).
// HPC_HOST: ssh alias / hostname, optionally "user@host".
const RE_HOST = /^(?!-)[\w.-]+(@(?!-)[\w.-]+)?$/;
// HPC_USER: AD/LDAP/Kerberos names may contain "@" or "\" (u@ad.example.edu,
// DOMAIN\u). Always single-quoted when interpolated into a remote command.
const RE_USER = /^(?!-)[\w.@\\-]+$/;
// SLURM_ACCOUNT
const RE_ENV_TOKEN = /^(?!-)[\w.-]+$/;
function requireEnvList(name, re, allowed) {
  return parseEnvList(name, requireEnv(name), re, allowed);
}
function parseEnvList(name, raw, re, allowed) {
  const items = raw.split(',').map(s => s.trim());
  const bad = items.filter(s => !re.test(s));
  if (bad.length) {
    process.stderr.write(`[slurm-mcp-server] ERROR: ${name} contains an invalid entry ${JSON.stringify(bad[0])} (allowed: ${allowed}, no leading "-"; comma-separated for multiple clusters)\n`);
    process.exit(1);
  }
  return items;
}

// Single-quote a value for a remote bash command line.
function shq(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

// Path validation: block shell metacharacters and traversal
const UNSAFE_PATH = /[;|$()&<>`\n\t\r\\]/;
// remote_path for rsync: strict allowlist (see sync_files); a leading ~ is allowed.
const RE_REMOTE_PATH = /^(?!$)~?[\p{L}\p{M}\p{N}_.\/+@:,=-]*$/u; // non-empty; bare ~ allowed; letters (incl. combining marks), digits, , = : are shell-inert unquoted
function validatePath(p, label) {
  if (UNSAFE_PATH.test(p)) return `${label} contains unsafe characters`;
  if (p.includes('..')) return `${label} contains '..' (path traversal not allowed)`;
  return null;
}

function envError(msg) {
  process.stderr.write(`[slurm-mcp-server] ERROR: ${msg}\n`);
  process.exit(1);
}

// --- Optional env vars ---
const HPC_PREAMBLE = process.env.HPC_PREAMBLE || null;
const NOTIFY_WEBHOOK = process.env.NOTIFY_WEBHOOK || null; // Slack/Discord webhook URL

// Optional: external resource log file on the cluster (e.g. a TSV of past
// runs). It is interpolated into a remote grep command, so validate it here.
const RESOURCE_LOG_PATH = process.env.HPC_RESOURCE_LOG || null;
if (RESOURCE_LOG_PATH) {
  const err = validatePath(RESOURCE_LOG_PATH, 'HPC_RESOURCE_LOG') ||
    (/['"\s]/.test(RESOURCE_LOG_PATH) ? 'HPC_RESOURCE_LOG contains quotes or whitespace' : null);
  if (err) envError(err);
}

// Site defaults for slurm_submit. Not every cluster has a "batch" partition or
// GPUs: SLURM_DEFAULT_GPUS=0 omits --gres entirely. Both accept a
// comma-separated list in HPC_HOST order (like SLURM_ACCOUNT); a single value
// applies to every cluster, a shorter list reuses its last entry, an empty
// entry means the built-in default (batch / 1).
// Same whitelist as the slurm_submit `partition` parameter (e.g. "gpu.a100").
const RE_PARTITION = /^(?!-)[\w.-]+$/;
const DEFAULT_PARTITIONS = String(process.env.SLURM_DEFAULT_PARTITION || '').split(',').map(s => s.trim() || 'batch');
for (const p of DEFAULT_PARTITIONS) {
  if (!RE_PARTITION.test(p)) envError(`SLURM_DEFAULT_PARTITION ${JSON.stringify(p)} must match [A-Za-z0-9_.-]+ (no leading "-"; comma-separated per cluster)`);
}
// HPC_REQUIRE_MASTER=1: treat "no ControlMaster configured" like a dead master
// (MFA clusters, where a direct connection can never authenticate).
const REQUIRE_MASTER = process.env.HPC_REQUIRE_MASTER === '1';
// HPC_ALLOW_UNSAFE_REUSE=1: with a live ControlMaster whose ControlPath cannot
// be resolved safely, fall back to plain BatchMode instead of refusing the
// call (see sshOptsFor). Never honored under HPC_REQUIRE_MASTER=1.
const ALLOW_UNSAFE_REUSE = process.env.HPC_ALLOW_UNSAFE_REUSE === '1';
// Returns the list of per-cluster GPU defaults, or null when an entry is invalid.
function parseDefaultGpus(raw) {
  const list = String(raw ?? '').split(',').map(s => (s.trim() === '' ? 1 : Number(s.trim())));
  return list.every(n => Number.isInteger(n) && n >= 0) ? list : null;
}
const DEFAULT_GPUS_LIST = parseDefaultGpus(process.env.SLURM_DEFAULT_GPUS);
if (!DEFAULT_GPUS_LIST) envError(`SLURM_DEFAULT_GPUS ${JSON.stringify(process.env.SLURM_DEFAULT_GPUS)} must be a non-negative integer or a comma-separated list of them (0 = do not request GPUs)`);
// Value of a per-cluster env list for `host` (HPC_HOST order; the last entry
// covers the remaining clusters, so a single value applies to all).
function pickPerCluster(list, hosts, host) {
  const idx = Math.max(0, hosts.indexOf(host));
  return list[Math.min(idx, list.length - 1)];
}
function defaultPartition(host = SSH_HOST) { return pickPerCluster(DEFAULT_PARTITIONS, HPC_HOSTS, host); }
function defaultGpus(host = SSH_HOST) { return pickPerCluster(DEFAULT_GPUS_LIST, HPC_HOSTS, host); }

// --- TTY detection (per-window identity) ---
let windowTty = 'unknown';
try {
  const ppid = process.ppid;
  const raw = execSync(`ps -p ${ppid} -o tty=`, { encoding: 'utf-8' }).trim();
  windowTty = (!raw || raw === '??' || raw === '?') ? `pid-${ppid}` : raw.replace(/[\/\\]/g, '-');
} catch { windowTty = `pid-${process.ppid}`; }

// --- Workdir storage ---
const WORKDIR_DIR = join(homedir(), '.claude', 'hpc-workdirs');
const WATCHES_FILE = join(homedir(), '.claude', 'slurm-watches.json');

function getWorkdirPath() {
  return join(WORKDIR_DIR, `${windowTty}.json`);
}

// The workdir is keyed by host + tty: a directory on one cluster means nothing
// on another (after cluster_switch the old one was used for cd/--output).
// File: { tty, byHost: { <host>: { workdir, setAt } } }. The legacy format
// { tty, workdir, setAt } (no host) belongs to the first configured cluster.
function readWorkdirFile() {
  let data;
  try { data = JSON.parse(readFileSync(getWorkdirPath(), 'utf-8')); } catch { return {}; }
  if (!data || typeof data !== 'object') return {};
  const byHost = data.byHost && typeof data.byHost === 'object' ? { ...data.byHost } : {};
  if (data.workdir && !byHost[data.host || HPC_HOSTS[0]]) {
    byHost[data.host || HPC_HOSTS[0]] = { workdir: data.workdir, setAt: data.setAt };
  }
  return byHost;
}

function loadWorkdir(host = SSH_HOST) {
  return readWorkdirFile()[host]?.workdir || null;
}

function saveWorkdir(path, host = SSH_HOST) {
  withFileLock(getWorkdirPath(), () => {
    const byHost = readWorkdirFile();
    byHost[host] = { workdir: path, setAt: new Date().toISOString() };
    atomicWriteJson(getWorkdirPath(), { tty: windowTty, byHost });
  });
}

// --- Debug logging (stderr, visible in MCP server logs) ---
function logDebug(msg) {
  process.stderr.write(`[slurm-mcp-server ${new Date().toISOString()}] ${msg}\n`);
}

// --- Shared state-file helpers ---
// Why: every Claude window runs its own server process, and all of them share
// ~/.claude/slurm-*.json. A plain writeFileSync can be observed half-written by
// a concurrent reader; the old loaders then returned [] and the next save
// wiped every watch. tmp file + rename makes each write atomic on POSIX.
function atomicWriteJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  try { renameSync(tmp, path); } catch (err) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Why: atomic writes alone still lose updates when two processes do
// read-modify-write concurrently (e.g. poller removes a finished watch while
// another window registers a new one). mkdir is atomic, so a lock directory is
// a portable cross-process mutex. Fail-open after LOCK_WAIT_MS: a stuck lock
// must never block job submission or notifications — worst case is the old
// racy behavior.
//
// The holder writes owner.json ({pid, host, at, token}) into the lock dir.
// A lock is stale only when its owner is provably gone: same machine and the
// pid no longer exists (ESRCH). A live owner is never preempted, however long
// it holds the lock — waiters fail open at the deadline instead. Only an
// owner-less lock (legacy server version, or a crash between mkdir and the
// owner write) falls back to age: mtime older than LOCK_OWNERLESS_STALE_MS,
// the same threshold older versions use, so mixed versions agree.
const LOCK_WAIT_MS = 2000;
const LOCK_OWNERLESS_STALE_MS = 10_000;
const LOCK_OWNER_FILE = 'owner.json';
const LOCAL_HOSTNAME = hostname();

function readLockOwner(lockDir) {
  try {
    const o = JSON.parse(readFileSync(join(lockDir, LOCK_OWNER_FILE), 'utf-8'));
    return o && Number.isInteger(o.pid) && o.pid > 0 ? o : null;
  } catch { return null; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code !== 'ESRCH'; } // EPERM: alive, other user
}

function isLockStale(lockDir, now = Date.now()) {
  const owner = readLockOwner(lockDir);
  if (owner) {
    // A pid from another machine (shared/NFS home) says nothing about
    // liveness here; fall back to the owner's age.
    if (owner.host && owner.host !== LOCAL_HOSTNAME) return now - Number(owner.at) > LOCK_OWNERLESS_STALE_MS;
    return !pidAlive(owner.pid);
  }
  let st;
  try { st = statSync(lockDir); } catch { return false; } // gone: just retry mkdir
  return now - st.mtimeMs > LOCK_OWNERLESS_STALE_MS;
}

// Remove a stale lock. Returns true when it was removed.
// Why a separate `.reclaim` guard: two waiters can judge the same dead owner
// stale; without serialization the slower one could move away the fresh lock
// the faster one had just taken. Under the guard the staleness is re-checked,
// so the second reclaimer sees the new (live) owner and backs off. The stale
// dir is renamed aside and deleted — never put back (putting back could
// overwrite a lock a third process created in the meantime).
function reclaimStaleLock(lockDir) {
  const guard = `${lockDir}.reclaim`;
  try { mkdirSync(guard); } catch (err) {
    if (err.code === 'EEXIST') {
      // A reclaimer that died inside this few-ms section leaves its guard.
      try { if (Date.now() - statSync(guard).mtimeMs > LOCK_OWNERLESS_STALE_MS) rmdirSync(guard); } catch { /* raced */ }
    }
    return false;
  }
  try {
    if (!isLockStale(lockDir)) return false;
    const aside = `${lockDir}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
    try { renameSync(lockDir, aside); } catch { return false; } // already gone
    try { rmSync(aside, { recursive: true, force: true }); } catch (err) { logDebug(`reclaimStaleLock: cleanup failed: ${err.message}`); }
    return true;
  } finally {
    try { rmdirSync(guard); } catch { /* already gone */ }
  }
}

function withFileLock(path, fn) {
  const lockDir = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  const token = randomBytes(6).toString('hex');
  let locked = false;
  let ownerWritten = false;
  try { mkdirSync(dirname(path), { recursive: true }); } catch { /* surfaces below */ }
  for (;;) {
    try {
      mkdirSync(lockDir);
      locked = true;
      try {
        writeFileSync(join(lockDir, LOCK_OWNER_FILE), JSON.stringify({ pid: process.pid, host: LOCAL_HOSTNAME, at: Date.now(), token }));
        ownerWritten = true;
      } catch (err) { logDebug(`withFileLock(${path}): owner write failed: ${err.message}`); }
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') { logDebug(`withFileLock(${path}): ${err.message}`); break; }
      if (isLockStale(lockDir) && reclaimStaleLock(lockDir)) continue;
      if (Date.now() > deadline) break;
      sleepSync(25);
    }
  }
  if (!locked) logDebug(`withFileLock(${path}): lock not acquired within ${LOCK_WAIT_MS}ms, proceeding unlocked (fail-open)`);
  try { return fn(); } finally {
    if (locked) {
      // Only remove our own lock: if it was (wrongly) reclaimed meanwhile, the
      // dir now belongs to someone else. An owner-less dir is NOT ours when
      // our owner.json was written: it is a new holder between its mkdir and
      // its owner write — deleting it would let a third process in. It is
      // left to the owner-less staleness rule. Only when our own owner write
      // failed is an owner-less lock presumed ours.
      const owner = readLockOwner(lockDir);
      if (owner ? owner.token === token : !ownerWritten) {
        try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* already gone */ }
      }
    }
  }
}

// Why: a corrupt state file must not be silently replaced by an empty one on
// the next save (that destroys the evidence and every watch in it). Move it
// aside as .corrupt-<ts> so it can be inspected/recovered, then start fresh.
function readJsonOrQuarantine(path, fallback, validate = () => true) {
  let raw;
  try { raw = readFileSync(path, 'utf-8'); } catch (err) {
    if (err.code !== 'ENOENT') logDebug(`read ${path} failed: ${err.message}`);
    return fallback;
  }
  try {
    const data = JSON.parse(raw);
    if (!validate(data)) throw new Error('unexpected JSON shape');
    return data;
  } catch (err) {
    const aside = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, aside); logDebug(`${path} unparsable (${err.message}); moved to ${aside}`); }
    catch (e2) { logDebug(`${path} unparsable (${err.message}); quarantine failed: ${e2.message}`); }
    return fallback;
  }
}

// --- SLURM Watch ---

// Polling state (exposed via slurm_watches for diagnostics)
let lastPollTime = null;
let lastPollError = null;
let pollCount = 0;

// Notifications persisted to disk (see NOTIF_FILE), this array removed
const NOTIF_FILE = join(homedir(), '.claude', 'slurm-notifications.json');

// Why the filter: the file is shared and user-editable; a valid JSON array can
// still hold null/garbage entries (same reasoning as isValidWatch). One null
// used to throw inside drainNotifications and turn a successful tool result
// (e.g. a queued sbatch) into an error.
function isValidNotification(n) {
  return !!n && typeof n === 'object' && !Array.isArray(n);
}
function loadNotifications() {
  return readJsonOrQuarantine(NOTIF_FILE, [], Array.isArray).filter(isValidNotification);
}

// Callers doing read-modify-write must hold withFileLock(NOTIF_FILE).
// Returns false when the write failed, so callers can keep the source of the
// notification (the watch) and retry instead of losing it.
function saveNotifications(notifs) {
  try {
    atomicWriteJson(NOTIF_FILE, notifs);
    return true;
  } catch (err) {
    logDebug(`saveNotifications failed: ${err.message}`);
    return false;
  }
}

// A watch is only dropped when the job has been missing from a SUCCESSFUL
// sacct query of its cluster for a long time. `unseenSince` is set on the
// first successful poll that does not return the job and cleared as soon as
// the job shows up again. Why not "time since last seen": while the master is
// dead (or sacct fails) nothing is known about the job, and a long outage
// (weekend without Duo) used to expire every watch of that cluster.
// Old fields (submittedAt, lastSeenAt) no longer affect expiry.
// Expiry is evaluated only by the poller (pollOnce), never when the file is
// loaded: a loader does not know whether the cluster is reachable, and a
// watch dropped at load time is gone before the next successful query could
// report the job again.
const WATCH_MIN_TTL_MS = 48 * 3600 * 1000;
function isWatchExpired(w, now = Date.now()) {
  const unseen = w.unseenSince ? new Date(w.unseenSince).getTime() : NaN;
  if (!Number.isFinite(unseen)) return false;
  const ttlMs = Math.max(WATCH_MIN_TTL_MS, 4 * (Number(w.estimatedSeconds) || 0) * 1000);
  return now - unseen > ttlMs;
}

// Why: the file is shared by every window's server and user-editable; a
// valid JSON array can still hold null/garbage entries. One bad element used
// to throw inside registerWatch (after sbatch had succeeded → "Submit failed"
// → duplicate jobs) and in every poll cycle. A numeric jobId (hand-edited
// file) is accepted and normalized to a string by loadWatches.
function isValidWatch(w) {
  if (!w || typeof w !== 'object' || Array.isArray(w)) return false;
  const idOk = (typeof w.jobId === 'string' && /^\d+$/.test(w.jobId)) ||
    (typeof w.jobId === 'number' && Number.isSafeInteger(w.jobId) && w.jobId >= 0);
  // host reaches `ssh -O check <host>` / ssh argv: same whitelist as HPC_HOST.
  // tty becomes a file name (heartbeat `<tty>.json`): no "/" or other path
  // syntax. A missing tty is allowed (the watch is simply adopted).
  return idOk && (w.host == null || (typeof w.host === 'string' && RE_HOST.test(w.host))) &&
    (w.tty == null || (typeof w.tty === 'string' && RE_TTY.test(w.tty)));
}
const RE_TTY = /^[\w.-]+$/;

// Time fields that drive adoption (submittedAt) and expiry (unseenSince,
// lastSeenAt, lastQueriedAt). A hand-edited or garbage value parsed to NaN,
// and every comparison with NaN is false: the watch was then never adopted
// and never expired. An invalid value is treated as "now" (logged); a missing
// submittedAt counts as invalid, the others are optional.
const WATCH_TIME_FIELDS = ['submittedAt', 'lastSeenAt', 'unseenSince', 'lastQueriedAt'];
function normalizeWatchTimes(w, nowIso = new Date().toISOString()) {
  let changed = false;
  for (const f of WATCH_TIME_FIELDS) {
    const v = w[f];
    if (v == null && f !== 'submittedAt') continue;
    if (typeof v === 'string' && Number.isFinite(Date.parse(v))) continue;
    logDebug(`Watch ${w.jobId}: invalid ${f} ${JSON.stringify(v)?.slice(0, 60)}, treated as now`);
    w[f] = nowIso;
    changed = true;
  }
  return changed;
}

// The returned array carries `normalized` (count of entries whose time fields
// were repaired) so the poller can persist the repair; see pollOnce.
function loadWatches() {
  const data = readJsonOrQuarantine(WATCHES_FILE, [], Array.isArray);
  const nowIso = new Date().toISOString();
  let normalized = 0;
  const out = data.filter(w => {
    if (!isValidWatch(w)) { logDebug(`Ignoring malformed watch entry: ${JSON.stringify(w)?.slice(0, 200)}`); return false; }
    if (typeof w.jobId === 'number') w.jobId = String(w.jobId);
    if (normalizeWatchTimes(w, nowIso)) normalized++;
    return true;
  });
  Object.defineProperty(out, 'normalized', { value: normalized, enumerable: false });
  return out;
}

// Watches are identified by cluster + job id: two clusters can hand out the
// same numeric job id. Entries from before multi-cluster support carry no
// host and belong to the first configured cluster.
function watchHost(w) {
  return w.host || HPC_HOSTS[0];
}
function watchKey(w) {
  return `${watchHost(w)}|${w.jobId}`;
}

// --- Poller heartbeat: lets other servers detect dead sessions and adopt
// their orphaned watches (a watch is only ever polled by its owning tty's
// server — without adoption, jobs outliving their session never notify). ---
const HEARTBEAT_DIR = join(homedir(), '.claude', 'hpc-pollers');

// Written by its own timer (see startHeartbeat), NOT by the poll loop: poll
// backoff can reach 10 min, far beyond the 150s liveness window, and a live
// server's watches were then "adopted" by other windows over and over.
const HEARTBEAT_INTERVAL = 30_000;
const HEARTBEAT_STALE_MS = 150_000; // 5 heartbeat intervals
// `busyUntil` (optional): see withBusyHeartbeat.
function writeHeartbeat(busyUntil = null) {
  try {
    mkdirSync(HEARTBEAT_DIR, { recursive: true });
    const hb = { pid: process.pid, at: Date.now() };
    if (busyUntil != null) hb.busyUntil = busyUntil;
    // Atomic (tmp + rename): pollerAlive in another window must never read a
    // half-written heartbeat — a parse error there means "dead" → adoption.
    atomicWriteJson(join(HEARTBEAT_DIR, `${windowTty}.json`), hb);
  } catch (err) { logDebug(`writeHeartbeat failed: ${err.message}`); }
}

// Why: ssh/rsync calls run synchronously (execFileSync) and block the event
// loop, so the heartbeat timer cannot fire. A long ssh_exec (up to 10 min) or
// sync_files (5 min) used to exceed the 150s liveness window: other windows
// then judged this live server dead, adopted its watches and drained its
// notifications. Before each blocking call the heartbeat announces
// busyUntil = now + timeout + 5s; pollerAlive honors it; the call's end
// refreshes the heartbeat (dropping busyUntil).
const BUSY_GRACE_MS = 5_000;
function withBusyHeartbeat(timeoutMs, fn) {
  writeHeartbeat(Date.now() + timeoutMs + BUSY_GRACE_MS);
  try { return fn(); } finally { writeHeartbeat(); }
}

// Remove this server's heartbeat on shutdown — but only if it is still ours:
// a new server in the same tty (client restart) may already have replaced it,
// and deleting that would get its live watches adopted by other windows.
function removeOwnHeartbeat() {
  const hbPath = join(HEARTBEAT_DIR, `${windowTty}.json`);
  try {
    const hb = JSON.parse(readFileSync(hbPath, 'utf-8'));
    if (hb?.pid !== process.pid) return false;
    unlinkSync(hbPath);
    return true;
  } catch { return false; }
}

function pollerAlive(tty, now = Date.now()) {
  try {
    const hb = JSON.parse(readFileSync(join(HEARTBEAT_DIR, `${tty}.json`), 'utf-8'));
    const fresh = now - hb.at <= HEARTBEAT_STALE_MS;
    const busy = Number(hb.busyUntil) > now; // inside a blocking ssh/rsync call
    if (!fresh && !busy) return false;
    process.kill(hb.pid, 0); // throws if pid is gone
    return true;
  } catch { return false; }
}

// Callers doing read-modify-write must hold withFileLock(WATCHES_FILE).
function saveWatches(watches) {
  atomicWriteJson(WATCHES_FILE, watches);
}

function registerWatch(jobId, jobName, estimatedSeconds, partition) {
  withFileLock(WATCHES_FILE, () => {
    const watches = loadWatches();
    watches.push({
      jobId,
      tty: windowTty,
      host: SSH_HOST, // cluster this job belongs to (multi-cluster polling)
      jobName,
      submittedAt: new Date().toISOString(),
      estimatedSeconds,
      partition,
      state: 'PENDING',
    });
    saveWatches(watches);
  });
}

function removeWatch(jobId, host = SSH_HOST) {
  const key = `${host}|${jobId}`;
  withFileLock(WATCHES_FILE, () => {
    saveWatches(loadWatches().filter(w => watchKey(w) !== key));
  });
}

// registerWatch runs AFTER sbatch succeeded: it must never turn a queued job
// into a reported failure (the model would resubmit → duplicate jobs).
function tryRegisterWatch(...args) {
  try {
    registerWatch(...args);
    return null;
  } catch (err) {
    const msg = String(err?.message ?? err);
    logDebug(`registerWatch failed: ${msg}`);
    return msg;
  }
}

// Strict parser for every --time format sbatch accepts. Returns seconds, or
// null when the string is not a valid SLURM time (used as an input whitelist,
// so anything unparsable is rejected before it reaches the #SBATCH header).
function parseSlurmTime(str) {
  if (typeof str !== 'string') return null;
  const t = str.trim();
  let m;
  if ((m = t.match(/^(\d+)$/))) return +m[1] * 60;                                   // M
  if ((m = t.match(/^(\d+):(\d+)$/))) return +m[1] * 60 + +m[2];                     // M:S
  if ((m = t.match(/^(\d+):(\d+):(\d+)$/))) return +m[1] * 3600 + +m[2] * 60 + +m[3]; // H:M:S
  if ((m = t.match(/^(\d+)-(\d+)$/))) return +m[1] * 86400 + +m[2] * 3600;            // D-H
  if ((m = t.match(/^(\d+)-(\d+):(\d+)$/))) return +m[1] * 86400 + +m[2] * 3600 + +m[3] * 60; // D-H:M
  if ((m = t.match(/^(\d+)-(\d+):(\d+):(\d+)$/))) return +m[1] * 86400 + +m[2] * 3600 + +m[3] * 60 + +m[4]; // D-H:M:S
  return null;
}

const TERMINAL_STATES = new Set([
  'COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT', 'OUT_OF_MEMORY', 'NODE_FAIL',
  // Why: these are also final; missing them left watches stuck until TTL.
  'PREEMPTED', 'BOOT_FAIL', 'DEADLINE', 'REVOKED',
]);

// Why: sacct reports user cancellations as "CANCELLED by <uid>", which never
// matched the set exactly, so cancelled jobs were watched forever.
function baseState(state) {
  return String(state || '').trim().split(' ')[0];
}
function isTerminalState(state) {
  return TERMINAL_STATES.has(baseState(state));
}

// sacct JobID → { baseId, taskKey }. Array jobs have no bare "12345" row, only
// "12345_1", "12345_[2-10]" (+ ".batch"/".extern" steps), so lookups by the
// submitted id found nothing and array jobs were never reported complete.
// Heterogeneous jobs report one row per component, "12345+0", "12345+1"
// (+ steps); they fold into the base id with `het` = component index, so the
// watch completes only when every component is terminal.
function parseSacctJobId(rawId) {
  const noStep = String(rawId).trim().split('.')[0];
  const m = noStep.match(/^(\d+)(?:\+(\d+))?(?:_(\d+|\[[^\]]*\]))?$/);
  if (!m) return null;
  const out = { baseId: m[1], taskKey: m[3] ?? null };
  if (m[2] != null) out.het = m[2];
  return out;
}

// Key of one schedulable unit inside a job: array task ("3", "[2-10]"),
// heterogeneous component ("+1"), or null for a plain job.
function unitKey(parsed) {
  if (parsed.taskKey != null) return parsed.taskKey;
  if (parsed.het != null) return `+${parsed.het}`;
  return null;
}

// Batched poll output ("JobID|State" rows) → Map(baseId → Map(unitKey → state)).
// The allocation row precedes its .batch/.extern steps, so first-seen wins.
function aggregateSacctRows(text) {
  const byJob = new Map();
  for (const line of String(text || '').split('\n')) {
    const [rawId, state] = line.split('|').map(s => s?.trim());
    if (!rawId || !state) continue;
    const parsed = parseSacctJobId(rawId);
    if (!parsed) continue;
    if (!byJob.has(parsed.baseId)) byJob.set(parsed.baseId, new Map());
    const units = byJob.get(parsed.baseId);
    const k = unitKey(parsed);
    if (!units.has(k)) units.set(k, state);
  }
  return byJob;
}

// How many array tasks a pending-range key like "[2-10%2]" or "[1,3,5-7]"
// stands for (used only for the ok/failed tally; unknown shapes count as 1).
function countTasksInKey(taskKey) {
  if (!taskKey || !taskKey.startsWith('[')) return 1;
  const body = taskKey.slice(1, -1).split('%')[0];
  let n = 0;
  for (const part of body.split(',')) {
    const r = part.match(/^(\d+)(?:-(\d+))?(?::(\d+))?$/);
    if (!r) return 1;
    const step = r[3] ? +r[3] : 1;
    n += r[2] ? Math.floor((+r[2] - +r[1]) / step) + 1 : 1;
  }
  return n || 1;
}

// Collapse all sacct rows of one job (plain or array) into a single verdict.
// Why: an array job may only be reported done once EVERY task is terminal;
// partial completion must keep the watch alive.
function summarizeJobRows(taskStates) {
  const states = [...taskStates.values()];
  const keys = [...taskStates.keys()];
  const isArray = keys.some(k => k !== null && !String(k).startsWith('+'));
  const isHet = keys.some(k => k !== null && String(k).startsWith('+'));
  const allDone = states.length > 0 && states.every(isTerminalState);
  let ok = 0, failed = 0;
  const failedKinds = new Map();
  for (const [key, st] of taskStates) {
    if (!isTerminalState(st)) continue;
    const n = countTasksInKey(key);
    if (baseState(st) === 'COMPLETED') ok += n;
    else { failed += n; failedKinds.set(baseState(st), (failedKinds.get(baseState(st)) || 0) + n); }
  }
  const running = states.some(st => baseState(st) === 'RUNNING');
  // Single verdict for non-array jobs: for a hetjob the first non-COMPLETED
  // component decides (a plain job has exactly one state).
  const verdict = states.find(st => baseState(st) !== 'COMPLETED') ?? states[0];
  return { isArray, isHet, allDone, ok, failed, failedKinds, running, states, verdict };
}

const MAX_PENDING = 50;

function markCompleted(watch, state, summary = null) {
  const emoji = baseState(state) === 'COMPLETED' ? '✅' : '❌';
  const msg = summary
    ? `${emoji} SLURM array job ${watch.jobId} (${watch.jobName}) finished: ${summary}`
    : `${emoji} SLURM job ${watch.jobId} (${watch.jobName}) ${state}`;

  logDebug(`Job ${watch.jobId} (${watch.jobName}) → ${state}`);

  // Persist to disk (survives process restart, no memory-only state).
  // Why return early on failure: the caller then keeps the watch and retries
  // next cycle; removing it would lose the notification for good. The other
  // channels wait too, so a retry does not repeat desktop/webhook alerts.
  const persisted = withFileLock(NOTIF_FILE, () => {
    const notifs = loadNotifications();
    if (notifs.length >= MAX_PENDING) notifs.shift();
    notifs.push({
      jobId: watch.jobId,
      host: watchHost(watch),
      jobName: watch.jobName,
      state,
      message: msg,
      completedAt: new Date().toISOString(),
      tty: watch.tty,
    });
    return saveNotifications(notifs);
  });
  if (!persisted) {
    logDebug(`Notification for job ${watch.jobId} not persisted; keeping the watch to retry next cycle`);
    return false;
  }

  // Update bridge file for cross-session notification (NanoClaw integration)
  try {
    const bridgeDir = join(homedir(), '.claude', 'bridges');
    const bridgeFile = join(bridgeDir, `${watch.tty}.json`);
    if (existsSync(bridgeFile)) {
      const bridge = JSON.parse(readFileSync(bridgeFile, 'utf8'));
      bridge.summary = `[HPC] ${msg}\n\n${bridge.summary || ''}`;
      writeFileSync(bridgeFile, JSON.stringify(bridge, null, 2));
    }
  } catch (err) {
    logDebug(`Bridge update failed for ${watch.tty}: ${String(err?.message ?? err)}`);
  }

  // Cross-platform desktop notification
  try {
    const platform = process.platform;
    // Why execFileSync: msg contains job names/states from remote sacct; going
    // through a local shell made a crafted job name a local command injection.
    // Only the AppleScript string literal needs escaping (backslash and quote).
    if (platform === 'darwin') {
      const asMsg = msg.replace(/[\\"]/g, '\\$&');
      execFileSync('osascript', ['-e', `display notification "${asMsg}" with title "SLURM" sound name "Glass"`],
        { timeout: 5000, stdio: 'ignore' });
    } else if (platform === 'linux') {
      execFileSync('notify-send', ['SLURM', msg], { timeout: 5000, stdio: 'ignore' });
    }
    // Windows/other: skip silently
  } catch (err) {
    logDebug(`Desktop notification failed: ${err.message}`);
  }

  // Webhook notification (Slack, Discord, etc.)
  if (NOTIFY_WEBHOOK) {
    try {
      const payload = JSON.stringify({ text: msg, content: msg }); // text=Slack, content=Discord
      execFileSync('curl', ['-s', '-X', 'POST', '-H', 'Content-Type: application/json', '-d', payload, NOTIFY_WEBHOOK], {
        timeout: 5000, stdio: 'ignore',
      });
    } catch (err) {
      logDebug(`Webhook notification failed: ${err.message}`);
    }
  }

  // MCP logging notification — attempt to push into Claude Code conversation.
  // Requires capabilities.logging (declared on the McpServer); without it the
  // SDK drops the message silently. Only log "sent" once the write resolved.
  try {
    if (server?.server?.sendLoggingMessage) {
      Promise.resolve(server.server.sendLoggingMessage({
        level: 'warning',
        logger: 'slurm-watch',
        data: msg,
      })).then(
        () => logDebug(`MCP logging notification sent: ${msg}`),
        (err) => logDebug(`MCP logging notification failed: ${String(err?.message ?? err)}`),
      );
    } else {
      logDebug('MCP sendLoggingMessage not available');
    }
  } catch (err) {
    logDebug(`MCP logging notification failed: ${err.message}`);
  }
  return true;
}

// One pass, one ownership decision per entry. Why: filtering twice called
// pollerAlive twice per entry; a heartbeat changing between the two calls
// could put an entry in both lists (shown AND kept → shown again) or neither
// (silently dropped).
function partitionNotifications(notifs, claimable) {
  const taken = [], kept = [];
  for (const n of notifs) (claimable(n) ? taken : kept).push(n);
  return { taken, kept };
}

function drainNotifications() {
  // Drain own notifications, plus orphans whose owning session is dead —
  // otherwise a notification for a closed session stays invisible forever.
  const claimable = (n) => n.tty === windowTty || !pollerAlive(n.tty);
  const mine = withFileLock(NOTIF_FILE, () => {
    const { taken, kept } = partitionNotifications(loadNotifications(), claimable);
    if (taken.length) saveNotifications(kept);
    return taken;
  });
  if (!mine.length) return '';
  const msgs = mine.map(n => n.tty === windowTty ? n.message : `${n.message} (from closed session ${n.tty})`).join('\n');
  return `\n--- SLURM Notifications ---\n${msgs}\n---\n\n`;
}

// One watch as a status line (shared by guide and slurm_watches).
function formatWatchLine(w, now = Date.now()) {
  const elapsed = (now - new Date(w.submittedAt).getTime()) / 1000;
  const ratio = w.estimatedSeconds > 0 ? elapsed / w.estimatedSeconds : 0;
  const pct = Math.min(Math.round(ratio * 100), 999);
  const elapsedMin = Math.round(elapsed / 60);
  const estMin = Math.round(w.estimatedSeconds / 60);
  const prog = w.progress ? ` tasks done ${w.progress}` : '';
  const host = watchHost(w);
  const unpolled = hostConfigured(host) ? '' : ` — host ${host} not configured (not in HPC_HOST), not polled`;
  return `  ${w.jobId} (${w.jobName}) [${w.state}${prog}] — ${elapsedMin}min elapsed, est. ${estMin}min, ~${pct}%${unpolled}`;
}

// Why: a watch in the shared file can name a cluster this server was not
// configured for (another window's HPC_HOST, an old config). Probing it
// would open a direct connection to an unknown host every backoff cycle —
// fail2ban food on a bastion we know nothing about. Such watches are neither
// polled nor adopted here; a server that has the host configured handles them.
function hostConfigured(host) {
  return HPC_HOSTS.includes(host);
}

// Sites without Slurm accounting (no slurmdbd / AccountingStorageType=none):
// sacct always fails, so a watch can never complete. Detected from sacct's own
// error text (poller or resource history); slurm_submit then registers no
// watch and says so. Kept for SACCT_UNAVAILABLE_TTL_MS so that a transient
// slurmdbd outage does not disable watches for the rest of the session; any
// successful sacct of the host clears it.
// Why: only a *configured* absence of accounting suppresses watch registration.
// A transient slurmdbd outage ("failed to open persistent connection",
// "Problem talking to the database") must keep registering watches — the
// poller retries with backoff and the job history is still there once the
// daemon is back (final-review finding).
const SACCT_UNAVAILABLE_RE = /accounting storage is disabled|accounting_storage\/none/i;
const SACCT_UNAVAILABLE_TTL_MS = 3600_000;
const sacctUnavailable = new Map(); // host → { at, reason }
function noteSacctError(host, text, now = Date.now()) {
  const t = String(text ?? '');
  if (!SACCT_UNAVAILABLE_RE.test(t)) return false;
  const reason = t.split('\n').map(l => l.trim()).find(l => SACCT_UNAVAILABLE_RE.test(l)) || t.trim();
  sacctUnavailable.set(host, { at: now, reason: reason.slice(0, 200) });
  return true;
}
function sacctUnavailableFor(host, now = Date.now()) {
  const st = sacctUnavailable.get(host);
  if (!st) return null;
  if (now - st.at > SACCT_UNAVAILABLE_TTL_MS) { sacctUnavailable.delete(host); return null; }
  return st;
}
const SACCT_UNAVAILABLE_NOTE = '⚠️ sacct unavailable on this cluster — job watches cannot complete; use slurm_status';

function formatWatchStatus(watches) {
  if (!watches.length) return 'No active SLURM watches.';
  const now = Date.now();
  return `Active SLURM Watches:\n${watches.map(w => formatWatchLine(w, now)).join('\n')}`;
}

// Polling loop — async, non-blocking, per-tty filtering
// SLURM_MCP_POLL_MS: test hook to shorten the cycle (default unchanged: 30s).
const POLL_INTERVAL = Number(process.env.SLURM_MCP_POLL_MS) > 0 ? Number(process.env.SLURM_MCP_POLL_MS) : 30_000;
const POLL_BACKOFF_MAX = 600_000; // 10 min cap under sustained failure
// Expiry continuity (see pollOnce): successful queries of a cluster further
// apart than this mean an outage in between.
const WATCH_QUERY_GAP_MS = 2 * POLL_BACKOFF_MAX;
const WATCH_QUERY_REFRESH_MS = 5 * 60_000;
// Consecutive poll cycles that crashed (not per-host failures, see below).
let consecutivePollFailures = 0;

// Per-host backoff. Why per host: one cluster with a dead master used to
// back off the whole loop (up to 10 min), delaying notifications for jobs on
// every other, healthy cluster. A failing host is skipped — no ssh at all, not
// even `ssh -O check` — until its own nextAt; the others keep the base cycle.
const hostBackoff = new Map(); // host → { failures, nextAt, error }

function hostBackoffDelay(failures) {
  return Math.min(POLL_INTERVAL * 2 ** failures, POLL_BACKOFF_MAX);
}
function noteHostFailure(host, error, now = Date.now()) {
  const st = hostBackoff.get(host) || { failures: 0, nextAt: 0, error: null };
  st.failures++;
  const delay = hostBackoffDelay(st.failures);
  st.nextAt = now + delay;
  st.error = `${error} (backoff ${Math.round(delay / 1000)}s)`;
  hostBackoff.set(host, st);
  return st;
}
function noteHostSuccess(host) {
  hostBackoff.delete(host);
}
function hostPollDue(host, now = Date.now()) {
  const st = hostBackoff.get(host);
  return !st || now >= st.nextAt;
}

// Delay until the next cycle: the smallest delay over all hosts. A healthy
// host — or one that has no backoff state yet, e.g. a watch another window
// just registered — always needs the base interval, so this is POLL_INTERVAL;
// a cycle waking up with every host still backing off costs one local file
// read and no network traffic. Only crashing cycles back the loop itself off.
function currentPollDelay() {
  return Math.min(POLL_INTERVAL * 2 ** consecutivePollFailures, POLL_BACKOFF_MAX);
}

// Local-only probe of the shared ControlMaster socket (no network, no auth
// attempt). Three states:
//   alive        — exit 0
//   unconfigured — "No ControlPath specified": the user runs without
//                  ControlMaster. Direct `ssh -o BatchMode=yes` connections are
//                  allowed (publickey without MFA works; BatchMode guarantees
//                  no hang on an interactive prompt). HPC_REQUIRE_MASTER=1
//                  turns this into `dead`.
//   dead         — anything else (socket missing, "Control socket connect",
//                  timeout). Chained MFA (publickey+Duo) means a background
//                  process can NEVER re-authenticate — pause, tell the human.
function probeMaster(host) {
  // spawnSync with argv, not a shell string: `host` comes from the shared watch file.
  const r = spawnSync('ssh', ['-O', 'check', String(host)], { timeout: 3000, encoding: 'utf8' });
  const output = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.status === 0) return { state: 'alive', output };
  if (/No ControlPath specified/i.test(output)) return { state: REQUIRE_MASTER ? 'dead' : 'unconfigured', output };
  return { state: 'dead', output };
}
async function pollOnce() {
  // Orphan guard: if the parent Claude session died we get re-parented to
  // PID 1 — exit instead of polling forever (2026-07-02: 28 zombies found).
  if (process.ppid === 1) {
    logDebug('Parent process gone (ppid=1), exiting to avoid zombie polling.');
    process.exit(0);
  }

  pollCount++;
  lastPollTime = new Date().toISOString();
  lastPollError = null;

  let watches;
  try {
    watches = loadWatches();
  } catch (err) {
    lastPollError = `loadWatches: ${String(err?.message ?? err)}`;
    logDebug(lastPollError);
    return;
  }

  // Adopt orphaned watches: their owning session is gone, so nobody polls
  // them and their jobs would complete silently. Rewriting tty hands them
  // to this poller (from next cycle). 90s grace avoids racing a server that
  // registered a watch before its first heartbeat. A watch whose cluster is
  // not configured here is left for a server that can poll it.
  const isOrphan = (w) => w.tty !== windowTty && hostConfigured(watchHost(w)) && !pollerAlive(w.tty) &&
    Date.now() - new Date(w.submittedAt).getTime() > 90_000;
  // Persist time fields repaired by loadWatches (see normalizeWatchTimes):
  // an in-memory "now" would move every cycle, so the 90s adoption grace and
  // the expiry clock would never elapse.
  if (watches.normalized) {
    watches = withFileLock(WATCHES_FILE, () => {
      const fresh = loadWatches();
      saveWatches(fresh);
      return fresh;
    });
  }
  if (watches.some(isOrphan)) {
    // Re-read under the lock so we never clobber a concurrent registration.
    watches = withFileLock(WATCHES_FILE, () => {
      const fresh = loadWatches();
      for (const w of fresh) {
        if (isOrphan(w)) {
          logDebug(`Adopting orphan watch ${w.jobId} (${w.jobName}) from dead session ${w.tty}`);
          w.tty = windowTty;
        }
      }
      saveWatches(fresh);
      return fresh;
    });
  }

  // Only poll watches belonging to this window's tty
  const myWatches = watches.filter(w => w.tty === windowTty);
  if (!myWatches.length) return;

  const completedKeys = new Set();
  let stateChanged = false;

  // Group by cluster; one batched sacct per host. Never generate network
  // traffic toward a host without a live master: each doomed reconnect is
  // a failed auth that feeds the bastion's fail2ban.
  const byHost = new Map();
  for (const w of myWatches) {
    const h = watchHost(w);
    if (!byHost.has(h)) byHost.set(h, []);
    byHost.get(h).push(w);
  }

  const stateMap = new Map(); // key: `${host}|${baseJobId}` → Map(unitKey → state)
  const queriedHosts = new Set(); // hosts whose sacct succeeded this cycle
  for (const [host, hostWatches] of byHost) {
    if (!hostConfigured(host)) continue; // unknown cluster: no traffic at all (see hostConfigured)
    if (!hostPollDue(host)) continue; // backing off: no traffic, not even -O check
    const mode = probeMaster(host).state;
    if (mode === 'dead') {
      const st = noteHostFailure(host, `SSH master to ${host} is dead — its watches paused. Reconnect interactively: run \`ssh ${host}\` in a terminal (needs Duo).`);
      logDebug(st.error);
      continue;
    }
    const jobIds = hostWatches.map(w => w.jobId).join(',');
    try {
      const escaped = `sacct -j ${jobIds} --format=JobID%-20,State -P -n`.replace(/'/g, "'\"'\"'");
      // Large arrays (10k tasks × step rows) exceed Node's default buffer.
      const { stdout } = await execFileAsync('ssh', [...sshBaseArgs(mode, host), host, `bash --login -c '${escaped}'`], {
        timeout: 15000, encoding: 'utf8', maxBuffer: SACCT_MAX_BUFFER,
      });
      // Normalize "12345.batch" / "12345_7" / "12345_[8-10]" / "12345+1" to
      // the base id and collect every task/component state under it.
      for (const [baseId, units] of aggregateSacctRows(stdout)) stateMap.set(`${host}|${baseId}`, units);
      queriedHosts.add(host);
      noteHostSuccess(host);
      sacctUnavailable.delete(host);
    } catch (err) {
      if (noteSacctError(host, err?.stderr || err?.message)) {
        logDebug(`sacct unavailable on ${host}: ${sacctUnavailable.get(host).reason}`);
      }
      const why = describeExecError(err, SACCT_MAX_BUFFER, `${hostWatches.length} watched job(s) in one sacct query`);
      noteHostFailure(host, `batch sacct (${host}): ${why}`);
      logDebug(`Batch poll failed for ${host}: ${why}`);
    }
  }
  const hostErrors = [...byHost.keys()].map(h => hostBackoff.get(h)?.error).filter(Boolean);
  lastPollError = hostErrors.length ? hostErrors.join(' | ') : null;

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const expiredKeys = new Set();
  for (const w of myWatches) {
    // Host not queried (dead master, sacct failed, backing off): nothing is
    // known about the job — leave the watch, including unseenSince, untouched.
    if (!queriedHosts.has(watchHost(w))) continue;
    // `lastQueriedAt`: last successful sacct of this watch's cluster (updated
    // at most every WATCH_QUERY_REFRESH_MS to avoid a file write per cycle).
    // A larger gap means an outage (dead master, no server running): this is
    // the first query after it.
    const prevQueried = Date.parse(w.lastQueriedAt ?? '');
    const continuous = Number.isFinite(prevQueried) && nowMs - prevQueried <= WATCH_QUERY_GAP_MS;
    if (!continuous || nowMs - prevQueried > WATCH_QUERY_REFRESH_MS) { w.lastQueriedAt = nowIso; stateChanged = true; }
    const tasks = stateMap.get(watchKey(w));
    if (!tasks || !tasks.size) {
      // sacct answered but does not report the job (sacct lag right after
      // submit, or the job is long gone): start the expiry clock once.
      if (!w.unseenSince) { w.unseenSince = nowIso; stateChanged = true; }
      // First successful query after an outage: restart the clock instead of
      // expiring — the absence before the outage says nothing about now.
      else if (!continuous) { w.unseenSince = nowIso; stateChanged = true; }
      // Absent again in a continuous series of successful queries.
      else if (isWatchExpired(w, nowMs)) {
        logDebug(`Watch ${w.jobId} on ${watchHost(w)} expired: not reported by sacct since ${w.unseenSince}`);
        expiredKeys.add(watchKey(w));
      }
      continue;
    }
    if (w.unseenSince) { delete w.unseenSince; stateChanged = true; }
    const sum = summarizeJobRows(tasks);
    if (sum.allDone) {
      let delivered;
      if (sum.isArray) {
        const kinds = [...sum.failedKinds].map(([k, n]) => `${k}×${n}`).join(', ');
        const summary = `${sum.ok} ok / ${sum.failed} failed${kinds ? ` (${kinds})` : ''}`;
        delivered = markCompleted(w, sum.failed ? 'FAILED' : 'COMPLETED', summary);
      } else {
        delivered = markCompleted(w, sum.verdict);
      }
      // Not persisted → keep the watch; the next cycle retries.
      if (delivered) completedKeys.add(watchKey(w));
      continue;
    }
    // Still active: RUNNING if any task/component runs, else the pending state.
    const newState = (sum.isArray || sum.isHet)
      ? (sum.running ? 'RUNNING' : baseState(sum.states.find(st => !isTerminalState(st))))
      : sum.states[0];
    const total = [...tasks.keys()].reduce((n, k) => n + countTasksInKey(k), 0);
    const progress = sum.isArray ? `${sum.ok + sum.failed}/${total}` : undefined;
    if (w.state !== newState || w.progress !== progress) {
      w.state = newState;
      w.progress = progress;
      stateChanged = true;
    }
  }

  if (completedKeys.size || expiredKeys.size || stateChanged) {
    // Re-read from disk (under lock) to avoid overwriting watches added
    // during the async poll by this or another window's server. Matching is by
    // host + job id: the same numeric id can exist on two clusters.
    const polledByKey = new Map(myWatches.map(m => [watchKey(m), m]));
    withFileLock(WATCHES_FILE, () => {
      const updated = loadWatches()
        .filter(w => !completedKeys.has(watchKey(w)) && !expiredKeys.has(watchKey(w)))
        .map(w => mergePolledWatch(w, polledByKey.get(watchKey(w)), windowTty));
      saveWatches(updated);
    });
  }
}

// Poll write-back: the disk entry is the base; only the fields the poll owns
// are copied from the (possibly stale) polled snapshot. Why: writing back the
// whole snapshot undid changes other windows made during the async poll — an
// adoption (tty) or any other field. If the watch on disk no longer belongs
// to `tty`, it is left untouched.
const POLL_OWNED_FIELDS = ['state', 'progress', 'lastSeenAt', 'unseenSince', 'lastQueriedAt'];
function mergePolledWatch(disk, polled, tty) {
  if (!polled || disk.tty !== tty) return disk;
  const out = { ...disk };
  for (const f of POLL_OWNED_FIELDS) {
    if (polled[f] === undefined) delete out[f]; else out[f] = polled[f];
  }
  return out;
}

// Runs one poll cycle and never lets it throw: an uncaught error used to end
// the setTimeout chain (or crash the process via an unhandled rejection), so
// every watch silently stopped being polled.
async function safePoll(fn = pollOnce) {
  try {
    await fn();
    consecutivePollFailures = 0;
  } catch (err) {
    lastPollError = `poll cycle crashed: ${String(err?.message ?? err)}`;
    consecutivePollFailures++;
    logDebug(`${lastPollError}\n${err?.stack ?? ''}`);
  }
}

function pollState() {
  const hosts = Object.fromEntries([...hostBackoff].map(([h, st]) => [h, { failures: st.failures, nextAt: st.nextAt }]));
  return { lastPollTime, lastPollError, pollCount, consecutivePollFailures, hostBackoff: hosts };
}

function startHeartbeat() {
  writeHeartbeat();
  setInterval(() => writeHeartbeat(), HEARTBEAT_INTERVAL).unref();
}

function startWatchPolling() {
  // setTimeout chain: wait for poll to finish before scheduling next.
  // Delay is dynamic: exponential backoff only for crashing cycles; failing
  // hosts back off individually inside pollOnce.
  (function scheduleNext() {
    setTimeout(async () => {
      try { await safePoll(); } finally { scheduleNext(); }
    }, currentPollDelay());
  })();
}

// --- Multi-cluster: HPC_HOST can be comma-separated (e.g. "cluster1,cluster2") ---
const HPC_HOSTS = requireEnvList('HPC_HOST', RE_HOST, 'letters, digits, _ . - and an optional user@ prefix');
const HPC_USERS = requireEnvList('HPC_USER', RE_USER, 'letters, digits, _ . - @ \\');
// Optional: many sites have a default account. Unset/empty → no
// "#SBATCH --account" line; an empty entry in a list means "none" for that
// cluster ("acct1,,acct3").
const SLURM_ACCOUNTS = process.env.SLURM_ACCOUNT
  ? parseEnvList('SLURM_ACCOUNT', process.env.SLURM_ACCOUNT, /^((?!-)[\w.-]+)?$/, 'letters, digits, _ . -')
  : [''];

// Default to first cluster
let SSH_HOST = HPC_HOSTS[0];
let SSH_USER = HPC_USERS[0];
let SLURM_ACCOUNT = SLURM_ACCOUNTS[0] || null;

function getClusterIndex(name) {
  if (!name) return 0;
  const idx = HPC_HOSTS.indexOf(name);
  return idx >= 0 ? idx : 0;
}

function switchCluster(name) {
  const idx = getClusterIndex(name);
  SSH_HOST = HPC_HOSTS[idx];
  SSH_USER = HPC_USERS[Math.min(idx, HPC_USERS.length - 1)];
  SLURM_ACCOUNT = SLURM_ACCOUNTS[Math.min(idx, SLURM_ACCOUNTS.length - 1)] || null;
  return SSH_HOST;
}

const TIMEOUT = 30000;

// sacct output of big array jobs (every task × .batch/.extern rows) can pass
// Node's 1 MB default and the 5 MB used elsewhere.
const SACCT_MAX_BUFFER = 32 * 1024 * 1024;

// Readable text for a failed child process; an output-limit overflow gets an
// explanation instead of Node's bare "stdout maxBuffer length exceeded".
function describeExecError(err, maxBuffer, what = '') {
  const code = err?.code;
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || code === 'ENOBUFS' || /maxBuffer/i.test(String(err?.message ?? ''))) {
    return `output exceeded ${Math.round(maxBuffer / 1048576)} MB${what ? ` (${what})` : ''} — too many array tasks/steps for one query`;
  }
  return String(err?.message ?? err);
}

// Why: the cluster uses chained publickey+Duo MFA. Without BatchMode, an ssh
// spawned by this server could fall back to an interactive/keyboard auth
// prompt (hang) or make a doomed auth attempt that feeds the bastion's
// fail2ban. BatchMode=yes makes every non-interactive call fail fast instead.
//
// `mode` is the probeMaster state of the target host. In ControlMaster mode
// ('alive') ProxyCommand=false is added: if the master dies between the probe
// and the call, ssh cannot reuse it and would open a NEW connection (a
// publickey attempt against the bastion, fail2ban food); with
// ProxyCommand=false that connection fails locally without touching the
// network. Direct mode ('unconfigured', no ControlPath) must connect, so it
// gets BatchMode only.
//
// The ControlPath is pinned explicitly next to ProxyCommand=false. Why: the
// common `ControlPath ~/.ssh/sockets/%C` hashes the ProxyJump value (%j)
// into the socket name; overriding the proxy changes the hash, ssh then looks
// for a different socket, misses the live master and fails every call
// (found on a real cluster with ProxyJump).
//
// If the path cannot be resolved safely (`ssh -G` failed, or the value holds
// "%" / whitespace / quotes), the call is refused locally (fail-local): without
// a pinned path ProxyCommand=false cannot be used, and a plain BatchMode call
// would open a NEW connection (a publickey attempt against the bastion) if the
// master happened to die. HPC_ALLOW_UNSAFE_REUSE=1 restores the plain-BatchMode
// fallback; under HPC_REQUIRE_MASTER=1 there is never a fallback.
function sshOptsFor(mode, controlPath, {
  reason = 'no ControlPath', allowUnsafe = ALLOW_UNSAFE_REUSE, requireMaster = REQUIRE_MASTER,
} = {}) {
  const args = ['-o', 'BatchMode=yes'];
  if (mode !== 'alive') return args;
  if (controlPath) {
    args.push('-o', controlPath.includes(' ') ? `ControlPath="${controlPath}"` : `ControlPath=${controlPath}`, '-o', 'ProxyCommand=false');
    return args;
  }
  if (allowUnsafe && !requireMaster) return args;
  throw new Error(controlPathUnresolvedMessage(reason, requireMaster));
}

function controlPathUnresolvedMessage(reason, requireMaster = REQUIRE_MASTER) {
  return `ControlMaster detected but its ControlPath could not be resolved safely (${reason}); ` +
    'refusing to open a new connection. Set HPC_ALLOW_UNSAFE_REUSE=1 to override' +
    (requireMaster ? ' (not honored while HPC_REQUIRE_MASTER=1)' : '') + '.';
}

// Effective ControlPath from `ssh -G` output (fully expanded), or null when
// none is configured or the value cannot be passed back verbatim ("%" would be
// re-expanded; whitespace would split `rsync -e`).
//
// Plain spaces inside the path are fine: sshOptsFor wraps such a value in
// double quotes (ssh's -o parser splits on spaces otherwise: "extra arguments
// at end of line"), and rsync -e keeps a single-quoted argument together
// (verified with openrsync; GNU rsync documents the same quoting). Refused:
// "%", quotes, backslashes, tabs/newlines, leading/trailing whitespace.
function parseControlPath(sshGOutput) {
  return controlPathProblem(sshGOutput) ? null : rawControlPath(sshGOutput);
}
function rawControlPath(sshGOutput) {
  const m = String(sshGOutput || '').match(/^controlpath (.+)$/im);
  return m ? m[1].replace(/\r$/, '') : '';
}

// Why the raw value is not usable (for the error message), or null.
function controlPathProblem(sshGOutput) {
  const raw = rawControlPath(sshGOutput);
  if (!raw.trim()) return 'ssh -G reports no controlpath';
  if (raw.trim().toLowerCase() === 'none') return 'ssh -G reports controlpath none';
  if (raw.includes('%')) return `controlpath "${raw}" contains an unexpanded "%" token`;
  if (/['"\\\t\n\r]/.test(raw) || raw !== raw.trim()) return `controlpath "${raw}" contains quotes, backslashes, tabs or leading/trailing whitespace`;
  return null;
}

// ssh argv for `rsync -e`: rsync splits the string on spaces, so an argument
// with a space (a quoted ControlPath) is single-quoted. Values never contain
// a single quote (see controlPathProblem).
function rsyncSshCommand(baseArgs) {
  return ['ssh', ...baseArgs.map(a => (a.includes(' ') ? `'${a}'` : a))].join(' ');
}

// `ssh -G` only evaluates the local config: no network, no auth attempt.
// Returns { path } or { path: null, reason }.
function resolveControlPath(host) {
  const r = spawnSync('ssh', ['-G', String(host)], { timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  let reason;
  if (r.status !== 0) {
    const detail = String(r.stderr || r.error?.message || '').trim().split('\n')[0] || `exit ${r.status ?? r.signal}`;
    reason = `ssh -G ${host} failed: ${detail}`;
  } else {
    const cp = parseControlPath(r.stdout);
    if (cp) return { path: cp };
    reason = `${host}: ${controlPathProblem(r.stdout) || 'unusable controlpath'}`;
  }
  logDebug(`ControlPath for ${host} not resolvable via ssh -G (${reason})`);
  return { path: null, reason };
}

// Throws (fail-local, no network) when the master is alive but its
// ControlPath cannot be pinned; see sshOptsFor.
function sshBaseArgs(mode, host) {
  if (mode !== 'alive') return sshOptsFor(mode, null);
  const { path, reason } = resolveControlPath(host);
  return sshOptsFor(mode, path, { reason });
}

function masterDeadMessage(host) {
  return `SSH master connection to ${host} is dead. Background processes cannot ` +
    `re-authenticate (Duo required). Fix: run \`ssh ${host}\` interactively ` +
    `in a terminal once, then retry this tool.`;
}

function sshExec(cmd, timeout = TIMEOUT, { maxBuffer = 5 * 1024 * 1024 } = {}) {
  // Use login shell so /etc/profile.d/ (SLURM PATH etc.) is sourced
  // execFileSync bypasses local shell — the entire remote command is passed
  // as one SSH argument, so 'bash -c' correctly receives the full string.
  const escaped = cmd.replace(/'/g, "'\"'\"'");
  const doExec = (baseArgs) => withBusyHeartbeat(timeout, () => execFileSync('ssh', [...baseArgs, SSH_HOST, `bash --login -c '${escaped}'`], {
    timeout, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer,
  }).trim());

  // Fail fast with zero network traffic when the master is dead: chained MFA
  // (publickey+Duo) means a non-interactive reconnect can never succeed — it
  // only records a failed auth on the bastion and feeds fail2ban. The old
  // auto-reconnect here (`ssh -O exit` + `ssh -fN`) killed the shared master
  // (the only Duo-free session token) and retried blindly; combined with
  // zombie pollers it caused the 2026 connection-storm bans. Never restore it.
  const mode = probeMaster(SSH_HOST).state;
  if (mode === 'dead') {
    throw new Error(masterDeadMessage(SSH_HOST));
  }
  // Alive master with an unresolvable ControlPath: refused here, before any
  // ssh that could open a connection (throws like a dead master).
  const baseArgs = sshBaseArgs(mode, SSH_HOST);

  try {
    return doExec(baseArgs);
  } catch (e) {
    const stderr = e.stderr ? String(e.stderr).trim() : '';
    // Exit 255 = ssh itself failed. Other codes come from the remote command,
    // whose own stderr may well say "Connection refused" (e.g. sacct → slurmdbd).
    if (e.status === 255 && (stderr.includes('Connection closed') || stderr.includes('Connection reset') ||
        stderr.includes('Connection refused') || stderr.includes('not a socket') ||
        e.message?.includes('socket is not connected'))) {
      e.message = `SSH connection to ${SSH_HOST} failed mid-command (master may have just died, ` +
        `or the bastion is fail2ban-banned). Do NOT retry in a loop — check \`ssh -O check ${SSH_HOST}\`, ` +
        `reconnect interactively if needed.\nOriginal: ${e.message}`;
    }
    if (stderr) e.message = `${e.message}\nSTDERR: ${stderr}`;
    throw e;
  }
}

// Why the second argument: `instructions` and `capabilities` are ServerOptions.
// `instructions` used to sit in serverInfo (ignored), and without
// capabilities.logging the SDK silently drops sendLoggingMessage.
const server = new McpServer({
  name: 'slurm-mcp-server',
  version: '2.2.0',
}, {
  capabilities: { logging: {} },
  instructions: 'SLURM HPC tools via SSH. 26 tools for job management, file sync, monitoring, and interactive sessions. Supports multi-cluster setups.',
});

// --- Auto-prepend SLURM notifications to all tool results (piggyback) ---
// IMPORTANT: All server.tool() calls MUST be after this monkey-patch
const SKIP_DRAIN_TOOLS = new Set(['slurm_watches']);
const _origTool = server.tool.bind(server);
server.tool = function(...toolArgs) {
  const toolName = typeof toolArgs[0] === 'string' ? toolArgs[0] : '';
  const handlerIdx = toolArgs.findIndex(a => typeof a === 'function');
  if (handlerIdx >= 0 && !SKIP_DRAIN_TOOLS.has(toolName)) {
    const origHandler = toolArgs[handlerIdx];
    toolArgs[handlerIdx] = async function(...hArgs) {
      const result = await origHandler.apply(this, hArgs);
      // The tool already ran: a broken notification file must never turn its
      // result (e.g. a queued sbatch) into an error.
      let notif = '';
      try { notif = drainNotifications(); } catch (err) { logDebug(`drainNotifications failed: ${String(err?.message ?? err)}`); }
      if (notif) {
        if (!result) return { content: [{ type: 'text', text: notif.trim() }] };
        if (!result.content) result.content = [];
        if (result.content[0]?.type === 'text') {
          result.content[0].text = notif + result.content[0].text;
        } else {
          result.content.unshift({ type: 'text', text: notif.trim() });
        }
      }
      return result;
    };
  }
  return _origTool(...toolArgs);
};

// --- SSH ---

server.tool('ssh_status', 'Check if SSH connection to HPC is active', {}, async () => {
  const { state, output } = probeMaster(SSH_HOST);
  if (state === 'alive') {
    noteHostSuccess(SSH_HOST); // master is back: the poller need not wait out its backoff
    return { content: [{ type: 'text', text: `SSH active: ${output}` }] };
  }
  if (state === 'unconfigured') {
    return { content: [{ type: 'text', text: `ControlMaster not configured — direct BatchMode connections to ${SSH_HOST}; for MFA clusters configure ControlMaster (see README).` }] };
  }
  const why = REQUIRE_MASTER && /No ControlPath specified/i.test(output)
    ? ` (HPC_REQUIRE_MASTER=1 and no ControlPath is configured for ${SSH_HOST} — configure ControlMaster, see README)` : '';
  return { content: [{ type: 'text', text: `SSH not connected${why}. Run "ssh ${SSH_HOST}" in terminal to connect.` }] };
});

// === Command Guard: reject prohibited patterns ===
// Not a security boundary: it catches the quoting mistakes that break the
// single-quoted `bash --login -c '...'` transport, nothing more.
// `<<-EOF` (tab-stripping heredoc) is a heredoc too.
const HEREDOC_RE = /<<-?\s*['"]?\w+/;
const BLOCKED_PATTERNS = [
  { re: HEREDOC_RE, reason: 'heredoc 禁止。写本地文件 → sync_files 上传' },
  // python, python3, python3.11 … with any flags before -c (python -u -c, -uc).
  { re: /\bpython[\d.]*(\s+-\w+)*\s+-\w*c\b/, reason: 'python -c 禁止。写 .py 文件 → sync_files 上传 → ssh_exec python script.py' },
  // Three or more lines (two newlines followed by more content); a single
  // trailing newline does not count as a line.
  { re: /\n[^]*\n[^]*\S/, reason: '多行命令禁止（>2行）。写脚本 → sync_files 上传 → ssh_exec bash script.sh' },
  { re: /"/, reason: '双引号禁止（多层 shell 转义会吞字符）。用 ssh_read_file 读取后在本地处理' },
  { re: /'/, reason: '单引号禁止（sshExec 用单引号包裹命令，嵌套必坏）。避免 echo 拼接，拆成多条简单命令' },
  { re: /^\s*grep\b/, reason: 'grep 禁止通过 ssh_exec 执行（引号/正则转义必坏）。用 ssh_read_file 或 ssh_exec cat 取回内容 → 在本地 Grep' },
  { re: /^\s*awk\b/, reason: 'awk 禁止通过 ssh_exec 执行（$变量被 shell 展开）。写 .py 脚本 → sync_files 上传' },
  { re: /^\s*sed\s+-/, reason: 'sed 禁止通过 ssh_exec 执行（正则转义问题）。用 ssh_write_file 或写脚本上传' },
];
const MAX_CMD_LENGTH = 500; // 超过 500 字符的命令大概率是内嵌代码

function guardCommand(cmd) {
  if (cmd.length > MAX_CMD_LENGTH) {
    return `BLOCKED: 命令长度 ${cmd.length} 超过 ${MAX_CMD_LENGTH} 字符限制。请写成脚本文件 → sync_files 上传 → ssh_exec 执行`;
  }
  for (const { re, reason } of BLOCKED_PATTERNS) {
    if (re.test(cmd)) return `BLOCKED: ${reason}`;
  }
  return null;
}

// === Output filter: compress trivial command output ===
const QUIET_RE = /^\s*(cd|pwd|mkdir|cp|mv|rm|rmdir|chmod|chown|ln|touch|source|export|module\s+load|module\s+unload|conda\s+activate)\b/;
const NAV_RE = /^\s*(ls|ll|la|ls\s+-[alh]|du|df|wc|file|stat|which|whoami|hostname|date|echo)\b/;

// Why the compound check: "cd /w && python run.py" starts with a quiet verb
// but its real output comes from the later command — never truncate those.
const COMPOUND_RE = /[;&|]/;

function compressOutput(cmd, out) {
  if (!out) return '(no output)';
  if (COMPOUND_RE.test(cmd)) return out;
  if (QUIET_RE.test(cmd)) {
    const first = out.split('\n')[0];
    return first ? `✓ ${first}` : '✓ done';
  }
  if (NAV_RE.test(cmd)) {
    const lines = out.split('\n');
    if (lines.length > 30) {
      return lines.slice(0, 30).join('\n') + `\n... (${lines.length - 30} more lines)`;
    }
  }
  return out;
}

server.tool('ssh_exec', 'Execute a command on HPC via SSH', {
  command: z.string().describe('Shell command to run on HPC. Max 500 chars. No heredoc, no python -c, no multi-line code. Write scripts locally and upload via sync_files.'),
  // Why min 1000: Node treats timeout 0 as "no timeout", and the ssh call is
  // synchronous — it would block the whole server indefinitely.
  timeout: z.number().int().min(1000).max(600000).optional().default(30000).describe('Timeout in ms (1000-600000, default 30000)'),
  verbose: z.boolean().optional().default(false).describe('Force full output (bypass noise filter)'),
}, async (args) => {
  // Hard block prohibited patterns
  const blocked = guardCommand(args.command);
  if (blocked) return { content: [{ type: 'text', text: blocked }], isError: true };
  try {
    const out = sshExec(args.command, args.timeout);
    // A manual call just proved the cluster reachable: end the poller's
    // backoff for it (up to 10 min) so watches resume on the next cycle.
    noteHostSuccess(SSH_HOST);
    const text = args.verbose ? (out || '(no output)') : compressOutput(args.command, out);
    return { content: [{ type: 'text', text }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `SSH exec failed: ${String(e?.message ?? e)}` }], isError: true };
  }
});

server.tool('ssh_write_file', 'Write content to a file on HPC. Use this instead of ssh_exec with cat/heredoc.', {
  path: z.string().describe('Absolute file path on HPC'),
  content: z.string().optional().describe('File content to write (omit if using from_file)'),
  from_file: z.string().optional().describe('Local file path to read content from (avoids displaying large content in UI)'),
  append: z.boolean().optional().default(false).describe('Append instead of overwrite'),
}, async (args) => {
  try {
    // Resolve content: from_file takes priority, then content
    let fileContent;
    let source;
    if (args.from_file) {
      fileContent = readFileSync(args.from_file, 'utf8');
      source = `(from ${args.from_file})`;
    } else if (args.content !== undefined) { // "" is valid: writes an empty file
      fileContent = args.content;
      source = '';
    } else {
      return { content: [{ type: 'text', text: 'Write failed: provide either content or from_file' }], isError: true };
    }
    const op = args.append ? '>>' : '>';
    // Same fail-fast as sshExec: a dead master means any connect attempt is a
    // doomed Duo-less auth against the bastion.
    const mode = probeMaster(SSH_HOST).state;
    if (mode === 'dead') {
      return { content: [{ type: 'text', text: `Write failed: ${masterDeadMessage(SSH_HOST)}` }], isError: true };
    }
    // Use stdin pipe to avoid shell escaping issues with file content
    const escaped = args.path.replace(/'/g, "'\"'\"'");
    withBusyHeartbeat(30000, () => execFileSync('ssh', [...sshBaseArgs(mode, SSH_HOST), SSH_HOST, `cat ${op} '${escaped}'`], {
      input: fileContent,
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }));
    const bytes = Buffer.byteLength(fileContent, 'utf8');
    return { content: [{ type: 'text', text: `Written ${bytes} bytes → ${args.path} ${source}`.trim() }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Write failed: ${String(e?.message ?? e)}` }], isError: true };
  }
});

server.tool('ssh_read_file', 'Read a file from HPC. Use this instead of ssh_exec with cat.', {
  path: z.string().describe('Absolute file path on HPC'),
  tail: z.number().optional().describe('Only read last N lines'),
  head: z.number().optional().describe('Only read first N lines'),
}, async (args) => {
  try {
    let cmd = `cat '${args.path.replace(/'/g, "'\"'\"'")}'`;
    if (args.tail) cmd = `tail -n ${args.tail} '${args.path.replace(/'/g, "'\"'\"'")}'`;
    if (args.head) cmd = `head -n ${args.head} '${args.path.replace(/'/g, "'\"'\"'")}'`;
    const out = sshExec(cmd, 15000);
    return { content: [{ type: 'text', text: out || '(empty file)' }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Read failed: ${String(e?.message ?? e)}` }], isError: true };
  }
});

// --- Workdir Guard ---

server.tool('workdir_set', 'Set HPC working directory for this window (used by slurm_submit guard)', {
  path: z.string().describe('Absolute path on HPC (e.g. /home/user/project)'),
}, async (args) => {
  if (!args.path.startsWith('/')) {
    return { content: [{ type: 'text', text: `Error: 必须是绝对路径，收到: ${args.path}` }], isError: true };
  }
  // Why: the workdir is interpolated into the generated job script (cd and
  // mkdir targets), so reject shell metacharacters / quotes / whitespace here.
  // "%" is rejected too: the workdir becomes part of #SBATCH --output, where
  // sbatch expands %j/%A/..., while mkdir creates the literal name.
  const wdErr = validatePath(args.path, 'path') || (/['"\s]/.test(args.path) ? 'path contains quotes or whitespace' : null) ||
    (args.path.includes('%') ? 'path must not contain "%" (sbatch expands it in --output, mkdir does not)' : null);
  if (wdErr) return { content: [{ type: 'text', text: `Error: ${wdErr}` }], isError: true };
  saveWorkdir(args.path);
  return { content: [{ type: 'text', text: `✓ 工作目录已设置\n  窗口: ${windowTty}\n  集群: ${SSH_HOST}\n  路径: ${args.path}` }] };
});

server.tool('workdir_get', 'Get HPC working directory for this window', {}, async () => {
  const wd = loadWorkdir();
  if (!wd) {
    return { content: [{ type: 'text', text: `窗口 ${windowTty} 在集群 ${SSH_HOST} 上未设置工作目录。使用 workdir_set 设置。` }] };
  }
  return { content: [{ type: 'text', text: `窗口: ${windowTty}\n集群: ${SSH_HOST}\n工作目录: ${wd}` }] };
});

// --- Job Templates ---
const TEMPLATES_FILE = join(homedir(), '.claude', 'slurm-templates.json');

function loadTemplates() {
  return readJsonOrQuarantine(TEMPLATES_FILE, {}, d => d && typeof d === 'object' && !Array.isArray(d));
}
function saveTemplates(t) {
  atomicWriteJson(TEMPLATES_FILE, t);
}

server.tool('template_save', 'Save a reusable SLURM job template', {
  name: z.string().describe('Template name (e.g. "gpu-a100", "cpu-quick")'),
  partition: z.string().optional(),
  gpus: z.number().optional(),
  mem: z.string().optional(),
  time: z.string().optional(),
  cpus_per_task: z.number().optional(),
  preamble: z.string().optional().describe('Extra shell lines injected after HPC_PREAMBLE and before cd/the main script when this template is used'),
}, async (args) => {
  const { name, ...config } = args;
  // Remove undefined values
  Object.keys(config).forEach(k => config[k] === undefined && delete config[k]);
  withFileLock(TEMPLATES_FILE, () => {
    const templates = loadTemplates();
    templates[name] = config;
    saveTemplates(templates);
  });
  return { content: [{ type: 'text', text: `Template "${name}" saved: ${JSON.stringify(config)}` }] };
});

server.tool('template_list', 'List saved SLURM job templates', {}, async () => {
  const templates = loadTemplates();
  const names = Object.keys(templates);
  if (!names.length) return { content: [{ type: 'text', text: 'No templates saved. Use template_save to create one.' }] };
  const lines = names.map(n => `  ${n}: ${JSON.stringify(templates[n])}`);
  return { content: [{ type: 'text', text: `Saved templates:\n${lines.join('\n')}` }] };
});

// --- SLURM ---

// Validate SLURM job ID: plain "12345", a heterogeneous job component
// "12345+1" (same shapes the poller parses), one array task "12345_3", or a
// task range "12345_[1-5]" / "12345_[1,3,5-7]" (scancel/squeue/sacct accept all).
// Callers must single-quote the id in shell commands: [..] is a bash glob.
const VALID_JOB_ID = /^\d+(\+\d+)?(_(\d+|\[\d+(-\d+)?(,\d+(-\d+)?)*\]))?$/;
function validateJobId(id) {
  if (!VALID_JOB_ID.test(id)) throw new Error(`Invalid job ID: ${id} (e.g. "12345", "12345+1", "12345_3" or "12345_[1-5]")`);
  return id;
}

server.tool('slurm_status', 'Check SLURM job status (squeue + sacct). For array jobs pass the base id "12345" to see all tasks, or "12345_3" for one task.', {
  job_id: z.string().optional().describe('Job ID: "12345", hetjob component "12345+1", array task "12345_3", or task range "12345_[1-5]". Omit for all your jobs.'),
}, async (args) => {
  try {
    if (args.job_id) {
      const jid = validateJobId(args.job_id);
      // Why independent: squeue errors out for jobs that already left the
      // queue ("Invalid job id specified"), which used to hide the sacct
      // history — exactly the case where it matters. Error only if both fail.
      // Quoted: "12345_[1-5]" would otherwise be a bash glob.
      const run = (cmd) => {
        try { return { ok: true, text: sshExec(cmd, 15000) }; } catch (e) { return { ok: false, text: String(e?.message ?? e) }; }
      };
      const squeue = run(`squeue -j '${jid}'`);
      const sacct = run(`sacct -j '${jid}'`);
      const text = [
        '=== squeue ===',
        squeue.ok ? (squeue.text || '(no output)') : `(squeue failed: ${squeue.text})`,
        '',
        '=== sacct ===',
        sacct.ok ? (sacct.text || '(no output)') : `(sacct failed: ${sacct.text})`,
      ].join('\n');
      if (!squeue.ok && !sacct.ok) return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true };
      return { content: [{ type: 'text', text }] };
    }
    const out = sshExec(`squeue -u ${shq(SSH_USER)}`, 15000);
    return { content: [{ type: 'text', text: out || '(no jobs)' }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${String(e?.message ?? e)}` }], isError: true };
  }
});

// --- Resource Check (MUST call before any sbatch) ---

// Short reason for a failed sshExec: the remote stderr if there is one (the
// first message line is "Command failed: ssh ... <whole command>").
function firstLine(err) {
  const msg = String(err?.message ?? err);
  const stderr = msg.match(/STDERR: (.*)/)?.[1]?.trim();
  if (stderr) return stderr;
  return msg.split('\n').find(l => l.trim())?.trim() || 'unknown error';
}

// Returns { status: 'ok' | 'empty' | 'error', text, reason }.
// Why two queries: MaxRSS lives only on the step rows (.batch/.extern), the
// allocation row has it empty (verified on SMU SuperPOD). The old single
// `grep COMPLETED | grep -iF name` dropped every step row (they are named
// "batch"/"extern"), so resource_check never saw memory. Step 1 finds the
// recent COMPLETED jobs whose name contains the pattern (case-insensitive, as
// before); step 2 fetches all their rows including steps. Filtering is done
// here, not with a remote `| grep`, so a failing sacct is an error, not "no data".
// sacct -S start date "YYYY-MM-DD", `days` before `now` (local calendar).
// Why computed here: `$(date -d '7 days ago')` is GNU-only and fails on
// BSD/macOS-flavoured login nodes (or wherever `date` is not coreutils).
function sacctSinceDate(days, now = Date.now()) {
  const d = new Date(now - Math.max(0, Number(days) || 0) * 86400_000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function queryResourceHistory(jobNamePattern, limit = 5) {
  const safe = String(jobNamePattern).replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safe) return { status: 'empty', text: '' };
  let ids;
  try {
    const list = sshExec(
      `sacct -u ${shq(SSH_USER)} -X -S ${sacctSinceDate(7)} -o JobID,JobName%-64,State -P -n`,
      15000
    );
    const needle = safe.toLowerCase();
    ids = list.split('\n')
      .map(l => l.split('|').map(s => s.trim()))
      .filter(([id, name, state]) => /^\d+(\+\d+)?(_\d+)?$/.test(id || '') && baseState(state) === 'COMPLETED' &&
        String(name || '').toLowerCase().includes(needle))
      .map(([id]) => id)
      .slice(-limit);
  } catch (err) {
    return { status: 'error', text: '', reason: firstLine(err) };
  }
  if (!ids.length) return { status: 'empty', text: '' };
  try {
    const text = sshExec(`sacct -j ${ids.join(',')} -o JobID%-20,JobName%-20,Elapsed,MaxRSS,ReqMem,State -P -n`, 15000, { maxBuffer: SACCT_MAX_BUFFER });
    return text.trim() ? { status: 'ok', text } : { status: 'empty', text: '' };
  } catch (err) {
    return { status: 'error', text: '', reason: (err?.code === 'ENOBUFS' ? describeExecError(err, SACCT_MAX_BUFFER) : firstLine(err)) };
  }
}

/** Parse SLURM elapsed time: D-HH:MM:SS, HH:MM:SS, or MM:SS → seconds */
function parseElapsed(s) {
  if (!s) return 0;
  const dayMatch = s.match(/^(\d+)-(\d+):(\d+):(\d+)$/);
  if (dayMatch) return parseInt(dayMatch[1]) * 86400 + parseInt(dayMatch[2]) * 3600 + parseInt(dayMatch[3]) * 60 + parseInt(dayMatch[4]);
  const parts = s.split(':').map(Number);
  if (parts.length === 3) return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
  if (parts.length === 2) return (parts[0] || 0) * 60 + (parts[1] || 0);
  return 0;
}

/**
 * Memory string → MB. Accepts K/M/G/T/P suffixes (optional "B"/"iB"), decimals
 * ("1.50G") and the old ReqMem per-node/per-cpu suffix ("4Gn", "500Mc").
 * `bareUnit` is the unit of a suffix-less number. For sacct values (MaxRSS,
 * the default) it is KB: sacct reports memory in KB-based units and normally
 * prints a suffix ("1201368K"); a bare number is rare (e.g. "0", or some
 * --noconvert setups) and KB is the conservative reading — assuming bytes
 * would under-state the peak 1024×, and the recommendation derived from it
 * would OOM. A --mem request without suffix is MB (pass 'M').
 * Returns null if unparsable.
 */
function parseMemToMB(str, bareUnit = 'K') {
  const m = String(str ?? '').trim().match(/^(\d+(?:\.\d+)?)(?:([KMGTP])(?:i?B)?)?([nc])?$/i);
  if (!m) return null;
  const mult = { B: 1 / (1024 * 1024), K: 1 / 1024, M: 1, G: 1024, T: 1024 ** 2, P: 1024 ** 3 }[(m[2] || bareUnit).toUpperCase()];
  return parseFloat(m[1]) * mult;
}

/**
 * sacct rows "JobID|JobName|Elapsed|MaxRSS|ReqMem|State" → per-job peaks.
 * Rows are grouped by job (array task = its own job, steps fold into it); a
 * job counts when its allocation row is COMPLETED (or, without an allocation
 * row, any of its rows), and its MaxRSS is the maximum over all its steps.
 */
function parseResourceHistory(sacctOutput) {
  if (!sacctOutput) return null;
  const jobs = new Map();
  for (const line of sacctOutput.split('\n')) {
    const parts = line.split('|').map(s => s.trim());
    const id = parts[0];
    if (!id || !parseSacctJobId(id)) continue;
    const key = id.split('.')[0];
    const isStep = id.includes('.');
    if (!jobs.has(key)) jobs.set(key, { mainState: null, anyCompleted: false, rssMB: 0, rssSeen: false, secs: 0 });
    const j = jobs.get(key);
    const state = baseState(parts[5]);
    if (!isStep) j.mainState = state;
    if (state === 'COMPLETED') j.anyCompleted = true;
    const rss = parseMemToMB(parts[3]);
    if (rss != null) { j.rssMB = Math.max(j.rssMB, rss); j.rssSeen = true; }
    j.secs = Math.max(j.secs, parseElapsed(parts[2] || ''));
  }
  const done = [...jobs.values()].filter(j => (j.mainState ? j.mainState === 'COMPLETED' : j.anyCompleted));
  if (!done.length) return null;
  // maxMemGB null = no job had a MaxRSS value at all (accounting without
  // memory gathering): "no data", never a 0G peak.
  const measured = done.filter(j => j.rssSeen);
  return {
    maxMemGB: measured.length ? Math.max(...measured.map(j => j.rssMB)) / 1024 : null,
    maxTimeSec: Math.max(...done.map(j => j.secs)),
    count: done.length,
  };
}

function formatRecommendation(hist) {
  if (!hist) return '';
  const recTimeSec = Math.max(hist.maxTimeSec * 4, 300); // ×4 余量, 最低 5min
  const recH = Math.floor(recTimeSec / 3600);
  const recM = Math.floor((recTimeSec % 3600) / 60);
  const recTime = `${String(recH).padStart(2, '0')}:${String(recM).padStart(2, '0')}:00`;
  const timeText = `${Math.floor(hist.maxTimeSec/60)}m${hist.maxTimeSec%60}s time`;
  if (hist.maxMemGB == null) {
    return `\n📊 Resource baseline (${hist.count} recent jobs):\n` +
      `  Actual peak: memory: no measurement available (no MaxRSS in sacct), ${timeText}\n` +
      `  Recommended: --time=${recTime} (×4 time)\n`;
  }
  const recMem = Math.max(Math.ceil(hist.maxMemGB * 3), 2); // ×3 余量, 最低 2G
  return `\n📊 Resource baseline (${hist.count} recent jobs):\n` +
    `  Actual peak: ${hist.maxMemGB.toFixed(1)}G mem, ${timeText}\n` +
    `  Recommended: --mem=${recMem}G --time=${recTime} (×3 mem, ×4 time)\n`;
}

function checkResourceWaste(requestedMem, requestedTime, hist) {
  if (!hist || !hist.maxMemGB) return ''; // 0 or null (no measurement)
  const reqMemGB = memToMB(requestedMem) / 1024;
  // Why parseSlurmTime: "1-00:00:00" or "90" used to produce NaN here.
  const reqTimeSec = parseSlurmTime(requestedTime) ?? 0;
  const memRatio = reqMemGB / Math.max(hist.maxMemGB, 0.1);
  const timeRatio = reqTimeSec / Math.max(hist.maxTimeSec, 1);
  const warnings = [];
  if (memRatio > 10) warnings.push(`⚠️ Memory ${+reqMemGB.toFixed(1)}G is ${memRatio.toFixed(0)}x actual usage (${hist.maxMemGB.toFixed(1)}G)`);
  if (timeRatio > 10) warnings.push(`⚠️ Time ${requestedTime} is ${timeRatio.toFixed(0)}x actual usage (${Math.floor(hist.maxTimeSec/60)}min)`);
  return warnings.length ? '\n' + warnings.join('\n') : '';
}

// Returns { status: 'disabled' | 'ok' | 'empty' | 'error', text, reason }.
// grep exits 1 on "no match" (→ empty) and 2 on a real error such as a
// missing file (→ error, with grep's stderr as the reason).
function queryResourceLog(pattern) {
  if (!RESOURCE_LOG_PATH) return { status: 'disabled', text: '' };
  const safe = String(pattern).replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safe) return { status: 'empty', text: '' };
  try {
    const text = sshExec(`grep -iF -e ${safe} ${RESOURCE_LOG_PATH}; test $? -le 1`, 10000);
    return text.trim() ? { status: 'ok', text } : { status: 'empty', text: '' };
  } catch (err) {
    return { status: 'error', text: '', reason: firstLine(err) };
  }
}

server.tool('resource_check', 'Check actual resource usage of past jobs (MUST call before sbatch)', {
  job_name: z.string().describe('Job name pattern to search (case-insensitive substring of recent COMPLETED job names)'),
}, async (args) => {
  try {
    const sections = [];

    // Source 1: sacct (SLURM accounting)
    const sacct = queryResourceHistory(args.job_name);
    const hist = sacct.status === 'ok' ? parseResourceHistory(sacct.text) : null;

    // Source 2: external resource log (optional, set HPC_RESOURCE_LOG env var)
    const log = queryResourceLog(args.job_name);

    // "Run a benchmark" only when both sources answered and found nothing —
    // an ssh/sacct failure is reported as such, not as missing history.
    if (sacct.status === 'empty' && (log.status === 'empty' || log.status === 'disabled')) {
      return { content: [{ type: 'text', text: `No resource data for "${args.job_name}". Run a 1-seed benchmark first.` }] };
    }

    if (sacct.status === 'ok') sections.push(`=== SLURM sacct (last 7 days) ===\n${sacct.text}`);
    else if (sacct.status === 'error') sections.push(`⚠️ resource history unavailable: ${sacct.reason}`);
    if (log.status === 'ok') sections.push(`=== External resource log ===\n${log.text}`);
    else if (log.status === 'error') sections.push(`⚠️ resource log unavailable: ${log.reason}`);
    if (hist) sections.push(formatRecommendation(hist));

    return { content: [{ type: 'text', text: sections.join('\n\n') }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${String(e?.message ?? e)}` }], isError: true };
  }
});

// --- Partition limit awareness ---
// Why: small debug partitions often carry a per-user QoS cap (e.g. SMU short:
// MaxJobsPU=1). Array tasks submitted there silently run one at a time, and
// requests above MaxTRESPU are rejected outright under DenyOnLimit. The model
// cannot know this from `sinfo`, so we surface the caps as submit-time hints.
const partitionLimitsCache = new Map(); // `${host}|${partition}` → limits

/** "256G" / "4096" (MB default) / "1T" → MB; null if unparsable. */
function memToMB(mem) {
  return parseMemToMB(mem, 'M');
}

function parseTres(str) {
  const out = {};
  for (const kv of String(str || '').split(',')) {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

// Fetches every partition + the QoS they reference in two ssh round-trips and
// caches the result for the lifetime of this process (limits rarely change).
// `scontrol show partition -o` lines → partition records (limits filled in
// later). The QoS key is matched case-insensitively: some Slurm versions
// print "QOS=" instead of "QoS=" ("AllowQos=" never matches: no word boundary).
function parsePartitionLines(text) {
  const found = [];
  for (const line of String(text || '').split('\n')) {
    const name = line.match(/\bPartitionName=(\S+)/)?.[1];
    if (!name) continue;
    const maxTime = line.match(/\bMaxTime=(\S+)/)?.[1] || null;
    const qosRaw = line.match(/\bQoS=(\S+)/i)?.[1] || null;
    found.push({
      partition: name,
      maxTime,
      maxTimeSec: parseSlurmTime(maxTime), // UNLIMITED → null
      qos: qosRaw && qosRaw !== 'N/A' && /^[\w.-]+$/.test(qosRaw) ? qosRaw : null,
      maxJobsPU: null, maxSubmitPU: null, maxTRESPU: null, tres: {},
    });
  }
  return found;
}

function loadPartitionLimitsForHost() {
  const found = parsePartitionLines(sshExec('scontrol show partition -o', 15000));
  const qosNames = [...new Set(found.map(p => p.qos).filter(Boolean))];
  // Why a separate try: sacctmgr can fail (slurmdbd down, restricted to
  // admins) while scontrol worked — keep the partition MaxTime we already have.
  let q = null;
  if (qosNames.length) {
    try {
      q = sshExec(`sacctmgr show qos where name=${qosNames.join(',')} -P -n format=Name,MaxJobsPU,MaxSubmitPU,MaxTRESPU,MaxWall`, 15000);
    } catch (err) {
      logDebug(`sacctmgr QoS query failed: ${String(err?.message ?? err)}`);
      for (const p of found) p.qosUnavailable = true;
    }
  }
  if (q != null) {
    const byName = new Map();
    for (const line of q.split('\n')) {
      const [name, jobs, submit, tres, wall] = line.split('|').map(x => (x ?? '').trim());
      if (name) byName.set(name, { jobs, submit, tres, wall });
    }
    for (const p of found) {
      const r = p.qos && byName.get(p.qos);
      if (!r) continue;
      p.maxJobsPU = r.jobs ? parseInt(r.jobs, 10) : null;
      p.maxSubmitPU = r.submit ? parseInt(r.submit, 10) : null;
      p.maxTRESPU = r.tres || null;
      p.tres = parseTres(r.tres);
      const wallSec = parseSlurmTime(r.wall);
      if (wallSec != null && (p.maxTimeSec == null || wallSec < p.maxTimeSec)) {
        p.maxTimeSec = wallSec; p.maxTime = r.wall;
      }
    }
  }
  for (const p of found) partitionLimitsCache.set(`${SSH_HOST}|${p.partition}`, p);
  return found;
}

/** Limits for one partition on the active host, or null on any failure. */
function getPartitionLimits(partition) {
  const key = `${SSH_HOST}|${partition}`;
  if (partitionLimitsCache.has(key)) return partitionLimitsCache.get(key);
  try {
    loadPartitionLimitsForHost();
  } catch (err) {
    // Never block a submission on a limits lookup; failures are not cached.
    logDebug(`getPartitionLimits(${partition}) failed: ${String(err?.message ?? err)}`);
    return null;
  }
  return partitionLimitsCache.get(key) || null;
}

// Hints only — never blocks the submission (the scheduler is the authority).
function partitionLimitHints(args, timeSec) {
  const lim = getPartitionLimits(args.partition);
  if (!lim) return '';
  const hints = [];
  if (lim.maxJobsPU != null && lim.maxJobsPU <= 2) {
    let busy = !!args.array;
    if (!busy) {
      try {
        busy = parseInt(sshExec(`squeue -u ${shq(SSH_USER)} -p ${args.partition} -h | wc -l`, 10000), 10) > 0;
      } catch { /* unknown — stay quiet */ }
    }
    if (busy) {
      hints.push(`⚠️ Partition ${args.partition} allows ${lim.maxJobsPU} concurrent job(s) per user; array tasks / additional jobs will serialize — for parallel chunks use a partition without a per-user cap (e.g. batch).`);
    }
  }
  const gpuCap = lim.tres['gres/gpu'] != null ? parseInt(lim.tres['gres/gpu'], 10) : null;
  if (gpuCap != null && args.gpus > gpuCap) {
    hints.push(`⚠️ gpus=${args.gpus} exceeds per-user cap gres/gpu=${gpuCap} on ${args.partition}; DenyOnLimit will reject.`);
  }
  const memCapMB = lim.tres.mem != null ? memToMB(lim.tres.mem) : null;
  const memMB = memToMB(args.mem);
  if (memCapMB != null && memMB != null && memMB > memCapMB) {
    hints.push(`⚠️ mem=${args.mem} exceeds per-user cap mem=${lim.tres.mem} on ${args.partition}; DenyOnLimit will reject.`);
  }
  if (lim.maxTimeSec != null && timeSec != null && timeSec > lim.maxTimeSec) {
    hints.push(`⚠️ time=${args.time} exceeds ${args.partition} MaxTime=${lim.maxTime}; the job will be rejected or never start.`);
  }
  return hints.length ? '\n' + hints.join('\n') : '';
}

// Input whitelists for slurm_submit. Every value lands in an #SBATCH header or
// shell line of a generated script, so anything outside these shapes is
// rejected rather than escaped.
const RE_JOB_NAME = /^[\w.-]{1,64}$/;
// RE_PARTITION is defined next to SLURM_DEFAULT_PARTITION (same whitelist).
const RE_MEM = /^\d+[KMGT]?$/;
// Ranges may carry a step ("1-10:2"), as sbatch accepts.
const RE_ARRAY = /^\d+(-\d+(:\d+)?)?(,\d+(-\d+(:\d+)?)?)*(%\d+)?$/;
// after* types need at least one job id; singleton takes none.
const DEP_ITEM = '((after|afterok|afternotok|afterany|aftercorr)(:\\d+(_\\d+)?)+|singleton)';
const RE_DEPENDENCY = new RegExp(`^${DEP_ITEM}(,${DEP_ITEM})*$`);

function validateSubmitArgs(args) {
  const errs = [];
  if (!RE_JOB_NAME.test(String(args.job_name))) errs.push(`job_name "${args.job_name}" must match ${RE_JOB_NAME} (letters, digits, _ . -, ≤64 chars)`);
  if (!RE_PARTITION.test(String(args.partition))) errs.push(`partition "${args.partition}" must match ${RE_PARTITION}`);
  if (!RE_MEM.test(String(args.mem))) errs.push(`mem "${args.mem}" must look like 4G / 512M / 4096`);
  // Whitespace is rejected (the handler trims first): the checked string must
  // be exactly the one written into #SBATCH --time.
  if (typeof args.time !== 'string' || args.time !== args.time.trim() || parseSlurmTime(args.time) == null) errs.push(`time "${args.time}" is not a SLURM time (M, M:S, H:M:S, D-H, D-H:M, D-H:M:S)`);
  if (args.array != null && !RE_ARRAY.test(String(args.array))) errs.push(`array "${args.array}" must look like 1-10, 1,3,5-7, 1-10:2 or 1-100%5`);
  if (args.dependency != null && !RE_DEPENDENCY.test(String(args.dependency))) errs.push(`dependency "${args.dependency}" must look like afterok:12345, afterany:12345_1,afterok:67890 or singleton`);
  if (!Number.isInteger(args.gpus) || args.gpus < 0) errs.push(`gpus must be a non-negative integer`);
  if (args.cpus_per_task != null && (!Number.isInteger(args.cpus_per_task) || args.cpus_per_task < 0)) errs.push(`cpus_per_task must be a non-negative integer`);
  const odErr = validatePath(String(args.output_dir), 'output_dir') || (/['"\s]/.test(String(args.output_dir)) ? 'output_dir contains quotes or whitespace' : null);
  if (odErr) errs.push(odErr);
  // Why: sbatch expands %j/%A/%x/... in --output, but mkdir -p creates the
  // literal name, so logs would land in a directory that was never created.
  if (!odErr && String(args.output_dir).includes('%')) errs.push(`output_dir "${args.output_dir}" must not contain "%" (sbatch would expand the placeholder in --output, but mkdir creates the literal directory, so the log directory would not exist)`);
  return errs;
}

// sbatch rejected the GPU request: the default gpus=1 (SLURM_DEFAULT_GPUS)
// writes "--gres=gpu:1", which CPU-only sites refuse. Only sbatch's own stderr
// is inspected — the error message also echoes the whole script, which
// contains "--gres" whenever GPUs were requested.
function gresHint(err) {
  const stderr = String(err?.stderr ?? '');
  return /gres|GPU|Invalid generic resource/i.test(stderr)
    ? '\n💡 This site may not offer GPUs: set SLURM_DEFAULT_GPUS=0 or pass gpus:0.'
    : '';
}

server.tool('slurm_submit',
  'Submit a SLURM batch job built from a command string. Auto-registers a completion watch: when the job (or, for arrays, EVERY task) finishes, a notification with an ok/failed tally is prepended to your next tool result — never poll with ssh loops. ' +
  'For many independent chunks use `array` (e.g. "1-20" or "1-100%10"; each task reads $SLURM_ARRAY_TASK_ID; logs go to slurm_<jobid>_<task>.out). ' +
  'Chain jobs with `dependency` (e.g. "afterok:12345"). Checks past resource usage, and appends ⚠️ hints (non-blocking) when the partition has a per-user cap that will serialize your jobs or reject the request (gpus/mem/time over the cap).', {
  script: z.string().describe('Main command(s) to run inside the job'),
  job_name: z.string().optional().describe('Job name, [A-Za-z0-9_.-]{1,64} (default: slurm-job)'),
  partition: z.string().optional().describe(`Partition (default: ${DEFAULT_PARTITIONS.join(' / ')}${DEFAULT_PARTITIONS.length > 1 ? ' per cluster, HPC_HOST order' : ''}). Use cluster_info to see per-user caps; small debug partitions often allow 1 job at a time — for parallel chunks pick a partition without a per-user cap.`),
  gpus: z.number().optional().describe(`Number of GPUs (default: ${DEFAULT_GPUS_LIST.join(' / ')}${DEFAULT_GPUS_LIST.length > 1 ? ' per cluster, HPC_HOST order' : ''}; 0 = no --gres line). Some sites reject 0 (every job must request ≥1 GPU).`),
  mem: z.string().optional().describe('Memory, e.g. 4G / 512M (default: 4G)'),
  time: z.string().optional().describe('Time limit: M, M:S, H:M:S, D-H, D-H:M or D-H:M:S (default: 00:15:00)'),
  cpus_per_task: z.number().optional(),
  output_dir: z.string().optional().describe('Log output dir (default: results/logs, under the workdir if set). Avoid /tmp — it is node-local.'),
  array: z.string().optional().describe('SLURM array spec: "1-10", "1,3,5-7", "1-100%5" (%N = max concurrent tasks). Each task gets $SLURM_ARRAY_TASK_ID.'),
  dependency: z.string().optional().describe('SLURM dependency, e.g. "afterok:12345", "afterany:12345_2", "singleton"'),
  template: z.string().optional().describe('Name of saved template to use as defaults (see template_list); unknown names are an error'),
  preamble: z.boolean().optional().default(true).describe('Include HPC_PREAMBLE (module loads/conda env) in the job script. Set false for generic jobs that do not need the project environment.'),
}, async (rawArgs) => {
  // Defaults — template values override these, user explicit values override template
  const DEFAULTS = { job_name: 'slurm-job', partition: defaultPartition(), gpus: defaultGpus(), mem: '4G', time: '00:15:00', output_dir: 'results/logs' };
  // Apply template, then user values, on top of defaults
  let tmplValues = {};
  let extraPreamble = null;
  if (rawArgs.template) {
    const templates = loadTemplates();
    const tmpl = templates[rawArgs.template];
    // Why: silently falling back to defaults submitted jobs with the wrong
    // partition/resources when a template name was mistyped.
    if (!tmpl) {
      const known = Object.keys(templates);
      return { content: [{ type: 'text', text: `Unknown template "${rawArgs.template}". Known: ${known.length ? known.join(', ') : '(none — use template_save)'}` }], isError: true };
    }
    tmplValues = { ...tmpl };
    // A template's string `preamble` is extra shell lines, not the boolean
    // HPC_PREAMBLE toggle below — keep them apart so neither clobbers the other.
    if (typeof tmplValues.preamble === 'string') extraPreamble = tmplValues.preamble;
    delete tmplValues.preamble;
  }
  const args = { ...DEFAULTS, ...tmplValues, ...Object.fromEntries(Object.entries(rawArgs).filter(([, v]) => v !== undefined)) };
  // Normalize before validating so the validated string is the written one.
  if (typeof args.time === 'string') args.time = args.time.trim();

  const argErrs = validateSubmitArgs(args);
  if (argErrs.length) {
    return { content: [{ type: 'text', text: `Submit rejected (invalid parameters):\n  - ${argErrs.join('\n  - ')}` }], isError: true };
  }
  const timeSec = parseSlurmTime(args.time);

  // Auto-check resource history before submitting
  let resourceInfo = '';
  try {
    const rh = queryResourceHistory(args.job_name);
    const hist = rh.status === 'ok' ? parseResourceHistory(rh.text) : null;
    if (rh.status === 'ok' || rh.status === 'empty') sacctUnavailable.delete(SSH_HOST); // sacct answered → accounting is working (empty history is still an answer)
    if (hist) {
      resourceInfo = formatRecommendation(hist) + checkResourceWaste(args.mem, args.time, hist);
    } else if (rh.status === 'error') {
      resourceInfo = `\n⚠️ resource history unavailable: ${rh.reason}`;
      noteSacctError(SSH_HOST, rh.reason); // accounting-less site → no watch below
    }
  } catch { /* non-fatal */ }

  // --- Workdir guard ---
  const storedWorkdir = loadWorkdir();
  let workdirHint = '';
  let cdLine = '';
  let outputDir = args.output_dir;

  if (storedWorkdir) {
    // Stored by an older version without validation — re-check before it is
    // interpolated into the job script.
    const wdErr = validatePath(storedWorkdir, 'stored workdir') || (/['"\s]/.test(storedWorkdir) ? 'stored workdir contains quotes or whitespace' : null);
    if (wdErr) return { content: [{ type: 'text', text: `Submit rejected: ${wdErr} — reset it with workdir_set` }], isError: true };
    // Check if script contains cd to a different directory
    const cdMatch = args.script.match(/\bcd\s+(\/\S+)/);
    if (cdMatch) {
      const scriptDir = cdMatch[1].replace(/\/+$/, ''); // normalize trailing slash
      const normalizedStored = storedWorkdir.replace(/\/+$/, '');
      if (scriptDir !== normalizedStored && !scriptDir.startsWith(normalizedStored + '/')) {
        return {
          content: [{ type: 'text', text:
            `🚫 工作目录冲突，提交已阻止\n` +
            `  窗口工作目录: ${storedWorkdir}\n` +
            `  脚本 cd 目标: ${scriptDir}\n\n` +
            `如果要切换目录，请先 workdir_set("${scriptDir}")` }],
          isError: true,
        };
      }
    }
    // validated above: no quotes inside. "--": a dir can never be an option;
    // "|| exit 1": never run the job in the wrong directory.
    cdLine = `cd -- '${storedWorkdir}' || exit 1`;
    // Why absolute: sbatch resolves a relative --output against the submit
    // cwd (the ssh login dir, $HOME), not the workdir — the `cd` in the script
    // runs later. mkdir and --output must name the same directory.
    if (!outputDir.startsWith('/')) {
      outputDir = `${storedWorkdir.replace(/\/+$/, '')}/${outputDir}`;
    }
  } else {
    workdirHint = '\n💡 建议先用 workdir_set 设置工作目录，确保实验文件保存在正确位置';
  }
  // The final log dir (stored workdir + output_dir) must not contain "%":
  // a workdir stored by an older version was never checked for it, and
  // sbatch would expand it in --output while mkdir creates the literal path.
  if (outputDir.includes('%')) {
    return { content: [{ type: 'text', text: `Submit rejected: log directory "${outputDir}" contains "%" (sbatch would expand it in --output, but mkdir creates the literal directory) — fix output_dir or reset the workdir with workdir_set` }], isError: true };
  }

  const lines = [
    '#!/bin/bash',
    ...(SLURM_ACCOUNT ? [`#SBATCH --account=${SLURM_ACCOUNT}`] : []),
    `#SBATCH --partition=${args.partition}`,
    `#SBATCH --job-name=${args.job_name}`,
    `#SBATCH --time=${args.time}`,
    `#SBATCH --mem=${args.mem}`,
    // Array tasks share %j-less names otherwise and overwrite each other's log.
    `#SBATCH --output=${outputDir}/${args.array ? 'slurm_%A_%a.out' : 'slurm_%j.out'}`,
  ];
  if (args.gpus != null && args.gpus > 0) lines.push(`#SBATCH --gres=gpu:${args.gpus}`);
  if (args.cpus_per_task) lines.push(`#SBATCH --cpus-per-task=${args.cpus_per_task}`);
  if (args.array) lines.push(`#SBATCH --array=${args.array}`);
  if (args.dependency) lines.push(`#SBATCH --dependency=${args.dependency}`);
  // Preamble is cluster-specific (module names differ across clusters):
  // only inject on the primary cluster, and honor preamble:false opt-out.
  if (HPC_PREAMBLE && args.preamble !== false && SSH_HOST === HPC_HOSTS[0]) {
    lines.push('', ...HPC_PREAMBLE.split('\n'));
  }
  // Template extra preamble: after the site preamble (so it can rely on the
  // loaded modules/env) and before cd, as documented in template_save.
  if (extraPreamble) lines.push('', ...extraPreamble.split('\n'));
  if (cdLine) lines.push(cdLine);
  lines.push('', args.script);
  const sbatch = lines.join('\n');
  // Why a random delimiter: a fixed SLURM_EOF line inside the user's script
  // would terminate the heredoc early and run the rest as login-node shell.
  const eof = `SLURM_EOF_${randomBytes(6).toString('hex')}`;
  if (sbatch.includes(eof)) {
    return { content: [{ type: 'text', text: 'Submit rejected: script/preamble contains the heredoc delimiter' }], isError: true };
  }
  const mkdirTarget = outputDir; // same path as #SBATCH --output (see above)
  // Computed before sbatch so the "other jobs in this partition" count does
  // not include the job we are about to submit.
  let limitHints = '';
  try { limitHints = partitionLimitHints(args, timeSec); } catch { /* hints are best-effort */ }
  try {
    // Values are whitelisted above (no quotes), so single-quoting is safe.
    const out = sshExec(`mkdir -p '${mkdirTarget}' && cat <<'${eof}' | sbatch\n${sbatch}\n${eof}`, 60000);

    // Register SLURM watch for automatic monitoring
    const jobMatch = out.match(/Submitted batch job (\d+)/);
    if (jobMatch) {
      const jobId = jobMatch[1];
      const estSeconds = timeSec;
      // No accounting on this cluster: a watch could never complete.
      if (sacctUnavailableFor(SSH_HOST)) {
        return { content: [{ type: 'text', text: `${out}\n${SACCT_UNAVAILABLE_NOTE} ${jobId}.${limitHints}${resourceInfo}${workdirHint}` }] };
      }
      const watchErr = tryRegisterWatch(jobId, args.job_name, estSeconds, args.partition);
      const estMin = Math.round(estSeconds / 60);
      // No POLL_CMD suggestion: the built-in 30s batched watcher already
      // monitors this job and piggybacks a notification onto the next tool
      // result. Handing the client a 10s `while true; do ssh ...` loop
      // multiplies SSH traffic for nothing (connection-storm lesson, 2026-07-02).
      const arrayNote = args.array ? ` (array ${args.array}: notifies once ALL tasks finish, with an ok/failed tally)` : '';
      const watchNote = watchErr
        ? `\n⚠️ The job IS queued (do not resubmit), but watch registration failed: ${watchErr} — check it with slurm_status ${jobId}.`
        : `\n👁️ Watch registered: job ${jobId}${arrayNote}, est. ${estMin}min — completion auto-notifies on the next tool call (or check slurm_watches). Do NOT poll with ssh loops.`;
      return { content: [{ type: 'text', text: out + watchNote + limitHints + resourceInfo + workdirHint }] };
    }
    return { content: [{ type: 'text', text: out + limitHints + resourceInfo + workdirHint }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Submit failed: ${String(e?.message ?? e)}${gresHint(e)}${limitHints}` }], isError: true };
  }
});

server.tool('slurm_cancel', 'Cancel a SLURM job, a single array task, or a range of array tasks', {
  job_id: z.string().describe('Job ID "12345" (whole job / whole array), hetjob component "12345+1", array task "12345_3", or task range "12345_[1-5]"'),
}, async (args) => {
  try {
    const jid = validateJobId(args.job_id);
    const out = sshExec(`scancel '${jid}' && echo "Job ${jid} cancelled"`);
    // Only a whole-job cancel ends the watch; cancelling some array tasks
    // leaves the rest running and the watch reports them when all finish.
    // Scoped to the active cluster: the same id may exist on another one.
    try { removeWatch(jid, SSH_HOST); } catch (err) { logDebug(`removeWatch(${jid}) failed: ${err.message}`); }
    return { content: [{ type: 'text', text: out }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Cancel failed: ${String(e?.message ?? e)}` }], isError: true };
  }
});

// A StdOut value from sacct/scontrol is a concrete log path only when it has
// no unexpanded %j/%A/%a placeholder and is not one of Slurm's "no file"
// markers ("(null)", "(none)", "/dev/null", "-", "|"); any of those used to
// stop the fallback chain (scontrol → pattern → workdir) early.
const NO_LOG_PATHS = new Set(['|', '-', '(null)', '(none)', '/dev/null']);
function isUsableLogPath(p) {
  const s = String(p ?? '').trim();
  return !!s && !NO_LOG_PATHS.has(s.toLowerCase()) && !s.includes('%');
}

server.tool('slurm_logs', 'Read SLURM job output log. For array jobs pass one task, e.g. "12345_3" (logs are slurm_<jobid>_<task>.out).', {
  job_id: z.string().describe('Job ID "12345", or for an array job one task "12345_3"'),
  lines: z.number().optional().default(50).describe('Number of lines to read (default 50, use 0 for all)'),
}, async (args) => {
  try {
    const jid = validateJobId(args.job_id);
    // Find the log file. sacct StdOut is empty on clusters whose accounting
    // doesn't store it (e.g. SMU SuperPOD, verified 2026-07-02) — fall back
    // to scontrol (recent/running jobs), then to the stored workdir's log dirs.
    // A path is usable only if it is concrete: sacct may return the raw
    // --output pattern with %j/%A/%a placeholders unexpanded.
    const usable = isUsableLogPath;
    const sacctPath = sshExec(`sacct -j '${jid}' --format=StdOut%-200 -P -n | head -1`, 10000).trim();
    let stdoutPath = usable(sacctPath) ? sacctPath : '';
    if (!stdoutPath) {
      try {
        // An array base id prints one record (one StdOut=) per task: use the
        // first; a multi-line value would otherwise trip UNSAFE_PATH ("\n").
        const p = parseScontrolStdOut(sshExec(`scontrol show job -o '${jid}' 2>/dev/null`, 10000))[0] || '';
        if (usable(p)) stdoutPath = p; // scontrol expands the placeholders
      } catch { /* job no longer known to slurmctld */ }
    }
    if (!stdoutPath && sacctPath.includes('%')) {
      stdoutPath = expandLogPattern(sacctPath, jid) || '';
      if (stdoutPath) {
        try {
          stdoutPath = sshExec(`ls '${stdoutPath}' 2>/dev/null | head -1`, 10000).trim();
        } catch { stdoutPath = ''; }
      }
    }
    if (!stdoutPath) {
      const wd = loadWorkdir();
      if (wd && !validatePath(wd, 'workdir') && !/['"\s]/.test(wd)) {
        // Array task "123_4": slurm_submit writes slurm_%A_%a.out, which is
        // exactly slurm_${jid}.out — no separate array candidates needed.
        const names = [`slurm_${jid}.out`, `slurm-${jid}.out`];
        const candidates = names.flatMap(n => [`${wd}/results/logs/${n}`, `${wd}/logs/${n}`, `${wd}/${n}`]);
        try {
          stdoutPath = sshExec(`ls ${candidates.map(c => `'${c}'`).join(' ')} 2>/dev/null | head -1`, 10000).trim();
        } catch { stdoutPath = ''; }
      }
    }
    if (!stdoutPath || stdoutPath === '|') {
      return { content: [{ type: 'text', text: `No log file found for job ${jid}. Notes: this cluster's sacct does not store StdOut and scontrol only knows recent jobs — pass the --output path you used, and avoid /tmp for --output (it is node-local on compute nodes, the file never reaches the login node).` }] };
    }
    if (UNSAFE_PATH.test(stdoutPath)) {
      return { content: [{ type: 'text', text: `Suspicious log path from sacct: ${stdoutPath}` }], isError: true };
    }
    const quoted = `'${stdoutPath.replace(/'/g, "'\\''")}'`;
    const cmd = args.lines === 0 ? `cat ${quoted}` : `tail -n ${args.lines} ${quoted}`;
    const out = sshExec(cmd, 15000);
    return { content: [{ type: 'text', text: out || '(empty log)' }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Log read failed: ${String(e?.message ?? e)}` }], isError: true };
  }
});

// StdOut paths from `scontrol show job -o` (one record per line; an array
// base id prints one record per task). The value runs from "StdOut=" to the
// next " Key=" (a space, then an upper-case key name and "="), or to the end
// of the line — so paths with "=" or spaces survive (the old
// `grep -o 'StdOut=[^ ]*' | cut -d= -f2` cut both). Also works on the
// multi-line format, where each key/value pair is on its own line.
function parseScontrolStdOut(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/(?:^|\s)StdOut=(.*)$/);
    if (!m) continue;
    const next = m[1].search(/ [A-Z][A-Za-z0-9_:/]*=/);
    const v = (next >= 0 ? m[1].slice(0, next) : m[1]).trim();
    if (v) out.push(v);
  }
  return out;
}

// Expand an sbatch --output pattern for a job id we know. Only placeholders
// that are fully determined by the id are handled (%j for a plain job, %A/%a
// for an array task, %%); anything else (%x, %N, %u, …) → null.
function expandLogPattern(pattern, jid) {
  const arr = String(jid).match(/^(\d+)_(\d+)$/);
  const plain = /^\d+$/.test(jid) ? jid : null;
  let failed = false;
  const out = String(pattern).replace(/%(\d*)([%jAa])|%./g, (tok, width, ch) => {
    if (!ch) { failed = true; return tok; }
    if (ch === '%') return '%';
    let v = null;
    if (ch === 'j') v = plain;
    else if (ch === 'A') v = arr ? arr[1] : null;
    else if (ch === 'a') v = arr ? arr[2] : null;
    if (v == null) { failed = true; return tok; }
    return width ? v.padStart(+width, '0') : v;
  });
  if (failed || UNSAFE_PATH.test(out) || /['"]/.test(out)) return null;
  return out;
}

server.tool('slurm_submit_file', 'Submit an existing .slurm/.sh script file on HPC', {
  path: z.string().describe('Absolute path to the .slurm/.sh file on HPC'),
}, async (args) => {
  try {
    // Basic path validation
    if (!args.path.startsWith('/')) {
      return { content: [{ type: 'text', text: 'Path must be absolute' }], isError: true };
    }
    if (UNSAFE_PATH.test(args.path)) {
      return { content: [{ type: 'text', text: 'Path contains unsafe characters' }], isError: true };
    }
    const out = sshExec(`sbatch '${args.path.replace(/'/g, "'\\''")}'`, 60000);

    // Register watch if job submitted
    const jobMatch = out.match(/Submitted batch job (\d+)/);
    if (jobMatch) {
      const jobId = jobMatch[1];
      // The watch label ends up in notifications; keep it to the same
      // [\w.-]{1,64} shape slurm_submit enforces for job_name.
      const baseName = args.path.split('/').pop() || '';
      const jobName = RE_JOB_NAME.test(baseName) ? baseName : (baseName.replace(/[^\w.-]/g, '_').slice(0, 64) || 'script-job');
      if (sacctUnavailableFor(SSH_HOST)) {
        return { content: [{ type: 'text', text: `${out}\n${SACCT_UNAVAILABLE_NOTE} ${jobId}.` }] };
      }
      const watchErr = tryRegisterWatch(jobId, jobName, 3600, defaultPartition());
      const watchNote = watchErr
        ? `\n⚠️ The job IS queued (do not resubmit), but watch registration failed: ${watchErr} — check it with slurm_status ${jobId}.`
        : `\n👁️ Watch registered: job ${jobId}`;
      return { content: [{ type: 'text', text: `${out}${watchNote}` }] };
    }
    return { content: [{ type: 'text', text: out }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Submit failed: ${String(e?.message ?? e)}${gresHint(e)}` }], isError: true };
  }
});

// Only the partition QoS is queried; association limits and the job's own
// QoS can be stricter, so the section says what it covers.
const LIMITS_TITLE = 'Per-user limits (partition QoS only; association/job QoS not queried)';

server.tool('cluster_info', 'Get HPC cluster partitions, queue load, your jobs, and per-user partition limits (MaxTime / MaxJobsPU / MaxTRESPU) — check before choosing a partition for parallel work', {}, async () => {
  try {
    const host = sshExec('hostname', 10000);
    const partitions = sshExec('sinfo -s', 15000);
    const jobs = sshExec(`squeue -u ${shq(SSH_USER)}`, 15000);
    const out = [
      '=== Host ===',
      host || '(unknown)',
      '',
      '=== Partitions ===',
      partitions || '(no output)',
      '',
      '=== Your Jobs ===',
      jobs || '(no output)',
    ].join('\n');

    // Queue wait estimation
    let queueInfo = '';
    try {
      const pending = sshExec(`squeue -t PENDING -h | wc -l`, 10000).trim();
      const running = sshExec(`squeue -t RUNNING -h | wc -l`, 10000).trim();
      queueInfo = `\n=== Queue Estimate ===\nRunning: ${running} jobs\nPending: ${pending} jobs`;
      if (parseInt(pending) > 50) queueInfo += '\n⚠️ High queue load — expect longer wait times';
    } catch { /* non-fatal */ }

    // Per-user caps are what decide whether N submissions run in parallel;
    // sinfo does not show them.
    let limitsInfo = '';
    try {
      const all = loadPartitionLimitsForHost();
      const rows = all.map(p =>
        p.qosUnavailable
        ? `${p.partition}: MaxTime=${p.maxTime ?? 'n/a'} (QoS limits unavailable)`
        : `${p.partition}: MaxTime=${p.maxTime ?? 'n/a'} MaxJobsPU=${p.maxJobsPU ?? 'n/a'}` +
          (p.maxSubmitPU != null ? ` MaxSubmitPU=${p.maxSubmitPU}` : '') +
          ` MaxTRESPU=${p.maxTRESPU || 'none'}` + (p.qos ? ` (QoS ${p.qos})` : ''));
      const qosNote = all.some(p => p.qosUnavailable) ? '\nQoS limits unavailable (sacctmgr query failed); per-user caps are not shown.' : '';
      limitsInfo = `\n\n=== ${LIMITS_TITLE} ===\n${rows.join('\n')}${qosNote}`;
    } catch (err) {
      limitsInfo = `\n\n=== ${LIMITS_TITLE} ===\n(unavailable: ${String(err?.message ?? err).split('\n')[0]})`;
    }

    return { content: [{ type: 'text', text: out + queueInfo + limitsInfo }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${String(e?.message ?? e)}` }], isError: true };
  }
});

server.tool('cluster_switch', 'Switch active HPC cluster (when multiple clusters configured)', {
  host: z.string().optional().describe('Cluster host name to switch to. Omit to list available clusters.'),
}, async (args) => {
  if (!args.host) {
    const list = HPC_HOSTS.map((h, i) => `  ${h === SSH_HOST ? '→' : ' '} ${h}${i === 0 ? ' (default)' : ''}`).join('\n');
    return { content: [{ type: 'text', text: `Available clusters:\n${list}\n\nActive: ${SSH_HOST}` }] };
  }
  if (!HPC_HOSTS.includes(args.host)) {
    return { content: [{ type: 'text', text: `Unknown cluster: ${args.host}. Available: ${HPC_HOSTS.join(', ')}` }], isError: true };
  }
  const prevHost = SSH_HOST;
  const switched = switchCluster(args.host);
  let warning = '';
  try {
    // Why: this referenced an undefined WATCH_FILE and treated the watch array
    // as an object, so the warning never fired. Watches carry `host` (absent on
    // pre-multi-cluster entries → first host) and are removed when finished.
    const activeCount = loadWatches()
      .filter(w => w.tty === windowTty && (w.host || HPC_HOSTS[0]) === prevHost).length;
    if (activeCount > 0) {
      warning = `\n⚠️ ${activeCount} active job watch(es) from ${prevHost} — they will continue polling the previous cluster.`;
    }
  } catch { /* no watches */ }
  return { content: [{ type: 'text', text: `Switched to cluster: ${switched}${warning}` }] };
});

// sacct rows "JobID|JobName|Partition|Elapsed|MaxRSS|ReqMem|ReqTRES|State"
// → totals. Jobs are counted on their allocation row; peak memory is the max
// MaxRSS over ALL rows of a job, because MaxRSS is only filled on the step
// rows (.batch/.extern) — skipping steps made the peak always 0.
function summarizeResourceReport(raw) {
  const jobs = new Map();
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('|').map(x => x.trim());
    const id = parts[0] || '';
    const key = id.split('.')[0];
    if (!key) continue;
    if (!jobs.has(key)) jobs.set(key, { main: null, rssMB: 0 });
    const j = jobs.get(key);
    if (!id.includes('.')) j.main = parts;
    const rss = parseMemToMB(parts[4]);
    if (rss != null) j.rssMB = Math.max(j.rssMB, rss);
  }
  let totalJobs = 0, completed = 0, failed = 0, totalTimeSec = 0, maxMB = 0, gpuJobs = 0;
  for (const j of jobs.values()) {
    if (!j.main) continue; // steps without their allocation row (outside the window)
    const parts = j.main;
    const state = baseState(parts[7]);
    totalJobs++;
    if (state === 'COMPLETED') completed++;
    if (state === 'FAILED' || state === 'TIMEOUT' || state === 'OUT_OF_MEMORY') failed++;
    totalTimeSec += parseElapsed(parts[3] || '');
    maxMB = Math.max(maxMB, j.rssMB);
    if ((parts[6] || '').includes('gpu')) gpuJobs++;
  }
  return { totalJobs, completed, failed, totalTimeSec, maxMemGB: maxMB / 1024, gpuJobs };
}

server.tool('resource_report', 'Summarize resource usage over a time period', {
  days: z.number().min(0).max(3650).optional().default(7).describe('Number of days to look back (default 7)'),
  format: z.enum(['text', 'csv']).optional().default('text'),
}, async (args) => {
  try {
    const raw = sshExec(
      `sacct -u ${shq(SSH_USER)} --format=JobID%-20,JobName%-30,Partition,Elapsed,MaxRSS,ReqMem,ReqTRES,State -P -S ${sacctSinceDate(args.days)} -n`,
      20000
    );
    if (!raw) return { content: [{ type: 'text', text: 'No jobs found in the specified period.' }] };

    const lines = raw.split('\n').filter(l => l.trim());
    const s = summarizeResourceReport(raw);
    const { totalJobs, completed, failed, totalTimeSec, maxMemGB, gpuJobs } = s;

    const totalH = (totalTimeSec / 3600).toFixed(1);

    if (args.format === 'csv') {
      return { content: [{ type: 'text', text: raw }] };
    }

    const report = [
      `📊 Resource Report (last ${args.days} days)`,
      ``,
      `Jobs: ${totalJobs} total, ${completed} completed, ${failed} failed`,
      `Total compute time: ${totalH} hours`,
      `GPU jobs: ${gpuJobs}`,
      `Peak memory: ${maxMemGB.toFixed(1)} GB`,
      ``,
      `Recent jobs:`,
      raw.split('\n').slice(0, 20).join('\n'),
      lines.length > 20 ? `... (${lines.length - 20} more)` : '',
    ].join('\n');

    return { content: [{ type: 'text', text: report }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Report failed: ${String(e?.message ?? e)}` }], isError: true };
  }
});

// --- File Sync ---
// (UNSAFE_PATH / validatePath are defined at the top: env validation uses them.)

// rsync is spawned without a shell, so "~/x" would be a literal directory
// named "~" under the server's cwd. Expand "~" and "~/..." here; "~user"
// forms are left as-is (rejected as not absolute).
function expandLocalHome(p) {
  if (p === '~') return homedir();
  // Not path.join: it would drop a trailing "/", which changes rsync semantics.
  if (p.startsWith('~/')) return `${homedir().replace(/\/+$/, '')}/${p.slice(2)}`;
  return p;
}

// -s (--protect-args): the remote path is sent to the remote rsync without
// being word-split or glob-expanded by the remote shell. openrsync (the macOS
// default /usr/bin/rsync since 15.x) rejects -s, so support is probed once
// locally (`rsync -s --version`, no network); without it remote_path's
// whitelist (no whitespace, no shell metacharacters) is the only guard.
let rsyncProtectArgs = null;
function rsyncSupportsProtectArgs() {
  if (rsyncProtectArgs == null) {
    const r = spawnSync('rsync', ['-s', '--version'], { timeout: 3000, stdio: ['ignore', 'ignore', 'ignore'] });
    rsyncProtectArgs = r.status === 0;
    if (!rsyncProtectArgs) logDebug('local rsync has no -s (protect-args), e.g. openrsync; relying on the remote_path whitelist');
  }
  return rsyncProtectArgs;
}

server.tool('sync_files', 'Sync files between local and HPC via rsync', {
  direction: z.enum(['upload', 'download']),
  local_path: z.string().describe('Local absolute path'),
  remote_path: z.string().describe('Remote path on HPC (use ~ for home)'),
  delete: z.boolean().optional().default(false),
}, async (args) => {
  const localErr = validatePath(args.local_path, 'local_path');
  if (localErr) return { content: [{ type: 'text', text: localErr }], isError: true };
  // Whitespace is rejected in remote_path (like the other UNSAFE_PATH
  // characters): without protect-args (-s) the remote shell splits it, and
  // openrsync (macOS default) has no -s.
  // Why the allowlist (beyond UNSAFE_PATH): without protect-args the remote
  // shell expands quotes and globs in the path — `/data/""` becomes /data/ and
  // `--delete` would then prune the wrong directory (final-review finding).
  const remoteErr = validatePath(args.remote_path, 'remote_path')
    || (/\s/.test(args.remote_path) ? 'remote_path contains whitespace' : null)
    || (!RE_REMOTE_PATH.test(args.remote_path) ? 'remote_path may only contain letters, digits, and . / _ - + @ : , = ~ (no quotes, spaces or glob characters)' : null);
  if (remoteErr) return { content: [{ type: 'text', text: remoteErr }], isError: true };
  const localPath = expandLocalHome(args.local_path);
  if (!localPath.startsWith('/')) {
    return { content: [{ type: 'text', text: 'local_path must be an absolute path (a leading ~/ is expanded to your home)' }], isError: true };
  }
  // Same guard as sshExec: rsync spawns ssh underneath — with a dead master
  // it would burn a doomed (Duo-required) auth attempt against the bastion.
  const mode = probeMaster(SSH_HOST).state;
  if (mode === 'dead') {
    return { content: [{ type: 'text', text: `SSH master connection to ${SSH_HOST} is dead. Run \`ssh ${SSH_HOST}\` interactively in a terminal once (needs Duo), then retry.` }], isError: true };
  }
  // Same ssh options for the rsync spawns as sshExec (BatchMode, and
  // ProxyCommand=false in ControlMaster mode); refused locally when the
  // ControlPath cannot be pinned (see sshOptsFor).
  let baseArgs;
  try { baseArgs = sshBaseArgs(mode, SSH_HOST); } catch (e) {
    return { content: [{ type: 'text', text: `Sync failed: ${String(e?.message ?? e)}` }], isError: true };
  }
  const rsyncArgs = ['-avz', '--partial', ...(rsyncSupportsProtectArgs() ? ['-s'] : []), '-e', rsyncSshCommand(baseArgs)];
  if (args.delete) rsyncArgs.push('--delete');
  // "--" ends option parsing: a path can never be read as an rsync option.
  if (args.direction === 'upload') {
    rsyncArgs.push('--', localPath, `${SSH_HOST}:${args.remote_path}`);
  } else {
    rsyncArgs.push('--', `${SSH_HOST}:${args.remote_path}`, localPath);
  }
  try {
    const out = withBusyHeartbeat(300000, () => execFileSync('rsync', rsyncArgs, {
      timeout: 300000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 5 * 1024 * 1024,
    }).trim());
    return { content: [{ type: 'text', text: out }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Sync failed: ${String(e?.message ?? e)}` }], isError: true };
  }
});

// --- tmux ---

// Session name sanitizer: only allow alphanumeric, dash, underscore
const SAFE_SESSION = /^[a-zA-Z0-9_-]+$/;
function validateSession(s) {
  if (!SAFE_SESSION.test(s)) throw new Error(`Invalid session name: ${s} (only a-z, 0-9, _, - allowed)`);
  return s;
}

// tmux key names that terminal_send forwards as keys (not literal text).
// "Ctrl-C" style is accepted as an alias of tmux's "C-c".
const TMUX_KEY_RE = /^(Enter|Tab|BTab|Escape|Space|BSpace|Up|Down|Left|Right|Home|End|PageUp|PageDown|PPage|NPage|Insert|IC|Delete|DC|F([1-9]|1[0-2])|[CMS]-.)$/;
function tmuxKeyName(keys) {
  const alias = String(keys).match(/^Ctrl-(.)$/i);
  if (alias) return `C-${alias[1].toLowerCase()}`;
  return TMUX_KEY_RE.test(keys) ? keys : null;
}

// Arguments for `tmux send-keys` into session `s`. Text is sent with
// `-l --`: literal (no key-name lookup, so "Enter" inside a command is typed,
// not pressed) and never parsed as a send-keys option even when it starts
// with "-" (tmux ≥ 1.x accepts "--"; verified on tmux 3.7c).
function sendKeysArgs(s, text, { key = false } = {}) {
  return key ? ['send-keys', '-t', s, '--', text] : ['send-keys', '-t', s, '-l', '--', text];
}

function tmuxExec(tmuxArgs, timeout = 5000) {
  return execFileSync('tmux', tmuxArgs, {
    timeout, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 5 * 1024 * 1024,
  }).trim();
}

server.tool('terminal_start', 'Start a tmux session', {
  session: z.string().optional().default('hpc'),
  command: z.string().optional().describe('Initial command (e.g. "ssh hpc-host")'),
}, async (args) => {
  try {
    const s = validateSession(args.session);
    try { tmuxExec(['kill-session', '-t', s], 3000); } catch { /* ignore */ }
    if (args.command) {
      tmuxExec(['new-session', '-d', '-s', s, args.command]);
    } else {
      tmuxExec(['new-session', '-d', '-s', s]);
    }
    return { content: [{ type: 'text', text: `tmux session "${s}" started` }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${String(e?.message ?? e)}` }], isError: true };
  }
});

server.tool('terminal_read', 'Read tmux terminal content', {
  session: z.string().optional().default('hpc'),
}, async (args) => {
  try {
    const s = validateSession(args.session);
    const out = tmuxExec(['capture-pane', '-t', s, '-p', '-S', '-100']);
    return { content: [{ type: 'text', text: out || '(empty)' }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${String(e?.message ?? e)}` }], isError: true };
  }
});

server.tool('terminal_send', 'Send keys to tmux session. No heredoc or multi-line scripts.', {
  session: z.string().optional().default('hpc'),
  keys: z.string().describe('Text (typed literally) or one special key: Enter, Tab, Escape, C-c / Ctrl-C, Up, ... No heredoc (<<), no multi-line code.'),
}, async (args) => {
  if (HEREDOC_RE.test(args.keys)) {
    return { content: [{ type: 'text', text: 'BLOCKED: heredoc not allowed via terminal_send. Write local file → sync_files upload.' }], isError: true };
  }
  if (args.keys.length > 500) {
    return { content: [{ type: 'text', text: `BLOCKED: content length ${args.keys.length} exceeds limit. Write local file → sync_files upload.` }], isError: true };
  }
  try {
    const s = validateSession(args.session);
    const key = tmuxKeyName(args.keys);
    tmuxExec(key ? sendKeysArgs(s, key, { key: true }) : sendKeysArgs(s, args.keys));
    await new Promise(r => setTimeout(r, 200));
    const out = tmuxExec(['capture-pane', '-t', s, '-p', '-S', '-100']);
    return { content: [{ type: 'text', text: out || '(empty)' }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${String(e?.message ?? e)}` }], isError: true };
  }
});

server.tool('terminal_exec', 'Run an INTERACTIVE command in tmux and return output. Only for interactive/monitoring use (top, watch, conda activate). For batch commands, use ssh_exec instead.', {
  session: z.string().optional().default('hpc'),
  command: z.string().describe('Shell command to run'),
  wait: z.number().optional().default(1000).describe('Ms to wait for output (default 1000, max 30000)'),
}, async (args) => {
  try {
    const s = validateSession(args.session);
    tmuxExec(sendKeysArgs(s, args.command));
    tmuxExec(sendKeysArgs(s, 'Enter', { key: true }));
    const wait = Math.min(args.wait ?? 1000, 30000); // cap at 30s
    await new Promise(r => setTimeout(r, wait));
    const out = tmuxExec(['capture-pane', '-t', s, '-p', '-S', '-100']);
    return { content: [{ type: 'text', text: out || '(empty)' }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${String(e?.message ?? e)}` }], isError: true };
  }
});

server.tool('terminal_stop', 'Kill a tmux session', {
  session: z.string().optional().default('hpc'),
}, async (args) => {
  try {
    const s = validateSession(args.session);
    tmuxExec(['kill-session', '-t', s]);
    return { content: [{ type: 'text', text: `Session "${s}" stopped` }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${String(e?.message ?? e)}` }], isError: true };
  }
});

server.tool('ssh_interactive', 'Start an interactive SSH session to HPC via tmux (for commands needing confirmation, 2FA, etc.)', {
  command: z.string().optional().describe('Command to run after connecting (optional)'),
  session: z.string().optional().default('hpc-interactive'),
}, async (args) => {
  try {
    const s = validateSession(args.session);
    // Kill existing session if any
    try { tmuxExec(['kill-session', '-t', s], 3000); } catch { /* ignore */ }

    // Start tmux with SSH
    // SSH_HOST is from env var; validate to prevent injection if ever tainted
    // "@" is kept: HPC_HOST may be "user@host". A leading "-" is stripped (it
    // is rejected at startup anyway) so it can never become an ssh option.
    const safeHost = SSH_HOST.replace(/[^a-zA-Z0-9._@-]/g, '').replace(/^-+/, '');
    tmuxExec(['new-session', '-d', '-s', s, `ssh ${safeHost}`]);

    // Wait for SSH to connect
    await new Promise(r => setTimeout(r, 2000));

    // Run command if provided
    if (args.command) {
      await new Promise(r => setTimeout(r, 1000));
      tmuxExec(sendKeysArgs(s, args.command));
      tmuxExec(sendKeysArgs(s, 'Enter', { key: true }));
      await new Promise(r => setTimeout(r, 1500));
    }

    const out = tmuxExec(['capture-pane', '-t', s, '-p', '-S', '-30']);
    return { content: [{ type: 'text', text: `Interactive session "${s}" started on ${SSH_HOST}.\nUse terminal_read/terminal_send to interact.\n\n--- Current output ---\n${out}` }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${String(e?.message ?? e)}` }], isError: true };
  }
});

// --- HPC Guide (resource) ---

server.tool('guide', 'Read the HPC guide (experiment workflow, data, SLURM templates, plus the site-specific guide if HPC_GUIDE_EXTRA is set)', {}, async () => {
  try {
    const guidePath = join(__dirname, 'docs', 'GUIDE.md');
    let guide = readFileSync(guidePath, 'utf-8');
    // Site-specific rules (accounts, partition policy, conda envs) live outside
    // this public repo; HPC_GUIDE_EXTRA points at such a file. Read errors are
    // ignored so a missing file never breaks the generic guide.
    if (process.env.HPC_GUIDE_EXTRA) {
      try { guide += `\n\n---\n# Site-specific guide\n${readFileSync(process.env.HPC_GUIDE_EXTRA, 'utf-8')}`; }
      catch (err) { logDebug(`HPC_GUIDE_EXTRA unreadable: ${err.message}`); }
    }
    const watches = loadWatches();
    const myNotifs = loadNotifications().filter(n => n.tty === windowTty);
    const watchSection = `\n\n---\n${formatWatchStatus(watches)}\n` +
      `Pending notifications: ${myNotifs.length}`;
    return { content: [{ type: 'text', text: guide + watchSection }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Cannot read guide: ${String(e?.message ?? e)}` }], isError: true };
  }
});

server.tool('slurm_watches', 'List active SLURM job watches and pending notifications', {}, async () => {
  try {
    const watches = loadWatches();
    const myWatches = watches.filter(w => w.tty === windowTty);
    const otherWatches = watches.filter(w => w.tty !== windowTty);
    const parts = [];

    // Header with tty
    parts.push(`Active SLURM Watches (tty=${windowTty}):`);

    if (myWatches.length) {
      const now = Date.now();
      for (const w of myWatches) parts.push(formatWatchLine(w, now));
    } else {
      parts.push('  (no watches for this window)');
    }

    if (otherWatches.length) {
      parts.push(`\nOther windows: ${otherWatches.length} watch(es)`);
    }

    // Clusters whose sacct reports no accounting: their watches cannot complete.
    for (const h of HPC_HOSTS) {
      const st = sacctUnavailableFor(h);
      if (st) parts.push(`\n${SACCT_UNAVAILABLE_NOTE} (${h}: ${st.reason})`);
    }

    // Polling diagnostics
    parts.push('');
    if (lastPollTime) {
      const ago = Math.round((Date.now() - new Date(lastPollTime).getTime()) / 1000);
      parts.push(`Last poll: ${lastPollTime} (${ago}s ago, #${pollCount})`);
    } else {
      parts.push('Last poll: (not yet polled)');
    }
    parts.push(`Last poll error: ${lastPollError || '(none)'}`);

    // Notifications from disk (not memory — eliminates drain race).
    // Show ALL ttys' pending notifications: a job submitted from a closed
    // session must still be discoverable here.
    const allNotifs = loadNotifications();
    if (allNotifs.length) {
      parts.push(`\nPending notifications (${allNotifs.length}):`);
      parts.push(allNotifs.map(n => `  ${n.message}${n.tty === windowTty ? '' : ` [session ${n.tty}]`}`).join('\n'));
    } else {
      parts.push('\nNo pending notifications.');
    }

    return { content: [{ type: 'text', text: parts.join('\n') }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Error reading watches: ${String(e?.message ?? e)}` }], isError: true };
  }
});

// SLURM_MCP_NO_START=1: import for unit tests without starting the poller,
// the stdin lifecycle hooks or the stdio transport (pure helpers only).
if (process.env.SLURM_MCP_NO_START !== '1') {
  // Liveness heartbeat on its own timer (independent of poll backoff), then
  // the watch polling loop.
  startHeartbeat();
  startWatchPolling();

  // Lifecycle: a stdio MCP server must die with its client. Without these, the
  // setTimeout polling chain keeps the event loop alive forever after the
  // Claude session exits (2026-07-02: 28 zombie servers from 3 weeks found).
  function shutdown() {
    // Remove our heartbeat so other pollers can adopt our watches immediately.
    removeOwnHeartbeat();
    process.exit(0);
  }
  process.stdin.on('end', () => { logDebug('stdin closed, exiting.'); shutdown(); });
  process.stdin.on('close', () => { logDebug('stdin closed, exiting.'); shutdown(); });
  process.stdin.on('error', () => shutdown());

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export {
  RE_REMOTE_PATH,
  parseSacctJobId, countTasksInKey, summarizeJobRows, baseState, isTerminalState, TERMINAL_STATES,
  parseSlurmTime, parseElapsed, parseResourceHistory, formatRecommendation, checkResourceWaste,
  memToMB, parseTres, validateSubmitArgs, RE_JOB_NAME, RE_PARTITION, RE_MEM, RE_ARRAY, RE_DEPENDENCY,
  VALID_JOB_ID, validateJobId, validatePath, validateSession, UNSAFE_PATH,
  guardCommand, BLOCKED_PATTERNS, MAX_CMD_LENGTH, compressOutput,
  atomicWriteJson, readJsonOrQuarantine, withFileLock, reclaimStaleLock,
  aggregateSacctRows, isWatchExpired, isValidWatch, parseMemToMB, summarizeResourceReport,
  expandLogPattern, safePoll, pollState,
  sshBaseArgs, sshOptsFor, parseControlPath, pollerAlive, withBusyHeartbeat, loadNotifications, NOTIF_FILE, partitionNotifications,
  mergePolledWatch, formatWatchLine, parseScontrolStdOut, expandLocalHome,
  RE_HOST, RE_USER, RE_ENV_TOKEN, shq, sacctSinceDate, isLockStale, readLockOwner,
  writeHeartbeat, removeOwnHeartbeat, HEARTBEAT_DIR, tmuxKeyName, sendKeysArgs, gresHint,
  noteHostFailure, noteHostSuccess, hostPollDue, currentPollDelay,
  controlPathProblem, controlPathUnresolvedMessage, normalizeWatchTimes, loadWatches, WATCHES_FILE,
  noteSacctError, sacctUnavailableFor, SACCT_UNAVAILABLE_NOTE, hostConfigured,
  rsyncSshCommand, isUsableLogPath, describeExecError, SACCT_MAX_BUFFER, parseDefaultGpus, pickPerCluster,
  parsePartitionLines, LOCK_OWNER_FILE,
};
