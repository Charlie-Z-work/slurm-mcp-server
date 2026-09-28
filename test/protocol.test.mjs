// End-to-end MCP stdio tests: spawns `node index.mjs` with test/fake-bin first
// on PATH (fake ssh/rsync answer with real SLURM output, desktop notifiers are
// no-ops), a throwaway HOME, and drives it over JSON-RPC. No network.
// Tests tagged BUG-<n> / B<n> are regression tests for the round-2 fixes
// (see CHANGELOG, Unreleased → Fixed).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_BIN = join(ROOT, 'test', 'fake-bin');
const children = new Set();
const killAll = () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } };
process.on('exit', killAll);
after(killAll);

async function startServer({ scenario = 'normal', env = {}, home } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `slurm-mcp-proto-${scenario}-`));
  home ??= join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const log = join(dir, 'fake.log');
  const guideExtra = join(dir, 'site-guide.md');
  writeFileSync(guideExtra, '## Partitions\nshort allows 1 job per user.\n');
  const childEnv = {
    ...process.env,
    PATH: `${FAKE_BIN}${delimiter}${process.env.PATH}`,
    HOME: home, HPC_HOST: 'fake', HPC_USER: 'u', SLURM_ACCOUNT: 'acct',
    HPC_PREAMBLE: 'module load x', HPC_GUIDE_EXTRA: guideExtra,
    FAKE_SCENARIO: scenario, FAKE_LOG: log, SLURM_MCP_POLL_MS: '250',
  };
  for (const k of ['NOTIFY_WEBHOOK', 'HPC_RESOURCE_LOG', 'SLURM_MCP_NO_START', 'SLURM_DEFAULT_PARTITION', 'SLURM_DEFAULT_GPUS']) delete childEnv[k];
  Object.assign(childEnv, env); // explicit per-test env wins
  const child = spawn(process.execPath, [join(ROOT, 'index.mjs')], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  child.on('exit', () => children.delete(child));
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  let buf = '';
  const pending = new Map();
  const notifications = []; // server → client notifications (no id)
  let nextId = 1;
  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      else if (msg.id == null && msg.method) notifications.push(msg);
    }
  });
  const rpc = (method, params) => new Promise((res, rej) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`timeout ${method}\n${stderr}`)); }, 20_000);
    pending.set(id, (m) => { clearTimeout(timer); res(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    if (r.error) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
    return { text: (r.result.content || []).map(c => c.text).join('\n'), isError: !!r.result.isError };
  };
  const logEntries = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
  const stop = () => new Promise(res => {
    if (child.exitCode != null || child.signalCode != null) return res();
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
    child.once('exit', () => { clearTimeout(t); res(); });
    child.stdin.end(); // server's lifecycle hook exits on stdin close
  });
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tty = async () => (await call('slurm_watches')).text.match(/tty=([^)]+)\)/)[1];
  const watchesFile = join(home, '.claude', 'slurm-watches.json');
  const readWatches = () => JSON.parse(readFileSync(watchesFile, 'utf8'));
  return { child, dir, home, log, rpc, call, logEntries, stop, init, stderr: () => stderr, notifications, tty, watchesFile, readWatches };
}

// Spawns the server with a broken env and returns { code, stderr } once it exits.
function runExpectingExit(env) {
  return new Promise((res) => {
    const childEnv = { ...process.env, PATH: `${FAKE_BIN}${delimiter}${process.env.PATH}`,
      HOME: mkdtempSync(join(tmpdir(), 'slurm-mcp-env-')), HPC_HOST: 'fake', HPC_USER: 'u', SLURM_ACCOUNT: 'acct', ...env };
    delete childEnv.SLURM_MCP_NO_START;
    const c = spawn(process.execPath, [join(ROOT, 'index.mjs')], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(c);
    let stderr = '';
    c.stderr.on('data', d => { stderr += d; });
    const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } }, 10_000);
    c.on('exit', (code) => { clearTimeout(t); children.delete(c); res({ code, stderr }); });
  });
}

const seedWatch = (over) => ({
  jobId: '541806', host: 'fake', jobName: 'seeded', submittedAt: new Date().toISOString(),
  estimatedSeconds: 900, partition: 'batch', state: 'PENDING', ...over,
});

async function waitFor(fn, { timeout = 10_000, every = 100 } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last.ok) return last;
    await new Promise(r => setTimeout(r, every));
  }
  return last;
}

const execs = (s) => s.logEntries().filter(e => e.kind === 'exec');
// ssh options in ControlMaster mode ('alive'): the ControlPath that `ssh -G`
// reports is pinned next to ProxyCommand=false; direct mode has BatchMode only (C1).
const cmOpts = (host = 'fake') => ['-o', 'BatchMode=yes', '-o', `ControlPath=/tmp/fake-cm/${host}`, '-o', 'ProxyCommand=false'];
const submitCmd = (s) => execs(s).map(e => e.cmd).find(c => /\| sbatch/.test(c));

describe('normal scenario', async () => {
  // Poller effectively off here so watch/notification state is only changed
  // by the calls under test; the poll path has its own suites below.
  const s = await startServer({ env: { SLURM_MCP_POLL_MS: '600000' } });
  after(() => s.stop());

  test('initialize reports server info', () => {
    assert.equal(s.init.result.serverInfo.name, 'slurm-mcp-server');
  });
  test('initialize declares the logging capability and instructions (B15)', () => {
    assert.deepEqual(s.init.result.capabilities.logging, {});
    assert.match(s.init.result.instructions, /SLURM HPC tools via SSH/);
    assert.equal(s.init.result.serverInfo.instructions, undefined, 'instructions are not stuffed into serverInfo');
  });
  test('heartbeat is written at startup, independent of the poll loop (B2)', async () => {
    // Poller is effectively off here (600s interval): no poll has run.
    const tty = await s.tty();
    const hb = JSON.parse(readFileSync(join(s.home, '.claude', 'hpc-pollers', `${tty}.json`), 'utf8'));
    assert.equal(hb.pid, s.child.pid);
    assert.ok(Date.now() - hb.at < 60_000);
    assert.match((await s.call('slurm_watches')).text, /Last poll: \(not yet polled\)/);
  });
  test('ssh_exec timeout outside 1000..600000 is rejected before any ssh (B6)', async () => {
    const before = s.logEntries().length;
    for (const timeout of [0, 999, 600001, 1500.5]) {
      const r = await s.rpc('tools/call', { name: 'ssh_exec', arguments: { command: 'ls', timeout } });
      const rejected = !!r.error || !!r.result?.isError;
      assert.ok(rejected, `timeout=${timeout}: ${JSON.stringify(r)}`);
    }
    assert.equal(s.logEntries().length, before, 'no master check or exec happened');
    const ok = await s.call('ssh_exec', { command: 'ls', timeout: 1000 });
    assert.equal(ok.isError, false, ok.text);
  });
  test('ssh_exec keeps the full output of compound commands (BUG-2)', async () => {
    const r = await s.call('ssh_exec', { command: 'cd /home/u && ls' });
    assert.equal(r.text, 'a.txt\nb.txt');
  });
  test('ssh_exec blocks 3-line commands and <<-EOF (BUG-3, BUG-4)', async () => {
    for (const command of ['a\nb\nc', 'cat <<-X > f', 'python3.11 -c x']) {
      const r = await s.call('ssh_exec', { command });
      assert.equal(r.isError, true, command); assert.match(r.text, /^BLOCKED:/);
    }
  });
  test('tools/list returns 26 tools', async () => {
    const r = await s.rpc('tools/list', {});
    assert.equal(r.result.tools.length, 26);
    for (const n of ['slurm_submit', 'slurm_watches', 'ssh_exec', 'ssh_write_file', 'cluster_info', 'guide']) {
      assert.ok(r.result.tools.some(t => t.name === n), n);
    }
  });
  test('guide appends HPC_GUIDE_EXTRA as Site-specific guide', async () => {
    const r = await s.call('guide');
    assert.equal(r.isError, false);
    assert.match(r.text, /# Site-specific guide\n## Partitions\nshort allows 1 job per user\./);
  });
  test('ssh_status reports the live master', async () => {
    assert.match((await s.call('ssh_status')).text, /SSH active: Master running/);
  });
  test('cluster_info shows sinfo and Per-user limits from scontrol + sacctmgr', async () => {
    const r = await s.call('cluster_info');
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /batch\*\s+up 2-00:00:00/);
    assert.match(r.text, /=== Per-user limits \(partition QoS only; association\/job QoS not queried\) ===/);
    assert.match(r.text, /^batch: MaxTime=2-00:00:00 MaxJobsPU=n\/a MaxTRESPU=none$/m);
    assert.match(r.text, /^short: MaxTime=04:00:00 MaxJobsPU=1 MaxTRESPU=cpu=32,gres\/gpu=2,mem=256G \(QoS shortqos\)$/m);
  });
  test('every remote exec goes through BatchMode + ProxyCommand=false + bash --login -c (C1)', () => {
    const e = execs(s);
    assert.ok(e.length > 0);
    for (const x of e) {
      assert.deepEqual(x.argv.slice(0, 7), [...cmOpts(), 'fake']);
      assert.equal(x.wrapped, true, x.argv.at(-1));
    }
  });
  test('slurm_submit rejects invalid parameters without touching ssh', async () => {
    const before = execs(s).length;
    for (const args of [{ job_name: "bad'name" }, { array: '1-3;rm' }, { mem: '4GB' }, { time: '1h' }, { dependency: 'afterok:1;x' }, { output_dir: '/a b' }]) {
      const r = await s.call('slurm_submit', { script: 'echo hi', ...args });
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(r.text, /Submit rejected \(invalid parameters\)/);
    }
    assert.equal(execs(s).length, before);
  });
  test('slurm_submit unknown template is an error', async () => {
    const r = await s.call('slurm_submit', { script: 'echo hi', template: 'nope' });
    assert.equal(r.isError, true); assert.match(r.text, /Unknown template "nope"/);
  });
  test('workdir_set rejects quotes / relative paths', async () => {
    assert.equal((await s.call('workdir_set', { path: "/home/u/it's" })).isError, true);
    assert.equal((await s.call('workdir_set', { path: 'rel/dir' })).isError, true);
  });
  test('slurm_submit (plain) builds the expected script and registers a watch', async () => {
    assert.equal((await s.call('workdir_set', { path: '/home/u/proj' })).isError, false);
    const r = await s.call('slurm_submit', { script: "echo 'hi there'", job_name: 'train', partition: 'batch', dependency: 'afterok:541000' });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /Submitted batch job 541806/);
    assert.match(r.text, /Watch registered: job 541806/);
    const cmd = submitCmd(s);
    assert.ok(cmd, 'sbatch command logged');
    const eof = cmd.match(/cat <<'(SLURM_EOF_[0-9a-f]{12})' \| sbatch\n/);
    assert.ok(eof, 'random quoted heredoc delimiter');
    assert.ok(cmd.trimEnd().endsWith(`\n${eof[1]}`), 'script closed by the same delimiter');
    assert.match(cmd, /^mkdir -p '\/home\/u\/proj\/results\/logs' && /);
    for (const line of ['#!/bin/bash', '#SBATCH --account=acct', '#SBATCH --partition=batch', '#SBATCH --job-name=train',
      '#SBATCH --time=00:15:00', '#SBATCH --mem=4G', '#SBATCH --output=/home/u/proj/results/logs/slurm_%j.out',
      '#SBATCH --gres=gpu:1', '#SBATCH --dependency=afterok:541000', 'module load x', "cd -- '/home/u/proj' || exit 1", "echo 'hi there'"]) {
      assert.ok(cmd.split('\n').includes(line), `missing line: ${line}`);
    }
    assert.ok(!/--array/.test(cmd));
    // The user's single quotes survive the ssh-level quoting.
    const raw = execs(s).find(e => e.cmd === cmd).argv.at(-1);
    assert.ok(raw.includes(`echo '"'"'hi there'"'"'`), 'single quotes escaped as \'"\'"\'');
    const w = await s.call('slurm_watches');
    assert.match(w.text, /541806 \(train\)/);
  });
  test('slurm_submit array: --array, slurm_%A_%a.out, cap hint on short', async () => {
    const r = await s.call('slurm_submit', { script: 'echo $SLURM_ARRAY_TASK_ID', job_name: 'arr', partition: 'short', array: '1-2', preamble: false, time: '00:03:00' });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /array 1-2: notifies once ALL tasks finish/);
    assert.match(r.text, /Partition short allows 1 concurrent job\(s\) per user/);
    const cmd = execs(s).map(e => e.cmd).filter(c => /\| sbatch/.test(c)).at(-1);
    assert.ok(cmd.includes('\n#SBATCH --array=1-2\n'));
    assert.ok(cmd.includes('\n#SBATCH --output=/home/u/proj/results/logs/slurm_%A_%a.out\n'));
    assert.ok(!cmd.includes('module load x'), 'preamble:false honoured');
  });
  test('slurm_submit cap hints for gpus/mem/time over the short QoS', async () => {
    const r = await s.call('slurm_submit', { script: 'echo hi', job_name: 'big', partition: 'short', gpus: 4, mem: '512G', time: '05:00:00' });
    assert.match(r.text, /gpus=4 exceeds per-user cap gres\/gpu=2/);
    assert.match(r.text, /mem=512G exceeds per-user cap mem=256G/);
    assert.match(r.text, /time=05:00:00 exceeds short MaxTime=04:00:00/);
  });
  test('slurm_submit workdir conflict is blocked', async () => {
    const r = await s.call('slurm_submit', { script: 'cd /elsewhere && python x.py' });
    assert.equal(r.isError, true); assert.match(r.text, /工作目录冲突/);
  });
  test('relative output_dir with a workdir: mkdir target and #SBATCH --output are the same absolute dir (BUG-1)', async () => {
    const r = await s.call('slurm_submit', { script: 'echo hi', job_name: 'rel', output_dir: 'logs' });
    assert.equal(r.isError, false, r.text);
    const cmd = execs(s).map(e => e.cmd).filter(c => /\| sbatch/.test(c)).at(-1);
    assert.match(cmd, /^mkdir -p '\/home\/u\/proj\/logs' && /);
    assert.ok(cmd.includes('\n#SBATCH --output=/home/u/proj/logs/slurm_%j.out\n'), cmd.split('\n').find(l => l.includes('--output')));
  });
  test('time is trimmed before validation and written trimmed (BUG-7)', async () => {
    const r = await s.call('slurm_submit', { script: 'echo hi', job_name: 'trim', time: ' 00:05:00\n' });
    assert.equal(r.isError, false, r.text);
    const cmd = execs(s).map(e => e.cmd).filter(c => /\| sbatch/.test(c)).at(-1);
    assert.ok(cmd.includes('\n#SBATCH --time=00:05:00\n'), cmd);
  });
  test('slurm_submit accepts array steps and rejects id-less after* dependencies (BUG-9, BUG-10)', async () => {
    const bad = await s.call('slurm_submit', { script: 'echo hi', dependency: 'afterok' });
    assert.equal(bad.isError, true); assert.match(bad.text, /dependency "afterok"/);
    const ok = await s.call('slurm_submit', { script: 'echo hi', job_name: 'step', array: '1-9:2%2' });
    assert.equal(ok.isError, false, ok.text);
    assert.ok(execs(s).map(e => e.cmd).filter(c => /\| sbatch/.test(c)).at(-1).includes('\n#SBATCH --array=1-9:2%2\n'));
  });
  test('resource_check with no history suggests a benchmark (B9)', async () => {
    const r = await s.call('resource_check', { job_name: 'train' });
    assert.match(r.text, /No resource data for "train"\. Run a 1-seed benchmark first\./);
  });
  test('slurm_submit_file registers a watch', async () => {
    const r = await s.call('slurm_submit_file', { path: '/home/u/proj/run.slurm' });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /Watch registered: job 541806/);
    assert.ok(s.readWatches().some(w => w.jobName === 'run.slurm'));
  });
  test('slurm_cancel / slurm_status quote array ids; invalid ids rejected', async () => {
    assert.match((await s.call('slurm_cancel', { job_id: '541822_[1-2]' })).text, /Job 541822_\[1-2\] cancelled/);
    assert.ok(execs(s).some(e => e.cmd.startsWith("scancel '541822_[1-2]'")));
    assert.equal((await s.call('slurm_cancel', { job_id: '1;rm -rf ~' })).isError, true);
    const st = await s.call('slurm_status', { job_id: '541806_3' });
    assert.match(st.text, /=== sacct ===/);
    assert.ok(execs(s).some(e => e.cmd === "squeue -j '541806_3'"));
  });
  test('slurm_logs reads the sacct StdOut path', async () => {
    const r = await s.call('slurm_logs', { job_id: '541806', lines: 5 });
    assert.match(r.text, /epoch 2 loss 0\.5/);
    assert.ok(execs(s).some(e => e.cmd === "tail -n 5 '/home/u/proj/results/logs/slurm_541806.out'"));
  });
  test('ssh_exec runs allowed commands', async () => {
    const r = await s.call('ssh_exec', { command: 'ls /home/u/proj' });
    assert.equal(r.text, 'a.txt\nb.txt');
  });
  test('ssh_exec guard blocks heredoc, python -c, quotes, >500 chars — before any ssh', async () => {
    const before = s.logEntries().length;
    for (const command of ['cat <<EOF > f', 'python3 -c import\\ os', 'echo "x"', "echo 'x'", `ls ${'a'.repeat(501)}`]) {
      const r = await s.call('ssh_exec', { command });
      assert.equal(r.isError, true, command);
      assert.match(r.text, /^BLOCKED:/);
    }
    assert.equal(s.logEntries().length, before, 'guard rejects without a master check or exec');
  });
  test('ssh_write_file pipes content via stdin with BatchMode and a quoted path', async () => {
    const r = await s.call('ssh_write_file', { path: "/home/u/proj/it's here.txt", content: 'hello\n' });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /Written 6 bytes/);
    const w = s.logEntries().filter(e => e.kind === 'write').at(-1);
    assert.deepEqual(w.argv.slice(0, 7), [...cmOpts(), 'fake']);
    assert.equal(w.path, "/home/u/proj/it's here.txt");
    assert.equal(w.bytes, 6);
  });
  test('sync_files uses rsync -e "ssh -o BatchMode=yes -o ProxyCommand=false" and validates paths (C1)', async () => {
    const r = await s.call('sync_files', { direction: 'upload', local_path: '/tmp/x', remote_path: '~/x' });
    assert.equal(r.isError, false, r.text);
    const rs = s.logEntries().filter(e => e.kind === 'rsync').at(-1);
    assert.deepEqual(rs.argv, ['-avz', '--partial', '-s', '-e', 'ssh -o BatchMode=yes -o ControlPath=/tmp/fake-cm/fake -o ProxyCommand=false', '--', '/tmp/x', 'fake:~/x']);
    await s.call('sync_files', { direction: 'download', local_path: '/tmp/y', remote_path: '-evil' });
    assert.deepEqual(s.logEntries().filter(e => e.kind === 'rsync').at(-1).argv.slice(-3), ['--', 'fake:-evil', '/tmp/y'], 'paths after "--" (R12)');
    assert.equal((await s.call('sync_files', { direction: 'upload', local_path: '/tmp/x;rm', remote_path: '~' })).isError, true);
  });
  test('template_save + template_list round trip', async () => {
    await s.call('template_save', { name: 'gpu', partition: 'short', gpus: 2 });
    assert.match((await s.call('template_list')).text, /gpu: \{"partition":"short","gpus":2\}/);
  });
});

describe('normal scenario: watch poller', async () => {
  const s = await startServer();
  after(() => s.stop());
  test('completes the plain job, notification drained exactly once', async () => {
    const r0 = await s.call('slurm_submit', { script: 'echo hi', job_name: 'train' });
    assert.match(r0.text, /Submitted batch job 541806/);
    const r = await waitFor(async () => {
      const w = await s.call('slurm_watches'); // does not drain
      return { ok: /SLURM job 541806 \(train\) COMPLETED/.test(w.text), text: w.text };
    });
    assert.ok(r.ok, r.text);
    assert.match(r.text, /\(no watches for this window\)/);
    // Next ordinary tool call drains the notification (piggyback) exactly once.
    const a = await s.call('workdir_get');
    assert.match(a.text, /--- SLURM Notifications ---\n✅ SLURM job 541806 \(train\) COMPLETED/);
    const b = await s.call('workdir_get');
    assert.doesNotMatch(b.text, /SLURM Notifications/);
  });
  test('completion is pushed as an MCP notifications/message, logged only after it was sent (B15)', async () => {
    const n = await waitFor(async () => {
      const m = s.notifications.find(x => x.method === 'notifications/message');
      return { ok: !!m, m };
    });
    assert.ok(n.ok, 'no notifications/message received');
    assert.equal(n.m.params.level, 'warning');
    assert.equal(n.m.params.logger, 'slurm-watch');
    assert.match(n.m.params.data, /✅ SLURM job 541806 \(train\) COMPLETED/);
    const sent = await waitFor(async () => ({ ok: /MCP logging notification sent: ✅ SLURM job 541806/.test(s.stderr()) }));
    assert.ok(sent.ok, s.stderr());
  });
});

describe('multi-cluster watches (B1)', async () => {
  test('same job id on two clusters: completion on one keeps the other watch', async () => {
    // "other"'s master is dead, so only fake's 541806 can complete.
    const s = await startServer({ env: { HPC_HOST: 'fake,other', FAKE_DEAD_HOSTS: 'other' } });
    try {
      const tty = await s.tty();
      writeFileSync(s.watchesFile, JSON.stringify([
        seedWatch({ tty, host: 'fake', jobName: 'on-fake' }),
        seedWatch({ tty, host: 'other', jobName: 'on-other' }),
      ]));
      const done = await waitFor(async () => {
        const w = await s.call('slurm_watches');
        return { ok: /SLURM job 541806 \(on-fake\) COMPLETED/.test(w.text), text: w.text };
      });
      assert.ok(done.ok, done.text);
      await new Promise(r => setTimeout(r, 600)); // a few more cycles
      const left = s.readWatches();
      assert.deepEqual(left.map(w => `${w.host}|${w.jobId}|${w.jobName}`), ['other|541806|on-other']);
    } finally { await s.stop(); }
  });
  test('slurm_cancel removes only the active cluster\'s watch', async () => {
    const s = await startServer({ env: { HPC_HOST: 'fake,other', SLURM_MCP_POLL_MS: '600000' } });
    try {
      const tty = await s.tty();
      writeFileSync(s.watchesFile, JSON.stringify([
        seedWatch({ tty, host: 'fake', jobName: 'on-fake' }),
        seedWatch({ tty, host: 'other', jobName: 'on-other' }),
        seedWatch({ tty, host: undefined, jobId: '541807', jobName: 'legacy-no-host' }),
      ]));
      const r = await s.call('slurm_cancel', { job_id: '541806' });
      assert.equal(r.isError, false, r.text);
      assert.deepEqual(s.readWatches().map(w => w.jobName), ['on-other', 'legacy-no-host']);
      // A host-less (pre-multi-cluster) watch belongs to the first cluster.
      await s.call('slurm_cancel', { job_id: '541807' });
      assert.deepEqual(s.readWatches().map(w => w.jobName), ['on-other']);
    } finally { await s.stop(); }
  });
});

describe('poller robustness', async () => {
  test('watch host from the shared file is whitelisted before any ssh (BUG-13, R8)', async () => {
    const s = await startServer();
    try {
      const tty = await s.tty();
      const marker = join(s.dir, 'pwned');
      const evilHost = `fake;touch ${marker}`;
      writeFileSync(s.watchesFile, JSON.stringify([
        seedWatch({ tty, host: evilHost, jobName: 'evil' }),
        seedWatch({ tty, host: '-oProxyCommand=touch', jobName: 'opt' }),
        seedWatch({ tty, jobId: 541806, jobName: 'numeric-id' }), // hand-edited: number, not string
      ]));
      const done = await waitFor(async () => {
        const w = await s.call('slurm_watches');
        return { ok: /SLURM job 541806 \(numeric-id\) COMPLETED/.test(w.text), text: w.text };
      });
      assert.ok(done.ok, `numeric jobId watch is polled, not dropped: ${done.text}`);
      const hosts = s.logEntries().filter(e => e.kind === 'control').map(e => e.argv.at(-1));
      assert.ok(hosts.length > 0 && hosts.every(h => h === 'fake'), JSON.stringify(hosts));
      assert.equal(existsSync(marker), false, 'no shell interpreted the host');
    } finally { await s.stop(); }
  });
  test('ssh_status passes the host as argv (BUG-13)', async () => {
    const s = await startServer({ env: { SLURM_MCP_POLL_MS: '600000' } });
    try {
      assert.match((await s.call('ssh_status')).text, /^SSH active: Master running/);
      const c = s.logEntries().filter(e => e.kind === 'control').at(-1);
      assert.deepEqual(c.argv, ['-O', 'check', 'fake']);
    } finally { await s.stop(); }
  });
  test('notification write failure keeps the watch and retries (B4)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'slurm-mcp-home-'));
    // A non-empty directory where the notifications file should be: every
    // save (tmp + rename) fails.
    const notifPath = join(home, '.claude', 'slurm-notifications.json');
    mkdirSync(join(notifPath, 'blocker'), { recursive: true });
    const s = await startServer({ home });
    try {
      const r0 = await s.call('slurm_submit', { script: 'echo hi', job_name: 'keep' });
      assert.match(r0.text, /Submitted batch job 541806/);
      await waitFor(async () => ({ ok: /Notification for job 541806 not persisted/.test(s.stderr()) }));
      await new Promise(r => setTimeout(r, 800)); // several failing cycles
      assert.match(s.stderr(), /Notification for job 541806 not persisted; keeping the watch/);
      assert.match((await s.call('slurm_watches')).text, /541806 \(keep\)/, 'watch kept while the notification cannot be stored');
      rmSync(notifPath, { recursive: true, force: true }); // disk "recovers"
      const done = await waitFor(async () => {
        const w = await s.call('slurm_watches');
        return { ok: /✅ SLURM job 541806 \(keep\) COMPLETED/.test(w.text), text: w.text };
      });
      assert.ok(done.ok, done.text);
      assert.match(done.text, /\(no watches for this window\)/);
    } finally { await s.stop(); }
  });
});

describe('env validation at startup (B14)', () => {
  const bad = [
    [{ HPC_HOST: 'fake;rm' }, /HPC_HOST contains an invalid entry "fake;rm"/],
    [{ HPC_HOST: 'fake, bad host' }, /HPC_HOST contains an invalid entry "bad host"/],
    [{ HPC_USER: 'u$(id)' }, /HPC_USER contains an invalid entry/],
    [{ SLURM_ACCOUNT: "acct'x" }, /SLURM_ACCOUNT contains an invalid entry/],
    [{ HPC_RESOURCE_LOG: '/data/$(id).tsv' }, /HPC_RESOURCE_LOG contains unsafe characters/],
    [{ HPC_RESOURCE_LOG: '/data/a b.tsv' }, /HPC_RESOURCE_LOG contains quotes or whitespace/],
    [{ SLURM_DEFAULT_GPUS: '-1' }, /SLURM_DEFAULT_GPUS "-1" must be a non-negative integer/],
    [{ SLURM_DEFAULT_PARTITION: 'a;b' }, /SLURM_DEFAULT_PARTITION "a;b" must match/],
  ];
  for (const [env, re] of bad) {
    test(`exits 1 on ${JSON.stringify(env)}`, async () => {
      const { code, stderr } = await runExpectingExit(env);
      assert.equal(code, 1);
      assert.match(stderr, re);
    });
  }
});

describe('site defaults (B13)', () => {
  test('SLURM_DEFAULT_PARTITION / SLURM_DEFAULT_GPUS=0: no --gres line', async () => {
    const s = await startServer({ env: { SLURM_DEFAULT_PARTITION: 'cpu-only', SLURM_DEFAULT_GPUS: '0', SLURM_MCP_POLL_MS: '600000' } });
    try {
      const tools = (await s.rpc('tools/list', {})).result.tools;
      const props = tools.find(t => t.name === 'slurm_submit').inputSchema.properties;
      assert.match(props.partition.description, /default: cpu-only/);
      assert.match(props.gpus.description, /default: 0/);
      const r = await s.call('slurm_submit', { script: 'echo hi', job_name: 'cpu' });
      assert.equal(r.isError, false, r.text);
      const cmd = submitCmd(s);
      assert.ok(cmd.includes('\n#SBATCH --partition=cpu-only\n'), cmd);
      assert.ok(!/--gres/.test(cmd), 'no --gres with SLURM_DEFAULT_GPUS=0');
    } finally { await s.stop(); }
  });
  test('SLURM_DEFAULT_GPUS=2 → --gres=gpu:2; explicit gpus still wins', async () => {
    const s = await startServer({ env: { SLURM_DEFAULT_GPUS: '2', SLURM_MCP_POLL_MS: '600000' } });
    try {
      await s.call('slurm_submit', { script: 'echo hi', job_name: 'g2' });
      assert.ok(submitCmd(s).includes('\n#SBATCH --gres=gpu:2\n'));
      await s.call('slurm_submit', { script: 'echo hi', job_name: 'g1', gpus: 1 });
      assert.ok(execs(s).map(e => e.cmd).filter(c => /\| sbatch/.test(c)).at(-1).includes('\n#SBATCH --gres=gpu:1\n'));
    } finally { await s.stop(); }
  });
});

describe('resource history (B7, B8, B9)', () => {
  test('two-step sacct: MaxRSS from step rows, distinct job count, pattern match', async () => {
    const s = await startServer({ env: { FAKE_RESOURCE_HISTORY: 'rows', SLURM_MCP_POLL_MS: '600000' } });
    try {
      const r = await s.call('resource_check', { job_name: 'train' });
      assert.equal(r.isError, false, r.text);
      assert.match(r.text, /=== SLURM sacct \(last 7 days\) ===/);
      assert.match(r.text, /541806\.batch\|batch\|00:10:00\|1\.50G/);
      assert.match(r.text, /Resource baseline \(4 recent jobs\)/);
      assert.match(r.text, /Actual peak: 3\.0G mem, 60m0s time/);
      const cmds = execs(s).map(e => e.cmd);
      // hetjob component ids ("541810+0") pass the step-1 filter (R10)
      assert.ok(cmds.includes('sacct -j 541806,541807,541809_1,541810+0 -o JobID%-20,JobName%-20,Elapsed,MaxRSS,ReqMem,State -P -n'), cmds.join('\n'));
      // start date computed locally, no GNU `date -d` on the cluster (R10)
      const step1 = cmds.find(c => c.startsWith('sacct -u '));
      assert.match(step1, /^sacct -u 'u' -X -S \d{4}-\d{2}-\d{2} -o /);
      assert.doesNotMatch(cmds.join('\n'), /date -d/);
      const sub = await s.call('slurm_submit', { script: 'echo hi', job_name: 'train', mem: '200G' });
      assert.match(sub.text, /Resource baseline \(4 recent jobs\)/);
      assert.match(sub.text, /Memory 200G is 67x actual usage \(3\.0G\)/);
    } finally { await s.stop(); }
  });
  test('sacct failure is reported as unavailable, not as "run a benchmark"', async () => {
    const s = await startServer({ env: { FAKE_RESOURCE_HISTORY: 'fail', SLURM_MCP_POLL_MS: '600000' } });
    try {
      const r = await s.call('resource_check', { job_name: 'train' });
      assert.match(r.text, /resource history unavailable: .*Problem talking to the database/);
      assert.doesNotMatch(r.text, /benchmark/);
      const sub = await s.call('slurm_submit', { script: 'echo hi', job_name: 'train' });
      assert.equal(sub.isError, false, sub.text);
      assert.match(sub.text, /⚠️ resource history unavailable: .*Problem talking to the database/);
    } finally { await s.stop(); }
  });
  test('HPC_RESOURCE_LOG: match shown; missing file reported as unavailable', async () => {
    const s = await startServer({ env: { HPC_RESOURCE_LOG: '/data/runs.tsv', SLURM_MCP_POLL_MS: '600000' } });
    try {
      const r = await s.call('resource_check', { job_name: 'train' });
      assert.match(r.text, /=== External resource log ===\ntrain\t2\.1G/);
    } finally { await s.stop(); }
    const m = await startServer({ env: { HPC_RESOURCE_LOG: '/data/missing.tsv', SLURM_MCP_POLL_MS: '600000' } });
    try {
      const r = await m.call('resource_check', { job_name: 'train' });
      assert.match(r.text, /resource log unavailable: grep: \/data\/missing\.tsv: No such file or directory/);
      assert.doesNotMatch(r.text, /benchmark/);
    } finally { await m.stop(); }
  });
});

describe('slurm_logs fallbacks (B10)', () => {
  test('sacct StdOut with an unexpanded %j falls back to scontrol', async () => {
    const s = await startServer({ env: { FAKE_STDOUT: 'placeholder', FAKE_SCONTROL_STDOUT: '/scratch/u/from-scontrol_541806.out', SLURM_MCP_POLL_MS: '600000' } });
    try {
      const r = await s.call('slurm_logs', { job_id: '541806', lines: 5 });
      assert.match(r.text, /epoch 2 loss 0\.5/);
      assert.ok(execs(s).some(e => e.cmd === "tail -n 5 '/scratch/u/from-scontrol_541806.out'"));
      assert.ok(!execs(s).some(e => /%j/.test(e.cmd) && /^(tail|cat) /.test(e.cmd)), 'never reads the literal %j path');
    } finally { await s.stop(); }
  });
  test('no scontrol: the %j pattern is expanded for a plain job id', async () => {
    const s = await startServer({ env: { FAKE_STDOUT: 'placeholder', FAKE_LS_EXISTS: '/home/u/proj/results/logs/slurm_541806.out', SLURM_MCP_POLL_MS: '600000' } });
    try {
      const r = await s.call('slurm_logs', { job_id: '541806', lines: 5 });
      assert.match(r.text, /epoch 2 loss 0\.5/, r.text);
      assert.ok(execs(s).some(e => e.cmd === "tail -n 5 '/home/u/proj/results/logs/slurm_541806.out'"));
    } finally { await s.stop(); }
  });
  test('array task "541822_4": workdir fallback finds slurm_<A>_<a>.out', async () => {
    const s = await startServer({ env: { FAKE_STDOUT: 'empty', FAKE_LS_EXISTS: '/home/u/proj/results/logs/slurm_541822_4.out', SLURM_MCP_POLL_MS: '600000' } });
    try {
      await s.call('workdir_set', { path: '/home/u/proj' });
      const r = await s.call('slurm_logs', { job_id: '541822_4', lines: 5 });
      assert.match(r.text, /epoch 2 loss 0\.5/, r.text);
      assert.ok(execs(s).some(e => e.cmd === "tail -n 5 '/home/u/proj/results/logs/slurm_541822_4.out'"));
    } finally { await s.stop(); }
  });
});

describe('partial failures (B11, B12)', () => {
  test('slurm_status: squeue failing (job left the queue) still shows sacct history', async () => {
    const s = await startServer({ env: { FAKE_SQUEUE_FAIL: '1', SLURM_MCP_POLL_MS: '600000' } });
    try {
      const r = await s.call('slurm_status', { job_id: '541806' });
      assert.equal(r.isError, false, r.text);
      assert.match(r.text, /=== squeue ===\n\(squeue: slurm_load_jobs error: Invalid job id specified — job left the queue; sacct below\)\n/);
      // D3: only the remote stderr line, never the local ssh command line.
      assert.doesNotMatch(r.text, /ControlPath=|Command failed|bash --login/);
      assert.match(r.text, /=== sacct ===\n[\s\S]*541806\s+train\s+batch/);
    } finally { await s.stop(); }
  });
  test('cluster_info: sacctmgr failure keeps partition MaxTime, marks QoS unavailable', async () => {
    const s = await startServer({ env: { FAKE_SACCTMGR_FAIL: '1', SLURM_MCP_POLL_MS: '600000' } });
    try {
      const r = await s.call('cluster_info');
      assert.equal(r.isError, false, r.text);
      assert.match(r.text, /^short: MaxTime=04:00:00 \(QoS limits unavailable\)$/m);
      assert.match(r.text, /^batch: MaxTime=2-00:00:00 \(QoS limits unavailable\)$/m);
      assert.match(r.text, /QoS limits unavailable \(sacctmgr query failed\)/);
      // Time cap hint still works from the partition MaxTime alone.
      const sub = await s.call('slurm_submit', { script: 'echo hi', job_name: 't', partition: 'short', time: '05:00:00' });
      assert.match(sub.text, /time=05:00:00 exceeds short MaxTime=04:00:00/);
    } finally { await s.stop(); }
  });
});

describe('array scenario', async () => {
  const s0 = mkdtempSync(join(tmpdir(), 'slurm-mcp-gate-'));
  const gate = join(s0, 'release');
  const s = await startServer({ scenario: 'array', env: { FAKE_ARRAY_GATE: gate } });
  after(() => s.stop());

  test('partial completion stays RUNNING, full completion notifies "2 ok / 0 failed"', async () => {
    const r = await s.call('slurm_submit', { script: 'echo $SLURM_ARRAY_TASK_ID', job_name: 'arr', array: '1-2' });
    assert.match(r.text, /Submitted batch job 541822/);
    const partial = await waitFor(async () => {
      const w = await s.call('slurm_watches');
      return { ok: /541822 \(arr\) \[RUNNING tasks done 1\/2\]/.test(w.text), text: w.text };
    });
    assert.ok(partial.ok, partial.text);
    // sacct sees the job → no expiry clock (R4)
    const seen = s.readWatches().find(w => w.jobId === '541822');
    assert.equal(seen.unseenSince, undefined, JSON.stringify(seen));
    // Several more polls while task 2 is still running: must not complete.
    await new Promise(res => setTimeout(res, 1000));
    const still = await s.call('slurm_watches');
    assert.match(still.text, /\[RUNNING tasks done 1\/2\]/);
    assert.doesNotMatch(still.text, /finished/);
    writeFileSync(gate, '');
    const done = await waitFor(async () => {
      const w = await s.call('slurm_watches');
      return { ok: /✅ SLURM array job 541822 \(arr\) finished: 2 ok \/ 0 failed/.test(w.text), text: w.text };
    });
    assert.ok(done.ok, done.text);
    assert.match(done.text, /\(no watches for this window\)/);
  });
});

describe('cancelled_by scenario', async () => {
  const s = await startServer({ scenario: 'cancelled_by' });
  after(() => s.stop());
  test('"CANCELLED by <uid>" is terminal and notifies', async () => {
    const r = await s.call('slurm_submit', { script: 'sleep 100', job_name: 'cx' });
    assert.match(r.text, /Submitted batch job 541900/);
    const done = await waitFor(async () => {
      const w = await s.call('slurm_watches');
      return { ok: /❌ SLURM job 541900 \(cx\) CANCELLED by 12345/.test(w.text), text: w.text };
    });
    assert.ok(done.ok, done.text);
    assert.match(done.text, /\(no watches for this window\)/);
  });
});

describe('master_dead scenario', async () => {
  const s = await startServer({ scenario: 'master_dead' });
  after(() => s.stop());
  test('ssh_exec / ssh_write_file / sync_files fail fast without any remote call', async () => {
    const e = await s.call('ssh_exec', { command: 'ls' });
    assert.equal(e.isError, true); assert.match(e.text, /SSH master connection to fake is dead/);
    const w = await s.call('ssh_write_file', { path: '/home/u/x', content: 'x' });
    assert.equal(w.isError, true); assert.match(w.text, /Write failed: SSH master connection to fake is dead/);
    const y = await s.call('sync_files', { direction: 'upload', local_path: '/tmp/x', remote_path: '~/x' });
    assert.equal(y.isError, true);
    const kinds = s.logEntries().map(x => x.kind);
    assert.ok(kinds.length > 0 && kinds.every(k => k === 'control'), JSON.stringify(kinds));
  });
  test('poller pauses the watch and reports the dead master', async () => {
    const home = s.home;
    writeFileSync(join(home, '.claude', 'slurm-watches.json'), '[]');
    // Seed a watch for this window via slurm_watches' tty label.
    const tty = (await s.call('slurm_watches')).text.match(/tty=([^)]+)\)/)[1];
    writeFileSync(join(home, '.claude', 'slurm-watches.json'), JSON.stringify([{
      jobId: '541806', tty, host: 'fake', jobName: 'dead', submittedAt: new Date().toISOString(), estimatedSeconds: 900, partition: 'batch', state: 'PENDING',
    }]));
    const r = await waitFor(async () => {
      const w = await s.call('slurm_watches');
      return { ok: /Last poll error: SSH master to fake is dead/.test(w.text), text: w.text };
    });
    assert.ok(r.ok, r.text);
    assert.match(r.text, /541806 \(dead\) \[PENDING\]/);
    assert.ok(s.logEntries().every(x => x.kind === 'control'));
  });
});

describe('sbatch_fail scenario', async () => {
  const s = await startServer({ scenario: 'sbatch_fail' });
  after(() => s.stop());
  test('submit failure is an error and registers no watch', async () => {
    const r = await s.call('slurm_submit', { script: 'echo hi', job_name: 'f' });
    assert.equal(r.isError, true);
    assert.match(r.text, /Submit failed: [\s\S]*Invalid account or account\/partition combination/);
    assert.match((await s.call('slurm_watches')).text, /\(no watches for this window\)/);
  });
});

describe('corrupt / malformed state files', async () => {
  test('corrupt slurm-watches.json is quarantined, submit still works', async () => {
    const home = mkdtempSync(join(tmpdir(), 'slurm-mcp-home-'));
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'slurm-watches.json'), '[{"jobId":');
    const s = await startServer({ home });
    try {
      const r = await s.call('slurm_submit', { script: 'echo hi', job_name: 'q' });
      assert.equal(r.isError, false, r.text);
      assert.ok(readFileSync(join(home, '.claude', 'slurm-watches.json'), 'utf8').includes('541806'));
    } finally { await s.stop(); }
  });
  test('malformed entries in slurm-watches.json are skipped; submit, watches and guide work (BUG-5)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'slurm-mcp-home-'));
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'slurm-watches.json'), '[null, 7, {"jobId": 5}, {"jobName": "no-id"}]');
    const s = await startServer({ home });
    try {
      const r = await s.call('slurm_submit', { script: 'echo hi', job_name: 'n' });
      assert.ok(submitCmd(s), 'sbatch did run');
      assert.equal(r.isError, false, r.text);
      assert.match(r.text, /Watch registered: job 541806/);
      assert.equal((await s.call('slurm_watches')).isError, false);
      assert.equal((await s.call('guide')).isError, false);
      const f = await s.call('slurm_submit_file', { path: '/home/u/run.sh' });
      assert.equal(f.isError, false, f.text);
    } finally { await s.stop(); }
  });
  test('watch registration failure after a successful sbatch is a warning, never isError (BUG-5)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'slurm-mcp-home-'));
    // A non-empty directory where the watch file should be: every save fails.
    mkdirSync(join(home, '.claude', 'slurm-watches.json', 'blocker'), { recursive: true });
    const s = await startServer({ home, env: { SLURM_MCP_POLL_MS: '600000' } });
    try {
      const r = await s.call('slurm_submit', { script: 'echo hi', job_name: 'w' });
      assert.equal(r.isError, false, r.text);
      assert.match(r.text, /Submitted batch job 541806\n⚠️ The job IS queued \(do not resubmit\), but watch registration failed: /);
      const f = await s.call('slurm_submit_file', { path: '/home/u/run.sh' });
      assert.equal(f.isError, false, f.text);
      assert.match(f.text, /The job IS queued \(do not resubmit\), but watch registration failed/);
    } finally { await s.stop(); }
  });
});

describe('lifecycle', () => {
  test('server exits when stdin closes (no leftover process)', async () => {
    const s = await startServer();
    await s.stop();
    assert.ok(s.child.exitCode === 0 || s.child.signalCode != null, `exit ${s.child.exitCode}/${s.child.signalCode}`);
    assert.equal(s.child.exitCode, 0, 'clean exit via stdin close, not SIGKILL');
  });
});

// ---- Round-3 review fixes (R1-R13) ----

describe('env whitelists accept real-world values (R1)', () => {
  test('HPC_HOST=user@host, HPC_USER with @, SLURM_DEFAULT_PARTITION=gpu.a100', async () => {
    const s = await startServer({ env: { HPC_HOST: 'u@fake', HPC_USER: 'u@ad.example.edu', SLURM_DEFAULT_PARTITION: 'gpu.a100', SLURM_MCP_POLL_MS: '600000' } });
    try {
      assert.match((await s.call('ssh_status')).text, /SSH active/);
      assert.deepEqual(s.logEntries().filter(e => e.kind === 'control').at(-1).argv, ['-O', 'check', 'u@fake']);
      assert.equal((await s.call('slurm_status')).isError, false);
      assert.ok(execs(s).some(e => e.cmd === "squeue -u 'u@ad.example.edu'"), 'user single-quoted');
      const r = await s.call('slurm_submit', { script: 'echo hi', job_name: 'p' });
      assert.equal(r.isError, false, r.text);
      assert.ok(submitCmd(s).includes('\n#SBATCH --partition=gpu.a100\n'));
      assert.deepEqual(execs(s).at(-1).argv.slice(0, 7), [...cmOpts('u@fake'), 'u@fake']);
    } finally { await s.stop(); }
  });
  test('HPC_USER with a backslash (DOMAIN\\user) survives the ssh quoting', async () => {
    const s = await startServer({ env: { HPC_USER: 'DOMAIN\\u', SLURM_MCP_POLL_MS: '600000' } });
    try {
      assert.equal((await s.call('slurm_status')).isError, false);
      assert.ok(execs(s).some(e => e.cmd === "squeue -u 'DOMAIN\\u'"), JSON.stringify(execs(s).map(e => e.cmd)));
    } finally { await s.stop(); }
  });
  const bad = [
    [{ HPC_HOST: '-oProxyCommand=x' }, /HPC_HOST contains an invalid entry "-oProxyCommand=x"/],
    [{ HPC_HOST: '-oProxyCommand' }, /HPC_HOST contains an invalid entry/],
    [{ HPC_HOST: 'u@-oX' }, /HPC_HOST contains an invalid entry/],
    [{ HPC_USER: '-oProxyCommand=x' }, /HPC_USER contains an invalid entry/],
    [{ HPC_USER: "u'x" }, /HPC_USER contains an invalid entry/],
    [{ SLURM_DEFAULT_PARTITION: '-p' }, /SLURM_DEFAULT_PARTITION "-p" must match/],
    [{ SLURM_ACCOUNT: '-A' }, /SLURM_ACCOUNT contains an invalid entry/],
  ];
  for (const [env, re] of bad) {
    test(`exits 1 on ${JSON.stringify(env)}`, async () => {
      const { code, stderr } = await runExpectingExit(env);
      assert.equal(code, 1);
      assert.match(stderr, re);
    });
  }
});

describe('master_unconfigured scenario (R2)', async () => {
  const s = await startServer({ scenario: 'master_unconfigured' });
  after(() => s.stop());
  test('ssh_status explains the direct BatchMode mode', async () => {
    const r = await s.call('ssh_status');
    assert.equal(r.isError, false);
    assert.match(r.text, /ControlMaster not configured — direct BatchMode connections.*configure ControlMaster \(see README\)/);
  });
  test('tools connect directly with BatchMode instead of reporting a dead master', async () => {
    const r = await s.call('ssh_exec', { command: 'ls /home/u' });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.text, 'a.txt\nb.txt');
    assert.deepEqual(execs(s).at(-1).argv.slice(0, 3), ['-o', 'BatchMode=yes', 'fake']);
  });
  test('the poller completes watches without a ControlMaster', async () => {
    const r0 = await s.call('slurm_submit', { script: 'echo hi', job_name: 'nocm' });
    assert.match(r0.text, /Submitted batch job 541806/);
    const done = await waitFor(async () => {
      const w = await s.call('slurm_watches');
      return { ok: /SLURM job 541806 \(nocm\) COMPLETED/.test(w.text), text: w.text };
    });
    assert.ok(done.ok, done.text);
  });
});

describe('HPC_REQUIRE_MASTER=1 (R2)', async () => {
  const s = await startServer({ scenario: 'master_unconfigured', env: { HPC_REQUIRE_MASTER: '1', SLURM_MCP_POLL_MS: '600000' } });
  after(() => s.stop());
  test('unconfigured is treated as dead: fail fast, no remote traffic', async () => {
    const e = await s.call('ssh_exec', { command: 'ls' });
    assert.equal(e.isError, true);
    assert.match(e.text, /SSH master connection to fake is dead/);
    assert.match((await s.call('ssh_status')).text, /SSH not connected \(HPC_REQUIRE_MASTER=1 and no ControlPath/);
    assert.ok(s.logEntries().every(x => x.kind === 'control'));
  });
});

describe('watch expiry only counts successful polls (R4)', () => {
  test('master dead: a watch older than the TTL is kept (not expired)', async () => {
    const s = await startServer({ scenario: 'master_dead' });
    try {
      const tty = await s.tty();
      const old = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
      writeFileSync(s.watchesFile, JSON.stringify([seedWatch({ tty, jobName: 'outage', submittedAt: old, lastSeenAt: old })]));
      const r = await waitFor(async () => {
        const w = await s.call('slurm_watches');
        return { ok: /Last poll error: SSH master to fake is dead/.test(w.text), text: w.text };
      });
      assert.ok(r.ok, r.text);
      assert.match(r.text, /541806 \(outage\) \[PENDING\]/, 'watch still listed');
      assert.equal(s.readWatches()[0].unseenSince, undefined, 'a failed poll never starts the expiry clock');
    } finally { await s.stop(); }
  });
  test('sacct answers without the job: unseenSince is set once; seen again → cleared', async () => {
    const s0 = mkdtempSync(join(tmpdir(), 'slurm-mcp-miss-'));
    const s = await startServer({ env: { FAKE_SACCT_MISSING: '541806' } });
    try {
      const tty = await s.tty();
      writeFileSync(s.watchesFile, JSON.stringify([seedWatch({ tty, jobName: 'missing' })]));
      const r = await waitFor(async () => ({ ok: !!s.readWatches()[0]?.unseenSince }));
      assert.ok(r.ok, JSON.stringify(s.readWatches()));
      const first = s.readWatches()[0].unseenSince;
      await new Promise(res => setTimeout(res, 700));
      assert.equal(s.readWatches()[0].unseenSince, first, 'not reset by later polls');
      // An entry whose unseenSince is older than the TTL is expired by the
      // next continuous successful poll that still misses the job (F2).
      writeFileSync(s.watchesFile, JSON.stringify([seedWatch({ tty, jobName: 'gone', unseenSince: new Date(Date.now() - 49 * 3600_000).toISOString(), lastQueriedAt: new Date().toISOString() })]));
      const gone = await waitFor(async () => ({ ok: s.readWatches().length === 0 }));
      assert.ok(gone.ok, JSON.stringify(s.readWatches()));
    } finally { await s.stop(); rmSync(s0, { recursive: true, force: true }); }
  });
});

describe('per-host backoff (R6)', () => {
  test('a dead cluster does not delay notifications of a healthy one', async () => {
    const s = await startServer({ env: { HPC_HOST: 'hostA,hostB', FAKE_SCENARIO_BY_HOST: 'hostA:master_dead,hostB:normal' } });
    try {
      const tty = await s.tty();
      writeFileSync(s.watchesFile, JSON.stringify([seedWatch({ tty, host: 'hostA', jobId: '541807', jobName: 'on-dead' })]));
      // Let hostA fail repeatedly until its backoff reaches 4s (250ms base).
      const backed = await waitFor(async () => {
        const w = await s.call('slurm_watches');
        return { ok: /hostA is dead.*backoff [4-9]s/.test(w.text), text: w.text };
      }, { timeout: 15_000 });
      assert.ok(backed.ok, backed.text);
      const watches = s.readWatches();
      watches.push(seedWatch({ tty, host: 'hostB', jobName: 'on-healthy' }));
      writeFileSync(s.watchesFile, JSON.stringify(watches));
      const t0 = Date.now();
      const done = await waitFor(async () => {
        const w = await s.call('slurm_watches');
        return { ok: /SLURM job 541806 \(on-healthy\) COMPLETED/.test(w.text), text: w.text };
      }, { timeout: 15_000, every: 50 });
      const latency = Date.now() - t0;
      assert.ok(done.ok, done.text);
      assert.ok(latency < 2000, `healthy host notified after ${latency}ms`);
      assert.match(done.text, /541807 \(on-dead\)/, 'dead host watch kept');
      // hostA is skipped while backing off: far fewer probes than cycles.
      const probesA = s.logEntries().filter(e => e.kind === 'control' && e.argv.at(-1) === 'hostA').length;
      assert.ok(probesA <= 6, `hostA probed ${probesA} times`);
    } finally { await s.stop(); }
  });
});

describe('slurm_logs array ids (R7)', () => {
  test('multi-line scontrol StdOut (array base id) uses the first path, not "Suspicious"', async () => {
    const s = await startServer({ env: { FAKE_STDOUT: 'empty', FAKE_SCONTROL_STDOUT: '/w/logs/slurm_541822_1.out\n/w/logs/slurm_541822_2.out', SLURM_MCP_POLL_MS: '600000' } });
    try {
      const r = await s.call('slurm_logs', { job_id: '541822', lines: 5 });
      assert.equal(r.isError, false, r.text);
      assert.match(r.text, /epoch 2 loss 0\.5/);
      assert.ok(execs(s).some(e => e.cmd === "tail -n 5 '/w/logs/slurm_541822_1.out'"));
    } finally { await s.stop(); }
  });
});

describe('SLURM_ACCOUNT optional (R9)', () => {
  test('unset: server starts, no #SBATCH --account line', async () => {
    const s = await startServer({ env: { SLURM_ACCOUNT: '', SLURM_MCP_POLL_MS: '600000' } });
    try {
      const r = await s.call('slurm_submit', { script: 'echo hi', job_name: 'noacct' });
      assert.equal(r.isError, false, r.text);
      assert.ok(!/--account/.test(submitCmd(s)), submitCmd(s));
    } finally { await s.stop(); }
  });
  test('per-cluster list with an empty entry: no --account on that cluster', async () => {
    const s = await startServer({ env: { HPC_HOST: 'fake,other', SLURM_ACCOUNT: 'acct,', SLURM_MCP_POLL_MS: '600000' } });
    try {
      await s.call('slurm_submit', { script: 'echo hi', job_name: 'a1' });
      assert.ok(submitCmd(s).includes('\n#SBATCH --account=acct\n'));
      await s.call('cluster_switch', { host: 'other' });
      await s.call('slurm_submit', { script: 'echo hi', job_name: 'a2' });
      const last = execs(s).map(e => e.cmd).filter(c => /\| sbatch/.test(c)).at(-1);
      assert.ok(!/--account/.test(last), last);
    } finally { await s.stop(); }
  });
});

describe('resource_report portability (R10)', () => {
  test('-S date computed locally, user quoted', async () => {
    const s = await startServer({ env: { SLURM_MCP_POLL_MS: '600000' } });
    try {
      await s.call('resource_report', { days: 3 });
      const cmd = execs(s).map(e => e.cmd).find(c => c.startsWith('sacct -u '));
      assert.match(cmd, /^sacct -u 'u' --format=\S+ -P -S \d{4}-\d{2}-\d{2} -n$/);
    } finally { await s.stop(); }
  });
});

describe('tmux tools (R12)', async () => {
  const s = await startServer({ env: { SLURM_MCP_POLL_MS: '600000' } });
  after(() => s.stop());
  const tmuxCalls = () => s.logEntries().filter(e => e.kind === 'tmux').map(e => e.argv);
  test('terminal_send: text is literal after "--", special keys are keys', async () => {
    await s.call('terminal_send', { session: 't1', keys: '-n hi' });
    assert.deepEqual(tmuxCalls().find(a => a[0] === 'send-keys'), ['send-keys', '-t', 't1', '-l', '--', '-n hi']);
    await s.call('terminal_send', { session: 't1', keys: 'Ctrl-C' });
    assert.deepEqual(tmuxCalls().filter(a => a[0] === 'send-keys').at(-1), ['send-keys', '-t', 't1', '--', 'C-c']);
  });
  test('terminal_exec: command literal, then Enter as a key', async () => {
    await s.call('terminal_exec', { session: 't1', command: '-rf echo Enter', wait: 10 });
    const sk = tmuxCalls().filter(a => a[0] === 'send-keys').slice(-2);
    assert.deepEqual(sk, [['send-keys', '-t', 't1', '-l', '--', '-rf echo Enter'], ['send-keys', '-t', 't1', '--', 'Enter']]);
  });
});

describe('sbatch GPU rejection hint (R13)', () => {
  test('gres error → hint to set SLURM_DEFAULT_GPUS=0 / gpus:0', async () => {
    const s = await startServer({ scenario: 'sbatch_fail', env: { FAKE_SBATCH_ERR: 'gres', SLURM_MCP_POLL_MS: '600000' } });
    try {
      const r = await s.call('slurm_submit', { script: 'echo hi', job_name: 'g' });
      assert.equal(r.isError, true);
      assert.match(r.text, /Invalid generic resource/);
      assert.match(r.text, /this site may not offer GPUs: set SLURM_DEFAULT_GPUS=0 or pass gpus:0/i);
    } finally { await s.stop(); }
  });
  test('an unrelated sbatch error (script contains --gres) gets no GPU hint', async () => {
    const s = await startServer({ scenario: 'sbatch_fail', env: { SLURM_MCP_POLL_MS: '600000' } });
    try {
      const r = await s.call('slurm_submit', { script: 'echo hi', job_name: 'a' });
      assert.match(r.text, /Invalid account/);
      assert.doesNotMatch(r.text, /may not offer GPUs/);
    } finally { await s.stop(); }
  });
});

// ---- Round-4 review fixes (C1-C14) ----

describe('ProxyCommand=false only in ControlMaster mode (C1)', () => {
  const sshCalls = (s) => s.logEntries().filter(e => e.kind === 'exec' || e.kind === 'write');
  const rsyncE = (s) => s.logEntries().filter(e => e.kind === 'rsync').map(e => e.argv[e.argv.indexOf('-e') + 1]);
  test('alive master: every ssh call (tools + poller) and rsync -e carry ProxyCommand=false', async () => {
    const s = await startServer();
    try {
      await s.call('ssh_exec', { command: 'ls /home/u' });
      await s.call('ssh_write_file', { path: '/home/u/f', content: 'x' });
      await s.call('sync_files', { direction: 'upload', local_path: '/tmp/x', remote_path: '~/x' });
      await s.call('slurm_submit', { script: 'echo hi', job_name: 'pc' });
      const done = await waitFor(async () => ({ ok: execs(s).some(e => /^sacct -j [\d,]+ --format=JobID/.test(e.cmd)) }));
      assert.ok(done.ok, 'poller ran a batched sacct');
      const calls = sshCalls(s);
      assert.ok(calls.length >= 4);
      for (const c of calls) assert.deepEqual(c.argv.slice(0, 6), cmOpts(), JSON.stringify(c.argv));
      assert.deepEqual(rsyncE(s), ['ssh -o BatchMode=yes -o ControlPath=/tmp/fake-cm/fake -o ProxyCommand=false']);
      // The ControlPath comes from the local `ssh -G`, never from a remote call.
      assert.ok(s.logEntries().some(e => e.kind === 'config' && e.argv[1] === 'fake'));
    } finally { await s.stop(); }
  });
  test('unresolvable ControlPath with HPC_ALLOW_UNSAFE_REUSE=1: plain BatchMode, never ProxyCommand=false without a pinned path', async () => {
    const s = await startServer({ env: { FAKE_CONTROLPATH: 'none', HPC_ALLOW_UNSAFE_REUSE: '1', SLURM_MCP_POLL_MS: '600000' } });
    try {
      const r = await s.call('ssh_exec', { command: 'ls /home/u' });
      assert.equal(r.text, 'a.txt\nb.txt');
      assert.deepEqual(execs(s).at(-1).argv.slice(0, 3), ['-o', 'BatchMode=yes', 'fake']);
      assert.match(s.stderr(), /ControlPath for fake not resolvable via ssh -G/);
    } finally { await s.stop(); }
  });
  test('unconfigured (direct mode): no ProxyCommand=false anywhere', async () => {
    const s = await startServer({ scenario: 'master_unconfigured' });
    try {
      await s.call('ssh_exec', { command: 'ls /home/u' });
      await s.call('ssh_write_file', { path: '/home/u/f', content: 'x' });
      await s.call('sync_files', { direction: 'upload', local_path: '/tmp/x', remote_path: '~/x' });
      await s.call('slurm_submit', { script: 'echo hi', job_name: 'pc' });
      const done = await waitFor(async () => ({ ok: execs(s).some(e => /^sacct -j [\d,]+ --format=JobID/.test(e.cmd)) }));
      assert.ok(done.ok, 'poller ran a batched sacct');
      const calls = sshCalls(s);
      assert.ok(calls.length >= 4);
      for (const c of calls) {
        assert.deepEqual(c.argv.slice(0, 3), ['-o', 'BatchMode=yes', 'fake'], JSON.stringify(c.argv));
        assert.ok(!c.argv.includes('ProxyCommand=false'));
      }
      assert.deepEqual(rsyncE(s), ['ssh -o BatchMode=yes']);
    } finally { await s.stop(); }
  });
});

describe('busy heartbeat during blocking ssh calls (C2)', () => {
  test('a long ssh_exec announces busyUntil = now + timeout + 5s; the end of the call clears it', async () => {
    const s = await startServer({ env: { FAKE_DELAY_MS: '1500', SLURM_MCP_POLL_MS: '600000' } });
    try {
      const tty = await s.tty();
      const hbFile = join(s.home, '.claude', 'hpc-pollers', `${tty}.json`);
      const t0 = Date.now();
      const pending = s.call('ssh_exec', { command: 'ls /home/u', timeout: 60000 });
      const busy = await waitFor(async () => {
        let hb = null;
        try { hb = JSON.parse(readFileSync(hbFile, 'utf8')); } catch { /* mid-write */ }
        return { ok: hb?.busyUntil != null, hb };
      }, { timeout: 5000, every: 20 });
      assert.ok(busy.ok, `no busyUntil during the call: ${JSON.stringify(busy.hb)}`);
      assert.ok(busy.hb.busyUntil >= t0 + 60000 + 5000 - 50, `busyUntil ${busy.hb.busyUntil - t0}ms after start`);
      const r = await pending;
      assert.equal(r.text, 'a.txt\nb.txt');
      const after = JSON.parse(readFileSync(hbFile, 'utf8'));
      assert.equal(after.busyUntil, undefined, 'heartbeat refreshed without busyUntil after the call');
      assert.ok(after.at >= busy.hb.at);
    } finally { await s.stop(); }
  });
});

describe('notification file hygiene (C3)', () => {
  test('[null] in slurm-notifications.json: slurm_submit still reports Submitted', async () => {
    const home = mkdtempSync(join(tmpdir(), 'slurm-mcp-home-'));
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'slurm-notifications.json'), '[null, 7, "x"]');
    const s = await startServer({ home, env: { SLURM_MCP_POLL_MS: '600000' } });
    try {
      const r = await s.call('slurm_submit', { script: 'echo hi', job_name: 'nn' });
      assert.equal(r.isError, false, r.text);
      assert.match(r.text, /Submitted batch job 541806/);
      assert.equal((await s.call('workdir_get')).isError, false);
    } finally { await s.stop(); }
  });
});

describe('workdir per cluster (C6)', () => {
  test('cluster_switch: workdir_get no longer returns the other cluster\'s dir', async () => {
    const s = await startServer({ env: { HPC_HOST: 'fake,other', SLURM_MCP_POLL_MS: '600000' } });
    try {
      assert.equal((await s.call('workdir_set', { path: '/home/u/on-fake' })).isError, false);
      assert.match((await s.call('workdir_get')).text, /工作目录: \/home\/u\/on-fake/);
      await s.call('cluster_switch', { host: 'other' });
      const g = await s.call('workdir_get');
      assert.doesNotMatch(g.text, /on-fake/);
      assert.match(g.text, /未设置工作目录/);
      await s.call('workdir_set', { path: '/home/u/on-other' });
      await s.call('slurm_submit', { script: 'echo hi', job_name: 'o' });
      assert.ok(submitCmd(s).includes("\ncd -- '/home/u/on-other' || exit 1\n"), submitCmd(s));
      await s.call('cluster_switch', { host: 'fake' });
      assert.match((await s.call('workdir_get')).text, /工作目录: \/home\/u\/on-fake/);
    } finally { await s.stop(); }
  });
  test('legacy workdir file without host belongs to the first cluster', async () => {
    const s = await startServer({ env: { HPC_HOST: 'fake,other', SLURM_MCP_POLL_MS: '600000' } });
    try {
      const tty = await s.tty();
      mkdirSync(join(s.home, '.claude', 'hpc-workdirs'), { recursive: true });
      writeFileSync(join(s.home, '.claude', 'hpc-workdirs', `${tty}.json`), JSON.stringify({ tty, workdir: '/home/u/legacy', setAt: 'x' }));
      assert.match((await s.call('workdir_get')).text, /工作目录: \/home\/u\/legacy/);
      await s.call('cluster_switch', { host: 'other' });
      assert.doesNotMatch((await s.call('workdir_get')).text, /legacy/);
      await s.call('workdir_set', { path: '/home/u/o2' }); // keeps the legacy entry of "fake"
      await s.call('cluster_switch', { host: 'fake' });
      assert.match((await s.call('workdir_get')).text, /工作目录: \/home\/u\/legacy/);
    } finally { await s.stop(); }
  });
});

describe('small portability fixes (C8, C9, C10, C12)', async () => {
  const s = await startServer({ env: { FAKE_STDOUT: 'empty', FAKE_SCONTROL_STDOUT: '/scratch/a=b/my log.out', SLURM_MCP_POLL_MS: '600000' } });
  after(() => s.stop());
  test('slurm_logs: scontrol StdOut with "=" and a space is read whole (C8)', async () => {
    const r = await s.call('slurm_logs', { job_id: '541806', lines: 5 });
    assert.equal(r.isError, false, r.text);
    assert.ok(execs(s).some(e => e.cmd === "scontrol show job -o '541806' 2>/dev/null"));
    assert.ok(execs(s).some(e => e.cmd === "tail -n 5 '/scratch/a=b/my log.out'"), JSON.stringify(execs(s).map(e => e.cmd)));
  });
  test('slurm_submit rejects output_dir with "%" (C9)', async () => {
    const r = await s.call('slurm_submit', { script: 'echo hi', output_dir: 'logs/%j' });
    assert.equal(r.isError, true);
    assert.match(r.text, /output_dir "logs\/%j" must not contain "%"/);
  });
  test('sync_files expands a leading ~/ of local_path (C10)', async () => {
    const r = await s.call('sync_files', { direction: 'download', local_path: '~/data/', remote_path: '~/x' });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(s.logEntries().filter(e => e.kind === 'rsync').at(-1).argv.slice(-3), ['--', 'fake:~/x', `${s.home}/data/`]);
    const bad = await s.call('sync_files', { direction: 'upload', local_path: '~other/x', remote_path: '~/x' });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /must be an absolute path/);
  });
  test('slurm_status / slurm_cancel accept a hetjob component id (C12)', async () => {
    const st = await s.call('slurm_status', { job_id: '541806+1' });
    assert.equal(st.isError, false, st.text);
    assert.ok(execs(s).some(e => e.cmd === "squeue -j '541806+1'"));
    const c = await s.call('slurm_cancel', { job_id: '541806+1' });
    assert.equal(c.isError, false, c.text);
    assert.ok(execs(s).some(e => e.cmd.startsWith("scancel '541806+1'")));
  });
});

// ---- Final review fixes (F1-F10) ----

describe('ControlPath unresolvable → fail-local (F1)', () => {
  const remote = (s) => s.logEntries().filter(e => ['exec', 'write', 'rsync'].includes(e.kind));
  const cases = [
    ['ssh -G reports a %C path', { FAKE_CONTROLPATH: '/tmp/fake-cm/%C' }, /unexpanded "%" token/],
    ['ssh -G reports a path with a quote', { FAKE_CONTROLPATH: '/tmp/fake"cm/x' }, /quotes, backslashes, tabs/],
    ['ssh -G fails', { FAKE_SSH_G_FAIL: '1' }, /ssh -G fake failed: ssh: .*Bad configuration option/],
  ];
  for (const [name, env, why] of cases) {
    test(`${name}: every tool and the poller refuse, zero remote exec`, async () => {
      const s = await startServer({ env });
      try {
        const tty = await s.tty();
        writeFileSync(s.watchesFile, JSON.stringify([seedWatch({ tty, jobName: 'cp' })]));
        for (const [tool, args] of [['ssh_exec', { command: 'ls' }], ['ssh_write_file', { path: '/home/u/f', content: 'x' }],
          ['sync_files', { direction: 'upload', local_path: '/tmp/x', remote_path: '~/x' }], ['slurm_submit', { script: 'echo hi', job_name: 'cp' }]]) {
          const r = await s.call(tool, args);
          assert.equal(r.isError, true, `${tool}: ${r.text}`);
          assert.match(r.text, /ControlMaster detected but its ControlPath could not be resolved safely \(.*\); refusing to open a new connection\. Set HPC_ALLOW_UNSAFE_REUSE=1 to override/, tool);
          assert.match(r.text, why, tool);
        }
        const polled = await waitFor(async () => {
          const w = await s.call('slurm_watches');
          return { ok: /Last poll error: .*refusing to open a new connection/.test(w.text), text: w.text };
        });
        assert.ok(polled.ok, polled.text);
        assert.deepEqual(remote(s), [], 'no remote exec / write / rsync');
        assert.ok(s.logEntries().some(e => e.kind === 'config'), 'the ControlPath was looked up locally');
      } finally { await s.stop(); }
    });
  }
  test('a ControlPath with a space is usable: quoted for ssh -o and for rsync -e', async () => {
    const s = await startServer({ env: { FAKE_CONTROLPATH: '/tmp/fake cm/x', SLURM_MCP_POLL_MS: '600000' } });
    try {
      assert.equal((await s.call('ssh_exec', { command: 'ls' })).text, 'a.txt\nb.txt');
      assert.deepEqual(execs(s).at(-1).argv.slice(0, 7), ['-o', 'BatchMode=yes', '-o', 'ControlPath="/tmp/fake cm/x"', '-o', 'ProxyCommand=false', 'fake']);
      await s.call('sync_files', { direction: 'upload', local_path: '/tmp/x', remote_path: '~/x' });
      const rs = s.logEntries().filter(e => e.kind === 'rsync').at(-1);
      assert.equal(rs.argv[rs.argv.indexOf('-e') + 1], `ssh -o BatchMode=yes -o 'ControlPath="/tmp/fake cm/x"' -o ProxyCommand=false`);
    } finally { await s.stop(); }
  });
  test('HPC_ALLOW_UNSAFE_REUSE=1 lets the call through with plain BatchMode', async () => {
    const s = await startServer({ env: { FAKE_CONTROLPATH: '/tmp/fake-cm/%C', HPC_ALLOW_UNSAFE_REUSE: '1', SLURM_MCP_POLL_MS: '600000' } });
    try {
      assert.equal((await s.call('ssh_exec', { command: 'ls' })).text, 'a.txt\nb.txt');
      assert.deepEqual(execs(s).at(-1).argv.slice(0, 3), ['-o', 'BatchMode=yes', 'fake']);
    } finally { await s.stop(); }
  });
  test('HPC_REQUIRE_MASTER=1 ignores the override', async () => {
    const s = await startServer({ env: { FAKE_SSH_G_FAIL: '1', HPC_ALLOW_UNSAFE_REUSE: '1', HPC_REQUIRE_MASTER: '1', SLURM_MCP_POLL_MS: '600000' } });
    try {
      const r = await s.call('ssh_exec', { command: 'ls' });
      assert.equal(r.isError, true);
      assert.match(r.text, /refusing to open a new connection.*not honored while HPC_REQUIRE_MASTER=1/);
      assert.deepEqual(remote(s), []);
    } finally { await s.stop(); }
  });
});

describe('watch expiry is decided at poll time only (F2)', () => {
  const old = () => new Date(Date.now() - 3 * 24 * 3600_000).toISOString();
  test('absent once → 3 days → master dead → reconnect: job RUNNING again, watch kept and finally notifies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slurm-mcp-f2-'));
    const dead = join(dir, 'dead'); const gate = join(dir, 'done');
    writeFileSync(dead, '');
    const s = await startServer({ env: { FAKE_DEAD_FILE: dead, FAKE_RUNNING_UNTIL: gate } });
    try {
      const tty = await s.tty();
      writeFileSync(s.watchesFile, JSON.stringify([seedWatch({ tty, jobName: 'outage', submittedAt: old(), unseenSince: old(), lastQueriedAt: old() })]));
      const deadRounds = await waitFor(async () => {
        const w = await s.call('slurm_watches');
        return { ok: /Last poll error: SSH master to fake is dead/.test(w.text), text: w.text };
      });
      assert.ok(deadRounds.ok, deadRounds.text);
      assert.match(deadRounds.text, /541806 \(outage\) \[PENDING\]/, 'not expired while the master is dead');
      assert.equal(s.readWatches().length, 1);
      rmSync(dead);
      const running = await waitFor(async () => {
        const w = s.readWatches()[0];
        return { ok: w?.state === 'RUNNING' && w.unseenSince === undefined, w };
      }, { timeout: 15_000 });
      assert.ok(running.ok, JSON.stringify(running.w));
      writeFileSync(gate, '');
      const done = await waitFor(async () => {
        const w = await s.call('slurm_watches');
        return { ok: /SLURM job 541806 \(outage\) COMPLETED/.test(w.text), text: w.text };
      });
      assert.ok(done.ok, done.text);
    } finally { await s.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
  test('long outage, still absent after reconnect: first poll only restarts the clock', async () => {
    const s = await startServer({ env: { FAKE_SACCT_MISSING: '541806' } });
    try {
      const tty = await s.tty();
      const unseen = old();
      writeFileSync(s.watchesFile, JSON.stringify([seedWatch({ tty, jobName: 'gap', submittedAt: old(), unseenSince: unseen, lastQueriedAt: old() })]));
      const r = await waitFor(async () => {
        const w = s.readWatches()[0];
        return { ok: w && w.unseenSince !== unseen, w };
      });
      assert.ok(r.ok, JSON.stringify(r.w));
      assert.ok(Date.now() - Date.parse(r.w.unseenSince) < 60_000, 'unseenSince restarted');
      await new Promise(res => setTimeout(res, 800)); // several more polls
      assert.equal(s.readWatches().length, 1, 'kept: absence clock restarted');
    } finally { await s.stop(); }
  });
  test('master dead with a TTL-old unseenSince: kept; reconnect and still absent → deleted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slurm-mcp-f2b-'));
    const dead = join(dir, 'dead');
    writeFileSync(dead, '');
    const s = await startServer({ env: { FAKE_DEAD_FILE: dead, FAKE_SACCT_MISSING: '541806' } });
    try {
      const tty = await s.tty();
      writeFileSync(s.watchesFile, JSON.stringify([seedWatch({ tty, jobName: 'vanished', submittedAt: old(), unseenSince: old(), lastQueriedAt: new Date().toISOString() })]));
      const deadRounds = await waitFor(async () => {
        const w = await s.call('slurm_watches');
        return { ok: /Last poll error: SSH master to fake is dead/.test(w.text), text: w.text };
      });
      assert.ok(deadRounds.ok, deadRounds.text);
      assert.match(deadRounds.text, /541806 \(vanished\)/, 'loading never expires');
      assert.equal(s.readWatches().length, 1);
      rmSync(dead);
      const gone = await waitFor(async () => ({ ok: s.readWatches().length === 0 }), { timeout: 15_000 });
      assert.ok(gone.ok, JSON.stringify(s.readWatches()));
      assert.match(s.stderr(), /Watch 541806 on fake expired: not reported by sacct since/);
    } finally { await s.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('"%" in the final log directory (F4)', () => {
  test('workdir_set rejects "%"; a stored legacy workdir with "%" blocks submit before sbatch', async () => {
    const s = await startServer({ env: { SLURM_MCP_POLL_MS: '600000' } });
    try {
      const w = await s.call('workdir_set', { path: '/home/u/run_%j' });
      assert.equal(w.isError, true);
      assert.match(w.text, /must not contain "%"/);
      const tty = await s.tty();
      mkdirSync(join(s.home, '.claude', 'hpc-workdirs'), { recursive: true });
      writeFileSync(join(s.home, '.claude', 'hpc-workdirs', `${tty}.json`), JSON.stringify({ tty, workdir: '/home/u/run_%A', setAt: 'x' }));
      const r = await s.call('slurm_submit', { script: 'echo hi', job_name: 'pct' });
      assert.equal(r.isError, true, r.text);
      assert.match(r.text, /Submit rejected: log directory "\/home\/u\/run_%A\/results\/logs" contains "%"/);
      assert.equal(submitCmd(s), undefined, 'no sbatch');
    } finally { await s.stop(); }
  });
});

describe('rsync protect-args and remote_path whitespace (F5)', () => {
  test('-s when the local rsync supports it; remote_path with whitespace rejected before rsync', async () => {
    const s = await startServer({ env: { SLURM_MCP_POLL_MS: '600000' } });
    try {
      await s.call('sync_files', { direction: 'download', local_path: '/tmp/y', remote_path: '~/data/' });
      const rs = s.logEntries().filter(e => e.kind === 'rsync');
      assert.equal(rs.length, 1);
      assert.deepEqual(rs[0].argv.slice(0, 3), ['-avz', '--partial', '-s']);
      for (const remote_path of ['~/my data', '~/a\tb', ' ~/x']) {
        const r = await s.call('sync_files', { direction: 'upload', local_path: '/tmp/x', remote_path });
        assert.equal(r.isError, true, remote_path);
        assert.match(r.text, /remote_path contains (whitespace|unsafe characters)/);
      }
      // quotes / globs would be expanded by the remote shell when -s is missing:
      // `/data/""` → /data/ and --delete would prune the wrong directory.
      for (const remote_path of ['/data/""', '/data/*', '~/x/{a,b}']) {
        const r = await s.call('sync_files', { direction: 'upload', local_path: '/tmp/x', remote_path, delete: true });
        assert.equal(r.isError, true, remote_path);
        assert.match(r.text, /remote_path may only contain/);
      }
      assert.equal(s.logEntries().filter(e => e.kind === 'rsync').length, 1, 'no rsync for rejected paths');
    } finally { await s.stop(); }
  });
  test('openrsync without -s: argv has no -s, sync still works', async () => {
    const s = await startServer({ env: { FAKE_RSYNC_NO_S: '1', SLURM_MCP_POLL_MS: '600000' } });
    try {
      const r = await s.call('sync_files', { direction: 'upload', local_path: '/tmp/x', remote_path: '~/x' });
      assert.equal(r.isError, false, r.text);
      const rs = s.logEntries().filter(e => e.kind === 'rsync').at(-1);
      assert.deepEqual(rs.argv.slice(0, 3), ['-avz', '--partial', '-e']);
    } finally { await s.stop(); }
  });
});

describe('sites without Slurm accounting (F6)', () => {
  test('submit warns and registers no watch; slurm_watches shows the reason', async () => {
    const s = await startServer({ scenario: 'sacct_disabled' });
    try {
      const r = await s.call('slurm_submit', { script: 'echo hi', job_name: 'noacct' });
      assert.equal(r.isError, false, r.text);
      assert.match(r.text, /Submitted batch job 541806/);
      assert.match(r.text, /⚠️ sacct unavailable on this cluster — job watches cannot complete; use slurm_status 541806/);
      assert.doesNotMatch(r.text, /Watch registered/);
      assert.ok(!existsSync(s.watchesFile) || s.readWatches().length === 0, 'no watch');
      const w = await s.call('slurm_watches');
      assert.match(w.text, /sacct unavailable on this cluster.*\(fake: sacct: error: Slurm accounting storage is disabled\)/);
    } finally { await s.stop(); }
  });
  test('the poller detects it from a watch registered before (e.g. by another window)', async () => {
    const s = await startServer({ scenario: 'sacct_disabled' });
    try {
      const tty = await s.tty();
      writeFileSync(s.watchesFile, JSON.stringify([seedWatch({ tty, jobName: 'before' })]));
      const r = await waitFor(async () => {
        const w = await s.call('slurm_watches');
        return { ok: /sacct unavailable on this cluster — job watches cannot complete; use slurm_status \(fake: /.test(w.text), text: w.text };
      });
      assert.ok(r.ok, r.text);
      const f = await s.call('slurm_submit_file', { path: '/home/u/job.sh' });
      assert.match(f.text, /sacct unavailable on this cluster/);
      assert.equal(s.readWatches().length, 1, 'only the old watch');
    } finally { await s.stop(); }
  });
});

describe('invalid time fields are repaired and persisted (F7)', () => {
  test('garbage submittedAt: persisted as a real date, so the orphan grace can elapse', async () => {
    const s = await startServer();
    try {
      writeFileSync(s.watchesFile, JSON.stringify([seedWatch({ tty: 'ttys-gone', jobName: 'badtime', submittedAt: 'yesterday-ish', unseenSince: 'nope' })]));
      const r = await waitFor(async () => {
        const w = s.readWatches()[0];
        return { ok: w && Number.isFinite(Date.parse(w.submittedAt)) && Number.isFinite(Date.parse(w.unseenSince)), w };
      });
      assert.ok(r.ok, JSON.stringify(r.w));
      assert.match(s.stderr(), /invalid submittedAt "yesterday-ish", treated as now/);
    } finally { await s.stop(); }
  });
});

describe('watches of unconfigured hosts (F8)', () => {
  test('never polled, probed or adopted; slurm_watches says "not configured"', async () => {
    const s = await startServer({ env: { FAKE_SCENARIO_BY_HOST: 'stranger:normal' } });
    try {
      const tty = await s.tty();
      const old = new Date(Date.now() - 3600_000).toISOString();
      writeFileSync(s.watchesFile, JSON.stringify([
        seedWatch({ tty, host: 'stranger', jobName: 'mine-stranger' }),
        seedWatch({ tty: 'ttys-gone', host: 'stranger', jobId: '541807', jobName: 'orphan-stranger', submittedAt: old }),
      ]));
      const polls = await waitFor(async () => {
        const w = await s.call('slurm_watches');
        const n = Number(w.text.match(/#(\d+)\)/)?.[1] || 0);
        return { ok: n >= 5, text: w.text };
      });
      assert.ok(polls.ok, polls.text);
      assert.match(polls.text, /541806 \(mine-stranger\) .*host stranger not configured \(not in HPC_HOST\), not polled/);
      assert.deepEqual(s.logEntries().filter(e => e.argv.includes('stranger')), [], 'zero ssh toward the unknown host');
      assert.equal(s.readWatches().find(w => w.jobId === '541807').tty, 'ttys-gone', 'not adopted');
    } finally { await s.stop(); }
  });
});

describe('tty whitelist in the watch file (F9)', () => {
  test('a "../" tty is dropped before it can reach a heartbeat path', async () => {
    const s = await startServer({ env: { SLURM_MCP_POLL_MS: '600000' } });
    try {
      writeFileSync(s.watchesFile, JSON.stringify([seedWatch({ tty: '../../evil', jobName: 'evil' })]));
      const w = await s.call('slurm_watches');
      assert.doesNotMatch(w.text, /Other windows/);
      assert.match(s.stderr(), /Ignoring malformed watch entry/);
    } finally { await s.stop(); }
  });
});

describe('legacy workdir file (F10)', () => {
  test('{tty, workdir} without host: submit writes cd -- \'<dir>\'', async () => {
    const s = await startServer({ env: { SLURM_MCP_POLL_MS: '600000' } });
    try {
      const tty = await s.tty();
      mkdirSync(join(s.home, '.claude', 'hpc-workdirs'), { recursive: true });
      writeFileSync(join(s.home, '.claude', 'hpc-workdirs', `${tty}.json`), JSON.stringify({ tty, workdir: '/home/u/legacy-proj' }));
      const r = await s.call('slurm_submit', { script: 'echo hi', job_name: 'leg' });
      assert.equal(r.isError, false, r.text);
      const cmd = submitCmd(s);
      assert.ok(cmd.includes("\ncd -- '/home/u/legacy-proj' || exit 1\n"), cmd);
      assert.ok(cmd.includes('#SBATCH --output=/home/u/legacy-proj/results/logs/slurm_%j.out'), cmd);
    } finally { await s.stop(); }
  });
});

// ---- Final review, Gemini items (G1-G7) ----

describe('slurm_logs: "(null)" StdOut falls through to scontrol (G1)', () => {
  test('sacct "(null)" is not read as a path', async () => {
    const s = await startServer({ env: { FAKE_STDOUT: 'null', FAKE_SCONTROL_STDOUT: '/w/logs/slurm_541806.out', SLURM_MCP_POLL_MS: '600000' } });
    try {
      const r = await s.call('slurm_logs', { job_id: '541806', lines: 5 });
      assert.equal(r.isError, false, r.text);
      assert.ok(execs(s).some(e => e.cmd === "tail -n 5 '/w/logs/slurm_541806.out'"), JSON.stringify(execs(s).map(e => e.cmd)));
      assert.ok(!execs(s).some(e => /\(null\)/.test(e.cmd) && /^(tail|cat) /.test(e.cmd)));
    } finally { await s.stop(); }
  });
});

describe('ssh_write_file with empty content (G2)', () => {
  test('content "" writes an empty file', async () => {
    const s = await startServer({ env: { SLURM_MCP_POLL_MS: '600000' } });
    try {
      const r = await s.call('ssh_write_file', { path: '/home/u/empty', content: '' });
      assert.equal(r.isError, false, r.text);
      assert.match(r.text, /Written 0 bytes → \/home\/u\/empty/);
      const w = s.logEntries().filter(e => e.kind === 'write').at(-1);
      assert.equal(w.path, '/home/u/empty');
      assert.equal(w.bytes, 0);
      const none = await s.call('ssh_write_file', { path: '/home/u/x' });
      assert.equal(none.isError, true);
      assert.match(none.text, /provide either content or from_file/);
    } finally { await s.stop(); }
  });
});

describe('large sacct output in the poller (G4)', () => {
  test('6 MB of sacct rows: the watch still completes', async () => {
    const s = await startServer({ env: { FAKE_SACCT_PAD_MB: '6' } });
    try {
      const tty = await s.tty();
      writeFileSync(s.watchesFile, JSON.stringify([seedWatch({ tty, jobName: 'big' })]));
      const done = await waitFor(async () => {
        const w = await s.call('slurm_watches');
        return { ok: /SLURM job 541806 \(big\) COMPLETED/.test(w.text), text: w.text };
      }, { timeout: 15_000 });
      assert.ok(done.ok, done.text);
    } finally { await s.stop(); }
  });
  test('over 32 MB: readable lastPollError, watch kept, server alive', async () => {
    const s = await startServer({ env: { FAKE_SACCT_PAD_MB: '40' } });
    try {
      const tty = await s.tty();
      writeFileSync(s.watchesFile, JSON.stringify([seedWatch({ tty, jobName: 'huge' })]));
      const r = await waitFor(async () => {
        const w = await s.call('slurm_watches');
        return { ok: /Last poll error: batch sacct \(fake\): output exceeded 32 MB \(1 watched job\(s\) in one sacct query\)/.test(w.text), text: w.text };
      }, { timeout: 20_000 });
      assert.ok(r.ok, r.text);
      assert.match(r.text, /541806 \(huge\)/);
    } finally { await s.stop(); }
  });
});

describe('per-cluster submit defaults (G5)', () => {
  test('SLURM_DEFAULT_PARTITION / SLURM_DEFAULT_GPUS lists follow HPC_HOST order', async () => {
    const s = await startServer({ env: { HPC_HOST: 'fake,other', SLURM_DEFAULT_PARTITION: 'batch,standard-s', SLURM_DEFAULT_GPUS: '1,0', SLURM_MCP_POLL_MS: '600000' } });
    try {
      await s.call('slurm_submit', { script: 'echo hi', job_name: 'p1' });
      let cmd = submitCmd(s);
      assert.ok(cmd.includes('\n#SBATCH --partition=batch\n') && cmd.includes('\n#SBATCH --gres=gpu:1\n'), cmd);
      await s.call('cluster_switch', { host: 'other' });
      await s.call('slurm_submit', { script: 'echo hi', job_name: 'p2' });
      cmd = execs(s).map(e => e.cmd).filter(c => /\| sbatch/.test(c)).at(-1);
      assert.ok(cmd.includes('\n#SBATCH --partition=standard-s\n'), cmd);
      assert.ok(!/--gres/.test(cmd), cmd);
    } finally { await s.stop(); }
  });
  test('a single value applies to every cluster', async () => {
    const s = await startServer({ env: { HPC_HOST: 'fake,other', SLURM_DEFAULT_PARTITION: 'gpu.a100', SLURM_MCP_POLL_MS: '600000' } });
    try {
      await s.call('cluster_switch', { host: 'other' });
      await s.call('slurm_submit', { script: 'echo hi', job_name: 'p3' });
      assert.ok(submitCmd(s).includes('\n#SBATCH --partition=gpu.a100\n'));
    } finally { await s.stop(); }
  });
});

describe('manual ssh success ends the poller backoff (G7)', () => {
  // Waits until the host's backoff has just grown to 8s, so without the fix
  // the next poll attempt would be ~8s away.
  async function backOff(s, dead) {
    writeFileSync(dead, '');
    const r = await waitFor(async () => {
      const w = await s.call('slurm_watches');
      return { ok: /SSH master to fake is dead.*backoff (8|16|32)s/.test(w.text), text: w.text };
    }, { timeout: 20_000, every: 50 });
    assert.ok(r.ok, r.text);
    rmSync(dead);
  }
  test('ssh_status (alive) and ssh_exec clear the host backoff', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slurm-mcp-g7-'));
    const dead = join(dir, 'dead');
    const s = await startServer({ env: { FAKE_DEAD_FILE: dead } });
    try {
      const tty = await s.tty();
      for (const [tool, args, jobId] of [['ssh_status', {}, '541806'], ['ssh_exec', { command: 'ls' }, '541807']]) {
        writeFileSync(s.watchesFile, JSON.stringify([seedWatch({ tty, jobId, jobName: `via-${tool}` })]));
        await backOff(s, dead);
        const t0 = Date.now();
        const r = await s.call(tool, args);
        assert.equal(r.isError, false, r.text);
        const done = await waitFor(async () => {
          const w = await s.call('slurm_watches');
          return { ok: new RegExp(`SLURM job ${jobId} \\(via-${tool}\\) COMPLETED`).test(w.text), text: w.text };
        }, { timeout: 15_000, every: 50 });
        assert.ok(done.ok, done.text);
        assert.ok(Date.now() - t0 < 3000, `${tool}: watch resumed after ${Date.now() - t0}ms`);
      }
    } finally { await s.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
});

// ---- Live experiment fixes (D1, D3) ----

describe('slurm_logs remembers --output patterns (D1)', () => {
  const LOGDIR = '/users/u/finding/results/config_compare/logs';
  test('custom absolute output_dir: found after sacct/scontrol forgot the job', async () => {
    const s = await startServer({ env: { FAKE_STDOUT: 'empty', FAKE_LS_EXISTS: `${LOGDIR}/slurm_541806.out`, SLURM_MCP_POLL_MS: '600000' } });
    try {
      const sub = await s.call('slurm_submit', { script: 'echo hi', output_dir: LOGDIR });
      assert.equal(sub.isError, false, sub.text);
      const map = JSON.parse(readFileSync(join(s.home, '.claude', 'slurm-outputs.json'), 'utf8'));
      assert.equal(map['fake|541806'].pattern, `${LOGDIR}/slurm_%j.out`);
      assert.equal(s.readWatches().find(w => w.jobId === '541806').outputPattern, `${LOGDIR}/slurm_%j.out`);
      const r = await s.call('slurm_logs', { job_id: '541806', lines: 0 });
      assert.equal(r.isError, false, r.text);
      assert.match(r.text, /epoch 2 loss 0\.5/);
      assert.ok(execs(s).some(e => e.cmd === `cat '${LOGDIR}/slurm_541806.out'`), JSON.stringify(execs(s).map(e => e.cmd)));
    } finally { await s.stop(); }
  });
  test('array task "541822_5": %A_%a expanded from the remembered pattern', async () => {
    const s = await startServer({ scenario: 'array', env: { FAKE_STDOUT: 'empty', FAKE_LS_EXISTS: `${LOGDIR}/slurm_541822_5.out`, SLURM_MCP_POLL_MS: '600000' } });
    try {
      const sub = await s.call('slurm_submit', { script: 'echo $SLURM_ARRAY_TASK_ID', output_dir: LOGDIR, array: '1-9' });
      assert.equal(sub.isError, false, sub.text);
      const r = await s.call('slurm_logs', { job_id: '541822_5', lines: 5 });
      assert.equal(r.isError, false, r.text);
      assert.ok(execs(s).some(e => e.cmd === `tail -n 5 '${LOGDIR}/slurm_541822_5.out'`), JSON.stringify(execs(s).map(e => e.cmd)));
    } finally { await s.stop(); }
  });
  test('log not there yet: the message names the expected file and the `path` parameter', async () => {
    const s = await startServer({ env: { FAKE_STDOUT: 'empty', SLURM_MCP_POLL_MS: '600000' } });
    try {
      await s.call('slurm_submit', { script: 'echo hi', output_dir: LOGDIR });
      const r = await s.call('slurm_logs', { job_id: '541806' });
      assert.match(r.text, new RegExp(`Expected ${LOGDIR}/slurm_541806\\.out`));
      assert.match(r.text, /pass `path`/);
    } finally { await s.stop(); }
  });
  test('slurm_submit_file: #SBATCH --output of the script is remembered (%x filled in)', async () => {
    const header = '#!/bin/bash\n#SBATCH --job-name=cmp\n#SBATCH --output=/scratch/u/%x_%j.log\nsrun python x.py';
    const s = await startServer({ env: { FAKE_STDOUT: 'empty', FAKE_SCRIPT_HEADER: header, FAKE_LS_EXISTS: '/scratch/u/cmp_541806.log', SLURM_MCP_POLL_MS: '600000' } });
    try {
      const sub = await s.call('slurm_submit_file', { path: '/home/u/job.slurm' });
      assert.equal(sub.isError, false, sub.text);
      assert.ok(execs(s).some(e => e.cmd === "head -n 500 '/home/u/job.slurm'"));
      const r = await s.call('slurm_logs', { job_id: '541806', lines: 5 });
      assert.ok(execs(s).some(e => e.cmd === "tail -n 5 '/scratch/u/cmp_541806.log'"), r.text);
    } finally { await s.stop(); }
  });
  test('explicit `path` is read directly; unsafe paths are rejected', async () => {
    const s = await startServer({ env: { SLURM_MCP_POLL_MS: '600000' } });
    try {
      const r = await s.call('slurm_logs', { job_id: '541806', path: '/users/u/other/run.log', lines: 0 });
      assert.equal(r.isError, false, r.text);
      assert.match(r.text, /epoch 2 loss 0\.5/);
      assert.ok(execs(s).some(e => e.cmd === "cat '/users/u/other/run.log'"));
      assert.ok(!execs(s).some(e => /^sacct -j '541806' --format=StdOut/.test(e.cmd)), 'no lookup when path is given');
      for (const bad of ['/w/../etc/passwd', '/w/$(id).log', '']) {
        const b = await s.call('slurm_logs', { job_id: '541806', path: bad });
        assert.equal(b.isError, true, bad);
      }
    } finally { await s.stop(); }
  });
});
