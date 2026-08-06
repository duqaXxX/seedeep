import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import known from '../../data/known-fields.json' with { type: 'json' };
import { cliRoot } from './roots.ts';

/**
 * The PASSIVE half of the schema guard: it answers "did Claude Code add
 * something?" and nothing else.
 *
 * Why only that question: presence is conclusive, absence is not. Seeing a key
 * once proves it exists; NOT seeing one proves nothing, because most fields are
 * conditional (`compactMetadata` only if you compacted, `interruptedMessageId`
 * only on Esc). Measured 2026-07-17: at a FIXED CC version, two halves of the
 * same logs differ by 4 keys — a detector that reported those as changes would be
 * red today with nothing changed. So this half reports ONLY unknown keys, where a
 * single occurrence is proof and false positives are impossible by construction.
 *
 * The absence side — "a field seedeep READS is gone" — cannot be answered by
 * observation at all. That is the probe's job: it provokes the event, so absence
 * becomes conclusive.
 */

/**
 * The nested objects the radar looks INSIDE, by dotted path. Top-level keys alone
 * are not enough: `toolUseResult` is one key at the top, and underneath it carries
 * a subagent's return (`content`, `totalTokens`, `status`), a background launch
 * (`agentId`, `runId`) and a background command (`backgroundTaskId`) — fields the
 * parser reads, and which the radar reported for years as the single word
 * "toolUseResult". `backgroundTaskId` arrived unnoticed exactly this way.
 *
 * An explicit list, NOT recursion: `message.content[].input` holds keys defined by
 * each tool and MCP server rather than by Claude Code, so walking down blindly
 * would bury the report in fields that prove nothing about CC's schema. The list is
 * the set of containers the parser dereferences — add a path here when it starts
 * reading a new one.
 */
export const OBSERVED_CONTAINERS = ['message', 'message.usage', 'toolUseResult', 'compactMetadata', 'origin'] as const;

/** Keys observed per line type, plus the keys seen inside each {@link OBSERVED_CONTAINERS} path. */
export interface ObservedSchema {
  types: Map<string, Set<string>>;
  /** Dotted container path → the keys seen directly inside it. */
  containers: Map<string, Set<string>>;
  filesScanned: number;
  linesScanned: number;
}

/** A key that is not in the known set — i.e. something CC started writing. */
export interface UnknownField {
  where: string;
  key: string;
  version: string | null;
}

// The test scans only recent sessions: new keys arrive with new releases, so old
// files cannot contain a key the newest ones lack. Capping cannot produce a false
// positive either — the diff is one-directional (observed \ known), so a key
// missing from a thin sample raises nothing. It only bounds discovery.
export const DEFAULT_MAX_FILES = 60;

// Recursive on purpose: subagent children live at <slug>/<uuid>/subagents/
// agent-<id>.jsonl, two levels down. A flat scan misses 1590 of 3087 files —
// exactly the ones carrying the subagents' own lines, which seedeep reads.
async function walk(dir: string, found: Array<{ path: string; mtime: number }>): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) {
      await walk(path, found);
    } else if (e.name.endsWith('.jsonl')) {
      try {
        found.push({ path, mtime: (await stat(path)).mtimeMs });
      } catch {
        // A file can vanish mid-scan (a session being cleaned up); skip it.
      }
    }
  }
}

async function newestFiles(root: string, maxFiles: number): Promise<string[]> {
  const found: Array<{ path: string; mtime: number }> = [];
  await walk(root, found);
  found.sort((a, b) => b.mtime - a.mtime);
  return found.slice(0, maxFiles).map((f) => f.path);
}

/** The object at a dotted path, or null when the path does not lead to one. */
function objectAt(line: any, path: string): Record<string, unknown> | null {
  let cur: any = line;
  for (const step of path.split('.')) {
    if (!cur || typeof cur !== 'object') return null;
    cur = cur[step];
  }
  return cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : null;
}

/**
 * Scan real session logs and collect every key actually written, per line type,
 * plus the keys inside each {@link OBSERVED_CONTAINERS} path. Never throws:
 * unreadable files and malformed lines are skipped. Pass `maxFiles: Infinity` to
 * scan everything (the regeneration path); the default bounds it for test-suite latency.
 */
export async function observeSchema(
  root: string = cliRoot(homedir()),
  maxFiles: number = DEFAULT_MAX_FILES,
): Promise<ObservedSchema> {
  const out: ObservedSchema = { types: new Map(), containers: new Map(), filesScanned: 0, linesScanned: 0 };
  for (const path of await newestFiles(root, maxFiles)) {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    out.filesScanned++;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let d: any;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      if (!d || typeof d !== 'object') continue;
      out.linesScanned++;
      const type = typeof d.type === 'string' ? d.type : '?';
      let set = out.types.get(type);
      if (!set) out.types.set(type, (set = new Set()));
      for (const k of Object.keys(d)) set.add(k);
      for (const path of OBSERVED_CONTAINERS) {
        const obj = objectAt(d, path);
        if (!obj) continue;
        let keys = out.containers.get(path);
        if (!keys) out.containers.set(path, (keys = new Set()));
        for (const k of Object.keys(obj)) keys.add(k);
      }
    }
  }
  return out;
}

/**
 * Keys present in the logs but absent from the known set — each one a thing CC
 * started writing that nobody has looked at yet. `version` names a release that
 * wrote the key, for the report; it is best-effort, not a first-seen claim.
 */
export function unknownFields(observed: ObservedSchema, set: typeof known = known): UnknownField[] {
  const out: UnknownField[] = [];
  const types = set.types as Record<string, string[]>;
  for (const [type, keys] of observed.types) {
    const knownKeys = types[type];
    if (!knownKeys) {
      // A whole line TYPE is new. This is not pedantry: `queue-operation` arrived
      // exactly this way and carried the end of every background subagent (the bug that made background subagents look finished at birth).
      out.push({ where: `type:${type}`, key: '(new line type)', version: null });
      continue;
    }
    for (const key of keys) if (!knownKeys.includes(key)) out.push({ where: `type:${type}`, key, version: null });
  }
  const containers = set.containers as Record<string, string[]>;
  for (const [path, keys] of observed.containers) {
    // An unlisted container reports every key it holds: the path is in
    // OBSERVED_CONTAINERS because seedeep reads it, so "never recorded" is itself
    // the finding — accept it once with --update and it goes quiet.
    const knownKeys = containers[path] ?? [];
    for (const key of keys) if (!knownKeys.includes(key)) out.push({ where: path, key, version: null });
  }
  return out.sort((a, b) => a.where.localeCompare(b.where) || a.key.localeCompare(b.key));
}

/**
 * Regenerate `data/known-fields.json` from a FULL scan of the local logs.
 * Run when an unknown field has been reviewed and accepted:
 *   bun run src/schema-known-fields.ts --update
 * The set is monotone by intent — it only ever grows, so it can never become the
 * source of a flaky failure.
 */
export async function buildKnownSet(root: string = cliRoot(homedir())): Promise<string> {
  const observed = await observeSchema(root, Infinity);
  const types: Record<string, string[]> = {};
  for (const [type, keys] of [...observed.types].sort((a, b) => a[0].localeCompare(b[0]))) {
    types[type] = [...keys].sort();
  }
  // Union with the current set: monotone. A field that exists but happened not to
  // occur in this scan must never be dropped, or it would be re-reported as new.
  for (const [type, keys] of Object.entries(known.types as Record<string, string[]>)) {
    types[type] = [...new Set([...(types[type] ?? []), ...keys])].sort();
  }
  const containers: Record<string, string[]> = {};
  for (const path of OBSERVED_CONTAINERS) {
    const prev = (known.containers as Record<string, string[]>)[path] ?? [];
    containers[path] = [...new Set([...(observed.containers.get(path) ?? []), ...prev])].sort();
  }
  return (
    JSON.stringify(
      {
        _note:
          'Keys Claude Code is known to write. Field NAMES only, never values — safe to publish. ' +
          'Monotone: entries are only ever added. Regenerate with `bun run src/schema-known-fields.ts --update` ' +
          'after reviewing an unknown field.',
        types,
        containers,
      },
      null,
      2,
    ) + '\n'
  );
}

if (import.meta.main && process.argv.includes('--update')) {
  const json = await buildKnownSet();
  const path = new URL('../../data/known-fields.json', import.meta.url).pathname;
  await (await import('node:fs/promises')).writeFile(path, json);
  console.log(`known-fields.json updated from a full scan (${path})`);
}
