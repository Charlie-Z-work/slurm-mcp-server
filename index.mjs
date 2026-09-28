#!/usr/bin/env node
/**
 * SLURM MCP Server — Direct SSH/SLURM/tmux for Claude Code CLI
 * Zero-dependency, single-file, TTY-aware job watching with desktop notifications.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execSync, execFileSync, execFile as execFileCb } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, renameSync, rmdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { randomBytes } from 'crypto';
import { homedir } from 'os';
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

// --- Optional env vars ---
const HPC_PREAMBLE = process.env.HPC_PREAMBLE || null;
const NOTIFY_WEBHOOK = process.env.NOTIFY_WEBHOOK || null; // Slack/Discord webhook URL

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

function loadWorkdir() {
  try {
    const data = JSON.parse(readFileSync(getWorkdirPath(), 'utf-8'));
    return data.workdir || null;
  } catch { return null; }
}

function saveWorkdir(path) {
  atomicWriteJson(getWorkdirPath(), {
    tty: windowTty,
    workdir: path,
    setAt: new Date().toISOString(),
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
  renameSync(tmp, path);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Why: atomic writes alone still lose updates when two processes do
// read-modify-write concurrently (e.g. poller removes a finished watch while
// another window registers a new one). mkdir is atomic, so a lock directory is
// a portable cross-process mutex. Fail-open after ~2s: a stuck lock must never
// block job submission or notifications — worst case is the old racy behavior.
function withFileLock(path, fn) {
  const lockDir = `${path}.lock`;
  const deadline = Date.now() + 2000;
  let locked = false;
  try { mkdirSync(dirname(path), { recursive: true }); } catch { /* surfaces below */ }
  for (;;) {
    try { mkdirSync(lockDir); locked = true; break; } catch (err) {
      if (err.code !== 'EEXIST') { logDebug(`withFileLock(${path}): ${err.message}`); break; }
      // Stale lock left by a crashed holder (critical sections take ms) — reclaim.
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > 10_000) { rmdirSync(lockDir); continue; }
      } catch { /* raced with the holder releasing it — just retry */ }
      if (Date.now() > deadline) break;
      sleepSync(25);
    }
  }
  if (!locked) logDebug(`withFileLock(${path}): lock not acquired within 2s, proceeding unlocked (fail-open)`);
  try { return fn(); } finally {
    if (locked) { try { rmdirSync(lockDir); } catch { /* already gone */ } }
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

function loadNotifications() {
  return readJsonOrQuarantine(NOTIF_FILE, [], Array.isArray);
}

// Callers doing read-modify-write must hold withFileLock(NOTIF_FILE).
function saveNotifications(notifs) {
  try {
    atomicWriteJson(NOTIF_FILE, notifs);
  } catch (err) {
    logDebug(`saveNotifications failed: ${err.message}`);
  }
}

function loadWatches() {
  const data = readJsonOrQuarantine(WATCHES_FILE, [], Array.isArray);
  const now = Date.now();
  // TTL honors the job's own time limit: a flat 48h silently dropped watches
  // for jobs at the 2-day partition limit that queued before starting.
  return data.filter(w => {
    const ttlMs = Math.max(48 * 3600, (w.estimatedSeconds || 0) + 24 * 3600) * 1000;
    return now - new Date(w.submittedAt).getTime() < ttlMs;
  });
}

// --- Poller heartbeat: lets other servers detect dead sessions and adopt
// their orphaned watches (a watch is only ever polled by its owning tty's
// server — without adoption, jobs outliving their session never notify). ---
const HEARTBEAT_DIR = join(homedir(), '.claude', 'hpc-pollers');

function writeHeartbeat() {
  try {
    mkdirSync(HEARTBEAT_DIR, { recursive: true });
    writeFileSync(join(HEARTBEAT_DIR, `${windowTty}.json`),
      JSON.stringify({ pid: process.pid, at: Date.now() }));
  } catch (err) { logDebug(`writeHeartbeat failed: ${err.message}`); }
}

function pollerAlive(tty) {
  try {
    const hb = JSON.parse(readFileSync(join(HEARTBEAT_DIR, `${tty}.json`), 'utf-8'));
    if (Date.now() - hb.at > 150_000) return false; // 5 poll cycles stale
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

function removeWatch(jobId) {
  withFileLock(WATCHES_FILE, () => {
    saveWatches(loadWatches().filter(w => w.jobId !== jobId));
  });
}

function parseTimeToSeconds(timeStr) {
  const dayMatch = timeStr.match(/^(\d+)-(\d+):(\d+):(\d+)$/);
  if (dayMatch) {
    return parseInt(dayMatch[1]) * 86400 + parseInt(dayMatch[2]) * 3600 +
           parseInt(dayMatch[3]) * 60 + parseInt(dayMatch[4]);
  }
  const parts = timeStr.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 900;
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

function checkJobState(jobId) {
  try {
    const out = sshExec(`sacct -j ${jobId} --format=State -P -n | head -1`, 15000);
    return out.split('\n')[0]?.trim() || 'UNKNOWN';
  } catch (err) {
    logDebug(`checkJobState(${jobId}) sync failed: ${err.message}`);
    return 'UNKNOWN';
  }
}

// Async version for polling (non-blocking)
async function checkJobStateAsync(jobId) {
  try {
    const escaped = `sacct -j ${jobId} --format=State -P -n | head -1`.replace(/'/g, "'\"'\"'");
    const { stdout } = await execFileAsync('ssh', [...sshBaseArgs(), SSH_HOST, `bash --login -c '${escaped}'`], {
      timeout: 15000, encoding: 'utf8',
    });
    return stdout.split('\n')[0]?.trim() || 'UNKNOWN';
  } catch (err) {
    logDebug(`checkJobStateAsync(${jobId}) failed: ${err.message}`);
    return 'UNKNOWN';
  }
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
function parseSacctJobId(rawId) {
  const noStep = String(rawId).split('.')[0];
  const m = noStep.match(/^(\d+)(?:_(\d+|\[[^\]]*\]))?$/);
  if (!m) return null;
  return { baseId: m[1], taskKey: m[2] ?? null };
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
  const isArray = [...taskStates.keys()].some(k => k !== null);
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
  return { isArray, allDone, ok, failed, failedKinds, running, states };
}

const MAX_PENDING = 50;

function markCompleted(watch, state, summary = null) {
  const emoji = baseState(state) === 'COMPLETED' ? '✅' : '❌';
  const msg = summary
    ? `${emoji} SLURM array job ${watch.jobId} (${watch.jobName}) finished: ${summary}`
    : `${emoji} SLURM job ${watch.jobId} (${watch.jobName}) ${state}`;

  logDebug(`Job ${watch.jobId} (${watch.jobName}) → ${state}`);

  // Persist to disk (survives process restart, no memory-only state)
  withFileLock(NOTIF_FILE, () => {
    const notifs = loadNotifications();
    if (notifs.length >= MAX_PENDING) notifs.shift();
    notifs.push({
      jobId: watch.jobId,
      jobName: watch.jobName,
      state,
      message: msg,
      completedAt: new Date().toISOString(),
      tty: watch.tty,
    });
    saveNotifications(notifs);
  });

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

  // MCP logging notification — attempt to push into Claude Code conversation
  try {
    if (server?.server?.sendLoggingMessage) {
      server.server.sendLoggingMessage({
        level: 'warning',
        logger: 'slurm-watch',
        data: msg,
      });
      logDebug(`MCP logging notification sent: ${msg}`);
    } else {
      logDebug('MCP sendLoggingMessage not available');
    }
  } catch (err) {
    logDebug(`MCP logging notification failed: ${err.message}`);
  }
}

function drainNotifications() {
  // Drain own notifications, plus orphans whose owning session is dead —
  // otherwise a notification for a closed session stays invisible forever.
  const claimable = (n) => n.tty === windowTty || !pollerAlive(n.tty);
  const mine = withFileLock(NOTIF_FILE, () => {
    const allNotifs = loadNotifications();
    const taken = allNotifs.filter(claimable);
    if (taken.length) saveNotifications(allNotifs.filter(n => !claimable(n)));
    return taken;
  });
  if (!mine.length) return '';
  const msgs = mine.map(n => n.tty === windowTty ? n.message : `${n.message} (from closed session ${n.tty})`).join('\n');
  return `\n--- SLURM Notifications ---\n${msgs}\n---\n\n`;
}

function formatWatchStatus(watches) {
  if (!watches.length) return 'No active SLURM watches.';
  const now = Date.now();
  const lines = watches.map(w => {
    const elapsed = (now - new Date(w.submittedAt).getTime()) / 1000;
    const ratio = w.estimatedSeconds > 0 ? elapsed / w.estimatedSeconds : 0;
    const pct = Math.min(Math.round(ratio * 100), 999);
    const elapsedMin = Math.round(elapsed / 60);
    const estMin = Math.round(w.estimatedSeconds / 60);
    const prog = w.progress ? ` tasks done ${w.progress}` : '';
    return `  ${w.jobId} (${w.jobName}) [${w.state}${prog}] — ${elapsedMin}min elapsed, est. ${estMin}min, ~${pct}%`;
  });
  return `Active SLURM Watches:\n${lines.join('\n')}`;
}

// Polling loop — async, non-blocking, per-tty filtering
const POLL_INTERVAL = 30_000;
const POLL_BACKOFF_MAX = 600_000; // 10 min cap under sustained failure
let consecutivePollFailures = 0;

function currentPollDelay() {
  return Math.min(POLL_INTERVAL * 2 ** consecutivePollFailures, POLL_BACKOFF_MAX);
}

// Local-only liveness probe of the shared ControlMaster socket (no network,
// no auth attempt). Chained MFA (publickey+Duo) means a background process
// can NEVER re-authenticate — dead master ⇒ pause, tell the human.
function masterAlive(host) {
  try {
    execSync(`ssh -O check ${host}`, { timeout: 3000, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function startWatchPolling() {
  async function poll() {
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

    // Announce liveness before any early return — adoption below relies on it.
    writeHeartbeat();

    // Adopt orphaned watches: their owning session is gone, so nobody polls
    // them and their jobs would complete silently. Rewriting tty hands them
    // to this poller (from next cycle). 90s grace avoids racing a server that
    // registered a watch before its first heartbeat.
    const isOrphan = (w) => w.tty !== windowTty && !pollerAlive(w.tty) &&
      Date.now() - new Date(w.submittedAt).getTime() > 90_000;
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

    const completedIds = new Set();
    let stateChanged = false;

    // Group by cluster; one batched sacct per host. Never generate network
    // traffic toward a host without a live master: each doomed reconnect is
    // a failed auth that feeds the bastion's fail2ban.
    const byHost = new Map();
    for (const w of myWatches) {
      const h = w.host || SSH_HOST;
      if (!byHost.has(h)) byHost.set(h, []);
      byHost.get(h).push(w);
    }

    const stateMap = new Map(); // key: `${host}|${baseJobId}` → Map(taskKey → state)
    let anyHostFailed = false;
    for (const [host, hostWatches] of byHost) {
      if (!masterAlive(host)) {
        anyHostFailed = true;
        lastPollError = `SSH master to ${host} is dead — its watches paused (backoff ${Math.round(currentPollDelay() / 1000)}s). Reconnect interactively: run \`ssh ${host}\` in a terminal (needs Duo).`;
        logDebug(lastPollError);
        continue;
      }
      const jobIds = hostWatches.map(w => w.jobId).join(',');
      try {
        const escaped = `sacct -j ${jobIds} --format=JobID%-20,State -P -n`.replace(/'/g, "'\"'\"'");
        const { stdout } = await execFileAsync('ssh', [...sshBaseArgs(), host, `bash --login -c '${escaped}'`], {
          timeout: 15000, encoding: 'utf8',
        });
        for (const line of stdout.split('\n')) {
          const [rawId, state] = line.split('|').map(s => s?.trim());
          if (!rawId || !state) continue;
          // Normalize "12345.batch" / "12345_7" / "12345_[8-10]" to the base id
          // and collect every array task's state under it. The allocation row
          // precedes its .batch/.extern steps, so first-seen per task wins.
          const parsed = parseSacctJobId(rawId);
          if (!parsed) continue;
          const key = `${host}|${parsed.baseId}`;
          if (!stateMap.has(key)) stateMap.set(key, new Map());
          const tasks = stateMap.get(key);
          if (!tasks.has(parsed.taskKey)) tasks.set(parsed.taskKey, state);
        }
      } catch (err) {
        anyHostFailed = true;
        lastPollError = `batch sacct (${host}): ${String(err?.message ?? err)} (backoff ${Math.round(currentPollDelay() / 1000)}s)`;
        logDebug(`Batch poll failed for ${host}: ${String(err?.message ?? err)}`);
      }
    }
    if (anyHostFailed) consecutivePollFailures++; else consecutivePollFailures = 0;

    for (const w of myWatches) {
      const tasks = stateMap.get(`${w.host || SSH_HOST}|${w.jobId}`);
      if (!tasks || !tasks.size) continue; // UNKNOWN: host failed or sacct lag
      const sum = summarizeJobRows(tasks);
      if (sum.allDone) {
        if (sum.isArray) {
          const kinds = [...sum.failedKinds].map(([k, n]) => `${k}×${n}`).join(', ');
          const summary = `${sum.ok} ok / ${sum.failed} failed${kinds ? ` (${kinds})` : ''}`;
          markCompleted(w, sum.failed ? 'FAILED' : 'COMPLETED', summary);
        } else {
          markCompleted(w, sum.states[0]);
        }
        completedIds.add(w.jobId);
        continue;
      }
      // Still active: RUNNING if any task runs, else the (single) pending state.
      const newState = sum.isArray
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

    if (completedIds.size || stateChanged) {
      // Re-read from disk (under lock) to avoid overwriting watches added
      // during the async poll by this or another window's server.
      withFileLock(WATCHES_FILE, () => {
        const updated = loadWatches()
          .filter(w => !completedIds.has(w.jobId))
          .map(w => {
            // Apply state updates from this poll cycle
            const polled = myWatches.find(m => m.jobId === w.jobId);
            return polled || w;
          });
        saveWatches(updated);
      });
    }
  }
  // setTimeout chain: wait for poll to finish before scheduling next.
  // Delay is dynamic: exponential backoff under sustained failure.
  (function scheduleNext() {
    setTimeout(async () => { await poll(); scheduleNext(); }, currentPollDelay());
  })();
}

// --- Multi-cluster: HPC_HOST can be comma-separated (e.g. "cluster1,cluster2") ---
const HPC_HOSTS = requireEnv('HPC_HOST').split(',').map(s => s.trim());
const HPC_USERS = requireEnv('HPC_USER').split(',').map(s => s.trim());
const SLURM_ACCOUNTS = requireEnv('SLURM_ACCOUNT').split(',').map(s => s.trim());

// Default to first cluster
let SSH_HOST = HPC_HOSTS[0];
let SSH_USER = HPC_USERS.length > 1 ? HPC_USERS[0] : HPC_USERS[0];
let SLURM_ACCOUNT = SLURM_ACCOUNTS.length > 1 ? SLURM_ACCOUNTS[0] : SLURM_ACCOUNTS[0];

function getClusterIndex(name) {
  if (!name) return 0;
  const idx = HPC_HOSTS.indexOf(name);
  return idx >= 0 ? idx : 0;
}

function switchCluster(name) {
  const idx = getClusterIndex(name);
  SSH_HOST = HPC_HOSTS[idx];
  SSH_USER = HPC_USERS[Math.min(idx, HPC_USERS.length - 1)];
  SLURM_ACCOUNT = SLURM_ACCOUNTS[Math.min(idx, SLURM_ACCOUNTS.length - 1)];
  return SSH_HOST;
}

const TIMEOUT = 30000;

function exec(cmd, timeout = TIMEOUT) {
  return execSync(cmd, { timeout, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 5 * 1024 * 1024 }).toString().trim();
}

// Why: the cluster uses chained publickey+Duo MFA. Without BatchMode, an ssh
// spawned by this server could fall back to an interactive/keyboard auth
// prompt (hang) or make a doomed auth attempt that feeds the bastion's
// fail2ban. BatchMode=yes makes every non-interactive call fail fast instead.
function sshBaseArgs() {
  return ['-o', 'BatchMode=yes'];
}

function masterDeadMessage(host) {
  return `SSH master connection to ${host} is dead. Background processes cannot ` +
    `re-authenticate (Duo required). Fix: run \`ssh ${host}\` interactively ` +
    `in a terminal once, then retry this tool.`;
}

function sshExec(cmd, timeout = TIMEOUT) {
  // Use login shell so /etc/profile.d/ (SLURM PATH etc.) is sourced
  // execFileSync bypasses local shell — the entire remote command is passed
  // as one SSH argument, so 'bash -c' correctly receives the full string.
  const escaped = cmd.replace(/'/g, "'\"'\"'");
  const doExec = () => execFileSync('ssh', [...sshBaseArgs(), SSH_HOST, `bash --login -c '${escaped}'`], {
    timeout, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 5 * 1024 * 1024,
  }).trim();

  // Fail fast with zero network traffic when the master is dead: chained MFA
  // (publickey+Duo) means a non-interactive reconnect can never succeed — it
  // only records a failed auth on the bastion and feeds fail2ban. The old
  // auto-reconnect here (`ssh -O exit` + `ssh -fN`) killed the shared master
  // (the only Duo-free session token) and retried blindly; combined with
  // zombie pollers it caused the 2026 connection-storm bans. Never restore it.
  if (!masterAlive(SSH_HOST)) {
    throw new Error(masterDeadMessage(SSH_HOST));
  }

  try {
    return doExec();
  } catch (e) {
    const stderr = e.stderr ? String(e.stderr).trim() : '';
    if (stderr.includes('Connection closed') || stderr.includes('Connection reset') ||
        stderr.includes('Connection refused') || stderr.includes('not a socket') ||
        e.message?.includes('socket is not connected')) {
      e.message = `SSH connection to ${SSH_HOST} failed mid-command (master may have just died, ` +
        `or the bastion is fail2ban-banned). Do NOT retry in a loop — check \`ssh -O check ${SSH_HOST}\`, ` +
        `reconnect interactively if needed.\nOriginal: ${e.message}`;
    }
    if (stderr) e.message = `${e.message}\nSTDERR: ${stderr}`;
    throw e;
  }
}

const server = new McpServer({
  name: 'slurm-mcp-server',
  version: '2.2.0',
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
      const notif = drainNotifications();
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
  try {
    const out = exec(`ssh -O check ${SSH_HOST} 2>&1`, 5000);
    return { content: [{ type: 'text', text: `SSH active: ${out}` }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `SSH not connected. Run "ssh ${SSH_HOST}" in terminal to connect.` }] };
  }
});

// === Command Guard: reject prohibited patterns ===
const BLOCKED_PATTERNS = [
  { re: /<<\s*['"]?\w+['"]?/, reason: 'heredoc 禁止。写本地文件 → sync_files 上传' },
  { re: /python[23]?\s+-c\s/, reason: 'python -c 禁止。写 .py 文件 → sync_files 上传 → ssh_exec python script.py' },
  { re: /\n.*\n.*\n/, reason: '多行命令禁止（>2行）。写脚本 → sync_files 上传 → ssh_exec bash script.sh' },
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

function compressOutput(cmd, out) {
  if (!out) return '(no output)';
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
  timeout: z.number().optional().default(30000).describe('Timeout in ms'),
  verbose: z.boolean().optional().default(false).describe('Force full output (bypass noise filter)'),
}, async (args) => {
  // Hard block prohibited patterns
  const blocked = guardCommand(args.command);
  if (blocked) return { content: [{ type: 'text', text: blocked }], isError: true };
  try {
    const out = sshExec(args.command, args.timeout);
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
    } else if (args.content) {
      fileContent = args.content;
      source = '';
    } else {
      return { content: [{ type: 'text', text: 'Write failed: provide either content or from_file' }], isError: true };
    }
    const op = args.append ? '>>' : '>';
    // Same fail-fast as sshExec: a dead master means any connect attempt is a
    // doomed Duo-less auth against the bastion.
    if (!masterAlive(SSH_HOST)) {
      return { content: [{ type: 'text', text: `Write failed: ${masterDeadMessage(SSH_HOST)}` }], isError: true };
    }
    // Use stdin pipe to avoid shell escaping issues with file content
    const escaped = args.path.replace(/'/g, "'\"'\"'");
    execFileSync('ssh', [...sshBaseArgs(), SSH_HOST, `cat ${op} '${escaped}'`], {
      input: fileContent,
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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
  const wdErr = validatePath(args.path, 'path') || (/['"\s]/.test(args.path) ? 'path contains quotes or whitespace' : null);
  if (wdErr) return { content: [{ type: 'text', text: `Error: ${wdErr}` }], isError: true };
  saveWorkdir(args.path);
  return { content: [{ type: 'text', text: `✓ 工作目录已设置\n  窗口: ${windowTty}\n  路径: ${args.path}` }] };
});

server.tool('workdir_get', 'Get HPC working directory for this window', {}, async () => {
  const wd = loadWorkdir();
  if (!wd) {
    return { content: [{ type: 'text', text: `窗口 ${windowTty} 未设置工作目录。使用 workdir_set 设置。` }] };
  }
  return { content: [{ type: 'text', text: `窗口: ${windowTty}\n工作目录: ${wd}` }] };
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

// Validate SLURM job ID: plain "12345", one array task "12345_3", or a task
// range "12345_[1-5]" / "12345_[1,3,5-7]" (scancel/squeue/sacct accept all).
// Callers must single-quote the id in shell commands: [..] is a bash glob.
const VALID_JOB_ID = /^\d+(_(\d+|\[\d+(-\d+)?(,\d+(-\d+)?)*\]))?$/;
function validateJobId(id) {
  if (!VALID_JOB_ID.test(id)) throw new Error(`Invalid job ID: ${id} (e.g. "12345", "12345_3" or "12345_[1-5]")`);
  return id;
}

server.tool('slurm_status', 'Check SLURM job status (squeue + sacct). For array jobs pass the base id "12345" to see all tasks, or "12345_3" for one task.', {
  job_id: z.string().optional().describe('Job ID: "12345", array task "12345_3", or task range "12345_[1-5]". Omit for all your jobs.'),
}, async (args) => {
  try {
    if (args.job_id) {
      const jid = validateJobId(args.job_id);
      // Quoted: "12345_[1-5]" would otherwise be a bash glob.
      const squeue = sshExec(`squeue -j '${jid}'`, 15000);
      const sacct = sshExec(`sacct -j '${jid}'`, 15000);
      const text = [
        '=== squeue ===',
        squeue || '(no output)',
        '',
        '=== sacct ===',
        sacct || '(no output)',
      ].join('\n');
      return { content: [{ type: 'text', text }] };
    }
    const out = sshExec(`squeue -u ${SSH_USER}`, 15000);
    return { content: [{ type: 'text', text: out || '(no jobs)' }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${String(e?.message ?? e)}` }], isError: true };
  }
});

// --- Resource Check (MUST call before any sbatch) ---

function queryResourceHistory(jobNamePattern, limit = 5) {
  // Sanitize: only allow alphanumeric, dash, underscore, dot for grep -F
  const safe = jobNamePattern.replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safe) return '';
  try {
    return sshExec(
      `sacct -u ${SSH_USER} --format=JobID%-20,JobName%-20,Elapsed,MaxRSS,ReqMem,State -P -S $(date -d '7 days ago' +%Y-%m-%d) | grep COMPLETED | grep -iF ${safe} | tail -${limit}`,
      15000
    );
  } catch { return ''; }
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

function parseResourceHistory(sacctOutput) {
  if (!sacctOutput) return null;
  const lines = sacctOutput.split('\n').filter(l => l.includes('COMPLETED'));
  if (!lines.length) return null;
  let maxMem = 0, maxTime = 0;
  for (const line of lines) {
    const parts = line.split('|');
    // Parse MaxRSS (e.g. "1201368K" or "1.2G")
    const rss = parts[3] || '';
    if (rss.endsWith('K')) maxMem = Math.max(maxMem, parseInt(rss) / 1024 / 1024); // → GB
    else if (rss.endsWith('M')) maxMem = Math.max(maxMem, parseInt(rss) / 1024);
    else if (rss.endsWith('G')) maxMem = Math.max(maxMem, parseFloat(rss));
    // Parse Elapsed (HH:MM:SS or MM:SS or D-HH:MM:SS)
    const elapsed = parts[2] || '';
    const secs = parseElapsed(elapsed);
    if (secs > 0) maxTime = Math.max(maxTime, secs);
  }
  return { maxMemGB: maxMem, maxTimeSec: maxTime, count: lines.length };
}

function formatRecommendation(hist) {
  if (!hist) return '';
  const recMem = Math.max(Math.ceil(hist.maxMemGB * 3), 2); // ×3 余量, 最低 2G
  const recTimeSec = Math.max(hist.maxTimeSec * 4, 300); // ×4 余量, 最低 5min
  const recH = Math.floor(recTimeSec / 3600);
  const recM = Math.floor((recTimeSec % 3600) / 60);
  const recTime = `${String(recH).padStart(2, '0')}:${String(recM).padStart(2, '0')}:00`;
  return `\n📊 Resource baseline (${hist.count} recent jobs):\n` +
    `  Actual peak: ${hist.maxMemGB.toFixed(1)}G mem, ${Math.floor(hist.maxTimeSec/60)}m${hist.maxTimeSec%60}s time\n` +
    `  Recommended: --mem=${recMem}G --time=${recTime} (×3 mem, ×4 time)\n`;
}

function checkResourceWaste(requestedMem, requestedTime, hist) {
  if (!hist || hist.maxMemGB === 0) return '';
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

// Optional: external resource log file (e.g. Python-generated TSV with persistent experiment metrics)
const RESOURCE_LOG_PATH = process.env.HPC_RESOURCE_LOG || null;

function queryResourceLog(pattern) {
  if (!RESOURCE_LOG_PATH) return '';
  const safe = pattern.replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safe) return '';
  try {
    return sshExec(`cat ${RESOURCE_LOG_PATH} 2>/dev/null | grep -iF ${safe} || true`, 10000);
  } catch { return ''; }
}

server.tool('resource_check', 'Check actual resource usage of past jobs (MUST call before sbatch)', {
  job_name: z.string().describe('Job name pattern to search'),
}, async (args) => {
  try {
    const sections = [];

    // Source 1: sacct (SLURM accounting)
    const sacctRaw = queryResourceHistory(args.job_name);
    const hist = sacctRaw ? parseResourceHistory(sacctRaw) : null;

    // Source 2: external resource log (optional, set HPC_RESOURCE_LOG env var)
    const logRaw = queryResourceLog(args.job_name);

    if (!sacctRaw && !logRaw) {
      return { content: [{ type: 'text', text: `No resource data for "${args.job_name}". Run a 1-seed benchmark first.` }] };
    }

    if (sacctRaw) {
      sections.push(`=== SLURM sacct (last 7 days) ===\n${sacctRaw}`);
    }
    if (logRaw) {
      sections.push(`=== External resource log ===\n${logRaw}`);
    }
    if (hist) {
      sections.push(formatRecommendation(hist));
    }

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
  const m = String(mem ?? '').trim().match(/^(\d+(?:\.\d+)?)([KMGT])?B?$/i);
  if (!m) return null;
  const mult = { K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024 }[(m[2] || 'M').toUpperCase()];
  return parseFloat(m[1]) * mult;
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
function loadPartitionLimitsForHost() {
  const parts = sshExec('scontrol show partition -o', 15000);
  const found = [];
  for (const line of parts.split('\n')) {
    const name = line.match(/\bPartitionName=(\S+)/)?.[1];
    if (!name) continue;
    const maxTime = line.match(/\bMaxTime=(\S+)/)?.[1] || null;
    const qosRaw = line.match(/\bQoS=(\S+)/)?.[1] || null;
    found.push({
      partition: name,
      maxTime,
      maxTimeSec: parseSlurmTime(maxTime), // UNLIMITED → null
      qos: qosRaw && qosRaw !== 'N/A' && /^[\w.-]+$/.test(qosRaw) ? qosRaw : null,
      maxJobsPU: null, maxSubmitPU: null, maxTRESPU: null, tres: {},
    });
  }
  const qosNames = [...new Set(found.map(p => p.qos).filter(Boolean))];
  if (qosNames.length) {
    const q = sshExec(`sacctmgr show qos where name=${qosNames.join(',')} -P -n format=Name,MaxJobsPU,MaxSubmitPU,MaxTRESPU,MaxWall`, 15000);
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
        busy = parseInt(sshExec(`squeue -u ${SSH_USER} -p ${args.partition} -h | wc -l`, 10000), 10) > 0;
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
const RE_PARTITION = /^[\w-]+$/;
const RE_MEM = /^\d+[KMGT]?$/;
const RE_ARRAY = /^\d+(-\d+)?(,\d+(-\d+)?)*(%\d+)?$/;
const RE_DEPENDENCY = /^(after|afterok|afternotok|afterany|aftercorr|singleton)(:\d+(_\d+)?)*(,(after|afterok|afternotok|afterany|aftercorr|singleton)(:\d+(_\d+)?)*)*$/;

function validateSubmitArgs(args) {
  const errs = [];
  if (!RE_JOB_NAME.test(String(args.job_name))) errs.push(`job_name "${args.job_name}" must match ${RE_JOB_NAME} (letters, digits, _ . -, ≤64 chars)`);
  if (!RE_PARTITION.test(String(args.partition))) errs.push(`partition "${args.partition}" must match ${RE_PARTITION}`);
  if (!RE_MEM.test(String(args.mem))) errs.push(`mem "${args.mem}" must look like 4G / 512M / 4096`);
  if (parseSlurmTime(args.time) == null) errs.push(`time "${args.time}" is not a SLURM time (M, M:S, H:M:S, D-H, D-H:M, D-H:M:S)`);
  if (args.array != null && !RE_ARRAY.test(String(args.array))) errs.push(`array "${args.array}" must look like 1-10, 1,3,5-7 or 1-100%5`);
  if (args.dependency != null && !RE_DEPENDENCY.test(String(args.dependency))) errs.push(`dependency "${args.dependency}" must look like afterok:12345 or afterany:12345_1,afterok:67890`);
  if (!Number.isInteger(args.gpus) || args.gpus < 0) errs.push(`gpus must be a non-negative integer`);
  if (args.cpus_per_task != null && (!Number.isInteger(args.cpus_per_task) || args.cpus_per_task < 0)) errs.push(`cpus_per_task must be a non-negative integer`);
  const odErr = validatePath(String(args.output_dir), 'output_dir') || (/['"\s]/.test(String(args.output_dir)) ? 'output_dir contains quotes or whitespace' : null);
  if (odErr) errs.push(odErr);
  return errs;
}

server.tool('slurm_submit',
  'Submit a SLURM batch job built from a command string. Auto-registers a completion watch: when the job (or, for arrays, EVERY task) finishes, a notification with an ok/failed tally is prepended to your next tool result — never poll with ssh loops. ' +
  'For many independent chunks use `array` (e.g. "1-20" or "1-100%10"; each task reads $SLURM_ARRAY_TASK_ID; logs go to slurm_<jobid>_<task>.out). ' +
  'Chain jobs with `dependency` (e.g. "afterok:12345"). Checks past resource usage, and appends ⚠️ hints (non-blocking) when the partition has a per-user cap that will serialize your jobs or reject the request (gpus/mem/time over the cap).', {
  script: z.string().describe('Main command(s) to run inside the job'),
  job_name: z.string().optional().describe('Job name, [A-Za-z0-9_.-]{1,64} (default: slurm-job)'),
  partition: z.string().optional().describe('Partition (default: batch). Use cluster_info to see per-user caps; small debug partitions often allow 1 job at a time — for parallel chunks pick a partition without a per-user cap.'),
  gpus: z.number().optional().describe('Number of GPUs (default: 1). Some sites reject 0 (every job must request ≥1 GPU).'),
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
  const DEFAULTS = { job_name: 'slurm-job', partition: 'batch', gpus: 1, mem: '4G', time: '00:15:00', output_dir: 'results/logs' };
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

  const argErrs = validateSubmitArgs(args);
  if (argErrs.length) {
    return { content: [{ type: 'text', text: `Submit rejected (invalid parameters):\n  - ${argErrs.join('\n  - ')}` }], isError: true };
  }
  const timeSec = parseSlurmTime(args.time);

  // Auto-check resource history before submitting
  let resourceInfo = '';
  try {
    const raw = queryResourceHistory(args.job_name);
    const hist = parseResourceHistory(raw);
    if (hist) {
      resourceInfo = formatRecommendation(hist) + checkResourceWaste(args.mem, args.time, hist);
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
    cdLine = `cd '${storedWorkdir}'`; // validated above: no quotes inside
    // Auto-align output_dir to workdir when using default
    if (args.output_dir === 'results/logs') {
      outputDir = `${storedWorkdir}/results/logs`;
    }
  } else {
    workdirHint = '\n💡 建议先用 workdir_set 设置工作目录，确保实验文件保存在正确位置';
  }

  const lines = [
    '#!/bin/bash',
    `#SBATCH --account=${SLURM_ACCOUNT}`,
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
  const mkdirTarget = outputDir.startsWith('/') ? outputDir : (storedWorkdir ? `${storedWorkdir}/${outputDir}` : outputDir);
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
      registerWatch(jobId, args.job_name, estSeconds, args.partition);
      const estMin = Math.round(estSeconds / 60);
      // No POLL_CMD suggestion: the built-in 30s batched watcher already
      // monitors this job and piggybacks a notification onto the next tool
      // result. Handing the client a 10s `while true; do ssh ...` loop
      // multiplies SSH traffic for nothing (connection-storm lesson, 2026-07-02).
      const arrayNote = args.array ? ` (array ${args.array}: notifies once ALL tasks finish, with an ok/failed tally)` : '';
      return { content: [{ type: 'text', text: out + `\n👁️ Watch registered: job ${jobId}${arrayNote}, est. ${estMin}min — completion auto-notifies on the next tool call (or check slurm_watches). Do NOT poll with ssh loops.` + limitHints + resourceInfo + workdirHint }] };
    }
    return { content: [{ type: 'text', text: out + limitHints + resourceInfo + workdirHint }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Submit failed: ${String(e?.message ?? e)}${limitHints}` }], isError: true };
  }
});

server.tool('slurm_cancel', 'Cancel a SLURM job, a single array task, or a range of array tasks', {
  job_id: z.string().describe('Job ID "12345" (whole job / whole array), array task "12345_3", or task range "12345_[1-5]"'),
}, async (args) => {
  try {
    const jid = validateJobId(args.job_id);
    const out = sshExec(`scancel '${jid}' && echo "Job ${jid} cancelled"`);
    // Only a whole-job cancel ends the watch; cancelling some array tasks
    // leaves the rest running and the watch reports them when all finish.
    removeWatch(jid);
    return { content: [{ type: 'text', text: out }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Cancel failed: ${String(e?.message ?? e)}` }], isError: true };
  }
});

server.tool('slurm_logs', 'Read SLURM job output log. For array jobs pass one task, e.g. "12345_3" (logs are slurm_<jobid>_<task>.out).', {
  job_id: z.string().describe('Job ID "12345", or for an array job one task "12345_3"'),
  lines: z.number().optional().default(50).describe('Number of lines to read (default 50, use 0 for all)'),
}, async (args) => {
  try {
    const jid = validateJobId(args.job_id);
    // Find the log file. sacct StdOut is empty on clusters whose accounting
    // doesn't store it (e.g. SMU SuperPOD, verified 2026-07-02) — fall back
    // to scontrol (recent/running jobs), then to the stored workdir's log dirs.
    let stdoutPath = sshExec(`sacct -j '${jid}' --format=StdOut%-200 -P -n | head -1`, 10000).trim();
    if (!stdoutPath || stdoutPath === '|') {
      try {
        stdoutPath = sshExec(`scontrol show job '${jid}' 2>/dev/null | grep -o 'StdOut=[^ ]*' | cut -d= -f2`, 10000).trim();
      } catch { stdoutPath = ''; }
    }
    if (!stdoutPath) {
      const wd = loadWorkdir();
      if (wd) {
        try {
          stdoutPath = sshExec(`ls ${wd}/results/logs/slurm_${jid}.out ${wd}/logs/slurm_${jid}.out ${wd}/slurm_${jid}.out ${wd}/slurm-${jid}.out 2>/dev/null | head -1`, 10000).trim();
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
      registerWatch(jobId, jobName, 3600, 'batch');
      return { content: [{ type: 'text', text: `${out}\n👁️ Watch registered: job ${jobId}` }] };
    }
    return { content: [{ type: 'text', text: out }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Submit failed: ${String(e?.message ?? e)}` }], isError: true };
  }
});

server.tool('cluster_info', 'Get HPC cluster partitions, queue load, your jobs, and per-user partition limits (MaxTime / MaxJobsPU / MaxTRESPU) — check before choosing a partition for parallel work', {}, async () => {
  try {
    const host = sshExec('hostname', 10000);
    const partitions = sshExec('sinfo -s', 15000);
    const jobs = sshExec(`squeue -u ${SSH_USER}`, 15000);
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
        `${p.partition}: MaxTime=${p.maxTime ?? 'n/a'} MaxJobsPU=${p.maxJobsPU ?? 'none'}` +
        (p.maxSubmitPU != null ? ` MaxSubmitPU=${p.maxSubmitPU}` : '') +
        ` MaxTRESPU=${p.maxTRESPU || 'none'}` + (p.qos ? ` (QoS ${p.qos})` : ''));
      limitsInfo = `\n\n=== Per-user limits ===\n${rows.join('\n')}`;
    } catch (err) {
      limitsInfo = `\n\n=== Per-user limits ===\n(unavailable: ${String(err?.message ?? err).split('\n')[0]})`;
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

server.tool('resource_report', 'Summarize resource usage over a time period', {
  days: z.number().optional().default(7).describe('Number of days to look back (default 7)'),
  format: z.enum(['text', 'csv']).optional().default('text'),
}, async (args) => {
  try {
    const raw = sshExec(
      `sacct -u ${SSH_USER} --format=JobID%-20,JobName%-30,Partition,Elapsed,MaxRSS,ReqMem,ReqTRES,State -P -S $(date -d '${args.days} days ago' +%Y-%m-%d) -n`,
      20000
    );
    if (!raw) return { content: [{ type: 'text', text: 'No jobs found in the specified period.' }] };

    const lines = raw.split('\n').filter(l => l.trim());
    let totalJobs = 0, completed = 0, failed = 0;
    let totalTimeSec = 0, maxMemGB = 0, gpuJobs = 0;

    for (const line of lines) {
      const parts = line.split('|');
      const state = parts[7] || '';
      if (parts[0]?.includes('.')) continue; // skip sub-steps
      totalJobs++;
      if (state === 'COMPLETED') completed++;
      if (state === 'FAILED' || state === 'TIMEOUT' || state === 'OUT_OF_MEMORY') failed++;
      // Parse elapsed
      const elapsed = parts[3] || '';
      const secs = parseElapsed(elapsed);
      if (secs > 0) totalTimeSec += secs;
      // Parse memory
      const rss = parts[4] || '';
      if (rss.endsWith('K')) maxMemGB = Math.max(maxMemGB, parseInt(rss) / 1024 / 1024);
      else if (rss.endsWith('M')) maxMemGB = Math.max(maxMemGB, parseInt(rss) / 1024);
      else if (rss.endsWith('G')) maxMemGB = Math.max(maxMemGB, parseFloat(rss));
      // GPU
      if ((parts[6] || '').includes('gpu')) gpuJobs++;
    }

    const totalH = (totalTimeSec / 3600).toFixed(1);
    const gpuH = gpuJobs > 0 ? `${(totalTimeSec / 3600 * gpuJobs / totalJobs).toFixed(1)}h (estimated)` : 'N/A';

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

// Path validation: block shell metacharacters and traversal
const UNSAFE_PATH = /[;|$()&<>`\n\t\r\\]/;
function validatePath(p, label) {
  if (UNSAFE_PATH.test(p)) return `${label} contains unsafe characters`;
  if (p.includes('..')) return `${label} contains '..' (path traversal not allowed)`;
  return null;
}

server.tool('sync_files', 'Sync files between local and HPC via rsync', {
  direction: z.enum(['upload', 'download']),
  local_path: z.string().describe('Local absolute path'),
  remote_path: z.string().describe('Remote path on HPC (use ~ for home)'),
  delete: z.boolean().optional().default(false),
}, async (args) => {
  const localErr = validatePath(args.local_path, 'local_path');
  if (localErr) return { content: [{ type: 'text', text: localErr }], isError: true };
  const remoteErr = validatePath(args.remote_path, 'remote_path');
  if (remoteErr) return { content: [{ type: 'text', text: remoteErr }], isError: true };
  if (!args.local_path.startsWith('/') && !args.local_path.startsWith('~')) {
    return { content: [{ type: 'text', text: 'local_path must be an absolute path' }], isError: true };
  }
  // Same guard as sshExec: rsync spawns ssh underneath — with a dead master
  // it would burn a doomed (Duo-required) auth attempt against the bastion.
  if (!masterAlive(SSH_HOST)) {
    return { content: [{ type: 'text', text: `SSH master connection to ${SSH_HOST} is dead. Run \`ssh ${SSH_HOST}\` interactively in a terminal once (needs Duo), then retry.` }], isError: true };
  }
  // BatchMode for the ssh rsync spawns: same no-interactive-auth rule as sshExec.
  const rsyncArgs = ['-avz', '--partial', '-e', `ssh ${sshBaseArgs().join(' ')}`];
  if (args.delete) rsyncArgs.push('--delete');
  if (args.direction === 'upload') {
    rsyncArgs.push(args.local_path, `${SSH_HOST}:${args.remote_path}`);
  } else {
    rsyncArgs.push(`${SSH_HOST}:${args.remote_path}`, args.local_path);
  }
  try {
    const out = execFileSync('rsync', rsyncArgs, {
      timeout: 300000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 5 * 1024 * 1024,
    }).trim();
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
  keys: z.string().describe('Keys to send (text or special: Enter, Ctrl-C, Tab). No heredoc (<<), no multi-line code.'),
}, async (args) => {
  if (/<<\s*['"]?\w+['"]?/.test(args.keys)) {
    return { content: [{ type: 'text', text: 'BLOCKED: heredoc not allowed via terminal_send. Write local file → sync_files upload.' }], isError: true };
  }
  if (args.keys.length > 500) {
    return { content: [{ type: 'text', text: `BLOCKED: content length ${args.keys.length} exceeds limit. Write local file → sync_files upload.` }], isError: true };
  }
  try {
    const s = validateSession(args.session);
    tmuxExec(['send-keys', '-t', s, args.keys]);
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
    tmuxExec(['send-keys', '-t', s, args.command, 'Enter']);
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
    const safeHost = SSH_HOST.replace(/[^a-zA-Z0-9._-]/g, '');
    tmuxExec(['new-session', '-d', '-s', s, `ssh ${safeHost}`]);

    // Wait for SSH to connect
    await new Promise(r => setTimeout(r, 2000));
    const initial = tmuxExec(['capture-pane', '-t', s, '-p', '-S', '-20']);

    // Run command if provided
    if (args.command) {
      await new Promise(r => setTimeout(r, 1000));
      tmuxExec(['send-keys', '-t', s, args.command, 'Enter']);
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
      for (const w of myWatches) {
        const elapsed = (now - new Date(w.submittedAt).getTime()) / 1000;
        const ratio = w.estimatedSeconds > 0 ? elapsed / w.estimatedSeconds : 0;
        const pct = Math.min(Math.round(ratio * 100), 999);
        const elapsedMin = Math.round(elapsed / 60);
        const estMin = Math.round(w.estimatedSeconds / 60);
        const prog = w.progress ? ` tasks done ${w.progress}` : '';
        parts.push(`  ${w.jobId} (${w.jobName}) [${w.state}${prog}] — ${elapsedMin}min elapsed, est. ${estMin}min, ~${pct}%`);
      }
    } else {
      parts.push('  (no watches for this window)');
    }

    if (otherWatches.length) {
      parts.push(`\nOther windows: ${otherWatches.length} watch(es)`);
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

// Start watch polling loop
startWatchPolling();

// Lifecycle: a stdio MCP server must die with its client. Without these, the
// setTimeout polling chain keeps the event loop alive forever after the
// Claude session exits (2026-07-02: 28 zombie servers from 3 weeks found).
function shutdown() {
  // Remove our heartbeat so other pollers can adopt our watches immediately.
  try { unlinkSync(join(HEARTBEAT_DIR, `${windowTty}.json`)); } catch {}
  process.exit(0);
}
process.stdin.on('end', () => { logDebug('stdin closed, exiting.'); shutdown(); });
process.stdin.on('close', () => { logDebug('stdin closed, exiting.'); shutdown(); });
process.stdin.on('error', () => shutdown());

const transport = new StdioServerTransport();
await server.connect(transport);
