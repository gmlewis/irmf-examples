#!/usr/bin/env node
// irmf-pin-includes: rewrite mutable GitHub #include URLs to commit-pinned
// URLs so that a reviewed model keeps executing the same code.

import { readFileSync, writeFileSync } from 'node:fs';

import { collectRefs, pinSource, resolveRef } from './pin.mjs';

const USAGE = `Usage: irmf-pin-includes [--write | --check] <file.irmf>...

Rewrites #include lines such as:

  #include "github.com/owner/repo/blob/master/x.glsl"

to the commit that the branch currently points at:

  #include "github.com/owner/repo/blob/<40-hex-commit>/x.glsl"

Options:
  --write   Rewrite the files in place. Without this, only report changes.
  --check   Exit 1 if any file would change (useful in CI). Never writes.
  -h, --help

Environment:
  GITHUB_TOKEN / GH_TOKEN  Optional token for the GitHub API (raises the
                           unauthenticated rate limit).

Already-pinned includes and LYGIA includes are left unchanged. LYGIA includes
are reported because the host serves unversioned content.
`;

function die(message, code = 2) {
  console.error(message);
  process.exit(code);
}

async function main() {
  const argv = process.argv.slice(2);
  let write = false;
  let check = false;
  const files = [];

  for (const arg of argv) {
    if (arg === '--write' || arg === '-w') write = true;
    else if (arg === '--check') check = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      return;
    } else if (arg.startsWith('-')) {
      die(`unknown option: ${arg}\n\n${USAGE}`);
    } else {
      files.push(arg);
    }
  }

  if (write && check) die('--write and --check are mutually exclusive');
  if (files.length === 0) die(USAGE);

  const shaCache = new Map();
  let changedFiles = 0;
  let cleanFiles = 0;

  for (const file of files) {
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch (e) {
      die(`cannot read ${file}: ${e.message}`);
    }

    const refs = collectRefs(source);
    for (const ref of refs) {
      const key = `${ref.owner}/${ref.repo}@${ref.ref}`;
      if (!shaCache.has(key)) {
        shaCache.set(key, await resolveRef(ref.owner, ref.repo, ref.ref));
      }
    }
    const shaFor = (owner, repo, ref) =>
      shaCache.get(`${owner}/${repo}@${ref}`) || '';

    let result;
    try {
      result = pinSource(source, shaFor);
    } catch (e) {
      die(`${file}: ${e.message}`);
    }
    const { output, changes, warnings } = result;

    for (const warning of warnings) {
      console.warn(
        `${file}:${warning.line}: note: ${warning.message}: ${warning.url}`,
      );
    }

    if (changes.length === 0) {
      if (warnings.length === 0) {
        cleanFiles++;
      } else {
        console.log(`${file}: no unpinned GitHub includes`);
      }
      continue;
    }

    changedFiles++;
    for (const change of changes) {
      console.log(`${file}:${change.line}: ${change.oldUrl} -> ${change.newUrl}`);
    }

    if (write) {
      writeFileSync(file, output);
      console.log(`${file}: pinned ${changes.length} include(s)`);
    } else if (check) {
      console.log(`${file}: ${changes.length} include(s) would be pinned`);
    } else {
      console.log(
        `${file}: would pin ${changes.length} include(s) (use --write to apply)`,
      );
    }
  }

  if (cleanFiles > 0) {
    console.log(`${cleanFiles} file(s) have no unpinned GitHub includes`);
  }
  if (check && changedFiles > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(2);
});
