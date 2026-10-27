#!/usr/bin/env node
// Enumerate the IRMF example corpus and verify the three-language matrix.
//
// For every logical variant it checks that a GLSL, a WGSL, and a TSL file
// exist, that their headers agree on materials/min/max/units/options, and that
// each file's `language` matches its filename suffix.
//
// Usage: node src/matrix.mjs [--examples DIR] [--json OUT] [--allow-missing]

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_EXAMPLES = resolve(HERE, '..', '..', '..', 'examples');

const LANGS = ['glsl', 'wgsl', 'tsl'];
const SUFFIX_LANG = { '-wgsl': 'wgsl', '-tsl': 'tsl', '-glsl': 'glsl' };
const ENCODINGS = ['-gzip+base64', '-gzip'];

function parseArgs(argv) {
  const opts = { examples: DEFAULT_EXAMPLES, json: '', allowMissing: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--examples') opts.examples = resolve(argv[++i]);
    else if (a === '--json') opts.json = resolve(argv[++i]);
    else if (a === '--allow-missing') opts.allowMissing = true;
    else if (a === '--help') {
      console.log('Usage: node src/matrix.mjs [--examples DIR] [--json OUT] [--allow-missing]');
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

function parseHeader(text) {
  const start = text.indexOf('/*{');
  if (start < 0) return null;
  const end = text.indexOf('}*/', start);
  if (end < 0) return null;
  let json = text.slice(start + 2, end + 1);
  // Tolerate trailing commas and unquoted keys, as the IRMF parsers do.
  json = json.replace(/,[\s\n]*}/g, '}');
  try {
    return JSON.parse(json);
  } catch {
    try {
      return JSON.parse(json.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":'));
    } catch {
      return null;
    }
  }
}

function classify(filename) {
  let name = filename.replace(/\.irmf$/, '');
  let encoded = false;
  for (const enc of ENCODINGS) {
    if (name.endsWith(enc)) {
      name = name.slice(0, -enc.length);
      encoded = true;
    }
  }
  let suffixLang = null;
  for (const [suffix, lang] of Object.entries(SUFFIX_LANG)) {
    if (name.endsWith(suffix)) {
      suffixLang = lang;
      name = name.slice(0, -suffix.length);
      break;
    }
  }
  return { base: name, suffixLang, encoded };
}

function headerSignature(h) {
  return JSON.stringify({
    materials: h.materials,
    min: h.min,
    max: h.max,
    units: h.units,
    options: h.options ?? {},
  });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const variants = new Map();
  const errors = [];
  const warnings = [];
  let fileCount = 0;

  for (const dir of readdirSync(opts.examples).sort()) {
    const dirPath = join(opts.examples, dir);
    if (!statSync(dirPath).isDirectory()) continue;
    for (const file of readdirSync(dirPath).sort()) {
      if (!file.endsWith('.irmf')) continue;
      fileCount++;
      const text = readFileSync(join(dirPath, file), 'utf8');
      const header = parseHeader(text);
      if (!header) {
        errors.push(`${dir}/${file}: cannot find a JSON header`);
        continue;
      }
      const { base, suffixLang, encoded } = classify(file);
      const language = suffixLang || String(header.language || 'glsl').toLowerCase();
      if (!LANGS.includes(language)) {
        errors.push(`${dir}/${file}: unsupported language ${JSON.stringify(header.language)}`);
        continue;
      }
      if (suffixLang && header.language && String(header.language).toLowerCase() !== suffixLang && !encoded) {
        warnings.push(`${dir}/${file}: filename says ${suffixLang} but header says ${header.language}`);
      }
      const key = `${dir}/${base}`;
      if (!variants.has(key)) variants.set(key, { key, dir, base, files: {}, encoded: [] });
      const v = variants.get(key);
      if (encoded) {
        v.encoded.push({ file, language, encoding: header.encoding });
        continue;
      }
      if (v.files[language]) {
        errors.push(`${dir}/${file}: duplicate ${language} variant (already ${v.files[language].file})`);
        continue;
      }
      v.files[language] = { file, header, signature: headerSignature(header) };
    }
  }

  const rows = [];
  let complete = 0;
  for (const v of [...variants.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    const present = LANGS.filter((l) => v.files[l]);
    const missing = LANGS.filter((l) => !v.files[l]);
    if (missing.length === 0) complete++;
    else if (!opts.allowMissing) {
      errors.push(`${v.key}: missing ${missing.join(', ')} (have ${present.join(', ') || 'none'})`);
    }
    // Header agreement across the languages that are present.
    const sigs = present.map((l) => v.files[l].signature);
    if (new Set(sigs).size > 1) {
      errors.push(`${v.key}: headers disagree on materials/min/max/units/options`);
    }
    rows.push({
      key: v.key,
      dir: v.dir,
      base: v.base,
      materials: v.files[present[0]]?.header.materials?.length ?? 0,
      present,
      missing,
      files: Object.fromEntries(present.map((l) => [l, `${v.dir}/${v.files[l].file}`])),
      encoded: v.encoded,
    });
  }

  if (opts.json) {
    mkdirSync(dirname(opts.json), { recursive: true });
    writeFileSync(opts.json, JSON.stringify({ variants: rows, errors, warnings }, null, 2) + '\n');
  }

  console.log(`Scanned ${fileCount} .irmf files in ${variants.size} logical variants.`);
  console.log(`Complete three-language variants: ${complete}/${variants.size}`);
  const tslCount = rows.filter((r) => r.present.includes('tsl')).length;
  console.log(`Variants with TSL: ${tslCount}`);
  if (warnings.length) {
    console.log(`\n${warnings.length} warning(s):`);
    for (const w of warnings.slice(0, 20)) console.log('  warning: ' + w);
    if (warnings.length > 20) console.log(`  ... and ${warnings.length - 20} more`);
  }
  if (errors.length) {
    console.log(`\n${errors.length} error(s):`);
    for (const e of errors.slice(0, 40)) console.log('  error: ' + e);
    if (errors.length > 40) console.log(`  ... and ${errors.length - 40} more`);
    process.exit(1);
  }
  console.log('\nMatrix OK.');
}

main();
