// Unit tests for the pure helpers in index.mjs. Importing index.mjs with
// SLURM_MCP_NO_START=1 registers the tools but starts no poller, stdin hooks
// or transport. No network, no real ssh.
// `test.todo` entries tagged BUG-<n> encode the intended behavior for known
// bugs (see CHANGELOG "Known issues"); they report as todo until fixed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = mkdtempSync(join(tmpdir(), 'slurm-mcp-unit-'));
Object.assign(process.env, {
  SLURM_MCP_NO_START: '1', HOME, HPC_HOST: 'fake', HPC_USER: 'u', SLURM_ACCOUNT: 'acct',
});
delete process.env.NOTIFY_WEBHOOK;
delete process.env.HPC_RESOURCE_LOG;
const M = await import(pathToFileURL(join(ROOT, 'index.mjs')).href);

// Mirrors the poller's aggregation: sacct rows → Map(taskKey → state), the
// allocation row (listed before its .batch/.extern steps) wins per task.
function rowsToTasks(text) {
  const tasks = new Map();
  for (const line of text.trim().split('\n')) {
    const [rawId, state] = line.split('|').map(s => s.trim());
    const p = M.parseSacctJobId(rawId);
    if (p && !tasks.has(p.taskKey)) tasks.set(p.taskKey, state);
  }
  return tasks;
}

describe('parseSacctJobId', () => {
  const cases = [
    ['541806', { baseId: '541806', taskKey: null }],
    ['541806.batch', { baseId: '541806', taskKey: null }],
    ['541806.extern', { baseId: '541806', taskKey: null }],
    ['541822_1', { baseId: '541822', taskKey: '1' }],
    ['541822_1.batch', { baseId: '541822', taskKey: '1' }],
    ['541822_[3-10]', { baseId: '541822', taskKey: '[3-10]' }],
    ['541822_[2-10%2]', { baseId: '541822', taskKey: '[2-10%2]' }],
    ['541806.0', { baseId: '541806', taskKey: null }],
  ];
  for (const [id, want] of cases) test(id, () => assert.deepEqual(M.parseSacctJobId(id), want));
  for (const bad of ['', 'JobID', 'abc', '541806_x', '12345;rm']) {
    test(`rejects ${JSON.stringify(bad)}`, () => assert.equal(M.parseSacctJobId(bad), null));
  }
  test.todo('heterogeneous job ids "12345+0" are not recognised (BUG-6)', () => {
    assert.deepEqual(M.parseSacctJobId('12345+0'), { baseId: '12345', taskKey: null });
  });
});

describe('countTasksInKey', () => {
  for (const [k, n] of [[null, 1], ['1', 1], ['[3-10]', 8], ['[2-10%2]', 9], ['[1,3,5-7]', 5], ['[1-9:2]', 5], ['[x]', 1]]) {
    test(String(k), () => assert.equal(M.countTasksInKey(k), n));
  }
});

describe('summarizeJobRows', () => {
  test('plain job with .batch/.extern steps, completed', () => {
    const s = M.summarizeJobRows(rowsToTasks('541806|COMPLETED\n541806.batch|COMPLETED\n541806.extern|COMPLETED'));
    assert.equal(s.isArray, false); assert.equal(s.allDone, true); assert.equal(s.ok, 1); assert.equal(s.failed, 0);
    assert.deepEqual(s.states, ['COMPLETED']);
  });
  test('plain job running is not done', () => {
    const s = M.summarizeJobRows(rowsToTasks('541806|RUNNING\n541806.batch|RUNNING'));
    assert.equal(s.allDone, false); assert.equal(s.running, true);
  });
  test('array: all tasks completed', () => {
    const s = M.summarizeJobRows(rowsToTasks('541822_1|COMPLETED\n541822_1.batch|COMPLETED\n541822_2|COMPLETED\n541822_2.extern|COMPLETED'));
    assert.deepEqual([s.isArray, s.allDone, s.ok, s.failed], [true, true, 2, 0]);
  });
  test('array: partially completed stays active', () => {
    const s = M.summarizeJobRows(rowsToTasks('541822_1|COMPLETED\n541822_1.batch|COMPLETED\n541822_2|RUNNING'));
    assert.deepEqual([s.isArray, s.allDone, s.ok, s.running], [true, false, 1, true]);
  });
  test('array: pending range row 12345_[3-10] keeps it active', () => {
    const s = M.summarizeJobRows(rowsToTasks('541822_1|COMPLETED\n541822_2|RUNNING\n541822_[3-10]|PENDING'));
    assert.equal(s.allDone, false);
    assert.equal([...rowsToTasks('541822_[3-10]|PENDING').keys()].reduce((n, k) => n + M.countTasksInKey(k), 0), 8);
  });
  test('array: CANCELLED by <uid> counts as failed and terminal', () => {
    const s = M.summarizeJobRows(rowsToTasks('541822_1|COMPLETED\n541822_2|FAILED\n541822_3|CANCELLED by 12345\n541822_3.batch|CANCELLED'));
    assert.deepEqual([s.allDone, s.ok, s.failed], [true, 1, 2]);
    assert.deepEqual([...s.failedKinds], [['FAILED', 1], ['CANCELLED', 1]]);
  });
  test('array: whole pending range cancelled counts every task', () => {
    const s = M.summarizeJobRows(rowsToTasks('541822_[3-10]|CANCELLED by 12345'));
    assert.deepEqual([s.allDone, s.ok, s.failed], [true, 0, 8]);
  });
  test('plain job CANCELLED by <uid> is terminal', () => {
    const s = M.summarizeJobRows(rowsToTasks('541900|CANCELLED by 12345\n541900.batch|CANCELLED'));
    assert.deepEqual([s.allDone, s.failed, s.states[0]], [true, 1, 'CANCELLED by 12345']);
  });
  test('empty map is never done', () => assert.equal(M.summarizeJobRows(new Map()).allDone, false));
});

describe('baseState / isTerminalState', () => {
  test('baseState strips the "by <uid>" suffix and whitespace', () => {
    assert.equal(M.baseState('CANCELLED by 12345'), 'CANCELLED');
    assert.equal(M.baseState('  RUNNING '), 'RUNNING');
    assert.equal(M.baseState(undefined), '');
    assert.equal(M.baseState(null), '');
  });
  for (const s of ['COMPLETED', 'FAILED', 'CANCELLED', 'CANCELLED by 1', 'TIMEOUT', 'OUT_OF_MEMORY', 'NODE_FAIL', 'PREEMPTED', 'BOOT_FAIL', 'DEADLINE', 'REVOKED']) {
    test(`terminal: ${s}`, () => assert.equal(M.isTerminalState(s), true));
  }
  for (const s of ['PENDING', 'RUNNING', 'REQUEUED', 'SUSPENDED', 'COMPLETING', '', 'UNKNOWN']) {
    test(`active: ${JSON.stringify(s)}`, () => assert.equal(M.isTerminalState(s), false));
  }
});

describe('parseSlurmTime', () => {
  const ok = [['90', 5400], ['5:30', 330], ['00:03:00', 180], ['1-2', 93600], ['1-2:30', 95400], ['2-00:00:00', 172800], [' 15 ', 900]];
  for (const [t, v] of ok) test(`${JSON.stringify(t)} → ${v}`, () => assert.equal(M.parseSlurmTime(t), v));
  for (const bad of ['UNLIMITED', '1h', '', '1:2:3:4', '-5', '1-', '1.5', '10\n#SBATCH --x', null, undefined, 90]) {
    test(`invalid ${JSON.stringify(bad)}`, () => assert.equal(M.parseSlurmTime(bad), null));
  }
});

describe('validateSubmitArgs', () => {
  const base = { job_name: 'train', partition: 'batch', gpus: 1, mem: '4G', time: '00:15:00', output_dir: 'results/logs' };
  const errs = (over) => M.validateSubmitArgs({ ...base, ...over });
  test('defaults are valid', () => assert.deepEqual(errs({}), []));
  const good = {
    job_name: ['a.b-c_1', 'x'.repeat(64)], partition: ['short', 'gpu-a100'], mem: ['512M', '4096', '1T'],
    time: ['90', '1-2:30', '2-00:00:00'], array: ['1-10', '1,3,5-7', '1-100%5'],
    dependency: ['afterok:12345', 'afterany:12345_1,afterok:67890', 'singleton'],
    gpus: [0, 8], cpus_per_task: [4, undefined], output_dir: ['/scratch/u/logs', 'logs'],
  };
  const bad = {
    job_name: ["bad'name", 'has space', 'x'.repeat(65), ''], partition: ['a;b', 'short batch'],
    mem: ['4GB', '4g', '-1G', '4G;x'], time: ['1h', 'UNLIMITED', '00:15:00;x'],
    array: ['1-3;rm', 'a'], dependency: ['afterok:1;x', 'before:1'],
    gpus: [-1, 1.5, '1'], cpus_per_task: [-2, 2.5], output_dir: ['/a b', "/it's", '/a/../b', '/a;b', '/a$(x)'],
  };
  for (const [field, vals] of Object.entries(good)) {
    for (const v of vals) test(`${field}=${JSON.stringify(v)} accepted`, () => assert.deepEqual(errs({ [field]: v }), []));
  }
  for (const [field, vals] of Object.entries(bad)) {
    for (const v of vals) test(`${field}=${JSON.stringify(v)} rejected`, () => {
      const e = errs({ [field]: v });
      assert.equal(e.length, 1, JSON.stringify(e));
      assert.match(e[0], new RegExp(field), 'error names the offending field');
    });
  }
  test.todo('dependency "afterok" without a job id is accepted; sbatch rejects it (BUG-9)', () => {
    assert.notDeepEqual(errs({ dependency: 'afterok' }), []);
  });
  test.todo('array step syntax "1-10:2" (valid SLURM) is rejected (BUG-10)', () => {
    assert.deepEqual(errs({ array: '1-10:2' }), []);
  });
  test('collects every error at once', () => assert.equal(errs({ job_name: 'a b', mem: 'x', time: 'y' }).length, 3));
  test.todo('time is validated after trim() but written untrimmed into #SBATCH (BUG-7)', () => {
    assert.notDeepEqual(errs({ time: '10\n' }), []);
  });
});

describe('VALID_JOB_ID / validateJobId', () => {
  for (const id of ['12345', '12345_3', '12345_[1-5]', '12345_[1,3-4]']) {
    test(`valid ${id}`, () => { assert.equal(M.VALID_JOB_ID.test(id), true); assert.equal(M.validateJobId(id), id); });
  }
  for (const id of ['12345;rm', '12345_[1-5];x', "12345'", 'abc', '', '12345_', '12345_[1-5%2]', '12345 6789']) {
    test(`invalid ${JSON.stringify(id)}`, () => {
      assert.equal(M.VALID_JOB_ID.test(id), false);
      assert.throws(() => M.validateJobId(id), /Invalid job ID/);
    });
  }
});

describe('RE_JOB_NAME', () => {
  for (const n of ['train', 'a.b-c_1', 'x'.repeat(64)]) test(`ok ${n.slice(0, 10)}`, () => assert.equal(M.RE_JOB_NAME.test(n), true));
  for (const n of ['', 'x'.repeat(65), 'a b', 'a;b', "a'b", 'a/b', 'a$b']) test(`bad ${JSON.stringify(n.slice(0, 10))}`, () => assert.equal(M.RE_JOB_NAME.test(n), false));
});

describe('guardCommand', () => {
  const allowed = ['ls -la /scratch', 'python train.py --epochs 3', 'cat results/log.txt | wc -l', 'sed s/a/b/ f', 'echo hi'];
  for (const c of allowed) test(`allows ${c}`, () => assert.equal(M.guardCommand(c), null));
  // [rule, blocked example, near-miss that must pass]
  const rules = [
    ['heredoc', 'cat <<EOF > f', 'cat a > f'],
    ['python -c', 'python3 -c import\\ os', 'python3 script.py -c cfg'],
    ['multi-line (>2 lines)', 'a\nb\nc\nd', 'a\nb'],
    ['double quote', 'echo "hi"', 'echo hi'],
    ['single quote', "echo 'hi'", 'echo hi'],
    ['grep', 'grep foo file', 'cat file'],
    ['awk', 'awk {print} f', 'cat f'],
    ['sed -', 'sed -i s/a/b/ f', 'sed s/a/b/ f'],
  ];
  assert.equal(M.BLOCKED_PATTERNS.length, rules.length, 'one test pair per rule');
  rules.forEach(([name, blocked, passes], i) => {
    test(`rule ${i + 1} (${name}) blocks`, () => {
      const r = M.guardCommand(blocked);
      assert.ok(r && r.startsWith('BLOCKED:'), String(r));
      assert.equal(r, `BLOCKED: ${M.BLOCKED_PATTERNS[i].reason}`, 'blocked by the intended rule');
    });
    test(`rule ${i + 1} (${name}) near-miss passes`, () => assert.equal(M.guardCommand(passes), null));
  });
  test('length limit', () => {
    assert.equal(M.guardCommand('x'.repeat(M.MAX_CMD_LENGTH)), null);
    assert.match(M.guardCommand('x'.repeat(M.MAX_CMD_LENGTH + 1)), /超过 500/);
  });
  test.todo('3-line commands pass the ">2 lines" rule (BUG-3)', () => {
    assert.notEqual(M.guardCommand('a\nb\nc'), null);
  });
  test.todo('"<<-EOF" heredoc bypasses the heredoc rule (BUG-4)', () => {
    assert.notEqual(M.guardCommand('cat <<-X > f'), null);
  });
});

describe('compressOutput', () => {
  test('empty output', () => assert.equal(M.compressOutput('ls', ''), '(no output)'));
  test('quiet command keeps first line', () => assert.equal(M.compressOutput('mkdir -p x', 'warn\nmore'), '✓ warn'));
  test('nav command truncated after 30 lines', () => {
    const out = Array.from({ length: 35 }, (_, i) => `f${i}`).join('\n');
    const r = M.compressOutput('ls', out);
    assert.equal(r.split('\n').length, 31); assert.match(r, /\(5 more lines\)$/);
  });
  test('nav command ≤30 lines untouched', () => assert.equal(M.compressOutput('ls', 'a\nb'), 'a\nb'));
  test('other commands untouched', () => {
    const out = Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n');
    assert.equal(M.compressOutput('python train.py', out), out);
  });
  test.todo('"cd dir && python run.py" output is cut to its first line (BUG-2)', () => {
    assert.equal(M.compressOutput('cd /w && python run.py', 'epoch 1\nepoch 2\ndone'), 'epoch 1\nepoch 2\ndone');
  });
});

describe('parseElapsed / parseResourceHistory / formatRecommendation', () => {
  for (const [s, v] of [['1-02:03:04', 93784], ['02:03:04', 7384], ['03:04', 184], ['', 0], [undefined, 0], ['junk', 0], ['1:2:3:4', 0]]) {
    test(`parseElapsed(${JSON.stringify(s)}) = ${v}`, () => assert.equal(M.parseElapsed(s), v));
  }
  const sacct = [
    '541806|train|00:10:00||4G|COMPLETED',
    '541806.batch|batch|00:10:00|1201368K||COMPLETED',
    '541807|train|1-00:00:30||4G|COMPLETED',
    '541807.batch|batch|1-00:00:30|2G||COMPLETED',
    '541808|train|00:00:05||4G|FAILED',
  ].join('\n');
  test('parses peak mem/time over COMPLETED rows', () => {
    const h = M.parseResourceHistory(sacct);
    assert.equal(h.maxMemGB, 2); assert.equal(h.maxTimeSec, 86430);
  });
  test('K / M suffixes', () => {
    assert.ok(Math.abs(M.parseResourceHistory('1|b|00:01:00|1201368K||COMPLETED').maxMemGB - 1.1457) < 1e-3);
    assert.equal(M.parseResourceHistory('1|b|00:01:00|512M||COMPLETED').maxMemGB, 0.5);
  });
  test('null on empty / no COMPLETED rows', () => {
    assert.equal(M.parseResourceHistory(''), null);
    assert.equal(M.parseResourceHistory('1|x|00:01:00||4G|FAILED'), null);
  });
  test.todo('count includes .batch/.extern step rows, inflating "N recent jobs" (BUG-8)', () => {
    assert.equal(M.parseResourceHistory(sacct).count, 2);
  });
  test('formatRecommendation: ×3 mem, ×4 time', () => {
    const r = M.formatRecommendation({ maxMemGB: 1.1457, maxTimeSec: 600, count: 2 });
    assert.match(r, /--mem=4G --time=00:40:00/); assert.match(r, /Actual peak: 1\.1G mem, 10m0s time/); assert.match(r, /\(2 recent jobs\)/);
  });
  test('formatRecommendation: floors 2G / 5 min', () => {
    assert.match(M.formatRecommendation({ maxMemGB: 0.1, maxTimeSec: 30, count: 1 }), /--mem=2G --time=00:05:00/);
  });
  test('formatRecommendation(null) is empty', () => assert.equal(M.formatRecommendation(null), ''));
});

describe('checkResourceWaste', () => {
  const hist = { maxMemGB: 0.2, maxTimeSec: 600, count: 1 };
  test('4096M (=4G) is 20x usage → memory warning', () => {
    const r = M.checkResourceWaste('4096M', '00:15:00', hist);
    assert.match(r, /Memory 4G is 20x actual usage/); assert.doesNotMatch(r, /Time/);
  });
  test('plain MB number 4096 same as 4096M', () => assert.equal(M.checkResourceWaste('4096', '00:15:00', hist), M.checkResourceWaste('4096M', '00:15:00', hist)));
  test('D-HH:MM:SS time → time warning (no NaN)', () => {
    const r = M.checkResourceWaste('2G', '1-00:00:00', hist);
    assert.match(r, /Time 1-00:00:00 is 144x/); assert.doesNotMatch(r, /NaN/);
  });
  test('exactly 10x does not warn (strict >)', () => assert.equal(M.checkResourceWaste('2G', '01:40:00', hist), ''));
  test('no history / zero mem → no warning', () => {
    assert.equal(M.checkResourceWaste('400G', '2-00:00:00', null), '');
    assert.equal(M.checkResourceWaste('400G', '2-00:00:00', { maxMemGB: 0, maxTimeSec: 1 }), '');
  });
  test('memToMB', () => assert.deepEqual([M.memToMB('256G'), M.memToMB('2G'), M.memToMB('4096'), M.memToMB('1T'), M.memToMB('x')], [262144, 2048, 4096, 1048576, null]));
});

describe('atomicWriteJson / readJsonOrQuarantine', () => {
  const dir = join(HOME, 'state');
  test('round trip, creates parent dirs, leaves no tmp files', () => {
    const p = join(dir, 'nested', 'a.json');
    M.atomicWriteJson(p, [{ x: 1 }]);
    assert.deepEqual(M.readJsonOrQuarantine(p, []), [{ x: 1 }]);
    assert.deepEqual(readdirSync(dirname(p)), ['a.json']);
  });
  test('missing file → fallback, nothing created', () => {
    const p = join(dir, 'missing.json');
    assert.deepEqual(M.readJsonOrQuarantine(p, ['fb']), ['fb']);
    assert.equal(existsSync(p), false);
  });
  test('corrupt JSON is moved aside as .corrupt-<ts>', () => {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'bad.json');
    writeFileSync(p, '[{"half":');
    assert.deepEqual(M.readJsonOrQuarantine(p, []), []);
    assert.equal(existsSync(p), false);
    const aside = readdirSync(dir).filter(f => f.startsWith('bad.json.corrupt-'));
    assert.equal(aside.length, 1);
    assert.equal(readFileSync(join(dir, aside[0]), 'utf8'), '[{"half":');
  });
  test('wrong shape (validate=false) is quarantined too', () => {
    const p = join(dir, 'shape.json');
    writeFileSync(p, '{"not":"array"}');
    assert.deepEqual(M.readJsonOrQuarantine(p, [], Array.isArray), []);
    assert.equal(readdirSync(dir).filter(f => f.startsWith('shape.json.corrupt-')).length, 1);
  });
});

describe('withFileLock', () => {
  const dir = join(HOME, 'locks');
  mkdirSync(dir, { recursive: true });
  test('returns fn result and removes the lock dir', () => {
    const p = join(dir, 'a.json');
    assert.equal(M.withFileLock(p, () => { assert.equal(existsSync(`${p}.lock`), true); return 42; }), 42);
    assert.equal(existsSync(`${p}.lock`), false);
  });
  test('releases the lock when fn throws', () => {
    const p = join(dir, 'b.json');
    assert.throws(() => M.withFileLock(p, () => { throw new Error('boom'); }), /boom/);
    assert.equal(existsSync(`${p}.lock`), false);
  });
  test('reclaims a stale lock (>10s old) immediately', () => {
    const p = join(dir, 'c.json');
    mkdirSync(`${p}.lock`);
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(`${p}.lock`, old, old);
    const t0 = Date.now();
    assert.equal(M.withFileLock(p, () => 'ran'), 'ran');
    assert.ok(Date.now() - t0 < 1000, 'no 2s wait');
    assert.equal(existsSync(`${p}.lock`), false);
  });
  test('fresh foreign lock: fail-open after ~2s and leaves the foreign lock alone', () => {
    const p = join(dir, 'd.json');
    mkdirSync(`${p}.lock`);
    const t0 = Date.now();
    assert.equal(M.withFileLock(p, () => 'ran'), 'ran');
    const dt = Date.now() - t0;
    assert.ok(dt >= 1900 && dt < 5000, `waited ${dt}ms`);
    assert.equal(existsSync(`${p}.lock`), true);
  });
  test('two processes doing read-modify-write never lose an update', async () => {
    const p = join(dir, 'counter.json');
    writeFileSync(p, '{"n":0}');
    const N = 60;
    const script = `
      const M = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'index.mjs')).href)});
      for (let i = 0; i < ${N}; i++) M.withFileLock(${JSON.stringify(p)}, () => {
        const d = M.readJsonOrQuarantine(${JSON.stringify(p)}, null);
        M.atomicWriteJson(${JSON.stringify(p)}, { n: d.n + 1 });
      });`;
    const run = () => new Promise((res, rej) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', script], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; c.stderr.on('data', d => { err += d; });
      c.on('exit', code => (code === 0 ? res() : rej(new Error(`child exit ${code}: ${err}`))));
    });
    await Promise.all([run(), run()]);
    assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { n: 2 * N });
  });
});

describe('validatePath / validateSession', () => {
  test('validatePath', () => {
    assert.equal(M.validatePath('/scratch/u/x', 'p'), null);
    assert.match(M.validatePath('/a;b', 'p'), /unsafe/);
    assert.match(M.validatePath('/a/../b', 'p'), /traversal/);
  });
  test('validateSession', () => {
    assert.equal(M.validateSession('hpc-1_a'), 'hpc-1_a');
    assert.throws(() => M.validateSession('a b'), /Invalid session name/);
  });
});
