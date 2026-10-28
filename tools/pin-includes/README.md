# irmf-pin-includes

IRMF consumers reject GitHub `#include` URLs that name a branch or tag,
because the included code can change after a model was reviewed. This tool
rewrites those includes to the commit the branch or tag currently points at:

```diff
-#include "github.com/gmlewis/irmf-examples/blob/master/examples/x.glsl"
+#include "github.com/gmlewis/irmf-examples/blob/6bb268f05fbe1c68a68ec1e66ce4c5d335bdf021/examples/x.glsl"
```

## Usage

```sh
# Report what would change (does not write):
node src/cli.mjs model.irmf

# Rewrite in place:
node src/cli.mjs --write model.irmf

# CI guard: fail if any include is still mutable:
node src/cli.mjs --check examples/**/*.irmf
```

Or install the `bin` entry from this directory (`npm link`) and use
`irmf-pin-includes`.

## What it does

- Rewrites `github.com/<owner>/<repo>/(blob|raw)/<branch-or-tag>/<path>` to the
  resolved 40-hex commit, preserving `blob` vs `raw`, indentation, and every
  other byte of the file.
- Leaves already-pinned includes and `lygia/` / `lygia.xyz/` includes alone.
  LYGIA is reported as an unpinnable, unversioned host.
- Resolves each `owner/repo@ref` once, so a model with many includes from the
  same branch makes one API call.
- Fails closed on traversal/injection attempts (`..`, `?`, `#`, `%`,
  whitespace) and on unexpected API responses.

## GitHub API rate limits

Unauthenticated requests are limited to 30–60 per hour. Set a token to raise
the limit:

```sh
export GITHUB_TOKEN=...   # or GH_TOKEN
```

Private repositories require a token with read access.

## Notes

- The commit is whatever the branch points at **when you run the tool**.
  Review the diff and commit the pinned model; that commit is now what the
  model executes.
- If you later update the included file, re-run the tool to move the pin
  forward.
- A ref containing `/` cannot be distinguished from the path in a GitHub
  `/blob/` URL, so only single-segment refs are rewritten. Use the commit SHA
  directly for those.
- Nothing is written unless `--write` is passed.
