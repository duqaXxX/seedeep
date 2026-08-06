import type { Stats } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { anon } from '../core/text.ts';
import { ACTIVE_WINDOW_MS, type Root, type SessionRecord } from '../core/types.ts';
import { listOpenSessions, type OpenSession } from './open-sessions.ts';
import { CONTROL_COMMANDS, userLineIntent } from './parser.ts';
import { cliRoot, slugToProject } from './roots.ts';

export interface DiscoverOptions {
  home?: string;
  now?: number;
  roots?: string[]; // override CLI slug-parent dirs (tests)
  // Inject the open set (tests); else read from ~/.claude/sessions. `null` means the PID
  // mechanism is unavailable, exactly as listOpenSessions reports it.
  openSessions?: OpenSession[] | null;
}

interface FirstLineMeta {
  sessionId?: string;
  model?: string | null;
  cwd?: string;
  entrypoint?: string;
  subject?: string; // first non-control human/sdk prompt, anonymized — the readable label
}

const HEAD_CHUNK = 65536; // one read satisfies the common case
const HEAD_MAX_SCAN = 1_048_576; // 1MB hard cap for the pathological-head escalation

interface HeadEntry {
  meta: FirstLineMeta;
  size: number;
  complete: boolean;
}

// The watcher re-discovers every ~300ms; without this cache every tick re-opened and
// re-parsed the head of EVERY session file under the roots, forever. A head's anchors
// are immutable once written, so a scan that found them all — or hit HEAD_MAX_SCAN,
// past which nothing more is ever read — is final and served from cache. An incomplete
// scan (a young session whose model/subject lines are not written yet) is retried only
// when the file has changed size.
// LIMIT: staleness is detected by size alone — an in-place rewrite that keeps or grows
// the size is served stale (session files are append-only, so only an external
// restore/sync tool can trigger it). Entries for deleted files are never pruned (a few
// hundred bytes each — harmless).
const headCache = new Map<string, HeadEntry>();

async function firstLineMeta(path: string, size: number): Promise<FirstLineMeta> {
  const hit = headCache.get(path);
  // A shrunken file was replaced, not appended to — even a "complete" entry is stale.
  if (hit && (hit.complete ? size >= hit.size : size === hit.size)) return hit.meta;
  const scan = await scanHead(path);
  if (scan) {
    // Discoveries run concurrently (watcher tick + HTTP endpoints share this Map): a
    // slower scan that read the file before its anchors landed must not clobber the
    // complete entry a faster concurrent scan already cached.
    const cur = headCache.get(path);
    if (!(cur?.complete && !scan.complete)) headCache.set(path, { meta: scan.meta, size, complete: scan.complete });
    return scan.meta;
  }
  // Read failed (EMFILE, permission blip): last known anchors beat a blank record.
  return hit?.meta ?? {};
}

async function scanHead(path: string): Promise<{ meta: FirstLineMeta; complete: boolean } | null> {
  // Scan the session head for its anchors. `sessionId`/`cwd`/`entrypoint` come from the
  // first line that carries them; `model` only appears on the first assistant line
  // (sessions open with mode/system lines that carry no model); the `subject` is the
  // first prompt that states a task — a session opening with `/clear` then `/effort`
  // must still be labelled by the real prompt, so control commands are skipped.
  // Common case: the first 64KB holds all anchors and ONE read suffices. Only when a
  // field is still missing — a huge early line (a big paste, or a docs-gate prompt
  // carrying a large git diff) pushed the prompt/model past 64KB — does it read further,
  // in 64KB steps, until the anchors are known or {@link HEAD_MAX_SCAN} is reached.
  // LIMIT: past that cap a field stays unset and the record falls back to an
  // id/"automated" label. The `StringDecoder` keeps a multi-byte char that straddles a
  // chunk boundary from corrupting the line it lands in.
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let entrypoint: string | undefined;
  let subject: string | undefined;
  let model: string | null = null;
  const haveAnchors = () => sessionId !== undefined && model !== null && subject !== undefined;
  const consume = (line: string): void => {
    if (!line.trim()) return;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      return;
    } // a truncated/partial line simply yields nothing
    if (sessionId === undefined && typeof d.sessionId === 'string') sessionId = d.sessionId;
    if (cwd === undefined && typeof d.cwd === 'string') cwd = d.cwd;
    if (entrypoint === undefined && typeof d.entrypoint === 'string') entrypoint = d.entrypoint;
    const m = d.message?.model;
    if (model === null && typeof m === 'string' && m.length > 0) model = m;
    if (subject === undefined && d.type === 'user') {
      const intent = userLineIntent(d);
      // Skip session-control commands (/clear, /effort…) and keep scanning; the first
      // task-bearing prompt (human, non-control command, or headless sdk) wins.
      if (intent && !(intent.command !== null && CONTROL_COMMANDS.has(intent.command)))
        subject = anon(intent.text, 200);
    }
  };
  let total = 0;
  try {
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.allocUnsafe(HEAD_CHUNK); // only subarray(0, bytesRead) is ever consumed — no zero-fill needed
      const decoder = new StringDecoder('utf8');
      let carry = '';
      for (;;) {
        const { bytesRead } = await fh.read(buf, 0, HEAD_CHUNK, null); // null = sequential
        if (bytesRead === 0) {
          consume(carry + decoder.end());
          break;
        } // EOF: last line has no trailing \n
        total += bytesRead;
        carry += decoder.write(buf.subarray(0, bytesRead));
        const nl = carry.lastIndexOf('\n');
        if (nl >= 0) {
          for (const line of carry.slice(0, nl).split('\n')) consume(line);
          carry = carry.slice(nl + 1);
        }
        if (haveAnchors() || total >= HEAD_MAX_SCAN) break;
      }
    } finally {
      await fh.close();
    }
    // Complete = every anchor found, or the cap reached (nothing past it is ever read),
    // so no future growth of the file can change this result.
    return { meta: { sessionId, model, cwd, entrypoint, subject }, complete: haveAnchors() || total >= HEAD_MAX_SCAN };
  } catch {
    return null; // open/read failed: yield nothing and never cache an error
  }
}

async function recordFor(
  path: string,
  root: Root,
  now: number,
  openById: Map<string, OpenSession> | null,
): Promise<SessionRecord | null> {
  let st: Stats;
  try {
    st = await stat(path);
  } catch {
    return null;
  }
  const meta = await firstLineMeta(path, st.size);
  const sessionId = meta.sessionId ?? basename(path).replace(/\.jsonl$/, '');
  const project = meta.cwd ? basename(meta.cwd) : slugToProject(basename(join(path, '..')));
  const open = openById?.get(sessionId) ?? null;
  return {
    sessionId,
    project,
    model: meta.model ?? null,
    lastActivity: st.mtimeMs,
    isActive: now - st.mtimeMs <= ACTIVE_WINDOW_MS,
    // null, not false, when there is no PID mechanism to ask: "no process file for this
    // session" and "no process files at all" are different facts, and only the first one
    // means closed. Consumers read it through `isLive`, whose mtime fallback exists for
    // exactly this case.
    isOpen: openById ? open !== null : null,
    status: open?.status ?? null,
    waitingFor: open?.waitingFor ?? null,
    waitingSince: open?.waitingSince ?? null,
    subject: meta.subject ?? null,
    entrypoint: meta.entrypoint ?? null,
    root,
    path,
  };
}

async function scanCliDir(
  slugParent: string,
  now: number,
  openById: Map<string, OpenSession> | null,
): Promise<SessionRecord[]> {
  const out: SessionRecord[] = [];
  let slugs: string[];
  try {
    slugs = await readdir(slugParent);
  } catch {
    return out;
  }
  for (const slug of slugs) {
    const dir = join(slugParent, slug);
    let s: Stats;
    try {
      s = await stat(dir);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl') || f === 'audit.jsonl') continue;
      const rec = await recordFor(join(dir, f), 'cli', now, openById);
      if (rec) out.push(rec);
    }
  }
  return out;
}

/**
 * Enumerate every Claude Code session under the discovered roots, newest first.
 * Read-only: stats and reads a leading chunk of each `.jsonl`, never writes.
 * Marks the sessions with a live `~/.claude/sessions/<PID>.json` (`isOpen` +
 * `status`) — `isOpen: null` on every record when that dir does not exist — and,
 * as a fallback openness proxy, those touched within {@link ACTIVE_WINDOW_MS}
 * (`isActive`).
 * All inputs are injectable via {@link DiscoverOptions} for testing (home, now,
 * roots, openSessions).
 */
export async function discoverSessions(opts: DiscoverOptions = {}): Promise<SessionRecord[]> {
  const home = opts.home ?? homedir();
  const now = opts.now ?? Date.now();
  const openSessions = opts.openSessions !== undefined ? opts.openSessions : await listOpenSessions({ home });
  const openById = openSessions === null ? null : new Map(openSessions.map((s) => [s.sessionId, s]));

  const cliDirs = opts.roots ?? [cliRoot(home)];
  const records: SessionRecord[] = [];
  for (const dir of cliDirs) {
    records.push(...(await scanCliDir(dir, now, openById)));
  }
  records.sort((a, b) => b.lastActivity - a.lastActivity);
  return records;
}
