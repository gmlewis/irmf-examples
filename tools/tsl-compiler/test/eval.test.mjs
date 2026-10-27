import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { TSL } from 'three/src/Three.WebGPU.js';
import { evaluateTSL, buildPrelude } from '../src/eval.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');

test('evaluates a 1-material sphere body', () => {
  const r = evaluateTSL(fixture('sphere-1.tsl'), TSL);
  assert.deepEqual(r.diagnostics, []);
  assert.equal(typeof r.entries.mainModel4, 'function');
});

test('finds 9-material entry points', () => {
  const r = evaluateTSL(fixture('identity-9mat.tsl'), TSL);
  assert.deepEqual(r.diagnostics, []);
  assert.equal(typeof r.entries.mainModel9, 'function');
  assert.equal(r.entries.mainModel4, undefined);
});

test('reports a missing entry point as absent', () => {
  const r = evaluateTSL('const helper = () => float(1);', TSL);
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual(Object.keys(r.entries), []);
});

test('strips an optional leading three/tsl import', () => {
  const src = "import { Fn, float } from 'three/tsl';\nconst mainModel4 = () => [float(1)];\n";
  const r = evaluateTSL(src, TSL);
  assert.deepEqual(r.diagnostics, []);
  assert.equal(typeof r.entries.mainModel4, 'function');
  assert.ok(r.warnings.some((w) => w.includes('import')));
});

test('rejects export statements', () => {
  const r = evaluateTSL('export const mainModel4 = () => [float(1)];\n', TSL);
  assert.equal(r.diagnostics.length, 1);
  assert.match(r.diagnostics[0].message, /export/);
});

test('maps a runtime error to the body line', () => {
  const r = evaluateTSL(fixture('runtime-error.tsl'), TSL);
  assert.equal(r.diagnostics.length, 1);
  assert.equal(r.diagnostics[0].line, 2);
});

test('maps a syntax error to the body line', () => {
  const r = evaluateTSL(fixture('syntax-error.tsl'), TSL);
  assert.equal(r.diagnostics.length, 1);
  assert.equal(r.diagnostics[0].line, 2);
});

test('does not leak TSL names into the global scope', () => {
  const before = globalThis.Fn;
  evaluateTSL(fixture('sphere-1.tsl'), TSL);
  assert.equal(globalThis.Fn, before);
});

test('prelude has a fixed line count', () => {
  assert.equal((buildPrelude(TSL).match(/\n/g) || []).length, 3);
});

test('blocks fetch and require inside the body', () => {
  const fetchRes = evaluateTSL('const mainModel4 = () => [float(fetch("https://example.com"))];', TSL);
  assert.deepEqual(fetchRes.diagnostics, []);
  assert.throws(() => fetchRes.entries.mainModel4(TSL.vec3(0)), /fetch is not a function/);

  const requireRes = evaluateTSL('const mainModel4 = () => [float(require("fs"))];', TSL);
  assert.throws(() => requireRes.entries.mainModel4(TSL.vec3(0)), /require is not a function/);
});

test('rejects dynamic import', () => {
  const r = evaluateTSL('const m = import("fs"); const mainModel4 = () => [float(1)];', TSL);
  assert.match(r.diagnostics[0].message, /dynamic `import\(\)`/);
});
