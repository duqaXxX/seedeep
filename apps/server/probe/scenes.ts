import { ECHO_MARKER, ESC_MARKER, POST_ESC_MARKER, SCENE1_MARKER } from '../src/server/schema-contract.ts';
import type { ProbeSession } from './driver.ts';

/**
 * The scenes that PROVOKE each contract event.
 *
 * The prompts state a TASK, never a tool. Ordering a tool ("use the Agent tool
 * to…") tests the shape of a line but is blind to a change in BEHAVIOUR — CC made
 * subagents background-by-default in 2.1.198, and a probe that hand-forces
 * "background" would have sailed green straight through it. The cost is more
 * UNPROVEN, which is the right trade: "could not conclude" beats a green on a
 * path nobody walks any more.
 *
 * Scene 6 is the single exception and says so at its call site.
 */

/**
 * Files seeded into the throwaway cwd.
 *
 * The synthetic codebase exists so that "explore this" is a REAL task — broad
 * exploration over an actual tree is what makes Claude delegate on its own.
 * The command/skill fixtures are the probe's own so the run does not depend on
 * which plugins happen to be installed on this machine; they live in the tmpdir
 * and die with it, and never reach ~/.claude or a user's install.
 */
export const FIXTURES: Record<string, string> = {
  'config.ts': `// Connection settings for the sync worker.
export const RETRY_LIMIT = 3;
export const TIMEOUT_MS = 5_000;
export const ENDPOINT = 'https://example.invalid/sync';
`,
  'worker.ts': `import { RETRY_LIMIT, TIMEOUT_MS } from './config.ts';

export async function sync(items: string[]): Promise<number> {
  let attempts = 0;
  while (attempts < RETRY_LIMIT) {
    attempts++;
    const ok = await push(items, TIMEOUT_MS);
    if (ok) return attempts;
  }
  throw new Error('sync failed after ' + RETRY_LIMIT + ' attempts');
}

async function push(_items: string[], _timeout: number): Promise<boolean> {
  return true;
}
`,
  'queue.ts': `import { RETRY_LIMIT } from './config.ts';

export class Queue {
  private items: string[] = [];
  push(item: string) { this.items.push(item); }
  drain(): string[] { const out = this.items; this.items = []; return out; }
  get retryBudget() { return RETRY_LIMIT; }
}
`,
  'README.md': `# sync-probe

A tiny worker that pushes queued items to an endpoint and retries on failure.
`,
  '.claude/commands/probe-echo.md': `---
description: Echo the arguments back (schema probe fixture)
---

Repeat the following text back verbatim and say nothing else: $ARGUMENTS
`,
  // The description must be matchable by a natural request: attributionSkill is
  // written only when the MODEL picks the skill. Naming a slash command here
  // (the old wording) invited the one invocation path that attributes nothing.
  '.claude/skills/probe-skill/SKILL.md': `---
name: probe-skill
description: Use when the user asks for the probe marker word, or asks to run the probe skill. Replies with a fixed word.
---

Reply with exactly the word: probeskillok

Do nothing else.
`,
};

// Proof the model is REALLY streaming, taken from the TUI's own progress counter
// rather than from the text being generated.
//
// Two failures got us here. Waiting for the answer's words matched the TUI's echo
// of the typed PROMPT (it redraws it repeatedly), so Esc fired before the turn
// began — and an Esc with nothing to interrupt cancels the pending prompt. Asking
// the model to emit a unique marker instead just moved the fragility onto its
// obedience: haiku answered "1,2,3…" and the marker never appeared, so Esc landed
// after the turn had already finished. The token counter is written by Claude
// Code while it generates, whatever it generates.
const STREAMING = /↓\d+tokens/;

export interface SceneReport {
  scene: number;
  what: string;
  ran: boolean;
  note?: string;
}

/**
 * Run every scene against a live session, in order. Never throws: a scene that
 * cannot run is recorded as `ran: false`, which surfaces as UNPROVEN rather than
 * as a crash — a probe that dies mid-run teaches nothing about the schema.
 *
 * Scene 10 (`/compact`) is last on purpose: it rewrites the session.
 */
export async function runScenes(s: ProbeSession, log: (m: string) => void = () => {}): Promise<SceneReport[]> {
  const out: SceneReport[] = [];
  const scene = async (n: number, what: string, fn: () => Promise<void>) => {
    log(`  scene ${n}: ${what}`);
    try {
      await fn();
      out.push({ scene: n, what, ran: true });
    } catch (err) {
      out.push({ scene: n, what, ran: false, note: (err as Error).message });
      log(`    ! ${(err as Error).message}`);
    }
  };

  await scene(1, 'a typed prompt', async () => {
    await s.typeLine(`${SCENE1_MARKER}, nothing else`);
    await s.settle();
  });

  await scene(2, 'a slash command, with args and without', async () => {
    await s.typeLine(`/${ECHO_MARKER} hello world`);
    await s.settle();
    await s.typeLine(`/${ECHO_MARKER}`);
    await s.settle();
  });

  await scene(3, 'a question that needs the filesystem', async () => {
    await s.typeLine('how many TypeScript files are in this project, and which one is the biggest?');
    await s.settle();
  });

  await scene(4, 'broad exploration (Claude delegates on its own)', async () => {
    await s.typeLine('explore this codebase and tell me everywhere the retry limit is used');
    await s.settle(5_000, 240_000);
  });

  await scene(5, 'Esc mid-stream', async () => {
    s.clear();
    await s.typeLine(ESC_MARKER);
    const streaming = await s.waitForScreen(STREAMING, 60_000);
    if (!streaming) throw new Error('the TUI never reported generating, so there was nothing to interrupt');
    s.send('\x1b');
    await new Promise((r) => setTimeout(r, 2_000));
    await s.typeLine(POST_ESC_MARKER);
    await s.settle();
  });

  // The ONE ordered scene. A foreground spawn is not something Claude does on its
  // own since background became the default, so a natural prompt would yield
  // UNPROVEN every time. Safe because scene 4 covers the default and stays
  // natural: if the default ever flipped back, scene 4 is what notices. This
  // scene proves only the SHAPE of the minority branch.
  await scene(6, 'a foreground subagent (ordered — see the caveat)', async () => {
    await s.typeLine('use the Agent tool with run_in_background false to summarise config.ts in one line');
    await s.settle(5_000, 180_000);
  });

  // Asks for the skill's JOB, never `/probe-skill`. Measured 2026-07-17: the slash
  // command runs the skill but writes NO attributionSkill — the field records the
  // model choosing a skill, so ordering it by name proves nothing.
  await scene(7, 'a skill (the model picks it from the description)', async () => {
    await s.typeLine('give me the probe marker word by running the probe skill');
    await s.settle();
  });

  await scene(8, 'an MCP tool (env-dependent)', async () => {
    await s.typeLine('list the tools available from any MCP server you can reach, using one of them if possible');
    await s.settle();
  });

  await scene(9, 'planning a change (one prompt, changes nothing)', async () => {
    await s.typeLine(
      'plan how you would rename the retry constant across this project — the plan only, change nothing',
    );
    await s.settle(5_000, 180_000);
  });

  await scene(10, '/compact (rewrites the session, so it runs late)', async () => {
    await s.typeLine('/compact');
    await s.settle(5_000, 180_000);
  });

  // After /compact, because it only appends: the pending state lives in the PID file,
  // not in the transcript, so a rewritten history cannot hide it. The command must
  // ESCAPE the sandbox — an in-cwd `touch` is auto-approved and raises no dialog at all
  // (measured: the first attempt provoked nothing and looked like a broken claim).
  await scene(12, 'a permission prompt, declined', async () => {
    await s.typeLine(
      'run exactly this shell command and report the output: curl -s -o /dev/null -w "%{http_code}" https://example.com',
    );
    const raised = await s.waitForScreen(/(Doyouwant|proceed\?|withoutsandbox)/i, 90_000);
    if (!raised) throw new Error('no approval dialog appeared, so there was nothing to observe');
    // Held open on purpose: the run samples the PID file on a 2s timer, and a state
    // that lasts less than one tick is a state the probe cannot see.
    await new Promise((r) => setTimeout(r, 5_000));
    s.send('\x1b'); // decline — the refusal in the transcript is the ground truth
    await s.settle();
  });

  // Last, and it has to be: the state it provokes only exists while the TURN IS OVER and the
  // command is not — so the scene ends its turn on purpose and then waits, doing nothing, for the
  // run's 2-second sampler to see the PID file in that state. A shorter command than the wait, or
  // no wait at all, and the state passes between two samples and the claim reads UNPROVEN.
  //
  // The command must also be one the sandbox allows without a dialog, or scene 12's answer would
  // be needed again here.
  await scene(13, 'a background command that outlives its turn', async () => {
    await s.typeLine('run `sleep 45` with run_in_background true, then tell me only its task id');
    await s.settle(5_000, 120_000);
    // The turn has ended; the command has ~40s left. Five samples at 2s is plenty, and this is
    // dead time for the session, not for Claude — nothing is being generated.
    await new Promise((r) => setTimeout(r, 10_000));
  });

  return out;
}
