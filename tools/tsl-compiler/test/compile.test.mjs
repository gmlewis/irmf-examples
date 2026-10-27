import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { compileTSL, THREE_VERSION } from '../src/compile.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');

test('compiles a sphere to a standalone vec4 function', () => {
  const r = compileTSL(fixture('sphere-1.tsl'), { materials: 1 });
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  assert.equal(r.three, THREE_VERSION);
  assert.equal(r.entry, 'mainModel4');
  assert.match(r.source, /fn mainModel4\( xyz : vec3<f32> \) -> vec4<f32>/);
  assert.doesNotMatch(r.source, /@group|@binding/);
  assert.doesNotMatch(r.source, /uniform/);
});

test('packs 3 materials in material order', () => {
  const r = compileTSL(fixture('cube-3mat.tsl'), { materials: 3 });
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  const ret = /return vec4<f32>\((.*)\);/.exec(r.source);
  assert.ok(ret, r.source);
  assert.equal(ret[1].split(',').length, 4); // three values + padding
});

test('packs 9 materials into mat3x3 in material order', () => {
  const r = compileTSL(fixture('identity-9mat.tsl'), { materials: 9 });
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  assert.match(r.source, /fn mainModel9\( xyz : vec3<f32> \) -> mat3x3<f32>/);
  const m = /return mat3x3<f32>\((.*)\);/.exec(r.source);
  assert.ok(m, r.source);
  const vals = m[1].split(',').map((s) => s.trim());
  assert.deepEqual(vals, ['0.0', '0.1', '0.2', '0.3', '0.4', '0.5', '0.6', '0.7', '0.8']);
});

test('is deterministic across compilations', () => {
  const a = compileTSL(fixture('cube-3mat.tsl'), { materials: 3 });
  const b = compileTSL(fixture('cube-3mat.tsl'), { materials: 3 });
  assert.equal(a.source, b.source);
});

test('reports a syntax error with a line', () => {
  const r = compileTSL(fixture('syntax-error.tsl'), { materials: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.diagnostics[0].line, 2);
});

test('rejects a material-count mismatch', () => {
  const r = compileTSL(fixture('cube-3mat.tsl'), { materials: 2 });
  assert.equal(r.ok, false);
  assert.match(r.diagnostics[0].message, /declares 2 materials/);
});

test('reports a missing entry point', () => {
  const r = compileTSL('const helper = () => float(1);', { materials: 1 });
  assert.equal(r.ok, false);
  assert.match(r.diagnostics[0].message, /missing entry point/);
});

test('supports Fn entry points returning an array', () => {
  const body = `
    const mainModel4 = Fn(([xyz]) => {
      return [select(length(xyz).lessThan(float(5)), float(1), float(0))];
    });
  `;
  const r = compileTSL(body, { materials: 1 });
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  assert.match(r.source, /fn mainModel4\( xyz : vec3<f32> \) -> vec4<f32>/);
});

test('materializes dynamically indexed arrays so the WGSL is valid', () => {
  const body = `
    const pts = array([vec2(0, 0), vec2(1, 1)]);
    const mainModel4 = (xyz) => {
      const a = array([float(0.1), float(0.2), float(0.3)]).toVar();
      const idx = float(0).toVar();
      const acc = float(0).toVar();
      Loop({ start: 0, end: 3, name: 'i' }, () => {
        acc.addAssign(a.element(idx));
        idx.addAssign(1);
      });
      return [acc];
    };
  `;
  const r = compileTSL(body, { materials: 1 });
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  assert.match(r.source, /var nodeVar\d+ : array< f32, 3 >;/);
  assert.match(r.source, /\[ u32\(/);
});
