// End-to-end MCP stdio tests: spawns `node index.mjs` with test/fake-bin first
// on PATH (fake ssh/rsync answer with real SLURM output, desktop notifiers are
// no-ops), a throwaway HOME, and drives it over JSON-RPC. No network.
// `test.todo` entries tagged BUG-<n> encode the intended behavior for known
// bugs (see CHANGELOG "Known issues"); they report as todo until fixed.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
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
    ...env,
  };
  for (const k of ['NOTIFY_WEBHOOK', 'HPC_RESOURCE_LOG', 'SLURM_MCP_NO_START']) delete childEnv[k];
  const child = spawn(process.execPath, [join(ROOT, 'index.mjs')], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  child.on('exit', () => children.delete(child));
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  let buf = '';
  const pending = new Map();
  let nextId = 1;
  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
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
  return { child, dir, home, log, rpc, call, logEntries, stop, init, stderr: () => stderr };
}

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
const submitCmd = (s) => execs(s).map(e => e.cmd).find(c => /\| sbatch/.test(c));

describe('normal scenario', async () => {
  // Poller effectively off here so watch/notification state is only changed
  // by the calls under test; the poll path has its own suites below.
  const s = await startServer({ env: { SLURM_MCP_POLL_MS: '600000' } });
  after(() => s.stop());

  test('initialize reports server info', () => {
    assert.equal(s.init.result.serverInfo.name, 'slurm-mcp-server');
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
    assert.match(r.text, /=== Per-user limits ===/);
    assert.match(r.text, /^batch: MaxTime=2-00:00:00 MaxJobsPU=none MaxTRESPU=none$/m);
    assert.match(r.text, /^short: MaxTime=04:00:00 MaxJobsPU=1 MaxTRESPU=cpu=32,gres\/gpu=2,mem=256G \(QoS shortqos\)$/m);
  });
  test('every remote exec goes through BatchMode + bash --login -c', () => {
    const e = execs(s);
    assert.ok(e.length > 0);
    for (const x of e) {
      assert.deepEqual(x.argv.slice(0, 3), ['-o', 'BatchMode=yes', 'fake']);
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
      '#SBATCH --gres=gpu:1', '#SBATCH --dependency=afterok:541000', 'module load x', "cd '/home/u/proj'", "echo 'hi there'"]) {
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
  test.todo('relative output_dir with a workdir: mkdir target and #SBATCH --output disagree (BUG-1)', async () => {
    await s.call('slurm_submit', { script: 'echo hi', job_name: 'rel', output_dir: 'logs' });
    const cmd = execs(s).map(e => e.cmd).filter(c => /\| sbatch/.test(c)).at(-1);
    assert.match(cmd, /^mkdir -p '\/home\/u\/proj\/logs'/);
    assert.ok(cmd.includes('#SBATCH --output=/home/u/proj/logs/slurm_%j.out'), cmd.split('\n').find(l => l.includes('--output')));
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
    assert.deepEqual(w.argv.slice(0, 3), ['-o', 'BatchMode=yes', 'fake']);
    assert.equal(w.path, "/home/u/proj/it's here.txt");
    assert.equal(w.bytes, 6);
  });
  test('sync_files uses rsync -e "ssh -o BatchMode=yes" and validates paths', async () => {
    const r = await s.call('sync_files', { direction: 'upload', local_path: '/tmp/x', remote_path: '~/x' });
    assert.equal(r.isError, false, r.text);
    const rs = s.logEntries().filter(e => e.kind === 'rsync').at(-1);
    assert.deepEqual(rs.argv, ['-avz', '--partial', '-e', 'ssh -o BatchMode=yes', '/tmp/x', 'fake:~/x']);
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
  test.todo('a null entry in slurm-watches.json makes a successful sbatch report "Submit failed" (BUG-5)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'slurm-mcp-home-'));
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'slurm-watches.json'), '[null]');
    const s = await startServer({ home });
    try {
      const r = await s.call('slurm_submit', { script: 'echo hi', job_name: 'n' });
      assert.ok(submitCmd(s), 'sbatch did run');
      assert.equal(r.isError, false, r.text);
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
