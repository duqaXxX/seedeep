import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliRoot } from '../src/server/roots.ts';

/**
 * Drives a REAL Claude Code `cli` session inside a pty, so the schema probe can
 * PROVOKE each event it wants to check.
 *
 * Why a pty and not `claude -p`: headless sessions are a different species.
 * Measured over 527 files / 5586 lines of `entrypoint: sdk-cli`, they NEVER carry
 * `origin`, `system/turn_duration`, `compactMetadata` or `interruptedMessageId`.
 * A probe built on `-p` would verify those vacuously and report green on a dead
 * parser — worse than having no probe at all.
 */

// Patterns are matched against the screen with ALL whitespace removed, and are
// therefore written without spaces. The TUI does not emit spaces between words —
// it positions the cursor with escape sequences — so a de-ansied screen reads
// "Isthisaprojectyoucreated". A spaced pattern matches only by luck (when a line
// happens to carry real spaces), which is how the trust gate was answered
// sometimes and silently missed other times, wedging the whole run.
const TRUST_GATE = /trustthisfolder|Isthisaprojectyoucreated/i;
// The banner the TUI draws once it is accepting input.
const TUI_READY = /ClaudeCodev\d|forshortcuts|Tipsforgettingstarted/i;

export interface ProbeSession {
  cwd: string;
  screen(): string;
  /** Forget everything drawn so far, so a later waitForScreen means "since now". */
  clear(): void;
  send(text: string): void;
  /** Type a line and press Enter, at a pace the TUI actually accepts. */
  typeLine(text: string): Promise<void>;
  /** Wait until the transcript stops growing — a turn is over. */
  settle(quietMs?: number, timeoutMs?: number): Promise<'settled' | 'timeout'>;
  waitForScreen(pattern: RegExp, timeoutMs?: number): Promise<boolean>;
  transcript(): Promise<string | null>;
  childTranscripts(): Promise<Array<{ agentId: string; lines: any[]; meta: any }>>;
  close(): Promise<void>;
}

/**
 * Env with every Claude Code variable removed.
 *
 * NOT cosmetic: a `claude` launched from inside a session inherits
 * CLAUDE_CODE_SESSION_ID and attaches to the PARENT's transcript. Measured
 * 2026-07-17 — the first probe run wrote its lines into the caller's jsonl and
 * left its own project dir empty, so the probe observed nothing at all.
 */
export function scrubbedEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (k.startsWith('CLAUDE') || k.startsWith('ANTHROPIC_DEFAULT') || k === 'AI_AGENT') continue;
    out[k] = v;
  }
  out.TERM = 'xterm-256color';
  return out;
}

/** The project dir Claude Code writes a session for `cwd` into. */
export function slugFor(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

async function newestJsonl(dir: string): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const files: Array<{ path: string; mtime: number }> = [];
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue;
    const path = join(dir, n);
    try {
      files.push({ path, mtime: (await stat(path)).mtimeMs });
    } catch {
      /* vanished */
    }
  }
  if (!files.length) return null;
  files.sort((a, b) => b.mtime - a.mtime);
  return files[0]!.path;
}

async function sizeOf(path: string | null): Promise<number> {
  if (!path) return -1;
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Open a driven Claude Code session in a throwaway cwd seeded with `files`
 * (a synthetic codebase + the probe's own command/skill fixtures).
 *
 * The cwd is ALWAYS a tmpdir, never the repo: a `.claude/` written into the
 * working tree would be committed and would register real commands for anyone
 * who clones seedeep.
 */
export async function openProbeSession(opts: {
  files: Record<string, string>;
  model?: string;
  home?: string;
  /**
   * A fixed working directory instead of a random tmpdir. Claude Code bakes the cwd into every
   * transcript line AND into the project slug, so `seedeep-probe-a7f3k2` would BE the project name
   * on a published demo frame. The demo capture needs to choose that name; the probe does not care.
   * Still never the repo — the reason the default is a tmpdir at all.
   */
  cwd?: string;
  /**
   * Run against an isolated `CLAUDE_CONFIG_DIR` instead of the caller's real one. The demo capture
   * needs it: a session that inherits a personal `CLAUDE.md` obeys it, and one such file turned a
   * scripted "read this file / dispatch three agents" into `awk` and no subagent at all. Note that
   * a clean config dir carries no credentials — the caller must put them there.
   */
  configDir?: string;
  /**
   * Claude Code's `--permission-mode`. The probe leaves it unset because one of its scenes exists
   * to provoke a permission prompt; an unattended capture must never see one — an Edit on a fresh
   * profile stops the session dead, waiting for an approval nobody is there to give.
   */
  permissionMode?: 'acceptEdits' | 'auto' | 'bypassPermissions' | 'manual' | 'dontAsk' | 'plan';
}): Promise<ProbeSession> {
  const home = opts.home ?? homedir();
  const envOverride = opts.configDir ? { CLAUDE_CONFIG_DIR: opts.configDir } : undefined;
  // realpath, NOT the mkdtemp path: on macOS tmpdir() is /var/folders/… which is a
  // symlink to /private/var/folders/…. Claude Code slugifies the RESOLVED cwd, so
  // the unresolved path points the probe at a project dir that never exists — the
  // session runs fine and the probe reports "no transcript", including on cleanup,
  // which then leaves real sessions behind.
  if (opts.cwd) await mkdir(opts.cwd, { recursive: true });
  const cwd = await realpath(opts.cwd ?? (await mkdtemp(join(tmpdir(), 'seedeep-probe-'))));
  for (const [rel, content] of Object.entries(opts.files)) {
    const path = join(cwd, rel);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content);
  }

  let buf = '';
  const args = ['claude'];
  if (opts.model) args.push('--model', opts.model);
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
  const proc = Bun.spawn(args, {
    cwd,
    // scrubbedEnv strips every CLAUDE* key, CLAUDE_CONFIG_DIR included, so an isolated profile has
    // to be put back AFTER the scrub or the child silently uses the caller's real one.
    env: { ...scrubbedEnv(), ...envOverride },
    terminal: {
      cols: 120,
      rows: 40,
      data(_t, data) {
        buf += new TextDecoder().decode(data);
      },
    },
  });

  const projectDir = join(cliRoot(home, envOverride), slugFor(cwd));
  // The TUI repositions with bare CRs as it redraws, so a de-ansi that keeps them
  // turns "hello" into "h\r\re\rl\rl\ro" and every pattern misses. Strip the ANSI
  // sequences AND the CRs: this screen is only ever matched against, never shown.
  const screen = () =>
    buf
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .replace(/\r/g, '');
  // What patterns are matched against — see the note on TRUST_GATE.
  const squashed = () => screen().replace(/\s+/g, '');

  const session: ProbeSession = {
    cwd,
    screen,
    clear() {
      buf = '';
    },
    send(text) {
      if (!proc.terminal) throw new Error('probe: no pty attached — Bun.spawn gave no terminal');
      proc.terminal.write(text);
    },
    async typeLine(text) {
      session.send(text);
      // The TUI needs a beat to ingest the text before the Enter, or it submits
      // an empty prompt and the text lands in the NEXT one.
      await sleep(400);
      session.send('\r');
    },
    async waitForScreen(pattern, timeoutMs = 60_000) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        if (pattern.test(squashed())) return true;
        await sleep(150);
      }
      return false;
    },
    async settle(quietMs = 3_000, timeoutMs = 120_000) {
      // Quiescence of the TRANSCRIPT, not of the screen: the TUI redraws
      // constantly (spinners, tips), and its "working" markers are random words.
      // Deliberately NOT keyed on `turn_duration` — that field is itself a claim,
      // and steering the probe by the thing under test would make a real removal
      // look like a hang instead of a finding.
      const end = Date.now() + timeoutMs;
      let last = -2;
      let stableSince = Date.now();
      while (Date.now() < end) {
        const size = await sizeOf(await newestJsonl(projectDir));
        if (size !== last) {
          last = size;
          stableSince = Date.now();
        } else if (size > 0 && Date.now() - stableSince >= quietMs) {
          return 'settled';
        }
        await sleep(250);
      }
      return 'timeout';
    },
    async transcript() {
      const path = await newestJsonl(projectDir);
      if (!path) return null;
      try {
        return await readFile(path, 'utf8');
      } catch {
        return null;
      }
    },
    async childTranscripts() {
      const path = await newestJsonl(projectDir);
      if (!path) return [];
      const uuid = path.split('/').pop()!.replace('.jsonl', '');
      const dir = join(projectDir, uuid, 'subagents');
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return [];
      }
      const out: Array<{ agentId: string; lines: any[]; meta: any }> = [];
      for (const n of names) {
        const m = /^agent-(.+)\.jsonl$/.exec(n);
        if (!m) continue;
        const agentId = m[1]!;
        const lines: any[] = [];
        try {
          for (const l of (await readFile(join(dir, n), 'utf8')).split('\n')) {
            if (!l.trim()) continue;
            try {
              lines.push(JSON.parse(l));
            } catch {
              /* skip */
            }
          }
        } catch {
          continue;
        }
        let meta: any = null;
        try {
          meta = JSON.parse(await readFile(join(dir, `agent-${agentId}.meta.json`), 'utf8'));
        } catch {
          /* a child may have no meta */
        }
        out.push({ agentId, lines, meta });
      }
      return out;
    },
    async close() {
      try {
        proc.terminal?.close();
        proc.kill();
        await proc.exited;
      } catch {
        /* already gone */
      }
      // The probe must not leave real sessions behind, or seedeep's own session
      // list fills with probe runs.
      await rm(projectDir, { recursive: true, force: true }).catch(() => {});
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
    },
  };

  // A fresh cwd raises the folder-trust gate; it is part of the contract too.
  if (await session.waitForScreen(TRUST_GATE, 15_000)) {
    // The pattern can match mid-redraw, before the menu accepts keys; give it a
    // beat or the Enter is swallowed and the gate never clears.
    await sleep(1_500);
    session.send('\r');
  }
  // Wait for the TUI to be READY, never a fixed delay: typing 2s after the trust
  // gate silently dropped every character — the prompt was never sent and the run
  // died with no transcript and no error.
  if (!(await session.waitForScreen(TUI_READY, 30_000))) {
    throw new Error(`probe: the TUI never became ready. Screen tail:\n${session.screen().slice(-600)}`);
  }
  await sleep(1_000);
  session.clear();
  return session;
}
