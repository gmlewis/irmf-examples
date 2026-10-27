#!/usr/bin/env node
// Compile every TSL example in the corpus with the shared compiler.
//
// Usage: node src/compile-all.mjs [--examples DIR]

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileTSL } from '../../tsl-compiler/src/compile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_EXAMPLES = resolve(HERE, '..', '..', '..', 'examples');

function parseArgs(argv) {
  const opts = { examples: DEFAULT_EXAMPLES };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--examples') opts.examples = resolve(argv[++i]);
    else if (argv[i] === '--help') {
      console.log('Usage: node src/compile-all.mjs [--examples DIR]');
      process.exit(0);
    } else {
      console.error(`unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  let total = 0;
  let failed = 0;
  let slowest = { file: '', ms: 0 };
  const started = performance.now();

  for (const dir of readdirSync(opts.examples).sort()) {
    const dirPath = join(opts.examples, dir);
    if (!statSync(dirPath).isDirectory()) continue;
    for (const file of readdirSync(dirPath).sort()) {
      if (!file.endsWith('-tsl.irmf')) continue;
      total++;
      const path = `${dir}/${file}`;
      const text = readFileSync(join(dirPath, file), 'utf8');
      const start = text.indexOf('/*{');
      const end = text.indexOf('}*/', start);
      let header;
      try {
        let json = text.slice(start + 2, end + 1).replace(/,[\s\n]*}/g, '}');
        try {
          header = JSON.parse(json);
        } catch {
          header = JSON.parse(json.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":'));
        }
      } catch (err) {
        console.log(`FAIL ${path}: invalid header: ${err.message}`);
        failed++;
        continue;
      }
      const body = text.slice(end + 3);
      const t0 = performance.now();
      const res = compileTSL(body, { materials: header.materials.length });
      const ms = performance.now() - t0;
      if (ms > slowest.ms) slowest = { file: path, ms };
      if (!res.ok) {
        console.log(`FAIL ${path}: ${res.diagnostics[0]?.message}`);
        failed++;
      } else {
        console.log(`ok   ${path} (${res.entry}, ${ms.toFixed(0)} ms, ${res.source.length} bytes)`);
      }
    }
  }

  const elapsed = performance.now() - started;
  console.log(`\nCompiled ${total - failed}/${total} TSL examples in ${elapsed.toFixed(0)} ms.`);
  if (slowest.file) console.log(`Slowest: ${slowest.file} (${slowest.ms.toFixed(0)} ms)`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
