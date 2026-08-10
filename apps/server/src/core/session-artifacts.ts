/**
 * The pages a session published with the `Artifact` tool.
 *
 * A published page is the one thing a session delivers that does not live on this machine: the HTML
 * behind it is a scratchpad temporary the tmpdir will eventually take, while the page itself stays
 * online. Measured 2026-08-10 over the local corpus — 12 distinct pages, all 12 still live, the
 * oldest 29 days — so the URL is what survives a session, and it is what its record has to keep.
 *
 * Read from the transcript and from nothing else. Nothing here asks claude.ai anything: a publish
 * states its own URL in its result (`Published <file> at <url>`), which is both complete — the 12
 * pages online are exactly the 12 the local transcripts name — and provably that session's own,
 * the same standard the commits and the ledger are held to.
 */

/**
 * What a published page's URL looks like.
 *
 * Shared with the client so the drawer's link and this parser can never disagree about what counts
 * as one. LIMIT: the host is matched literally — if it ever changes, publishes stop being collected
 * and the row disappears, rather than showing a link that goes nowhere.
 */
export const ARTIFACT_URL = /https:\/\/claude\.ai\/code\/artifact\/[\w-]+/;

/** One page a session put online. The URL is its identity: a redeploy overwrites it in place. */
export interface SessionArtifact {
  /** `https://claude.ai/code/artifact/<uuid>` — stable across redeploys of the same page. */
  url: string;
  /** What to call it on screen: the publish's own description, or the file's name without one. */
  label: string;
  /** The file it was published from, anonymized — a scratchpad temporary in every local case. */
  path: string;
  /** The instant of the LAST publish to this URL. */
  at: number;
}

/**
 * The name a row carries: the publish's `description`, falling back to the file's own name.
 *
 * `description` is the tool's one-line summary of the page and reads as a title — measured, it is
 * present on 33 of 33 local publishes, while the `title` parameter is on 5 (a page normally titles
 * itself in its HTML, which never reaches the transcript). It is optional in the tool's schema
 * though, so the file name stands in: `proto-note.html` says more than a bare uuid.
 */
export function artifactLabel(description: string, path: string): string {
  const d = description.trim();
  if (d) return d;
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return path.slice(slash + 1) || path;
}

/**
 * Dedupe publishes into pages, newest first.
 *
 * A redeploy passes the page's own `url` and overwrites it — measured, 20 of 33 local publishes did,
 * and one session republished a single page six times. Counting publishes would say 33 where the
 * user has 12 pages, so the URL is the identity and the LAST publish to it wins: its description is
 * the one that matches what is online now. Same rule as a path delivered by several commits.
 */
export function mergeArtifacts(pubs: readonly SessionArtifact[]): SessionArtifact[] {
  const by = new Map<string, SessionArtifact>();
  // `>=`, not `>`: several publishes of one page can share a timestamp (the transcript's stamps are
  // whole milliseconds and a redeploy is fast), and the later LINE is the later publish.
  for (const p of pubs) {
    const prev = by.get(p.url);
    if (!prev || p.at >= prev.at) by.set(p.url, p);
  }
  return [...by.values()].sort((a, b) => b.at - a.at || a.label.localeCompare(b.label));
}
