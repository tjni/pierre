const GITHUB_HOST = 'github.com';
const GITHUB_RAW_DIFF_HOST = 'patch-diff.githubusercontent.com';
const RAW_GITHUB_DIFF_PATH_PATTERN =
  /^\/raw\/([^/]+)\/([^/]+)\/pull\/([^/]+\.(?:diff|patch))$/;
const GITHUB_PULL_TAB_PATH_PATTERN =
  /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/(?:changes|files)$/;
const GITHUB_PULL_COMMIT_PATH_PATTERN =
  /^\/([^/]+)\/([^/]+)\/pull\/\d+\/(?:changes|files)\/([0-9a-f]{4,40})$/i;

// Matches GitHub shorthand "owner/repo#123" → /owner/repo/pull/123.
const GITHUB_SHORTHAND_PATTERN = /^([^/\s]+)\/([^/\s#]+)#(\d+)$/;

// Matches bare paths like "owner/repo/pull/123" where neither of the first two
// segments contains a dot — a dot would indicate a domain like "github.com".
const BARE_GITHUB_PATH_PATTERN = /^([^/\s.]+)\/([^/\s.]+)(\/[^\s]*)?$/;

export function getGitHubPath(input: string): string | undefined {
  try {
    const parsedURL = new URL(input);
    return getGitHubPathFromURL(parsedURL);
  } catch {
    return undefined;
  }
}

// Resolves a user-supplied string into a viewer href, or undefined if the
// input can't be mapped to a supported diff URL. Accepts full URLs, URLs
// without a protocol (e.g. "github.com/…"), bare "owner/repo/…" paths, and
// GitHub shorthand ("owner/repo#123").
export function getPatchViewerHref(input: string): string | undefined {
  const trimmed = input.trim();
  if (trimmed === '') return undefined;

  // GitHub shorthand: "owner/repo#123" → "/owner/repo/pull/123"
  const shorthandMatch = GITHUB_SHORTHAND_PATTERN.exec(trimmed);
  if (shorthandMatch != null) {
    return `/${shorthandMatch[1]}/${shorthandMatch[2]}/pull/${shorthandMatch[3]}`;
  }

  // Full URL with protocol (most common case).
  try {
    const parsedURL = new URL(trimmed);
    const githubPath = getGitHubPathFromURL(parsedURL);
    if (githubPath != null) return githubPath;
    if (parsedURL.pathname !== '/') {
      return `${parsedURL.pathname}?domain=${encodeURIComponent(parsedURL.hostname)}`;
    }
    return undefined;
  } catch {
    // Not a fully-qualified URL; try other interpretations.
  }

  // Domain-relative URL like "github.com/owner/repo/pull/123" — only attempt
  // when the first path segment contains a dot, indicating it's a hostname
  // rather than an owner name. Checking only the first segment avoids false
  // positives from dots in later segments (e.g. "v6.0...v7.0" in a compare URL).
  const firstSegment = trimmed.split('/')[0] ?? '';
  if (firstSegment.includes('.')) {
    try {
      const parsedURL = new URL(`https://${trimmed}`);
      const githubPath = getGitHubPathFromURL(parsedURL);
      if (githubPath != null) return githubPath;
      if (parsedURL.pathname !== '/') {
        return `${parsedURL.pathname}?domain=${encodeURIComponent(parsedURL.hostname)}`;
      }
    } catch {
      // Not parseable even with https:// prefix.
    }
  }

  // Bare GitHub path: "owner/repo/pull/123" or "owner/repo/compare/a...b".
  // The dot-free first segment check above ensures we don't land here for
  // domain-style inputs.
  const bareMatch = BARE_GITHUB_PATH_PATTERN.exec(trimmed);
  if (bareMatch != null) {
    const [, owner, repo, rest = ''] = bareMatch;
    return normalizeGitHubPath(`/${owner}/${repo}${rest}`);
  }

  return undefined;
}

export type DiffshubViewerRoute =
  | { kind: 'redirect'; target: string }
  | {
      kind: 'render';
      upstreamPath: string;
      url: string;
      domain: string | undefined;
    };

// Resolves the catch-all viewer route into either a redirect or the props the
// viewer needs to render. Extracted from the route page so it can be unit
// tested without spinning up Next.js. Empty paths redirect to the home page;
// GitHub paths are canonicalized via normalizeGitHubPath so direct navigation
// matches the hrefs getPatchViewerHref produces from form input. Non-GitHub
// hosts are passed through unchanged because their canonical form is unknown.
export function resolveDiffshubViewerRoute(
  pathSegments: readonly string[],
  requestedDomainInput: string | undefined
): DiffshubViewerRoute {
  if (pathSegments.length === 0) {
    return { kind: 'redirect', target: '/' };
  }

  const domain =
    requestedDomainInput == null || requestedDomainInput === ''
      ? undefined
      : requestedDomainInput;
  const joinedPath = `/${pathSegments.join('/')}`;
  const upstreamPath =
    domain == null ? normalizeGitHubPath(joinedPath) : joinedPath;

  if (upstreamPath !== joinedPath) {
    const query = domain == null ? '' : `?domain=${encodeURIComponent(domain)}`;
    return { kind: 'redirect', target: `${upstreamPath}${query}` };
  }

  const host = domain ?? GITHUB_HOST;
  return {
    domain,
    kind: 'render',
    upstreamPath,
    url: `https://${host}${upstreamPath}`,
  };
}

function getGitHubPathFromURL(parsedURL: URL): string | undefined {
  if (parsedURL.hostname === GITHUB_HOST) {
    if (parsedURL.pathname === '/') {
      return undefined;
    }
    return normalizeGitHubPath(parsedURL.pathname);
  }

  if (parsedURL.hostname !== GITHUB_RAW_DIFF_HOST) {
    return undefined;
  }

  const rawDiffMatch = RAW_GITHUB_DIFF_PATH_PATTERN.exec(parsedURL.pathname);
  if (rawDiffMatch == null) {
    return undefined;
  }

  const owner = rawDiffMatch[1];
  const repo = rawDiffMatch[2];
  const pullFile = rawDiffMatch[3];
  if (owner == null || repo == null || pullFile == null) {
    return undefined;
  }

  return `/${owner}/${repo}/pull/${pullFile}`;
}

export function normalizeGitHubPath(path: string): string {
  const pathWithoutTrailingSlash = path.replace(/\/+$/, '');
  const trimmedPath =
    pathWithoutTrailingSlash === '' ? '/' : pathWithoutTrailingSlash;
  const pullCommitMatch = GITHUB_PULL_COMMIT_PATH_PATTERN.exec(trimmedPath);
  if (pullCommitMatch != null) {
    return `/${pullCommitMatch[1]}/${pullCommitMatch[2]}/commit/${pullCommitMatch[3]}`;
  }

  const pullTabMatch = GITHUB_PULL_TAB_PATH_PATTERN.exec(trimmedPath);
  if (pullTabMatch == null) {
    return trimmedPath;
  }

  return `/${pullTabMatch[1]}/${pullTabMatch[2]}/pull/${pullTabMatch[3]}`;
}
