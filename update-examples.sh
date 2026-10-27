#!/bin/bash -ex

# Default to the in-repo TSL compiler so `irmf-slicer` can compile and validate
# the TSL variants as well as parse the GLSL/WGSL ones.
if [ -z "${IRMF_TSL_COMPILER:-}" ]; then
  IRMF_TSL_COMPILER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/tools/tsl-compiler/src/cli.mjs"
  export IRMF_TSL_COMPILER
  chmod +x "$IRMF_TSL_COMPILER"
fi

# Regenerate the README snippets for GLSL, WGSL, and TSL.
go run cmd/update-examples/main.go
if command -v pt >/dev/null 2>&1; then
  pt -l '##' examples/*/README.md | sort | sed -e 's|/README.md||'
else
  echo "NOTE: pt is not installed; skipping the heading list."
fi

# Compile every TSL example and check the three-language matrix.
if command -v node >/dev/null 2>&1; then
  if [ ! -d tools/tsl-compiler/node_modules ]; then
    (cd tools/tsl-compiler && npm ci)
  fi
  node tools/conformance/src/compile-all.mjs
  node tools/conformance/src/matrix.mjs
fi

# Validate IRMF shader syntax. The Go slicer parses GLSL/WGSL and compiles TSL
# through IRMF_TSL_COMPILER.
if command -v irmf-slicer >/dev/null 2>&1; then
  if irmf-slicer --help 2>&1 | grep -q -- "-tsl-compiler"; then
    irmf-slicer examples/*/*.irmf
  else
    echo "NOTE: the installed irmf-slicer predates TSL support."
    echo "      Reinstall it (cd irmf-slicer && go install ./cmd/irmf-slicer) to validate TSL."
  fi
else
  echo "NOTE: irmf-slicer is not on PATH; skipping the slicer validation pass."
fi
