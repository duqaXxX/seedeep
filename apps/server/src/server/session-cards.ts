import {
  type CardTouch,
  cardFromResult,
  ghIssueFromResult,
  ghTitleFromResult,
  mergeTouches,
  type SessionCards,
} from '../core/tracker-cards.ts';
import type { SessionRecord } from '../core/types.ts';
import { issueUrl, remoteBase, repoFor, repoSlug } from './git.ts';
import { scanSession, type TrackerCall } from './transcript-scan.ts';

/**
 * The tracker cards a session worked on.
 *
 * An MCP card needs nothing but the transcript: its id came from the call's input, its title and
 * url from the call's result. A forge issue needs one thing more — a number is unique only inside a
 * repository — so the session's cwd is resolved to a repo exactly as the commit link does it, and
 * `origin` gives both the scope and the link.
 */

/** Where a forge issue lives: the browsable base of `origin`, and `owner/repo` to key it by. */
interface IssueScope {
  base: string | null;
  slug: string | null;
}

const scopeCache = new Map<string, IssueScope>();

/** The forge scope of a cwd — cached per directory, since it costs two subprocesses. */
async function scopeOf(cwd: string | null): Promise<IssueScope> {
  if (!cwd) return { base: null, slug: null };
  const hit = scopeCache.get(cwd);
  if (hit) return hit;
  const repo = await repoFor(cwd);
  const base = repo ? await remoteBase(repo) : null;
  // With no origin the issue still belongs to SOMETHING: the repo's own path keeps two
  // repositories' `#42` apart, even though neither can be linked.
  const scope: IssueScope = { base, slug: repoSlug(base) ?? repo?.commonDir ?? null };
  scopeCache.set(cwd, scope);
  return scope;
}

/**
 * The scope a command spelled out itself: `[host/]owner/repo`.
 *
 * LIMIT: with no host, `gh` talks to whatever its own configuration calls default — github.com
 * unless `GH_HOST` or an enterprise setup says otherwise, which the transcript does not record. The
 * key is right either way; only the link would point at the wrong forge in that case.
 */
export function namedScope(repo: string): IssueScope {
  const parts = repo.split('/').filter(Boolean);
  const withHost = parts.length >= 3;
  const host = withHost ? parts[0] : 'github.com';
  const base = `https://${host}/${(withHost ? parts.slice(1) : parts).join('/')}`;
  // Keyed through `repoSlug`, never by hand: a repository's identity has one definition, and a
  // second one here is what made a single issue render as two rows.
  return { base, slug: repoSlug(base) };
}

/** One tracker call as a card touch, or null when the call never names a card. */
async function touchOf(call: TrackerCall): Promise<CardTouch | null> {
  if (call.source === 'mcp') {
    const { id, title, url } = cardFromResult(call.result, call.id);
    if (!id) return null;
    return { key: id, id, title, url, evidence: call.evidence, source: 'mcp', at: call.at };
  }
  // A creation names its issue only in the output.
  const fromResult = call.number === null ? ghIssueFromResult(call.result) : null;
  const number = call.number ?? fromResult?.number ?? null;
  if (number === null) return null;
  // A command that named its repository is talking about THAT repository, whatever directory it
  // ran in — most reads in the corpus are other projects' issues, read as documentation.
  const named = call.repo ? namedScope(call.repo) : null;
  const { base, slug } = named ?? (await scopeOf(call.cwd));
  return {
    key: `${slug ?? '?'}#${number}`,
    id: `#${number}`,
    title: ghTitleFromResult(call.result),
    url: fromResult?.url ?? issueUrl(base, number),
    evidence: call.evidence,
    source: 'cli',
    at: call.at,
  };
}

/**
 * The cards `rec` touched, newest first.
 *
 * Unlike commits, nothing here is exclusive: the same card may be returned for several sessions,
 * because several sessions really did work on it (17% of cards locally). No sibling session is
 * read, which also makes this cheaper than the commit join.
 */
export async function cardsForSession(rec: SessionRecord): Promise<SessionCards> {
  const scan = await scanSession(rec.path);
  if (!scan.tracker.length) return { cards: [] };
  const touches: CardTouch[] = [];
  for (const call of scan.tracker) {
    const t = await touchOf(call);
    if (t) touches.push(t);
  }
  return { cards: mergeTouches(touches) };
}
