# T0.2 Spike Results — TSL → WGSL function compilation

Date: 2026-10-27
three.js pin: `0.180.0` (npm integrity
`sha512-o+qycAMZrh+TsE01GqWUxUIKR1AL0S8pq7zDkYOQw8GqfX8b8VoCKYUoHbhiX5j+7hr8XsuHDVU6+gkQJQKg9w==`)

## Chosen path: **A — renderer-free `WGSLNodeBuilder`** ✅

Import the internal builder from the package's `./src/*` export:

```js
import WGSLNodeBuilder from 'three/src/renderers/webgpu/nodes/WGSLNodeBuilder.js';
import { TSL } from 'three/src/Three.WebGPU.js';
```

Drive it with a minimal renderer stub and build a synthetic entry function:

```js
const renderer = {
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

const outer = Fn(([xyz]) => vec4(m0, m1, m2, float(0)));
outer.setLayout({ name: 'mainModel4', type: 'vec4', inputs: [{ name: 'xyz', type: 'vec3' }] });
const fnNode = builder.buildFunctionNode(outer.shaderNode);
// fnNode.includes -> helper function nodes; fnNode.code -> the entry function
```

## Verified results

| Check | Result |
|---|---|
| Standalone `fn mainModel4(xyz: vec3<f32>) -> vec4<f32>` | ✅ no bindings/uniforms |
| 9 materials → `mat3x3<f32>`, column-major material order | ✅ matches Go/Rust footers |
| 16 materials → `mat4x4<f32>`, column-major | ✅ |
| `Loop` / `Var` accumulation | ✅ emits WGSL `for` |
| `array([...])` + `.element(dynamicIndex)` | ✅ **must call `.toVar()`** first (see below) |
| 2106-element arrays + 16³ nested loops | ✅ 25–32 ms, 64 KB, naga-valid |
| Deterministic across runs | ✅ identical SHA-256 |
| Wrapped with the Go slicer's vertex/header/footer | ✅ `naga` "Validation successful" |

## Gotchas discovered (feed into the cookbook)

1. **`Fn` returning an array is broken in r180.** `Fn(([xyz]) => [m0, m1])` produces
   a `ShaderNodeObject` wrapping the array, not an array, and codegen emits an
   empty expression. The compiler must, for an `Fn` entry point, call
   `entry.shaderNode.jsFunc([xyz])` directly to obtain the raw array. Plain JS
   functions (`(xyz) => [m0, m1]`) work as-is.
2. **Dynamically indexing an array literal is invalid WGSL** ("may only be
   indexed by a constant"). Always materialize with `.toVar()`:
   `const a = array([...]).toVar(); ... a.element(idx) ...`.
3. **Nested loops need distinct names** or the inner loop shadows the outer:
   `Loop({ start: 0, end: 16, name: 'dz' }, ({ dz }) => ...)`.
4. Loop indices are `i32`; cast with `float(i)` before math (`cos(float(dz))`).
5. `array([...], 'vec2')` is the wrong signature; use `array([...])` (one arg).

## Error line mapping

`new Function` runtime stacks report `<anonymous>:LINE:COL`. For a prelude of
`P` lines, body line `L` is reported as `L + P + 2` in Node (V8). The evaluator
calibrates the wrapper offset at first use instead of hard-coding it.
