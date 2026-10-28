import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  collectRefs,
  parseGithubInclude,
  pinSource,
  resolveRef,
} from '../src/pin.mjs';

const SHA = '6bb268f05fbe1c68a68ec1e66ce4c5d335bdf021';

test('parses mutable, pinned, and unpinnable includes', () => {
  const mutable = parseGithubInclude(
    '#include "github.com/o/r/blob/master/x.glsl"',
  );
  assert.equal(mutable.pinned, false);
  assert.equal(mutable.owner, 'o');
  assert.equal(mutable.repo, 'r');
  assert.equal(mutable.kind, 'blob');
  assert.equal(mutable.ref, 'master');
  assert.equal(mutable.path, 'x.glsl');

  const pinned = parseGithubInclude(
    `#include "github.com/o/r/blob/${SHA}/x.glsl"`,
  );
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.sha, SHA);

  const lygia = parseGithubInclude('#include "lygia/math/decimation.glsl"');
  assert.equal(lygia.unpinnable, true);

  assert.equal(parseGithubInclude('void mainModel4() {}'), null);
});

test('rejects traversal and URL-injection in includes', () => {
  assert.equal(
    parseGithubInclude(
      '#include "github.com/o/r/blob/master/../../etc/passwd.glsl"',
    ),
    null,
  );
  assert.equal(
    parseGithubInclude('#include "github.com/o/r/blob/master/x.glsl?raw=1"'),
    null,
  );
});

test('collectRefs deduplicates refs', () => {
  const source = [
    '#include "github.com/o/r/blob/master/a.glsl"',
    '#include "github.com/o/r/blob/master/b.glsl"',
    '#include "github.com/o/r/raw/v1/c.glsl"',
    `#include "github.com/o/r/blob/${SHA}/d.glsl"`,
    '#include "lygia/math/decimation.glsl"',
  ].join('\n');
  assert.deepEqual(collectRefs(source), [
    { owner: 'o', repo: 'r', ref: 'master' },
    { owner: 'o', repo: 'r', ref: 'v1' },
  ]);
});

test('pinSource rewrites mutable includes and preserves everything else', () => {
  const source = [
    '/*{',
    '  irmf: "1.0",',
    '}*/',
    '#include "github.com/o/r/blob/master/a.glsl"',
    '  #include "github.com/o/r/raw/v1/b.glsl"',
    `#include "github.com/o/r/blob/${SHA}/c.glsl"`,
    '#include "lygia/math/decimation.glsl"',
    'void mainModel4(out vec4 materials, in vec3 xyz) {}',
  ].join('\n');

  const { output, changes, warnings } = pinSource(source, () => SHA);

  assert.match(output, new RegExp(`blob/${SHA}/a\\.glsl`));
  assert.match(output, new RegExp(`raw/${SHA}/b\\.glsl`));
  assert.match(output, new RegExp(`blob/${SHA}/c\\.glsl`));
  assert.match(output, /#include "lygia\/math\/decimation\.glsl"/);
  assert.match(output, /^ {2}#include "github\.com\/o\/r\/raw\//m);
  assert.equal(changes.length, 2);
  assert.equal(changes[0].line, 4);
  assert.equal(changes[1].line, 5);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].line, 7);
});

test('pinSource leaves an already-pinned file byte-identical', () => {
  const source = `/*{\n}*/\n#include "github.com/o/r/blob/${SHA}/x.glsl"\n`;
  const { output, changes } = pinSource(source, () => {
    throw new Error('resolver must not be called');
  });
  assert.equal(output, source);
  assert.deepEqual(changes, []);
});

test('resolveRef uses the GitHub API and validates the response', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ sha: SHA }) };
  };

  assert.equal(await resolveRef('o', 'r', 'master', { fetchImpl }), SHA);
  assert.equal(
    calls[0].url,
    'https://api.github.com/repos/o/r/commits/master',
  );
  assert.equal(calls[0].options.headers.Accept, 'application/vnd.github+json');

  const bad = async () => ({
    ok: false,
    status: 403,
    text: async () => 'API rate limit exceeded',
  });
  await assert.rejects(
    () => resolveRef('o', 'r', 'master', { fetchImpl: bad }),
    /403.*GITHUB_TOKEN/,
  );

  const unexpected = async () => ({ ok: true, json: async () => ({}) });
  await assert.rejects(
    () => resolveRef('o', 'r', 'master', { fetchImpl: unexpected }),
    /unexpected GitHub API response/,
  );
});
