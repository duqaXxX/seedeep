/**
 * `seedeep status` — the one question no other subcommand answers: what state is this machine in?
 *
 * Every other command is an ACTION (`open`, `stop`, `restart`, `update`). This one changes nothing
 * and is the only way to see the two things that went wrong on the day it was written: a server
 * still SERVING the previous version after the package had been updated (a running process keeps
 * its code until it is restarted, and nothing said so), and `/seedeep` missing because
 * `install-command` had never been run. Both took a shell and a token to diagnose.
 *
 * **A server that is down is a STATE, not a failure** (the maintainer's call, 2026-08-05): the exit code is
 * 0 whatever it finds, exactly as `stop` succeeds against a server already stopped. Asking a
 * question is not the same as demanding an answer you like.
 *
 * **It never touches the registry.** The update line comes from the cache the server refreshes
 * ({@link updateStatus} with `offline`), so `status` is instant and works with no network at all.
 * It does talk to the local server — that is what makes the served version knowable.
 */

import { readFile } from 'node:fs/promises';
import type { SeedDeepConfig } from './config.ts';
import { commandFilePath, type Ownership, ownershipOf, type PathState, pathState } from './install-command.ts';
import { portOf } from './open-cmd.ts';
import { askServer } from './own-server.ts';
import { type RunningServerRecord, runningServers } from './run-state.ts';
import { isLoopback } from './server.ts';
import { type UpdateStatus, updateStatus } from './update-check.ts';
import { type Channel, detectChannel, ownExecPath } from './update-cmd.ts';
import { VERSION } from './version.ts';

/** What is answering on the port, and what it says about itself. */
export type ServerState =
  | { kind: 'down' }
  /** A record exists and the process is alive; `serving` is null when it would not say. */
  | {
      kind: 'up';
      record: RunningServerRecord;
      remote: boolean;
      serving: string | null;
      /** The server compared what it started with against what a restart would resolve to, and
       * they differ. False also covers a server too old to answer the question. */
      restartPending: boolean;
    };

/** Whether `/seedeep` exists, and whose it is. */
export type CommandState = { kind: 'absent' } | { kind: 'present'; ownership: Ownership };

/** Everything `status` reports, gathered once so the rendering can be pure. */
export interface StatusFacts {
  version: string;
  channel: Channel;
  execPath: string;
  server: ServerState;
  update: UpdateStatus;
  command: CommandState;
  path: PathState;
  port: number;
}

/** `1.2.3` → `1.2.3`, but a path is shortened to its last two parts — a full one is noise here. */
function shortPath(p: string): string {
  const parts = p.split('/');
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p;
}

/** How long ago `iso` was, in the coarsest unit that is still true. */
function ago(iso: string, now: number): string {
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** The Server block: where it answers, what it is, and whether it is running the code you installed. */
function serverLines(facts: StatusFacts): string[] {
  if (facts.server.kind === 'down') {
    return [`Server    not running        \`seedeep start\` starts one on port ${facts.port}`];
  }
  const { record, remote, serving, restartPending } = facts.server;
  const lines = [
    `Server    running — ${record.baseUrl}`,
    `          pid ${record.pid} · ${remote ? 'remote mode (TLS + token)' : 'loopback'}`,
  ];
  // The line this command exists for. A process keeps the code it started with, so an install can
  // be newer than what is actually serving, and nothing else on the machine says so.
  if (serving === null) {
    lines.push('          version unknown — it did not answer');
  } else if (serving === facts.version) {
    lines.push(`          serving ${serving}`);
  } else {
    lines.push(`          serving ${serving} — you have ${facts.version} installed; \`seedeep restart\` swaps it`);
  }
  // The same shape of staleness one line up, on the other axis: there, the process is older than
  // the code on disk; here, it is older than the configuration on disk. Only when true — a line
  // that appears on every run is one nobody reads on the run that matters.
  if (restartPending) {
    lines.push('          config.json has changed since it started; `seedeep restart` applies it');
  }
  return lines;
}

/** The Update block, from the cache — never a request. */
function updateLines(u: UpdateStatus, now: number): string[] {
  const when = u.checkedAt ? `checked ${ago(u.checkedAt, now)}` : 'never checked';
  switch (u.standing) {
    case 'behind':
      return [`Update    ${u.latest} available — \`seedeep update\` says how (${when})`];
    case 'ahead':
      return [`Update    ahead of npm's ${u.latest} — a build of your own (${when})`];
    case 'current':
      return [`Update    up to date (${when})`];
    case 'unknown':
      return [`Update    unknown — npm has not been reached${u.reason ? ` (${u.reason})` : ''}`];
  }
}

/** The `/seedeep` block: the question that has no other answer short of listing another tool's directory. */
function commandLines(c: CommandState, path: PathState): string[] {
  if (c.kind === 'absent') {
    return ['/seedeep  not installed       `seedeep install-command` writes it'];
  }
  const lines =
    c.ownership.kind === 'theirs'
      ? ['/seedeep  yours — edited by hand, so seedeep leaves it alone']
      : [
          c.ownership.stale
            ? `/seedeep  installed, from ${c.ownership.version} — the next server start refreshes it`
            : '/seedeep  installed, current',
        ];
  // The command file calls `seedeep` BY NAME, so an install that is not on PATH under that name
  // makes `/seedeep` fail with "command not found" — an installed file and a working command are
  // two different facts, and only this one is checkable from here.
  if (path.kind === 'absent') {
    lines.push('          but `seedeep` is not on PATH under that name, so /seedeep cannot run it');
  } else if (path.kind === 'other') {
    lines.push(`          careful: \`seedeep\` on PATH is ${shortPath(path.found)}, not this one`);
  }
  return lines;
}

/**
 * The whole text `seedeep status` prints. Pure, so every combination — a server that will not say
 * its version, a command file the user has taken over, a registry never reached — is testable
 * without a process, a port or a network.
 */
export function statusReport(facts: StatusFacts, now = Date.now()): string {
  const channel = facts.channel.kind === 'checkout' ? 'checkout' : facts.channel.kind;
  const lines = [
    `seedeep ${facts.version}  (${channel}, ${shortPath(facts.execPath)})`,
    '',
    ...serverLines(facts),
    '',
    ...updateLines(facts.update, now),
    '',
    ...commandLines(facts.command, facts.path),
  ];
  return `${lines.join('\n')}\n`;
}

/** Read the command file's state without caring why it could not be read — absent is absent. */
async function readCommandState(path: string): Promise<CommandState> {
  try {
    return { kind: 'present', ownership: ownershipOf(await readFile(path, 'utf8')) };
  } catch {
    return { kind: 'absent' };
  }
}

/** Gather the real facts and print them. Always 0: a server that is down is an answer. */
export async function runStatus(
  port: number,
  config: SeedDeepConfig,
  out: { log: (s: string) => void } = { log: console.log },
): Promise<number> {
  const execPath = ownExecPath();
  const record = (await runningServers()).find((s) => portOf(s.baseUrl) === port);
  let server: ServerState = { kind: 'down' };
  if (record) {
    const config_ = await askServer<{ version?: string; restart_pending?: boolean }>(record, '/api/config', config);
    let remote = false;
    try {
      remote = !isLoopback(new URL(record.baseUrl).hostname);
    } catch {
      /* an unparseable address is not a claim about the mode */
    }
    server = {
      kind: 'up',
      record,
      remote,
      serving: config_?.version ?? null,
      // The server is the only party that knows both sides of it; a `status` that worked it out
      // locally would be guessing at flags and an environment it is not running under.
      restartPending: config_?.restart_pending ?? false,
    };
  }
  out.log(
    statusReport({
      version: VERSION,
      channel: detectChannel(execPath),
      execPath,
      server,
      update: await updateStatus({ offline: true }),
      command: await readCommandState(commandFilePath()),
      path: pathState({}),
      port,
    }),
  );
  return 0;
}
