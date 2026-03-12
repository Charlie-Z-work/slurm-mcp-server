#!/usr/bin/env node
/**
 * SLURM MCP Server — Direct SSH/SLURM/tmux for Claude Code CLI
 * Zero-dependency, single-file, TTY-aware job watching with desktop notifications.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execSync, execFileSync, execFile as execFileCb } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
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
  mkdirSync(WORKDIR_DIR, { recursive: true });
  writeFileSync(getWorkdirPath(), JSON.stringify({
    tty: windowTty,
    workdir: path,
    setAt: new Date().toISOString(),
  }, null, 2));
}

// --- Debug logging (stderr, visible in MCP server logs) ---
function logDebug(msg) {
  process.stderr.write(`[slurm-mcp-server ${new Date().toISOString()}] ${msg}\n`);
}

// --- SLURM Watch ---

// Polling state (exposed via slurm_watches for diagnostics)
let lastPollTime = null;
let lastPollError = null;
let pollCount = 0;

// Notifications persisted to disk (see NOTIF_FILE), this array removed
const NOTIF_FILE = join(homedir(), '.claude', 'slurm-notifications.json');

function loadNotifications() {
  try {
    return JSON.parse(readFileSync(NOTIF_FILE, 'utf-8'));
  } catch { return []; }
}

function saveNotifications(notifs) {
  try {
    mkdirSync(join(homedir(), '.claude'), { recursive: true });
    writeFileSync(NOTIF_FILE, JSON.stringify(notifs, null, 2));
  } catch (err) {
    logDebug(`saveNotifications failed: ${err.message}`);
  }
}

function loadWatches() {
  try {
    const data = JSON.parse(readFileSync(WATCHES_FILE, 'utf-8'));
    const now = Date.now();
    return data.filter(w => now - new Date(w.submittedAt).getTime() < 48 * 3600 * 1000);
  } catch (err) {
    if (err.code !== 'ENOENT') logDebug(`loadWatches failed: ${err.message}`);
    return [];
  }
}

function saveWatches(watches) {
  mkdirSync(join(homedir(), '.claude'), { recursive: true });
  writeFileSync(WATCHES_FILE, JSON.stringify(watches, null, 2));
}

function registerWatch(jobId, jobName, estimatedSeconds, partition) {
  const watches = loadWatches();
  watches.push({
    jobId,
    tty: windowTty,
    jobName,
    submittedAt: new Date().toISOString(),
    estimatedSeconds,
    partition,
    state: 'PENDING',
  });
  saveWatches(watches);
}

function removeWatch(jobId) {
  const watches = loadWatches().filter(w => w.jobId !== jobId);
  saveWatches(watches);
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
    const { stdout } = await execFileAsync('ssh', [SSH_HOST, `bash --login -c '${escaped}'`], {
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
]);

const MAX_PENDING = 50;

function markCompleted(watch, state) {
  const emoji = state === 'COMPLETED' ? '✅' : '❌';
  const msg = `${emoji} SLURM job ${watch.jobId} (${watch.jobName}) ${state}`;

  logDebug(`Job ${watch.jobId} (${watch.jobName}) → ${state}`);

  // Persist to disk (survives process restart, no memory-only state)
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

  // Cross-platform desktop notification
  try {
    const platform = process.platform;
    if (platform === 'darwin') {
      const safeMsg = msg.replace(/[\\"]/g, '\\$&');
      execSync(`osascript -e 'display notification "${safeMsg}" with title "SLURM" sound name "Glass"'`,
        { timeout: 5000, stdio: 'ignore' });
    } else if (platform === 'linux') {
      const safeMsg = msg.replace(/'/g, "'\"'\"'");
      execSync(`notify-send 'SLURM' '${safeMsg}'`,
        { timeout: 5000, stdio: 'ignore' });
    }
    // Windows/other: skip silently
  } catch (err) {
    logDebug(`Desktop notification failed: ${err.message}`);
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
  const allNotifs = loadNotifications();
  const mine = allNotifs.filter(n => n.tty === windowTty);
  if (!mine.length) return '';
  // Atomic: remove only this tty's notifications, keep others
  const remaining = allNotifs.filter(n => n.tty !== windowTty);
  saveNotifications(remaining);
  const msgs = mine.map(n => n.message).join('\n');
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
    return `  ${w.jobId} (${w.jobName}) [${w.state}] — ${elapsedMin}min elapsed, est. ${estMin}min, ~${pct}%`;
  });
  return `Active SLURM Watches:\n${lines.join('\n')}`;
}

// Polling loop — async, non-blocking, per-tty filtering
const POLL_INTERVAL = 30_000;

function startWatchPolling() {
  async function poll() {
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

    // Only poll watches belonging to this window's tty
    const myWatches = watches.filter(w => w.tty === windowTty);
    if (!myWatches.length) return;

    const completedIds = new Set();
    let stateChanged = false;

    for (const w of myWatches) {
      try {
        const state = await checkJobStateAsync(w.jobId);
        if (TERMINAL_STATES.has(state)) {
          markCompleted(w, state);
          completedIds.add(w.jobId);
        } else if (state !== 'UNKNOWN' && w.state !== state) {
          w.state = state;
          stateChanged = true;
        }
      } catch (err) {
        lastPollError = `job ${w.jobId}: ${String(err?.message ?? err)}`;
        logDebug(`Poll error for ${w.jobId}: ${String(err?.message ?? err)}`);
      }
    }

    if (completedIds.size || stateChanged) {
      const updated = watches
        .filter(w => !completedIds.has(w.jobId))
        .map(w => {
          const mine = myWatches.find(m => m.jobId === w.jobId);
          return mine || w;
        });
      saveWatches(updated);
    }
  }
  // setTimeout chain: wait for poll to finish before scheduling next
  (function scheduleNext() {
    setTimeout(async () => { await poll(); scheduleNext(); }, POLL_INTERVAL);
  })();
}

const SSH_HOST = requireEnv('HPC_HOST');
const SSH_USER = requireEnv('HPC_USER');
const SLURM_ACCOUNT = requireEnv('SLURM_ACCOUNT');
const TIMEOUT = 30000;

function exec(cmd, timeout = TIMEOUT) {
  return execSync(cmd, { timeout, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 5 * 1024 * 1024 }).toString().trim();
}

function sshExec(cmd, timeout = TIMEOUT) {
  // Use login shell so /etc/profile.d/ (SLURM PATH etc.) is sourced
  // execFileSync bypasses local shell — the entire remote command is passed
  // as one SSH argument, so 'bash -c' correctly receives the full string.
  // (execSync broke commands with flags like 'mkdir -p' because local sh
  // stripped the quotes and SSH re-split the args)
  const escaped = cmd.replace(/'/g, "'\"'\"'");
  return execFileSync('ssh', [SSH_HOST, `bash --login -c '${escaped}'`], {
    timeout, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 5 * 1024 * 1024,
  }).trim();
}

const server = new McpServer({
  name: 'slurm-mcp-server',
  version: '1.0.0',
  instructions: 'SLURM HPC tools via SSH. Requires SSH ControlMaster (or key-based auth). Use resource_check before submitting jobs.',
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
    return { content: [{ type: 'text', text: `SSH exec failed: ${e.message}` }], isError: true };
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
    // Use stdin pipe to avoid shell escaping issues with file content
    const escaped = args.path.replace(/'/g, "'\"'\"'");
    execFileSync('ssh', [SSH_HOST, `cat ${op} '${escaped}'`], {
      input: fileContent,
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const bytes = Buffer.byteLength(fileContent, 'utf8');
    return { content: [{ type: 'text', text: `Written ${bytes} bytes → ${args.path} ${source}`.trim() }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Write failed: ${e.message}` }], isError: true };
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
    return { content: [{ type: 'text', text: `Read failed: ${e.message}` }], isError: true };
  }
});

// --- Workdir Guard ---

server.tool('workdir_set', 'Set HPC working directory for this window (used by slurm_submit guard)', {
  path: z.string().describe('Absolute path on HPC (e.g. /home/user/project)'),
}, async (args) => {
  if (!args.path.startsWith('/')) {
    return { content: [{ type: 'text', text: `Error: 必须是绝对路径，收到: ${args.path}` }], isError: true };
  }
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

// --- SLURM ---

server.tool('slurm_status', 'Check SLURM job status', {
  job_id: z.string().optional().describe('Specific job ID, or omit for all your jobs'),
}, async (args) => {
  try {
    if (args.job_id) {
      const squeue = sshExec(`squeue -j ${args.job_id}`, 15000);
      const sacct = sshExec(`sacct -j ${args.job_id}`, 15000);
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
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }
});

// --- Resource Check (MUST call before any sbatch) ---

function queryResourceHistory(jobNamePattern, limit = 5) {
  // Query sacct for recent completed jobs matching pattern
  try {
    return sshExec(
      `sacct -u ${SSH_USER} --format=JobID%-20,JobName%-20,Elapsed,MaxRSS,ReqMem,State -P -S $(date -d '7 days ago' +%Y-%m-%d) | grep COMPLETED | grep -i "${jobNamePattern}" | tail -${limit}`,
      15000
    );
  } catch { return ''; }
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
    // Parse Elapsed (HH:MM:SS)
    const elapsed = parts[2] || '';
    const [h, m, s] = elapsed.split(':').map(Number);
    if (!isNaN(h)) maxTime = Math.max(maxTime, h * 3600 + m * 60 + s);
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
  const reqMemGB = parseInt(requestedMem); // "16G" → 16
  const [rh, rm, rs] = requestedTime.split(':').map(Number);
  const reqTimeSec = rh * 3600 + rm * 60 + rs;
  const memRatio = reqMemGB / Math.max(hist.maxMemGB, 0.1);
  const timeRatio = reqTimeSec / Math.max(hist.maxTimeSec, 1);
  const warnings = [];
  if (memRatio > 10) warnings.push(`⚠️ Memory ${reqMemGB}G is ${memRatio.toFixed(0)}x actual usage (${hist.maxMemGB.toFixed(1)}G)`);
  if (timeRatio > 10) warnings.push(`⚠️ Time ${requestedTime} is ${timeRatio.toFixed(0)}x actual usage (${Math.floor(hist.maxTimeSec/60)}min)`);
  return warnings.length ? '\n' + warnings.join('\n') : '';
}

server.tool('resource_check', 'Check actual resource usage of past jobs (MUST call before sbatch)', {
  job_name: z.string().describe('Job name pattern to search'),
}, async (args) => {
  try {
    const sacctRaw = queryResourceHistory(args.job_name);
    const hist = sacctRaw ? parseResourceHistory(sacctRaw) : null;

    if (!sacctRaw) {
      return { content: [{ type: 'text', text: `No resource data for "${args.job_name}". Run a 1-seed benchmark first.` }] };
    }

    const sections = [];
    sections.push(`=== SLURM sacct (last 7 days) ===\n${sacctRaw}`);
    if (hist) {
      sections.push(formatRecommendation(hist));
    }

    return { content: [{ type: 'text', text: sections.join('\n\n') }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }
});

server.tool('slurm_submit', 'Submit a SLURM batch job (auto-checks resource history)', {
  script: z.string().describe('Main command to run'),
  job_name: z.string().optional().default('slurm-job'),
  partition: z.string().optional().default('batch'),
  gpus: z.number().optional().default(1).describe('Number of GPUs'),
  mem: z.string().optional().default('4G'),
  time: z.string().optional().default('00:15:00').describe('HH:MM:SS'),
  cpus_per_task: z.number().optional(),
  output_dir: z.string().optional().default('results/logs'),
}, async (args) => {
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
    cdLine = `cd ${storedWorkdir}`;
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
    `#SBATCH --output=${outputDir}/slurm_%j.out`,
  ];
  if (args.gpus != null && args.gpus > 0) lines.push(`#SBATCH --gres=gpu:${args.gpus}`);
  if (args.cpus_per_task) lines.push(`#SBATCH --cpus-per-task=${args.cpus_per_task}`);
  if (HPC_PREAMBLE) {
    lines.push('', ...HPC_PREAMBLE.split('\n'));
  }
  if (cdLine) lines.push(cdLine);
  lines.push('', args.script);
  const sbatch = lines.join('\n');
  const mkdirTarget = outputDir.startsWith('/') ? outputDir : (storedWorkdir ? `${storedWorkdir}/${outputDir}` : outputDir);
  try {
    const out = sshExec(`mkdir -p ${mkdirTarget} && cat <<'SLURM_EOF' | sbatch\n${sbatch}\nSLURM_EOF`, 60000);

    // Register SLURM watch for automatic monitoring
    const jobMatch = out.match(/Submitted batch job (\d+)/);
    if (jobMatch) {
      const jobId = jobMatch[1];
      const estSeconds = parseTimeToSeconds(args.time);
      registerWatch(jobId, args.job_name, estSeconds, args.partition);
      const estMin = Math.round(estSeconds / 60);
      const pollCmd = `while true; do state=$(ssh ${SSH_HOST} "bash --login -c 'sacct -j ${jobId} --format=State --noheader -P'" 2>/dev/null | head -1 | tr -d ' '); if [[ "\\$state" == "COMPLETED" || "\\$state" == "FAILED" || "\\$state" == "CANCELLED" || "\\$state" == "TIMEOUT" ]]; then echo "✅ SLURM job ${jobId} (${args.job_name}): \\$state"; break; fi; sleep 10; done`;
      return { content: [{ type: 'text', text: out + `\n👁️ Watch registered: job ${jobId}, est. ${estMin}min` + resourceInfo + workdirHint + `\n⏳ POLL_CMD: ${pollCmd}` }] };
    }
    return { content: [{ type: 'text', text: out + resourceInfo + workdirHint }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Submit failed: ${e.message}` }], isError: true };
  }
});

server.tool('slurm_cancel', 'Cancel a SLURM job', {
  job_id: z.string(),
}, async (args) => {
  try {
    const out = sshExec(`scancel ${args.job_id} && echo "Job ${args.job_id} cancelled"`);
    removeWatch(args.job_id);
    return { content: [{ type: 'text', text: out }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Cancel failed: ${e.message}` }], isError: true };
  }
});

server.tool('cluster_info', 'Get HPC cluster partitions and status', {}, async () => {
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
    return { content: [{ type: 'text', text: out }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }
});

// --- File Sync ---

// Path validation: block shell metacharacters and traversal
const UNSAFE_PATH = /[;|$()&<>`\n\t\r]/;
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
  const rsyncArgs = ['-avz', '--partial'];
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
  wait: z.number().optional().default(1000).describe('Ms to wait for output (default 1000, use more for slow commands)'),
}, async (args) => {
  try {
    const s = validateSession(args.session);
    tmuxExec(['send-keys', '-t', s, args.command, 'Enter']);
    await new Promise(r => setTimeout(r, args.wait ?? 1000));
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

// --- HPC Guide (resource) ---

server.tool('guide', 'Read the HPC guide (experiment workflow, data, SLURM templates)', {}, async () => {
  try {
    const guidePath = join(__dirname, 'docs', 'GUIDE.md');
    const guide = readFileSync(guidePath, 'utf-8');
    const watches = loadWatches();
    const myNotifs = loadNotifications().filter(n => n.tty === windowTty);
    const watchSection = `\n\n---\n${formatWatchStatus(watches)}\n` +
      `Pending notifications: ${myNotifs.length}`;
    return { content: [{ type: 'text', text: guide + watchSection }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Cannot read guide: ${e.message}` }], isError: true };
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
        parts.push(`  ${w.jobId} (${w.jobName}) [${w.state}] — ${elapsedMin}min elapsed, est. ${estMin}min, ~${pct}%`);
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

    // Notifications from disk (not memory — eliminates drain race)
    const allNotifs = loadNotifications();
    const myNotifs = allNotifs.filter(n => n.tty === windowTty);
    if (myNotifs.length) {
      parts.push(`\nPending notifications (${myNotifs.length}):`);
      parts.push(myNotifs.map(n => `  ${n.message}`).join('\n'));
    } else {
      parts.push('\nNo pending notifications.');
    }

    return { content: [{ type: 'text', text: parts.join('\n') }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Error reading watches: ${e.message}` }], isError: true };
  }
});

// Start watch polling loop
startWatchPolling();

const transport = new StdioServerTransport();
await server.connect(transport);
