// Release gate for the npm tarball: exact file list, executable bin with a
// shebang, and the packed index.mjs imports cleanly (SLURM_MCP_NO_START=1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const out = mkdtempSync(join(tmpdir(), 'slurm-mcp-pack-'));
const [info] = JSON.parse(execFileSync(npm, ['pack', '--json', '--pack-destination', out], {
  cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}));
const tarball = join(out, info.filename);
execFileSync('tar', ['-xzf', tarball, '-C', out]);
const dir = join(out, 'package');

test('tarball contains only the published files', () => {
  const files = info.files.map(f => f.path).sort();
  assert.deepEqual(files, ['LICENSE', 'README.md', 'docs/GUIDE.md', 'docs/TOOLS.md', 'index.mjs', 'package.json']);
  assert.deepEqual(pkg.files, ['index.mjs', 'docs/']);
});

test('bin points at index.mjs, which has a node shebang and is executable', () => {
  assert.deepEqual(pkg.bin, { 'slurm-mcp-server': 'index.mjs' });
  const bin = join(dir, pkg.bin['slurm-mcp-server']);
  assert.ok(readFileSync(bin, 'utf8').startsWith('#!/usr/bin/env node\n'));
  if (process.platform !== 'win32') assert.ok(statSync(bin).mode & 0o111, 'executable bit set in tarball');
  assert.ok(info.files.find(f => f.path === 'index.mjs').mode & 0o111);
});

test('packed version and server version agree', () => {
  assert.equal(info.version, pkg.version);
  assert.ok(readFileSync(join(dir, 'index.mjs'), 'utf8').includes(`version: '${pkg.version}'`));
});

test('packed index.mjs imports with SLURM_MCP_NO_START=1 and exposes helpers', () => {
  // The tarball ships no node_modules; borrow the repo's installed deps.
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'junction');
  const home = mkdtempSync(join(tmpdir(), 'slurm-mcp-pack-home-'));
  const res = execFileSync(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify('file://' + join(dir, 'index.mjs'))}); console.log(typeof m.parseSlurmTime, m.parseSlurmTime('90'));`], {
    env: { ...process.env, SLURM_MCP_NO_START: '1', HOME: home, HPC_HOST: 'fake', HPC_USER: 'u', SLURM_ACCOUNT: 'acct' },
    encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(res.trim(), 'function 5400');
  assert.deepEqual(readdirSync(home), [], 'import touched no state files');
});
