import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { cliRoot } from './roots.ts';
import type { ClaimContext } from './schema-contract.ts';

/**
 * Evidence for a claim, gathered from REAL sessions written by one CC version.
 *
 * Why this exists: the probe cannot make Claude delegate, pick a skill, or make
 * Claude Code accept a /compact. But ordinary use of Claude Code produces all of
 * those on the new version within days. Presence is conclusive — a subagent's returned
 * output found in a log written by 2.1.213 PROVES the field is alive on 2.1.213,
 * with nobody doing anything.
 *
 * Correctness is the whole point here, so two rules are absolute:
 *   1. Only lines whose `version` IS the target count. A field seen on 2.1.211
 *      says nothing about 2.1.213 — confirming the present with the past is the
 *      exact lie this guard exists to prevent (and a draft of this file did it:
 *      it reported 9 claims "proven" on a version with 0 lines).
 *   2. Subagent children carry NO `version`, so it is inherited from the parent
 *      transcript — and ONLY when that parent has exactly ONE version. A session
 *      that spans an upgrade cannot attribute its children, so it is discarded
 *      rather than guessed.
 *
 * Absence proves nothing here and is never reported as a finding: a claim with no
 * evidence stays open for the manual checklist.
 */

export interface VersionEvidence {
  /** One context per real session written by the target version. */
  contexts: ClaimContext[];
  sessionsScanned: number;
  sessionsAttributed: number;
  /** Sessions skipped because their version could not be pinned down. */
  sessionsAmbiguous: number;
}

const parse = (text: string): any[] =>
  text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

async function jsonlFiles(dir: string, out: string[] = []): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await jsonlFiles(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/** The versions that wrote a transcript. More than one = spans an upgrade. */
export function versionsIn(lines: any[]): Set<string> {
  const out = new Set<string>();
  for (const d of lines) if (typeof d?.version === 'string') out.add(d.version);
  return out;
}

/**
 * Real sessions written by `version`, as claim contexts.
 *
 * A session qualifies only when EVERY version it carries is the target — so its
 * subagent children (which have no version of their own) can be attributed to it
 * without guessing. `maxAgeMs` bounds the scan; older sessions cannot have been
 * written by a version released after them.
 */
export async function evidenceForVersion(
  version: string,
  opts: { root?: string; maxAgeMs?: number } = {},
): Promise<VersionEvidence> {
  const root = opts.root ?? cliRoot(homedir());
  const maxAge = opts.maxAgeMs ?? 30 * 86400_000;
  const all = await jsonlFiles(root);
  // Parents only; children are reached from their parent.
  const parents = all.filter((f) => !f.includes(`${join('', 'subagents')}${''}`) && !/\/subagents\//.test(f));

  const ev: VersionEvidence = { contexts: [], sessionsScanned: 0, sessionsAttributed: 0, sessionsAmbiguous: 0 };

  for (const path of parents) {
    try {
      if (Date.now() - (await stat(path)).mtimeMs > maxAge) continue;
    } catch {
      continue;
    }
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    if (!raw.includes(`"${version}"`)) continue; // cheap reject before parsing
    ev.sessionsScanned++;
    const lines = parse(raw);
    const versions = versionsIn(lines);
    if (versions.size !== 1 || !versions.has(version)) {
      // Either not this version at all, or a session that spans an upgrade: its
      // children cannot be attributed, so it is not evidence.
      if (versions.has(version)) ev.sessionsAmbiguous++;
      continue;
    }
    ev.sessionsAttributed++;

    const uuid = basename(path, '.jsonl');
    const subDir = join(dirname(path), uuid, 'subagents');
    const children: ClaimContext['children'] = [];
    let names: string[] = [];
    try {
      names = await readdir(subDir);
    } catch {
      /* no children */
    }
    for (const n of names) {
      const m = /^agent-(.+)\.jsonl$/.exec(n);
      if (!m) continue;
      let childRaw: string;
      try {
        childRaw = await readFile(join(subDir, n), 'utf8');
      } catch {
        continue;
      }
      let meta: any = null;
      try {
        meta = JSON.parse(await readFile(join(subDir, `agent-${m[1]!}.meta.json`), 'utf8'));
      } catch {
        /* a child may have no meta */
      }
      children.push({ agentId: m[1]!, lines: parse(childRaw), meta });
    }

    ev.contexts.push({ lines, raw, children, openSessions: [] });
  }
  return ev;
}
