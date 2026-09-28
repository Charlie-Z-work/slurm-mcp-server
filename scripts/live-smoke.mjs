#!/usr/bin/env node
/**
 * Live smoke test against a REAL SLURM cluster. Manual only — never run in CI.
 *
 * WARNING: this script really submits a 2-task array job (1 GPU, 2G, 3 min per
 * task by default) to your cluster account, waits up to 6 minutes for it, then
 * runs `rm -rf` on the self-test directory LIVE_SMOKE_DIR on the cluster.
 * Point LIVE_SMOKE_DIR at a throwaway path.
 *
 * Prerequisites: a live SSH ControlMaster to HPC_HOST (run `ssh <host>` in a
 * terminal first; this script never authenticates by itself).
 *
 * Env:
 *   HPC_HOST, HPC_USER    required (same as the server; SLURM_ACCOUNT optional)
 *   LIVE_SMOKE_DIR        required, absolute remote dir, created and DELETED
 *   LIVE_SMOKE_PARTITION  partition for the array job (default: short)
 *   HPC_GUIDE_EXTRA       optional; if set, `guide` must include it
 *   HPC_PREAMBLE, ...     passed through to the server unchanged
 *   LIVE_SMOKE_HOME       HOME for the server's state files (default: a temp dir,
 *                         so your real watches/notifications are untouched;
 *                         ssh still reads your real ~/.ssh via the passwd entry)
 *
 * Usage: npm run test:live
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const k of ['HPC_HOST', 'HPC_USER', 'LIVE_SMOKE_DIR']) {
  if (!process.env[k]) { console.error(`live-smoke: missing env ${k}`); process.exit(2); }
}
const DIR = process.env.LIVE_SMOKE_DIR.replace(/\/+$/, '');
if (!DIR.startsWith('/') || /['"\s;$`]/.test(DIR) || DIR.split('/').length < 3) {
  console.error('live-smoke: LIVE_SMOKE_DIR must be an absolute path at least two levels deep, without quotes/whitespace');
  process.exit(2);
}
const PARTITION = process.env.LIVE_SMOKE_PARTITION || 'short';
const HOME = process.env.LIVE_SMOKE_HOME || mkdtempSync(join(tmpdir(), 'slurm-mcp-live-'));

const env = { ...process.env, HOME };
delete env.SLURM_MCP_NO_START;
delete env.SLURM_MCP_POLL_MS;
const child = spawn(process.execPath, [join(ROOT, 'index.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', d => process.stdout.write(`[server stderr] ${d}`));

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
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
const rpc = (method, params) => new Promise((res, rej) => {
  const id = nextId++;
  pending.set(id, res);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => pending.has(id) && rej(new Error(`timeout ${method}`)), 120_000);
});
const call = async (name, args = {}) => {
  const r = await rpc('tools/call', { name, arguments: args });
  return { text: (r.result?.content || []).map(c => c.text).join('\n'), isError: !!r.result?.isError };
};
let fails = 0;
const check = (label, cond, excerpt) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}\n    ${String(excerpt).replace(/\n/g, '\n    ')}`);
  if (!cond) fails++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

try {
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'live-smoke', version: '1' } });
  console.log('server:', JSON.stringify(init.result.serverInfo));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tl = await rpc('tools/list', {});
  check('tools/list = 26', tl.result.tools.length === 26, tl.result.tools.map(t => t.name).join(', '));

  let r = await call('ssh_status');
  check('ssh master alive', /SSH active/.test(r.text), r.text);
  if (!/SSH active/.test(r.text)) throw new Error(`no live ControlMaster — run \`ssh ${process.env.HPC_HOST}\` first`);

  r = await call('guide');
  check('guide readable' + (process.env.HPC_GUIDE_EXTRA ? ' + Site-specific guide' : ''),
    !r.isError && (!process.env.HPC_GUIDE_EXTRA || r.text.includes('Site-specific guide')), r.text.split('\n')[0]);

  r = await call('cluster_info');
  check('cluster_info has Per-user limits', r.text.includes('=== Per-user limits'), r.text.slice(r.text.indexOf('=== Per-user limits')));

  r = await call('slurm_submit', { script: 'echo hi', job_name: "bad'name" });
  check('slurm_submit bad job_name → isError', r.isError, r.text);
  r = await call('slurm_submit', { script: 'echo hi', job_name: 'ok', array: '1-3;rm' });
  check('slurm_submit bad array → isError', r.isError, r.text);

  r = await call('ssh_exec', { command: `mkdir -p ${DIR}/logs` });
  check('ssh_exec mkdir', !r.isError, r.text);
  r = await call('workdir_set', { path: DIR });
  check('workdir_set', !r.isError, r.text);

  r = await call('slurm_submit', {
    job_name: 'hpc-selftest-array', partition: PARTITION, gpus: 1, mem: '2G', time: '00:03:00',
    array: '1-2', preamble: false, output_dir: `${DIR}/logs`,
    script: 'echo task $SLURM_ARRAY_TASK_ID on $(hostname); sleep 5',
  });
  const jobId = r.text.match(/Submitted batch job (\d+)/)?.[1];
  check('slurm_submit array → Submitted', !r.isError && !!jobId, r.text);

  let notif = '';
  const t0 = Date.now();
  while (jobId && Date.now() - t0 < 6 * 60_000) {
    await sleep(30_000);
    r = await call('slurm_watches');
    const line = r.text.split('\n').find(l => l.includes(`array job ${jobId}`)) || '';
    const wl = r.text.split('\n').find(l => l.trim().startsWith(jobId)) || '(watch gone)';
    console.log(`  [t+${Math.round((Date.now() - t0) / 1000)}s] watch: ${wl.trim()} | notif: ${line.trim() || '-'}`);
    if (line) { notif = line; break; }
  }
  check('array notification "2 ok / 0 failed"', /2 ok \/ 0 failed/.test(notif), notif || '(none within 6 min)');

  r = await call('ssh_exec', { command: `ls ${DIR}/logs` });
  check(`logs slurm_${jobId}_1.out & _2.out`, r.text.includes(`slurm_${jobId}_1.out`) && r.text.includes(`slurm_${jobId}_2.out`), r.text);
  r = await call('slurm_logs', { job_id: `${jobId}_2` });
  console.log('    slurm_logs _2:', r.text.replace(/\n/g, ' | ').slice(0, 300));

  r = await call('slurm_cancel', { job_id: `${jobId}_1` });
  check('slurm_cancel <id>_1 passes id validation', !/Invalid job ID/.test(r.text), r.text);
} catch (err) {
  fails++;
  console.log(`FAIL aborted: ${err.message}`);
} finally {
  const rm = await call('ssh_exec', { command: `rm -rf ${DIR}` }).catch(e => ({ text: String(e) }));
  console.log('    cleanup rm:', rm.text);
  const ls = await call('ssh_exec', { command: `ls -d ${DIR}`, verbose: true }).catch(e => ({ text: String(e), isError: true }));
  check('self-test dir removed', ls.isError && /No such file/.test(ls.text), ls.text.split('\n').slice(-1)[0]);
  console.log(fails ? `\nRESULT: ${fails} FAIL` : '\nRESULT: ALL PASS');
  child.stdin.end();
  setTimeout(() => process.exit(fails ? 1 : 0), 500);
}
