export interface UpgradePayload {
  allExpandedPaths: readonly string[];
  paths: readonly string[];
}

// Fetches a gzipped upgrade payload from the CDN, gunzips it in the browser via
// DecompressionStream, and parses it. This keeps the docs demo server bundle
// small while the client upgrades into the full fixture on demand.
export async function fetchUpgradePayload(
  url: string,
  signal: AbortSignal
): Promise<UpgradePayload> {
  const response = await fetch(url, { signal });
  if (!response.ok || response.body == null) {
    throw new Error(
      `Failed to fetch upgrade path list (${String(response.status)})`
    );
  }

  const decompressedStream = response.body.pipeThrough(
    new DecompressionStream('gzip')
  );
  const decompressedText = await new Response(decompressedStream).text();
  return JSON.parse(decompressedText) as UpgradePayload;
}
