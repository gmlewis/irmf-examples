import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'src', 'cli.mjs');
const fixture = (name) => join(here, 'fixtures', name);

function run(args, input) {
  return spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8' });
}

test('--json success shape', () => {
  const r = run(['--json', '--materials', '1', fixture('sphere-1.tsl')]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.entry, 'mainModel4');
  assert.equal(out.materials, 1);
  assert.equal(out.target, 'wgsl');
  assert.equal(out.format, 'function');
  assert.match(out.source, /fn mainModel4/);
  assert.deepEqual(out.diagnostics, []);
});

test('reads a raw body from stdin', () => {
  const body = 'const mainModel4 = (xyz) => [float(1)];\n';
  const r = run(['--json', '--materials', '1', '-'], body);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);
});

test('missing entry point exits 1 with a diagnostic', () => {
  const r = run(['--json', '--materials', '1', '-'], 'const x = float(1);\n');
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.match(out.diagnostics[0].message, /missing entry point/);
});

test('--check omits the source', () => {
  const r = run(['--json', '--check', '--materials', '1', fixture('sphere-1.tsl')]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.source, undefined);
});

test('--cache-dir reuses results', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irmf-tsl-cache-'));
  const first = run(['--json', '--cache-dir', dir, '--materials', '1', fixture('sphere-1.tsl')]);
  assert.equal(first.status, 0, first.stderr);
  const second = run(['--json', '--cache-dir', dir, '--materials', '1', fixture('sphere-1.tsl')]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).cached, true);
});

test('bad flag exits 2 with usage', () => {
  const r = run(['--bogus']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Usage:/);
});

test('rejects a non-TSL irmf file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irmf-tsl-'));
  const path = join(dir, 'x.irmf');
  writeFileSync(path, '/*{ "language": "glsl", "materials": ["a"] }*/\nvoid main() {}\n');
  const r = run(['--json', path]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not a TSL file/);
});

test('compiles an .irmf file with a TSL header', () => {
  const dir = mkdtempSync(join(tmpdir(), 'irmf-tsl-'));
  const path = join(dir, 'x.irmf');
  writeFileSync(
    path,
    '/*{ "irmf": "1.0", "language": "tsl", "tslVersion": "0.180.0", "materials": ["a"] }*/\n' +
      'const mainModel4 = (xyz) => [float(1)];\n'
  );
  const r = run(['--json', path]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).materials, 1);
});

test('an infinite loop times out and exits non-zero', () => {
  const r = run(['--json', '--timeout-ms', '1500', '--materials', '1', fixture('infinite-loop.tsl')]);
  assert.notEqual(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.match(out.diagnostics[0].message, /timed out/);
});

test('stdout source mode prints the generated function', () => {
  const r = run(['--materials', '1', fixture('sphere-1.tsl')]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /fn mainModel4/);
});
