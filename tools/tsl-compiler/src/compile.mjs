// TSL -> WGSL function compilation.
//
// Uses three.js's WGSL node builder directly, without a GPU or a renderer.
// The builder is imported from an internal path (`three/src/...`) because it is
// not part of the public `three/webgpu` export list in r180. This is an
// undocumented API: the compiler is pinned to the exact three.js version.

import WGSLNodeBuilder from 'three/src/renderers/webgpu/nodes/WGSLNodeBuilder.js';
import { WebGPUCoordinateSystem } from 'three/src/constants.js';
import { TSL } from 'three/src/Three.WebGPU.js';

import { evaluateTSL, callEntry } from './eval.mjs';

export const THREE_VERSION = '0.180.0';

export function entryNameForMaterialCount(n) {
  if (n >= 1 && n <= 4) return 'mainModel4';
  if (n >= 5 && n <= 9) return 'mainModel9';
  if (n >= 10 && n <= 16) return 'mainModel16';
  if (n >= 17 && n <= 32) return 'mainModel32';
  if (n >= 33 && n <= 48) return 'mainModel48';
  return null;
}

function outputSpec(materials) {
  if (materials <= 4) return { type: 'vec4', count: 4, ctor: 'vec4' };
  if (materials <= 9) return { type: 'mat3', count: 9, ctor: 'mat3' };
  if (materials <= 16) return { type: 'mat4', count: 16, ctor: 'mat4' };
  return null;
}

function makeBuilder() {
  const renderer = {
    // Required so MathNode lowers two-argument atan() to WGSL's atan2().
    coordinateSystem: WebGPUCoordinateSystem,
    backend: {
      isWebGPUBackend: true,
      compatibilityMode: false,
      utils: { getTextureSampleData: () => ({ primarySamples: 1 }) },
    },
    hasFeature: () => false,
    getRenderTarget: () => null,
  };
  const builder = new WGSLNodeBuilder(null, renderer);
  builder.setShaderStage('fragment');
  return builder;
}

/** Recursively collect helper function code emitted by three.js. */
function emitIncludes(fnNode) {
  let out = '';
  const seen = new Set();
  const visit = (f) => {
    for (const inc of f.includes || []) {
      if (seen.has(inc)) continue;
      seen.add(inc);
      visit(inc);
      if (inc.code) out += inc.code.trimEnd() + '\n\n';
    }
  };
  visit(fnNode);
  return out;
}

/**
 * Compile a TSL body into a standalone WGSL function.
 *
 * @param {string} source - The decoded TSL body.
 * @param {object} opts
 * @param {number} opts.materials - Number of materials (selects the entry point).
 * @param {string} [opts.entry] - Explicit entry point name.
 * @param {object} [opts.tslNamespace] - Override the TSL namespace (tests).
 * @param {boolean} [opts.check] - Compile only, omit `source` from the result.
 * @returns {{ok:boolean, three?:string, entry?:string, materials?:number,
 *            target?:string, format?:string, source?:string,
 *            diagnostics:Array<{line:number,col:number,message:string}>,
*             warnings?:string[]}}
 */
export function compileTSL(source, opts = {}) {
  const materials = Number(opts.materials);
  const tslNamespace = opts.tslNamespace || TSL;

  if (!Number.isInteger(materials) || materials < 1 || materials > 16) {
    return {
      ok: false,
      diagnostics: [{ line: 1, col: 1, message: `unsupported material count: ${opts.materials}` }],
    };
  }

  const spec = outputSpec(materials);
  const entry = opts.entry || entryNameForMaterialCount(materials);

  const ev = evaluateTSL(source, tslNamespace, opts);
  if (ev.diagnostics.length) {
    return { ok: false, diagnostics: ev.diagnostics, warnings: ev.warnings };
  }
  const entryFn = ev.entries[entry];
  if (typeof entryFn !== 'function') {
    const found = Object.keys(ev.entries);
    return {
      ok: false,
      warnings: ev.warnings,
      diagnostics: [
        {
          line: 1,
          col: 1,
          message:
            `missing entry point \`${entry}\` (materials=${materials}); ` +
            (found.length ? `found: ${found.join(', ')}` : 'no mainModelN function was defined'),
        },
      ],
    };
  }

  let fnNode;
  try {
    const outer = TSL.Fn(([xyz]) => {
      const raw = callEntry(entryFn, xyz);
      if (Array.isArray(raw)) {
        if (raw.length !== materials) {
          throw new Error(
            `entry point \`${entry}\` returned ${raw.length} values but the header declares ${materials} materials`
          );
        }
        const values = raw.slice();
        while (values.length < spec.count) values.push(TSL.float(0));
        return TSL[spec.ctor](...values);
      }
      if (raw && raw.isNode) return raw;
      throw new Error(
        `entry point \`${entry}\` must return an array of ${materials} nodes or a ${spec.type} node`
      );
    });
    outer.setLayout({ name: entry, type: spec.type, inputs: [{ name: 'xyz', type: 'vec3' }] });
    const builder = makeBuilder();
    fnNode = builder.buildFunctionNode(outer.shaderNode);
  } catch (err) {
    const loc = /<anonymous>:(\d+):(\d+)/.exec(String((err && err.stack) || ''));
    return {
      ok: false,
      warnings: ev.warnings,
      diagnostics: [
        {
          line: loc ? ev.mapLine(Number(loc[1])) : 1,
          col: loc ? Number(loc[2]) : 1,
          message: (err && err.message) || String(err),
        },
      ],
    };
  }

  const header = `// generated by irmf-tsl-compile; three ${THREE_VERSION}\n\n`;
  const code = header + emitIncludes(fnNode) + fnNode.code.trimEnd() + '\n';

  return {
    ok: true,
    three: THREE_VERSION,
    entry,
    materials,
    target: 'wgsl',
    format: 'function',
    source: opts.check ? undefined : code,
    warnings: ev.warnings,
    diagnostics: [],
  };
}
