// Unit tests for the pure helpers in index.mjs. Importing index.mjs with
// SLURM_MCP_NO_START=1 registers the tools but starts no poller, stdin hooks
// or transport. No network, no real ssh.
// Tests tagged BUG-<n> / B<n> are regression tests for the round-2 fixes
// (see CHANGELOG, Unreleased → Fixed).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = mkdtempSync(join(tmpdir(), 'slurm-mcp-unit-'));
Object.assign(process.env, {
  SLURM_MCP_NO_START: '1', HOME, HPC_HOST: 'fake', HPC_USER: 'u', SLURM_ACCOUNT: 'acct',
});
delete process.env.NOTIFY_WEBHOOK;
delete process.env.HPC_RESOURCE_LOG;
const M = await import(pathToFileURL(join(ROOT, 'index.mjs')).href);
// A pid that existed and has exited (for "dead lock owner" tests).
const DEAD_PID = spawnSync(process.execPath, ['-e', '']).pid;

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
  test('heterogeneous job ids "12345+0" fold into the base id (BUG-6)', () => {
    assert.deepEqual(M.parseSacctJobId('12345+0'), { baseId: '12345', taskKey: null, het: '0' });
    assert.deepEqual(M.parseSacctJobId('12345+1.batch'), { baseId: '12345', taskKey: null, het: '1' });
    assert.equal(M.parseSacctJobId('12345+x'), null);
  });
  test('hetjob completes only when every component is terminal; verdict = first non-COMPLETED (BUG-6)', () => {
    const run = M.aggregateSacctRows('12345+0|COMPLETED\n12345+0.batch|COMPLETED\n12345+1|RUNNING\n12345+1.batch|RUNNING');
    const r = M.summarizeJobRows(run.get('12345'));
    assert.deepEqual([r.allDone, r.isArray, r.isHet, r.running], [false, false, true, true]);
    const done = M.summarizeJobRows(M.aggregateSacctRows('12345+0|COMPLETED\n12345+0.batch|COMPLETED\n12345+1|FAILED\n12345+1.batch|FAILED').get('12345'));
    assert.deepEqual([done.allDone, done.isArray, done.verdict], [true, false, 'FAILED']);
  });
  test('aggregateSacctRows groups by base id, allocation row wins over steps', () => {
    const m = M.aggregateSacctRows('541806|COMPLETED\n541806.batch|FAILED\n541822_1|RUNNING\n541822_[2-3]|PENDING\n\ngarbage|X\n');
    assert.deepEqual([...m.keys()], ['541806', '541822']);
    assert.deepEqual([...m.get('541806')], [[null, 'COMPLETED']]);
    assert.deepEqual([...m.get('541822')], [['1', 'RUNNING'], ['[2-3]', 'PENDING']]);
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
  test('dependency after* without a job id is rejected; singleton takes no id (BUG-9)', () => {
    for (const d of ['afterok', 'afterany', 'afterok:', 'afterok:1,afterany', 'singleton:123']) {
      assert.equal(errs({ dependency: d }).length, 1, d);
    }
    for (const d of ['afterok:1:2', 'afterok:1,singleton', 'singleton,afterany:5_2']) {
      assert.deepEqual(errs({ dependency: d }), [], d);
    }
  });
  test('array step syntax "1-10:2" (valid SLURM) is accepted (BUG-10)', () => {
    for (const a of ['1-10:2', '1-10:2%3', '1,5-9:2', '0-100:10%5']) assert.deepEqual(errs({ array: a }), [], a);
    for (const a of ['1:2', '1-10:', '1-10:2:3']) assert.equal(errs({ array: a }).length, 1, a);
  });
  test('collects every error at once', () => assert.equal(errs({ job_name: 'a b', mem: 'x', time: 'y' }).length, 3));
  test('time with surrounding whitespace is rejected: validated string = written string (BUG-7)', () => {
    for (const t of ['10\n', ' 10 ', '00:15:00 ']) assert.equal(errs({ time: t }).length, 1, JSON.stringify(t));
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
  test('3-line commands are blocked by the ">2 lines" rule (BUG-3)', () => {
    assert.equal(M.guardCommand('a\nb\nc'), `BLOCKED: ${M.BLOCKED_PATTERNS[2].reason}`);
    assert.equal(M.guardCommand('a\n\nc'), `BLOCKED: ${M.BLOCKED_PATTERNS[2].reason}`);
    assert.equal(M.guardCommand('a\nb\n'), null, 'a trailing newline is not a third line');
  });
  test('"<<-EOF" heredoc is blocked by the heredoc rule (BUG-4)', () => {
    assert.equal(M.guardCommand('cat <<-X > f'), `BLOCKED: ${M.BLOCKED_PATTERNS[0].reason}`);
    assert.equal(M.guardCommand('cat <<- X > f'), `BLOCKED: ${M.BLOCKED_PATTERNS[0].reason}`);
  });
  test('python -c variants are blocked (BUG-4)', () => {
    for (const c of ['python3.11 -c import\\ os', 'python -u -c import\\ os', 'python -uc x', 'python3 -B -c x', '/usr/bin/python3 -c x']) {
      assert.equal(M.guardCommand(c), `BLOCKED: ${M.BLOCKED_PATTERNS[1].reason}`, c);
    }
    for (const c of ['python3.11 train.py -c cfg', 'python -u train.py', 'python -m pip list']) assert.equal(M.guardCommand(c), null, c);
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
  test('compound commands starting with a quiet verb keep full output (BUG-2)', () => {
    const out = 'epoch 1\nepoch 2\ndone';
    for (const c of ['cd /w && python run.py', 'source env.sh; python run.py', 'mkdir -p x && ls x', 'module load cuda | tee log']) {
      assert.equal(M.compressOutput(c, out), out, c);
    }
    const long = Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n');
    assert.equal(M.compressOutput('echo start && python train.py', long), long, 'compound nav-prefixed command untouched');
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
  test('count is distinct jobs, not .batch/.extern step rows (BUG-8)', () => {
    assert.equal(M.parseResourceHistory(sacct).count, 2);
  });
  test('real-shaped rows: MaxRSS only on steps, decimals and T units (B7/B8)', () => {
    const h = M.parseResourceHistory([
      '600|train|00:10:00||4G|COMPLETED', '600.batch|batch|00:10:00|1.50G||COMPLETED', '600.extern|extern|00:10:00|1024K||COMPLETED',
      '601_2|train|00:02:00||4G|COMPLETED', '601_2.batch|batch|00:02:00|0.5T||COMPLETED',
      '602|train|00:01:00||4G|CANCELLED by 1', '602.batch|batch|00:01:00|900G||CANCELLED',
    ].join('\n'));
    assert.deepEqual(h, { maxMemGB: 512, maxTimeSec: 600, count: 2 });
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

describe('parseMemToMB / summarizeResourceReport (B8)', () => {
  const cases = [['1201368K', 1201368 / 1024], ['1.5M', 1.5], ['2.25G', 2304], ['2T', 2 * 1024 * 1024], ['1P', 1024 ** 3],
    ['1048576', 1024], ['0', 0], ['4Gn', 4096], ['500Mc', 500], ['4GB', 4096], ['4GiB', 4096]];
  for (const [s, v] of cases) test(`parseMemToMB(${s}) = ${v}`, () => assert.ok(Math.abs(M.parseMemToMB(s) - v) < 1e-9, String(M.parseMemToMB(s))));
  for (const bad of ['', null, undefined, 'x', '1.2.3G', '-1K', '4X']) test(`parseMemToMB(${JSON.stringify(bad)}) = null`, () => assert.equal(M.parseMemToMB(bad), null));
  test('bare number is KB for sacct (R11), MB for requests', () => {
    assert.equal(M.parseMemToMB('2048'), 2);
    assert.equal(M.parseMemToMB('2048', 'M'), 2048);
    // resource history: a suffix-less MaxRSS is not under-read 1024x
    const h = M.parseResourceHistory('9|t|00:01:00||4G|COMPLETED\n9.batch|batch|00:01:00|3145728||COMPLETED');
    assert.equal(h.maxMemGB, 3);
  });
  test('resource_report aggregation: peak memory comes from step rows', () => {
    const raw = [
      '700|a|batch|00:10:00||4G|billing=1,gres/gpu=1|COMPLETED',
      '700.batch|batch||00:10:00|2.5G|||COMPLETED',
      '700.extern|extern||00:10:00|1K|||COMPLETED',
      '701|b|batch|01:00:00||4G|billing=1|FAILED',
      '701.batch|batch||01:00:00|7T|||FAILED',
      '702.batch|batch||00:01:00|99T|||COMPLETED', // step without allocation row: ignored
    ].join('\n');
    const s = M.summarizeResourceReport(raw);
    assert.deepEqual(s, { totalJobs: 2, completed: 1, failed: 1, totalTimeSec: 4200, maxMemGB: 7 * 1024, gpuJobs: 1 });
  });
});

describe('watch file hygiene (BUG-5, B5)', () => {
  const H = 3600 * 1000;
  const now = Date.parse('2026-09-27T12:00:00Z');
  const iso = (ms) => new Date(ms).toISOString();
  test('isValidWatch rejects null / non-objects / bad jobId / bad host', () => {
    for (const w of [null, 1, 'x', [], {}, { jobId: 5.5 }, { jobId: -1 }, { jobId: '5;rm' }, { jobId: '5', host: '' }, { jobId: '5', host: 3 },
      { jobId: '5', host: 'mp;rm' }, { jobId: '5', host: '-oProxyCommand=x' }, { jobId: '5', host: 'a b' }]) {
      assert.equal(M.isValidWatch(w), false, JSON.stringify(w));
    }
    assert.equal(M.isValidWatch({ jobId: '541806' }), true);
    assert.equal(M.isValidWatch({ jobId: '541806', host: 'mp' }), true);
    assert.equal(M.isValidWatch({ jobId: '541806', host: 'u@login.hpc.edu' }), true);
  });
  test('numeric jobId is accepted, not dropped (R8)', () => {
    assert.equal(M.isValidWatch({ jobId: 541806 }), true);
    assert.equal(M.isValidWatch({ jobId: 541806, host: 'mp' }), true);
  });
  test('never expires without unseenSince, whatever its age (R4: master outage)', () => {
    assert.equal(M.isWatchExpired({ submittedAt: iso(now - 30 * 24 * H), estimatedSeconds: 900 }, now), false);
    assert.equal(M.isWatchExpired({ submittedAt: iso(now - 30 * 24 * H), lastSeenAt: iso(now - 29 * 24 * H), estimatedSeconds: 900 }, now), false);
  });
  test('expires after max(48h, 4×estimate) of successful polls not seeing the job (R4)', () => {
    assert.equal(M.isWatchExpired({ unseenSince: iso(now - 49 * H), estimatedSeconds: 900 }, now), true);
    assert.equal(M.isWatchExpired({ unseenSince: iso(now - 47 * H), estimatedSeconds: 900 }, now), false);
    // 2-day time limit → 8-day TTL
    assert.equal(M.isWatchExpired({ unseenSince: iso(now - 7 * 24 * H), estimatedSeconds: 2 * 86400 }, now), false);
    assert.equal(M.isWatchExpired({ unseenSince: iso(now - 9 * 24 * H), estimatedSeconds: 2 * 86400 }, now), true);
    assert.equal(M.isWatchExpired({ unseenSince: 'garbage', estimatedSeconds: 900 }, now), false);
  });
});

describe('expandLogPattern (B10)', () => {
  test('expands %j for a plain id and %A/%a for an array task', () => {
    assert.equal(M.expandLogPattern('/w/logs/slurm_%j.out', '541806'), '/w/logs/slurm_541806.out');
    assert.equal(M.expandLogPattern('/w/logs/slurm_%A_%a.out', '541822_4'), '/w/logs/slurm_541822_4.out');
    assert.equal(M.expandLogPattern('/w/%5a/x%%.out', '9_3'), '/w/00003/x%.out');
  });
  test('placeholders not determined by the id → null', () => {
    assert.equal(M.expandLogPattern('/w/slurm_%j.out', '541822_4'), null, '%j of an array task is its own id');
    assert.equal(M.expandLogPattern('/w/%x_%j.out', '541806'), null);
    assert.equal(M.expandLogPattern('/w/slurm_%A.out', '541806'), null);
  });
});

describe('safePoll (B3)', () => {
  test('a throwing poll cycle is recorded, counted and does not reject', async () => {
    const before = M.pollState().consecutivePollFailures;
    await M.safePoll(async () => { throw new Error('boom from poll'); });
    const st = M.pollState();
    assert.match(st.lastPollError, /poll cycle crashed: boom from poll/);
    assert.equal(st.consecutivePollFailures, before + 1);
  });
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
  test('stale reclaim renames atomically and leaves no .stale- dirs (BUG-11)', () => {
    const p = join(dir, 'e.json');
    mkdirSync(`${p}.lock`);
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(`${p}.lock`, old, old);
    assert.equal(M.withFileLock(p, () => 'ran'), 'ran');
    assert.deepEqual(readdirSync(dir).filter(f => f.startsWith('e.json')), []);
  });
  test('slower reclaimer of the same dead owner never steals the fresh lock (BUG-11 race, R3)', () => {
    const p = join(dir, 'f.json');
    const lockDir = `${p}.lock`;
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: DEAD_PID, host: hostname(), at: Date.now(), token: 'x' }));
    assert.equal(M.isLockStale(lockDir), true, 'both waiters judge it stale');
    // The first waiter reclaims and takes a fresh lock (live owner).
    assert.equal(M.reclaimStaleLock(lockDir), true);
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now(), token: 'winner' }));
    // The slower waiter acts on its earlier judgement: re-checked, refused.
    assert.equal(M.reclaimStaleLock(lockDir), false);
    assert.equal(M.readLockOwner(lockDir).token, 'winner', 'fresh lock survives');
    assert.deepEqual(readdirSync(dir).filter(f => f.startsWith('f.json.lock.')), [], 'no .stale-/.reclaim leftovers');
    rmSync(lockDir, { recursive: true });
  });
  test('dead owner pid: reclaimed at once, even with a fresh mtime (R3)', () => {
    const p = join(dir, 'g.json');
    mkdirSync(`${p}.lock`);
    writeFileSync(join(`${p}.lock`, 'owner.json'), JSON.stringify({ pid: DEAD_PID, host: hostname(), at: Date.now(), token: 'dead' }));
    const t0 = Date.now();
    assert.equal(M.withFileLock(p, () => 'ran'), 'ran');
    assert.ok(Date.now() - t0 < 1000, `no 2s wait (${Date.now() - t0}ms)`);
    assert.equal(existsSync(`${p}.lock`), false);
  });
  test('live owner is never preempted, even with an old mtime: fail-open at the deadline (R3)', () => {
    const p = join(dir, 'h.json');
    const lockDir = `${p}.lock`;
    mkdirSync(lockDir);
    const owner = JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() - 60_000, token: 'live' });
    writeFileSync(join(lockDir, 'owner.json'), owner);
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(lockDir, old, old);
    const t0 = Date.now();
    assert.equal(M.withFileLock(p, () => 'ran'), 'ran');
    const dt = Date.now() - t0;
    assert.ok(dt >= 1900 && dt < 5000, `waited ${dt}ms`);
    assert.equal(readFileSync(join(lockDir, 'owner.json'), 'utf8'), owner, 'holder lock untouched');
    rmSync(lockDir, { recursive: true });
  });
  test('the holder writes owner.json with its pid while it holds the lock (R3)', () => {
    const p = join(dir, 'i.json');
    M.withFileLock(p, () => {
      const o = M.readLockOwner(`${p}.lock`);
      assert.equal(o.pid, process.pid);
      assert.equal(M.isLockStale(`${p}.lock`), false);
    });
    assert.equal(existsSync(`${p}.lock`), false);
  });
  test('two waiters + one dead owner: exactly one reclaim, no lost update (R3)', async () => {
    const p = join(dir, 'counter2.json');
    writeFileSync(p, '{"n":0}');
    mkdirSync(`${p}.lock`);
    writeFileSync(join(`${p}.lock`, 'owner.json'), JSON.stringify({ pid: DEAD_PID, host: hostname(), at: Date.now(), token: 'dead' }));
    const N = 40;
    const script = `
      const M = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'index.mjs')).href)});
      for (let i = 0; i < ${N}; i++) M.withFileLock(${JSON.stringify(p)}, () => {
        const d = M.readJsonOrQuarantine(${JSON.stringify(p)}, null);
        M.atomicWriteJson(${JSON.stringify(p)}, { n: d.n + 1 });
      });`;
    const run = () => new Promise((res, rej) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', script], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; c.stderr.on('data', d => { err += d; });
      c.on('exit', code => (code === 0 ? res(err) : rej(new Error(`child exit ${code}: ${err}`))));
    });
    const t0 = Date.now();
    const errs = await Promise.all([run(), run()]);
    assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { n: 2 * N });
    assert.ok(!errs.join('').includes('fail-open'), 'nobody had to fail open');
    assert.ok(Date.now() - t0 < 10_000);
    assert.deepEqual(readdirSync(dir).filter(f => f.startsWith('counter2.json.lock')), []);
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

describe('env whitelists (R1)', () => {
  test('RE_HOST accepts aliases, FQDNs and user@host; rejects options and shell', () => {
    for (const h of ['mp', 'login.hpc.example.edu', 'user@host', 'u.x@login-01.hpc.edu', 'm3_b']) assert.equal(M.RE_HOST.test(h), true, h);
    for (const h of ['-oProxyCommand=x', '-x', 'a b', 'a;b', 'u@', '@h', 'u@-h x', 'a@b@c', '']) assert.equal(M.RE_HOST.test(h), false, h);
  });
  test('RE_USER accepts AD/LDAP/Kerberos names; rejects options and shell', () => {
    for (const u of ['tzheng', 'u@ad.example.edu', 'DOMAIN\\u', 'first.last', 'a-b_c']) assert.equal(M.RE_USER.test(u), true, u);
    for (const u of ['-oProxyCommand=x', 'u$(id)', "u'x", 'a b', 'u;x', '']) assert.equal(M.RE_USER.test(u), false, u);
  });
  test('RE_PARTITION accepts "gpu.a100", rejects a leading "-"', () => {
    for (const v of ['batch', 'gpu.a100', 'short-1']) assert.equal(M.RE_PARTITION.test(v), true, v);
    for (const v of ['-p', 'a;b', 'a b', '']) assert.equal(M.RE_PARTITION.test(v), false, v);
  });
  test('shq single-quotes for bash, including backslash and quote', () => {
    assert.equal(M.shq('DOMAIN\\u'), "'DOMAIN\\u'");
    assert.equal(M.shq("it's"), "'it'\\''s'");
    const out = spawnSync('bash', ['-c', `printf %s ${M.shq("DOMAIN\\u@x'y")}`], { encoding: 'utf8' }).stdout;
    assert.equal(out, "DOMAIN\\u@x'y");
  });
});

describe('sacctSinceDate (R10)', () => {
  test('YYYY-MM-DD, days before now, computed locally (no GNU date -d)', () => {
    const now = new Date(2026, 8, 27, 12, 0, 0).getTime(); // local 2026-09-27
    assert.equal(M.sacctSinceDate(7, now), '2026-09-20');
    assert.equal(M.sacctSinceDate(0, now), '2026-09-27');
    assert.equal(M.sacctSinceDate(30, now), '2026-08-28');
    assert.match(M.sacctSinceDate(7), /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('heartbeat ownership (R5)', () => {
  test('shutdown removes the heartbeat only when it is still ours', () => {
    M.writeHeartbeat();
    const files = readdirSync(M.HEARTBEAT_DIR);
    assert.equal(files.length, 1);
    const hb = join(M.HEARTBEAT_DIR, files[0]);
    // A new server in the same tty has taken over the heartbeat.
    writeFileSync(hb, JSON.stringify({ pid: process.pid + 100000, at: Date.now() }));
    assert.equal(M.removeOwnHeartbeat(), false);
    assert.equal(existsSync(hb), true, "the other server's heartbeat survives");
    M.writeHeartbeat();
    assert.equal(M.removeOwnHeartbeat(), true);
    assert.equal(existsSync(hb), false);
  });
});

describe('per-host poll backoff (R6)', () => {
  test('a failing host backs off alone; the loop keeps the base interval', () => {
    const base = M.currentPollDelay();
    const now = Date.now();
    const st = M.noteHostFailure('hostA', 'dead', now);
    M.noteHostFailure('hostA', 'dead', now);
    assert.equal(st.failures, 2);
    assert.equal(M.hostPollDue('hostA', now + 10), false, 'hostA skipped while backing off');
    assert.equal(M.hostPollDue('hostB', now + 10), true, 'hostB unaffected');
    assert.equal(M.currentPollDelay(), base, 'loop delay unchanged by a host failure');
    assert.deepEqual(Object.keys(M.pollState().hostBackoff), ['hostA']);
    M.noteHostSuccess('hostA');
    assert.equal(M.hostPollDue('hostA', now + 10), true);
    assert.deepEqual(M.pollState().hostBackoff, {});
  });
});

describe('tmux send-keys (R12)', () => {
  test('text is literal and after "--"; key names are keys', () => {
    assert.deepEqual(M.sendKeysArgs('hpc', '-n hi'), ['send-keys', '-t', 'hpc', '-l', '--', '-n hi']);
    assert.deepEqual(M.sendKeysArgs('hpc', 'Enter', { key: true }), ['send-keys', '-t', 'hpc', '--', 'Enter']);
    assert.equal(M.tmuxKeyName('Enter'), 'Enter');
    assert.equal(M.tmuxKeyName('Ctrl-C'), 'C-c');
    assert.equal(M.tmuxKeyName('C-d'), 'C-d');
    assert.equal(M.tmuxKeyName('echo Enter'), null);
    assert.equal(M.tmuxKeyName('-t other'), null);
  });
});

describe('gresHint (R13)', () => {
  test('only sbatch stderr about gres/GPU triggers the hint', () => {
    assert.match(M.gresHint({ stderr: 'sbatch: error: Invalid generic resource (gres) specification' }), /SLURM_DEFAULT_GPUS=0 or pass gpus:0/);
    assert.equal(M.gresHint({ stderr: 'sbatch: error: Invalid account', message: '... #SBATCH --gres=gpu:1 ...' }), '');
    assert.equal(M.gresHint(new Error('x')), '');
  });
});

// ---- Round-4 review fixes (C1-C14) ----

describe('sshOptsFor / parseControlPath (C1)', () => {
  test('ControlMaster mode pins the ControlPath and adds ProxyCommand=false; direct mode does not', () => {
    assert.deepEqual(M.sshOptsFor('alive', '/s/cm'), ['-o', 'BatchMode=yes', '-o', 'ControlPath=/s/cm', '-o', 'ProxyCommand=false']);
    assert.deepEqual(M.sshOptsFor('unconfigured', null), ['-o', 'BatchMode=yes']);
    assert.deepEqual(M.sshOptsFor('alive', null), ['-o', 'BatchMode=yes'], 'no pinned path → no ProxyCommand=false');
  });
  test('ControlPath from ssh -G output (%C-hashed path with ProxyJump)', () => {
    const g = 'hostname superpod.example.edu\ncontrolmaster auto\ncontrolpath /Users/u/.ssh/sockets/ssh_mux_e090d0f7\nproxyjump bastion\n';
    assert.equal(M.parseControlPath(g), '/Users/u/.ssh/sockets/ssh_mux_e090d0f7');
    assert.equal(M.parseControlPath('controlpath none\n'), null);
    assert.equal(M.parseControlPath('hostname x\n'), null);
    assert.equal(M.parseControlPath('controlpath /a b/c\n'), null, 'whitespace would split rsync -e');
    assert.equal(M.parseControlPath('controlpath /a/%h\n'), null, '% would be re-expanded');
  });
});

describe('pollerAlive busyUntil (C2)', () => {
  const hb = (tty, obj) => {
    mkdirSync(M.HEARTBEAT_DIR, { recursive: true });
    writeFileSync(join(M.HEARTBEAT_DIR, `${tty}.json`), JSON.stringify(obj));
  };
  test('stale heartbeat but busyUntil in the future → alive', () => {
    const now = Date.now();
    hb('busy-a', { pid: process.pid, at: now - 400_000, busyUntil: now + 60_000 });
    assert.equal(M.pollerAlive('busy-a', now), true);
  });
  test('stale heartbeat, busyUntil passed → dead', () => {
    const now = Date.now();
    hb('busy-b', { pid: process.pid, at: now - 400_000, busyUntil: now - 1 });
    assert.equal(M.pollerAlive('busy-b', now), false);
  });
  test('busyUntil never overrides a dead pid', () => {
    const now = Date.now();
    hb('busy-c', { pid: DEAD_PID, at: now - 400_000, busyUntil: now + 60_000 });
    assert.equal(M.pollerAlive('busy-c', now), false);
  });
  test('withBusyHeartbeat writes busyUntil before the call and clears it after', () => {
    const t0 = Date.now();
    let during;
    const files = () => readdirSync(M.HEARTBEAT_DIR).filter(f => !f.startsWith('busy-'));
    const ret = M.withBusyHeartbeat(60_000, () => {
      during = JSON.parse(readFileSync(join(M.HEARTBEAT_DIR, files()[0]), 'utf8'));
      return 42;
    });
    assert.equal(ret, 42);
    assert.ok(during.busyUntil >= t0 + 65_000, JSON.stringify(during));
    const afterHb = JSON.parse(readFileSync(join(M.HEARTBEAT_DIR, files()[0]), 'utf8'));
    assert.equal(afterHb.busyUntil, undefined);
    assert.throws(() => M.withBusyHeartbeat(1000, () => { throw new Error('boom'); }), /boom/);
    assert.equal(JSON.parse(readFileSync(join(M.HEARTBEAT_DIR, files()[0]), 'utf8')).busyUntil, undefined, 'cleared on throw too');
  });
});

describe('loadNotifications / partitionNotifications (C3, C13)', () => {
  test('non-object entries are dropped', () => {
    mkdirSync(dirname(M.NOTIF_FILE), { recursive: true });
    writeFileSync(M.NOTIF_FILE, JSON.stringify([null, 7, 'x', [], { tty: 't', message: 'm' }]));
    assert.deepEqual(M.loadNotifications(), [{ tty: 't', message: 'm' }]);
    rmSync(M.NOTIF_FILE, { force: true });
  });
  test('one ownership decision per entry, every entry lands in exactly one list', () => {
    const notifs = [{ tty: 'a' }, { tty: 'b' }, { tty: 'c' }];
    let calls = 0;
    // A flip-flopping judge: with two passes an entry could be taken AND kept.
    const claimable = () => (calls++ % 2 === 0);
    const { taken, kept } = M.partitionNotifications(notifs, claimable);
    assert.equal(calls, 3);
    assert.equal(taken.length + kept.length, 3);
    assert.deepEqual([...taken, ...kept].map(n => n.tty).sort(), ['a', 'b', 'c']);
  });
});

describe('mergePolledWatch (C4)', () => {
  const disk = { jobId: '1', host: 'h', tty: 'me', jobName: 'j', state: 'PENDING', unseenSince: 'T0', note: 'disk' };
  test('only poll-owned fields are copied; disk is the base', () => {
    const polled = { ...disk, state: 'RUNNING', progress: '1/2', note: 'stale', jobName: 'stale' };
    delete polled.unseenSince;
    const m = M.mergePolledWatch(disk, polled, 'me');
    assert.deepEqual(m, { jobId: '1', host: 'h', tty: 'me', jobName: 'j', state: 'RUNNING', progress: '1/2', note: 'disk' });
  });
  test('a watch another window adopted meanwhile is left untouched', () => {
    const adopted = { ...disk, tty: 'other' };
    assert.equal(M.mergePolledWatch(adopted, { ...disk, state: 'RUNNING' }, 'me'), adopted);
  });
  test('no polled snapshot → disk entry as-is', () => assert.equal(M.mergePolledWatch(disk, undefined, 'me'), disk));
});

describe('resource baseline without MaxRSS (C7)', () => {
  test('all MaxRSS missing: maxMemGB null, no 0.0G peak and no --mem advice; time still shown', () => {
    const h = M.parseResourceHistory('5|t|00:10:00||4G|COMPLETED\n5.batch|batch|00:10:00|||COMPLETED');
    assert.equal(h.maxMemGB, null);
    assert.equal(h.maxTimeSec, 600);
    const r = M.formatRecommendation(h);
    assert.match(r, /memory: no measurement available/);
    assert.match(r, /10m0s time/);
    assert.match(r, /Recommended: --time=00:40:00 \(×4 time\)/);
    assert.doesNotMatch(r, /0\.0G|--mem/);
    assert.equal(M.checkResourceWaste('400G', '00:15:00', h), '');
  });
  test('a measured 0 is still a measurement', () => {
    assert.equal(M.parseResourceHistory('6|t|00:01:00||4G|COMPLETED\n6.batch|batch|00:01:00|0||COMPLETED').maxMemGB, 0);
  });
});

describe('parseScontrolStdOut (C8)', () => {
  test('one-line records: value runs to the next " Key="', () => {
    assert.deepEqual(M.parseScontrolStdOut('JobId=1 StdErr=/e StdIn=/dev/null StdOut=/scratch/a=b/log.out Power= TresPerNode=x'), ['/scratch/a=b/log.out']);
    assert.deepEqual(M.parseScontrolStdOut('JobId=1 StdOut=/scratch/my logs/x.out Power='), ['/scratch/my logs/x.out']);
    assert.deepEqual(M.parseScontrolStdOut('JobId=1 StdOut=/last/field.out'), ['/last/field.out']);
  });
  test('multi-line format and array records', () => {
    assert.deepEqual(M.parseScontrolStdOut('   StdIn=/dev/null\n   StdOut=/w/a b=c.out\n   Power='), ['/w/a b=c.out']);
    assert.deepEqual(M.parseScontrolStdOut('JobId=2 StdOut=/w/1.out Power=\nJobId=3 StdOut=/w/2.out Power='), ['/w/1.out', '/w/2.out']);
    assert.deepEqual(M.parseScontrolStdOut(''), []);
    assert.deepEqual(M.parseScontrolStdOut('JobId=1 StdErr=/e'), []);
  });
});

describe('output_dir with % (C9)', () => {
  const base = { job_name: 'j', partition: 'batch', mem: '4G', time: '00:10:00', gpus: 0, output_dir: 'logs' };
  test('rejected with the reason', () => {
    const errs = M.validateSubmitArgs({ ...base, output_dir: '/w/logs_%j' });
    assert.equal(errs.length, 1);
    assert.match(errs[0], /must not contain "%".*mkdir creates the literal directory/);
  });
  test('plain dirs still pass', () => assert.deepEqual(M.validateSubmitArgs(base), []));
});

describe('expandLocalHome (C10)', () => {
  test('~ and ~/ expand to the home dir; trailing slash kept; others untouched', () => {
    assert.equal(M.expandLocalHome('~'), HOME);
    assert.equal(M.expandLocalHome('~/a/b'), `${HOME}/a/b`);
    assert.equal(M.expandLocalHome('~/a/'), `${HOME}/a/`);
    assert.equal(M.expandLocalHome('/abs'), '/abs');
    assert.equal(M.expandLocalHome('~other/x'), '~other/x');
  });
});

describe('hetjob component ids (C12)', () => {
  for (const id of ['12345+1', '12345+0']) {
    test(`valid ${id}`, () => { assert.equal(M.VALID_JOB_ID.test(id), true); assert.equal(M.validateJobId(id), id); });
  }
  for (const id of ['12345+', '+1', '12345+1;x', '12345++1']) {
    test(`invalid ${JSON.stringify(id)}`, () => assert.throws(() => M.validateJobId(id), /Invalid job ID/));
  }
});

describe('formatWatchLine (C14)', () => {
  test('progress and percentage', () => {
    const now = Date.parse('2026-01-01T01:00:00Z');
    const w = { jobId: '7', jobName: 'n', state: 'RUNNING', progress: '1/2', submittedAt: '2026-01-01T00:30:00Z', estimatedSeconds: 3600 };
    assert.equal(M.formatWatchLine(w, now), '  7 (n) [RUNNING tasks done 1/2] — 30min elapsed, est. 60min, ~50%');
  });
});
