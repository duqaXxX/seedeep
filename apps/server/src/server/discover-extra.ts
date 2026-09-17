import type { Stats } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { anon } from '../core/text.ts';
import { ACTIVE_WINDOW_MS, type Root, type SessionRecord } from '../core/types.ts';
import type { OpenSession } from './open-sessions.ts';
import { parseJson } from './parse-util.ts';

export interface ExtraScan {
  sessions: SessionRecord[];
  complete: boolean;
}

function isOpenFor(root: Root, sessionId: string, grokOpen: Map<string, OpenSession> | null): boolean | null {
  if (root === 'grok') return grokOpen ? grokOpen.has(sessionId) : null;
  return null; // Codex / Gemini / Antigravity: mtime only
}

function record(
  partial: Omit<SessionRecord, 'isActive' | 'isOpen' | 'status' | 'waitingFor' | 'waitingSince'> & {
    lastActivity: number;
  },
  now: number,
  grokOpen: Map<string, OpenSession> | null,
): SessionRecord {
  const open = grokOpen?.get(partial.sessionId) ?? null;
  const isOpen = isOpenFor(partial.root, partial.sessionId, grokOpen);
  return {
    ...partial,
    isActive: now - partial.lastActivity <= ACTIVE_WINDOW_MS,
    isOpen,
    status: open?.status ?? null,
    waitingFor: open?.waitingFor ?? null,
    waitingSince: open?.waitingSince ?? null,
  };
}

async function safeStat(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function readHead(path: string, max = 65_536): Promise<string> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(max);
    const { bytesRead } = await fh.read(buf, 0, max, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

async function walkDirs(
  dir: string,
  visit: (path: string, entries: string[]) => Promise<void>,
  complete: { v: boolean },
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e: any) {
    if (e?.code !== 'ENOENT') complete.v = false;
    return;
  }
  await visit(dir, names);
  if (names.includes('summary.json')) return; // a Grok session dir — do not walk terminal/ etc.
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = await safeStat(p);
    if (st?.isDirectory()) await walkDirs(p, visit, complete);
  }
}

/** Grok Build sessions under `~/.grok/sessions`, one record per `summary.json`. */
export async function scanGrokSessions(
  home: string,
  now: number,
  grokOpen: Map<string, OpenSession> | null,
): Promise<ExtraScan> {
  const root = join(home, '.grok', 'sessions');
  const sessions: SessionRecord[] = [];
  const complete = { v: true };
  await walkDirs(
    root,
    async (dir, names) => {
      if (!names.includes('summary.json')) return;
      let summary: any;
      try {
        summary = JSON.parse(await readFile(join(dir, 'summary.json'), 'utf8'));
      } catch {
        complete.v = false;
        return;
      }
      const info = summary?.info && typeof summary.info === 'object' ? summary.info : {};
      const sessionId = typeof info.id === 'string' ? info.id : basename(dir);
      const cwd = typeof info.cwd === 'string' ? info.cwd : '';
      const path = names.includes('updates.jsonl')
        ? join(dir, 'updates.jsonl')
        : names.includes('events.jsonl')
          ? join(dir, 'events.jsonl')
          : names.includes('chat_history.jsonl')
            ? join(dir, 'chat_history.jsonl')
            : null;
      if (!path) return;
      const st = await safeStat(path);
      const last = typeof summary.last_active_at === 'string' ? Date.parse(summary.last_active_at) : NaN;
      const lastActivity = Number.isFinite(last) ? last : (st?.mtimeMs ?? now);
      const kind = summary.session_kind;
      const entrypoint = kind === 'subagent' || kind === 'subagent_resume' ? 'sdk-subagent' : 'cli';
      const subjectRaw =
        (typeof summary.generated_title === 'string' && summary.generated_title) ||
        (typeof summary.session_summary === 'string' && summary.session_summary) ||
        null;
      sessions.push(
        record(
          {
            sessionId,
            project: cwd ? basename(cwd) : 'grok',
            model: typeof summary.current_model_id === 'string' ? summary.current_model_id : null,
            lastActivity,
            subject: subjectRaw ? anon(subjectRaw, 200) : null,
            entrypoint,
            root: 'grok',
            path,
          },
          now,
          grokOpen,
        ),
      );
    },
    complete,
  );
  return { sessions, complete: complete.v };
}

/** Codex rollout jsonl files under `~/.codex/sessions`. */
export async function scanCodexSessions(home: string, now: number): Promise<ExtraScan> {
  const root = join(home, '.codex', 'sessions');
  const sessions: SessionRecord[] = [];
  const complete = { v: true };
  await walkDirs(
    root,
    async (dir, names) => {
      for (const name of names) {
        if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
        const path = join(dir, name);
        const st = await safeStat(path);
        if (!st?.isFile()) continue;
        let sessionId = name.slice('rollout-'.length, -'.jsonl'.length);
        let cwd = '';
        let model: string | null = null;
        let subject: string | null = null;
        try {
          const lines = (await readHead(path)).split('\n');
          for (const line of lines) {
            const d = parseJson(line);
            if (!d) continue;
            const payload = d.payload && typeof d.payload === 'object' ? (d.payload as Record<string, unknown>) : {};
            if (d.type === 'session_meta') {
              if (typeof payload.session_id === 'string') sessionId = payload.session_id;
              if (typeof payload.cwd === 'string') cwd = payload.cwd;
            }
            if (d.type === 'turn_context' && typeof payload.model === 'string') model = payload.model;
            if (d.type === 'event_msg') {
              const item =
                payload.item && typeof payload.item === 'object' ? (payload.item as Record<string, unknown>) : null;
              if (payload.type === 'item_completed' && item?.type === 'UserMessage' && !subject) {
                const content = item.content;
                const text =
                  typeof content === 'string'
                    ? content
                    : Array.isArray(content)
                      ? content
                          .map((c) =>
                            c && typeof c === 'object' && typeof (c as any).text === 'string' ? (c as any).text : '',
                          )
                          .join('\n')
                      : '';
                if (text.trim()) subject = anon(text, 200);
              }
            }
          }
        } catch {
          /* head scan failed — still list the file */
        }
        sessions.push(
          record(
            {
              sessionId,
              project: cwd ? basename(cwd) : 'codex',
              model,
              lastActivity: st.mtimeMs,
              subject,
              entrypoint: 'cli',
              root: 'codex',
              path,
            },
            now,
            null,
          ),
        );
      }
    },
    complete,
  );
  return { sessions, complete: complete.v };
}

/** Gemini CLI chats under `~/.gemini/tmp/<project>/chats`. */
export async function scanGeminiSessions(home: string, now: number): Promise<ExtraScan> {
  const root = join(home, '.gemini', 'tmp');
  const sessions: SessionRecord[] = [];
  const complete = { v: true };
  let projects: string[];
  try {
    projects = await readdir(root);
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { sessions, complete: true };
    throw e;
  }
  for (const project of projects) {
    const chatDir = join(root, project, 'chats');
    let files: string[];
    try {
      files = await readdir(chatDir);
    } catch (e: any) {
      if (e?.code !== 'ENOENT') complete.v = false;
      continue;
    }
    for (const f of files) {
      if (!f.startsWith('session-') || !f.endsWith('.jsonl')) continue;
      const path = join(chatDir, f);
      const st = await safeStat(path);
      if (!st?.isFile()) continue;
      let sessionId = f.slice('session-'.length, -'.jsonl'.length);
      let subject: string | null = null;
      let model: string | null = null;
      try {
        const head = await readHead(path);
        for (const line of head.split('\n')) {
          const d = parseJson(line);
          if (!d) continue;
          if (typeof d.sessionId === 'string') sessionId = d.sessionId;
          if (d.type === 'user' && !subject) {
            const text = typeof d.content === 'string' ? d.content : '';
            if (text.trim()) subject = anon(text, 200);
          }
          if ((d.type === 'gemini' || d.type === 'model') && typeof d.model === 'string' && !model) model = d.model;
        }
      } catch {
        complete.v = false;
        continue;
      }
      sessions.push(
        record(
          {
            sessionId,
            project,
            model,
            lastActivity: st.mtimeMs,
            subject,
            entrypoint: 'cli',
            root: 'gemini',
            path,
          },
          now,
          null,
        ),
      );
    }
  }
  return { sessions, complete: complete.v };
}

/** Antigravity CLI transcripts under ~/.gemini/antigravity-cli/brain and ~/.gemini/antigravity/brain. */
export async function scanAgySessions(home: string, now: number): Promise<ExtraScan> {
  const sessions: SessionRecord[] = [];
  const complete = { v: true };
  const brains = [join(home, '.gemini', 'antigravity-cli', 'brain'), join(home, '.gemini', 'antigravity', 'brain')];
  for (const brain of brains) {
    let ids: string[];
    try {
      ids = await readdir(brain);
    } catch (e: any) {
      if (e?.code !== 'ENOENT') complete.v = false;
      continue;
    }
    for (const id of ids) {
      const transcript = join(brain, id, '.system_generated', 'logs', 'transcript.jsonl');
      const st = await safeStat(transcript);
      if (!st?.isFile()) continue;
      sessions.push(
        record(
          {
            sessionId: id,
            project: 'antigravity',
            model: null,
            lastActivity: st.mtimeMs,
            subject: null,
            entrypoint: 'cli',
            root: 'agy',
            path: transcript,
          },
          now,
          null,
        ),
      );
    }
  }
  return { sessions, complete: complete.v };
}

/** All non-Claude roots. Tests that pin DiscoverOptions.roots skip this. */
export async function scanExtraSessions(
  home: string,
  now: number,
  grokOpen: Map<string, OpenSession> | null,
): Promise<ExtraScan> {
  const parts = await Promise.all([
    scanGrokSessions(home, now, grokOpen),
    scanCodexSessions(home, now),
    scanGeminiSessions(home, now),
    scanAgySessions(home, now),
  ]);
  return {
    sessions: parts.flatMap((p) => p.sessions),
    complete: parts.every((p) => p.complete),
  };
}

/** Codex / Gemini / Antigravity only — they have no PID file, so the watcher polls mtime. */
export async function scanMtimeSessions(home: string, now: number): Promise<SessionRecord[]> {
  const parts = await Promise.all([
    scanCodexSessions(home, now),
    scanGeminiSessions(home, now),
    scanAgySessions(home, now),
  ]);
  return parts.flatMap((p) => p.sessions);
}
