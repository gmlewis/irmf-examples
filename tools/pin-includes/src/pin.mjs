// Rewrite mutable GitHub #include URLs in an IRMF file to commit-pinned ones.
//
// A pinned include names a 40-hex commit, so the code a model executes cannot
// change without changing the model file. This module only changes include
// lines; everything else is preserved byte-for-byte (including indentation).

const LINE_RE = /^(\s*#include\s+")([^"]+)(")/;
const PINNED_RE =
  /^github\.com\/([^/]+)\/([^/]+)\/(?:(?:blob|raw)\/)?([0-9a-fA-F]{40})\/(.+)$/;
const MUTABLE_RE = /^github\.com\/([^/]+)\/([^/]+)\/(blob|raw)\/([^/]+)\/(.+)$/;

function safeRef(ref) {
  return (
    !!ref &&
    ref !== '.' &&
    ref !== '..' &&
    !ref.includes('..') &&
    !/[\\?#%\s]/.test(ref) &&
    !/[\x00-\x1f\x7f]/.test(ref)
  );
}

function safePath(path) {
  if (!path || /[\\?#%\s]/.test(path) || /[\x00-\x1f\x7f]/.test(path)) {
    return false;
  }
  return !path.split('/').some((part) => part === '.' || part === '..');
}

/**
 * Extracts the GitHub include information from one source line.
 *
 * @returns {null | {
 *   pinned?: boolean, unpinnable?: boolean,
 *   owner?: string, repo?: string, kind?: string,
 *   ref?: string, path?: string, sha?: string, url: string
 * }}
 */
export function parseGithubInclude(line) {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  const url = m[2];

  const pinned = PINNED_RE.exec(url);
  if (pinned) {
    return {
      pinned: true,
      owner: pinned[1],
      repo: pinned[2],
      sha: pinned[3],
      path: pinned[4],
      url,
    };
  }

  const mutable = MUTABLE_RE.exec(url);
  if (!mutable) {
    if (url.startsWith('lygia/') || url.startsWith('lygia.xyz/')) {
      return { unpinnable: true, url };
    }
    return null;
  }

  const [, owner, repo, kind, ref, path] = mutable;
  if (!safeRef(ref) || !safePath(path)) return null;
  return { pinned: false, owner, repo, kind, ref, path, url };
}

/**
 * Collects unique mutable GitHub includes from a model.
 *
 * @returns {Array<{owner: string, repo: string, ref: string}>}
 */
export function collectRefs(source) {
  const seen = new Map();
  for (const line of source.split('\n')) {
    const inc = parseGithubInclude(line);
    if (!inc || inc.pinned || inc.unpinnable) continue;
    const key = `${inc.owner}/${inc.repo}@${inc.ref}`;
    if (!seen.has(key)) {
      seen.set(key, { owner: inc.owner, repo: inc.repo, ref: inc.ref });
    }
  }
  return [...seen.values()];
}

/**
 * Rewrites mutable includes to pinned ones.
 *
 * @param {string} source
 * @param {(owner: string, repo: string, ref: string) => string} shaFor
 * @returns {{
 *   output: string,
 *   changes: Array<{line: number, oldUrl: string, newUrl: string}>,
 *   warnings: Array<{line: number, url: string, message: string}>
 * }}
 */
export function pinSource(source, shaFor) {
  const lines = source.split('\n');
  const changes = [];
  const warnings = [];

  const output = lines.map((line, index) => {
    const inc = parseGithubInclude(line);
    if (!inc) return line;
    if (inc.unpinnable) {
      warnings.push({
        line: index + 1,
        url: inc.url,
        message: 'cannot pin an unversioned LYGIA include',
      });
      return line;
    }
    if (inc.pinned) return line;

    const sha = shaFor(inc.owner, inc.repo, inc.ref);
    if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) {
      throw new Error(
        `cannot resolve ${inc.owner}/${inc.repo}@${inc.ref} to a 40-hex commit`,
      );
    }
    const newUrl = `github.com/${inc.owner}/${inc.repo}/${inc.kind}/${sha}/${inc.path}`;
    const start = line.indexOf(inc.url);
    changes.push({ line: index + 1, oldUrl: inc.url, newUrl });
    return line.slice(0, start) + newUrl + line.slice(start + inc.url.length);
  });

  return { output: output.join('\n'), changes, warnings };
}

/**
 * Resolves a branch or tag to the commit it currently points at.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} ref
 * @param {{token?: string, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<string>} 40-hex commit SHA
 */
export async function resolveRef(
  owner,
  repo,
  ref,
  {
    token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
    fetchImpl = fetch,
  } = {},
) {
  const api = `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'irmf-pin-includes/1.0 (+https://github.com/gmlewis/irmf-examples)',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const resp = await fetchImpl(api, { headers });
  if (!resp.ok) {
    let detail = '';
    try {
      detail = (await resp.text()).slice(0, 200);
    } catch {
      // ignore
    }
    const hint =
      resp.status === 403 || resp.status === 429
        ? ' (rate limited; set GITHUB_TOKEN to raise the limit)'
        : '';
    throw new Error(
      `GitHub API ${resp.status} for ${owner}/${repo}@${ref}${hint}${detail ? `: ${detail}` : ''}`,
    );
  }

  const data = await resp.json();
  const sha = data && typeof data.sha === 'string' ? data.sha : '';
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error(`unexpected GitHub API response for ${owner}/${repo}@${ref}`);
  }
  return sha;
}
