#!/usr/bin/env node
// irmf-tsl-compile: compile an IRMF TSL body to a standalone WGSL function.

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { compileTSL, THREE_VERSION } from './compile.mjs';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `Usage: irmf-tsl-compile [options] [file|-]

Compile an IRMF TSL body (JavaScript that builds a three.js TSL node graph)
into a standalone WGSL function that can be spliced into the IRMF slicer's
WGSL footer.

Input:
  file            An .irmf file (header + body), or a raw TSL body.
  -               Read the body from stdin.

Options:
  --json                Emit a JSON result object (see README).
  --check               Compile only; omit the generated source.
  --materials N         Material count (required for raw bodies; overrides header).
  --entry NAME          Entry point name (default: selected from material count).
  --format function     Output format (only "function" is supported).
  --target wgsl         Output target (only "wgsl" is supported).
  --cache-dir DIR       Content-addressed compilation cache.
  --timeout-ms N        Hard limit for the compilation child (default 30000).
  --[no-]sandbox        Run the compile child with Node's permission model.
  --version             Print the three.js version.
  --help                Show this help.

Environment:
  IRMF_TSL_COMPILER     Path to this executable (used by the slicers).
  IRMF_TSL_CACHE_DIR    Default cache directory.
`;

function fail(message, code = 2) {
  process.stderr.write(message.endsWith('\n') ? message : message + '\n');
  process.exit(code);
}

function parseIrmf(text) {
  const start = text.indexOf('/*{');
  if (start < 0) return null;
  const end = text.indexOf('}*/', start);
  if (end < 0) return null;
  let header;
  // Tolerate trailing commas and unquoted keys, as the IRMF parsers do.
  const json = text.slice(start + 2, end + 1).replace(/,[\s\n]*}/g, '}');
  try {
    header = JSON.parse(json);
  } catch {
    try {
      header = JSON.parse(
        json.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
      );
    } catch (err) {
      throw new Error(`invalid IRMF header JSON: ${err.message}`);
    }
  }
  return { header, body: text.slice(end + 3) };
}

function decodeBody(body, encoding) {
  const enc = String(encoding || '').trim().toLowerCase();
  if (!enc) return body;
  const b64 = body.trim();
  switch (enc) {
    case 'gzip+base64':
    case 'base64+gzip':
    case 'gzip':
      return gunzipSync(Buffer.from(b64, 'base64')).toString('utf8');
    case 'base64':
      return Buffer.from(b64, 'base64').toString('utf8');
    case 'gpg':
      throw new Error('gpg-encoded bodies cannot be compiled; decode them first');
    default:
      throw new Error(`unsupported encoding: ${encoding}`);
  }
}

function readStdin() {
  return readFileSync(0, 'utf8');
}

function cacheKey(job) {
  return createHash('sha256')
    .update(job.source)
    .update('\0')
    .update(String(job.materials))
    .update('\0')
    .update(job.entry || '')
    .update('\0')
    .update(job.target || 'wgsl')
    .update('\0')
    .update(THREE_VERSION)
    .digest('hex');
}

function runCompile(job, opts) {
  if (process.env.IRMF_TSL_INPROCESS === '1') {
    return compileTSL(job.source, job);
  }

  const args = [fileURLToPath(import.meta.url), '--worker'];
  if (opts.sandbox) {
    args.unshift('--permission', `--allow-fs-read=${PKG_ROOT}`);
  }

  const child = spawnSync(process.execPath, args, {
    input: JSON.stringify(job),
    encoding: 'utf8',
    timeout: opts.timeoutMs,
    maxBuffer: 128 * 1024 * 1024,
  });

  if (child.error) {
    if (child.error.code === 'ETIMEDOUT') {
      return {
        ok: false,
        diagnostics: [{ line: 1, col: 1, message: `compilation timed out after ${opts.timeoutMs} ms` }],
      };
    }
    return {
      ok: false,
      diagnostics: [{ line: 1, col: 1, message: `failed to run compiler child: ${child.error.message}` }],
    };
  }
  if (!child.stdout) {
    const detail = (child.stderr || '').trim().split('\n').slice(-5).join('\n');
    return {
      ok: false,
      diagnostics: [{ line: 1, col: 1, message: `compiler child produced no output${detail ? ': ' + detail : ''}` }],
    };
  }
  try {
    return JSON.parse(child.stdout);
  } catch {
    return {
      ok: false,
      diagnostics: [{ line: 1, col: 1, message: `compiler child produced invalid JSON: ${child.stdout.slice(0, 200)}` }],
    };
  }
}

function workerMain() {
  let job;
  try {
    job = JSON.parse(readStdin());
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, diagnostics: [{ line: 1, col: 1, message: String(err) }] }));
    return;
  }
  let result;
  try {
    result = compileTSL(job.source, job);
  } catch (err) {
    result = { ok: false, diagnostics: [{ line: 1, col: 1, message: (err && err.message) || String(err) }] };
  }
  process.stdout.write(JSON.stringify(result));
}

function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        json: { type: 'boolean', default: false },
        check: { type: 'boolean', default: false },
        materials: { type: 'string' },
        entry: { type: 'string' },
        format: { type: 'string', default: 'function' },
        target: { type: 'string', default: 'wgsl' },
        'cache-dir': { type: 'string' },
        'timeout-ms': { type: 'string', default: '30000' },
        sandbox: { type: 'boolean', default: true },
        'no-sandbox': { type: 'boolean', default: false },
        worker: { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    });
  } catch (err) {
    fail(USAGE + '\n' + err.message);
  }

  const { values, positionals } = parsed;

  if (values.worker) {
    workerMain();
    return;
  }
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (values.version) {
    process.stdout.write(`three ${THREE_VERSION}\n`);
    return;
  }
  if (values.format !== 'function') fail(`unsupported --format: ${values.format}\n` + USAGE);
  if (values.target !== 'wgsl') fail(`unsupported --target: ${values.target}\n` + USAGE);
  if (positionals.length > 1) fail(`expected at most one input file\n` + USAGE);

  let input = '';
  if (positionals.length === 0 || positionals[0] === '-') {
    input = readStdin();
  } else {
    const path = positionals[0];
    try {
      input = readFileSync(path, 'utf8');
    } catch (err) {
      fail(`cannot read ${path}: ${err.message}`, 1);
    }
  }

  let source = input;
  let materials = values.materials !== undefined ? Number(values.materials) : undefined;
  const irmf = parseIrmf(input);
  if (irmf) {
    const lang = String(irmf.header.language || '').trim();
    if (lang && lang !== 'tsl') {
      fail(`not a TSL file (language="${lang}")`, 1);
    }
    try {
      source = decodeBody(irmf.body, irmf.header.encoding);
    } catch (err) {
      fail(err.message, 1);
    }
    if (materials === undefined) materials = Array.isArray(irmf.header.materials) ? irmf.header.materials.length : 1;
  } else if (input.trimStart().startsWith('{')) {
    // A bare header object (no /*{ ... }*/ framing) is not valid IRMF.
    fail('input looks like a raw IRMF header; wrap it in /*{ ... }*/ or pass the TSL body', 1);
  }

  if (materials === undefined || !Number.isInteger(materials)) {
    fail('--materials N is required when compiling a raw TSL body', 2);
  }

  const timeoutMs = Number(values['timeout-ms']);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail('--timeout-ms must be a positive number', 2);

  const job = {
    source,
    materials,
    entry: values.entry,
    target: values.target,
    check: values.check,
  };

  const cacheDir = values['cache-dir'] || process.env.IRMF_TSL_CACHE_DIR || '';
  let key = '';
  if (cacheDir) {
    try {
      mkdirSync(cacheDir, { recursive: true });
      key = cacheKey(job);
      const cachedPath = resolve(cacheDir, `${key}.json`);
      if (existsSync(cachedPath)) {
        const cached = JSON.parse(readFileSync(cachedPath, 'utf8'));
        cached.cached = true;
        if (values.check) delete cached.source;
        emit(cached, values.json);
        return;
      }
    } catch {
      // Cache problems must never fail a compile.
      cacheDir = '';
    }
  }

  const result = runCompile(job, {
    sandbox: values.sandbox && !values['no-sandbox'],
    timeoutMs,
  });

  if (result.ok && cacheDir && key) {
    try {
      writeFileSync(resolve(cacheDir, `${key}.json`), JSON.stringify(result));
    } catch {
      /* ignore cache write failures */
    }
  }

  emit(result, values.json);
}

function emit(result, asJSON) {
  if (asJSON) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else if (result.ok) {
    process.stdout.write(result.source || '');
  } else {
    for (const d of result.diagnostics || []) {
      process.stderr.write(`line ${d.line}:${d.col}: ${d.message}\n`);
    }
  }
  // Set exitCode rather than calling process.exit(): a large JSON payload is
  // written to a pipe asynchronously, and process.exit() would truncate it
  // (observed at 64 KiB).
  process.exitCode = result.ok ? 0 : 1;
}

main();
