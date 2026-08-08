/**
 * The scenes in `scripts/doc-scenes.ts` exist to be PHOTOGRAPHED, and a figure is published as what
 * the product does. So the scenes are driven through the REAL parser and the REAL reducer here, and
 * each one is asserted to produce the state its figure claims.
 *
 * Without this, a wrong field name would not draw a wrong picture — it would draw an empty one, and
 * the only reader who could catch it is the one who already knows what should have been there. The
 * capture's own guards (a crop under 200x60, a selector that matches nothing) catch the crude cases;
 * this catches "the line was parsed but meant nothing".
 */

import { describe, expect, test } from 'bun:test';
import { SCENES, slugOf } from '../scripts/doc-scenes.ts';
import { windowFor } from '../src/core/context-windows.ts';
import { backgroundCommands } from '../src/core/selectors.ts';
import { createSessionTree } from '../src/core/session-tree.ts';
import type { NormalizedEvent } from '../src/core/types.ts';
import { computeVerdict, turnBillable } from '../src/core/verdict.ts';
import { parseLine } from '../src/server/parser.ts';

/**
 * Run a scene exactly as the live pipeline does — parent transcript first, then each child's own
 * file with its `agentId`. Feeding only the parent would hide half the state: a subagent's returned
 * length lives in ITS transcript, and that is the number the verdict's wasted-subagent check reads.
 */
function snapshotOf(
  lines: string[],
  sessionId: string,
  children: Record<string, { lines: string[] }> = {},
  mainModel = 'claude-opus-5',
) {
  const tree = createSessionTree({ windowFor, mainModel });
  let seq = 0;
  for (const l of lines) {
    for (const e of parseLine(l, { sessionId, root: 'cli' as const, agentId: null, seq: seq++ }) as NormalizedEvent[])
      tree.apply(e);
  }
  for (const [agentId, child] of Object.entries(children)) {
    for (const l of child.lines) {
      for (const e of parseLine(l, { sessionId, root: 'cli' as const, agentId, seq: seq++ }) as NormalizedEvent[])
        tree.apply(e);
    }
  }
  return tree.snapshot();
}

describe('slugOf', () => {
  test('matches how Claude Code names a project directory', () => {
    expect(slugOf('/tmp/orbit')).toBe('-tmp-orbit');
  });
});

describe('every scene parses into something', () => {
  for (const [id, build] of Object.entries(SCENES)) {
    test(`${id}: no line is dropped in silence`, () => {
      const scene = build();
      const ctx = { sessionId: scene.sessionId, root: 'cli' as const, agentId: null };
      const dropped = scene.lines
        .filter((l, i) => (parseLine(l, { ...ctx, seq: i }) as NormalizedEvent[]).length === 0)
        // The one legitimate exception: a `local-command-stdout` line is the RECEIPT of a slash
        // command, and the command's own line is what opened the entry. The parser having nothing
        // to say about it is correct — everything else dropping means a wrong shape.
        .filter((l) => !l.includes('local-command-stdout'));
      expect(dropped).toEqual([]);
    });
  }
});

describe('busy-day — the timeline, the verdict, the compaction, the skills', () => {
  const scene = SCENES['busy-day']!();
  const snap = snapshotOf(scene.lines, scene.sessionId, scene.children);

  test('five entries on the timeline, of four different kinds', () => {
    // The figure's whole subject: a strip with ONE column teaches nothing.
    expect(snap.turnList.length).toBeGreaterThanOrEqual(5);
    const kinds = new Set(snap.turnList.map((t) => t.kind));
    expect(kinds.size).toBeGreaterThanOrEqual(3);
  });

  test('one turn was interrupted, so the strip has its red column', () => {
    expect(snap.turnList.some((t) => t.state === 'interrupted')).toBe(true);
  });

  test('a local command cost nothing, so the strip has its grey column', () => {
    expect(snap.turnList.some((t) => turnBillable(t) === 0)).toBe(true);
  });

  test('at least one turn is flagged wasteful — the Verdict lens needs one', () => {
    const flagged = snap.turnList.filter((t) => computeVerdict(t, snap).findings.length > 0);
    expect(flagged.length).toBeGreaterThanOrEqual(1);
  });

  test('the compaction is seen, with the sizes it went between', () => {
    expect(snap.compactions.length).toBeGreaterThanOrEqual(1);
    expect(snap.compactions[0]?.pre).toBe(191_400);
  });

  test('the Skills card has a skill, and the Commands card has commands', () => {
    expect(snap.skills.length).toBeGreaterThanOrEqual(1);
    expect(snap.commands.length).toBeGreaterThanOrEqual(2);
  });

  test('a failed tool is recorded as failed — that badge is a figure of its own', () => {
    expect(snap.mainTools.some((t) => t.error === true)).toBe(true);
  });

  test('the subagent returned more than the verdict tolerates — 5,000 chars', () => {
    // `outLen` comes from the child's OWN transcript, which is also what the drawer shows as
    // "RETURNED TO MAIN". `returned` stays null here because it is linked through the meta file the
    // watcher reads from disk, and this test has no disk — the capture does.
    expect(snap.subagents.some((a) => a.outLen > 5_000)).toBe(true);
  });
});

describe('broken — the state that cannot be provoked', () => {
  const scene = SCENES['broken']!();
  const snap = snapshotOf(scene.lines, scene.sessionId);

  test('the session reads as broken, from the last call', () => {
    expect(snap.error).not.toBeNull();
  });

  test('the message the user was shown is the one the figure will carry', () => {
    expect(snap.error?.message).toContain('session limit');
  });
});

describe('corpus — five sessions, so a ranking has something to rank', () => {
  const scene = SCENES['corpus']!();

  test('five sessions in all, on three different models', () => {
    const all = [{ cwd: scene.cwd, sessionId: scene.sessionId, lines: scene.lines }, ...(scene.archive ?? [])];
    expect(all.length).toBe(5);
    // Flattened, not `models[0]`: the first entry is the model the tree was SEEDED with, so
    // reading only that says the same thing five times.
    const models = new Set(all.flatMap((s) => snapshotOf(s.lines, s.sessionId).main.models));
    expect(models.size).toBeGreaterThanOrEqual(3);
  });

  test('they differ in weight, or the leaderboard is a flat list', () => {
    const all = [{ cwd: scene.cwd, sessionId: scene.sessionId, lines: scene.lines }, ...(scene.archive ?? [])];
    const totals = all.map((s) => {
      const snap = snapshotOf(s.lines, s.sessionId);
      return snap.turnList.reduce((sum, t) => sum + turnBillable(t), 0);
    });
    expect(Math.max(...totals)).toBeGreaterThan(Math.min(...totals) * 2);
  });

  test('every session says the shared phrase, which is what Search will rank', () => {
    const all = [{ cwd: scene.cwd, sessionId: scene.sessionId, lines: scene.lines }, ...(scene.archive ?? [])];
    for (const s of all) expect(s.lines.some((l) => l.includes('503 spike'))).toBe(true);
  });
});

// The figure this scene exists for is the bottom card with BOTH catalogues filled — the state that
// makes it grow its two tabs. Every claim the picture makes is asserted here, because a wrong field
// name would not draw a wrong picture: it would draw an empty one.
describe('the commands scene', () => {
  const scene = SCENES.commands!();
  const snap = snapshotOf(scene.lines, scene.sessionId, scene.children ?? {});

  test('both catalogues have something, which is what puts the tabs on the card', () => {
    // The two SPAWNS, by the intent each was launched with. The count of `subagents` is not the
    // assertion: this helper feeds transcripts only, and the agentId → spawn link lives in the
    // `.meta.json` sidecar that the capture writes and the server reads — without it each child
    // also appears under its own bare id. What the figure needs is that both spawns parsed and
    // both catalogues are non-empty.
    expect(
      snap.subagents
        .filter((a) => a.toolUseId !== null)
        .map((a) => a.title)
        .sort(),
    ).toEqual(['Check the docs against the code', 'Review the diff for correctness']);
    expect(backgroundCommands(snap.mainTools, { ended: false }).length).toBe(5);
  });

  test('the commands carry every state the figure shows', () => {
    const byState = backgroundCommands(snap.mainTools, { ended: false }).reduce<Record<string, number>>((acc, c) => {
      acc[c.state] = (acc[c.state] ?? 0) + 1;
      return acc;
    }, {});
    // Two clean, two failed, and one nothing ever reported — the last is what 8% of real launches do.
    expect(byState).toEqual({ done: 2, failed: 2, running: 1 });
  });

  test('a failed row can state its exit code and its real duration, or the picture says nothing', () => {
    const failed = backgroundCommands(snap.mainTools, { ended: false }).filter((c) => c.state === 'failed');
    for (const c of failed) {
      expect(c.sentence).toMatch(/exit code \d+/);
      expect(c.ranMs).toBeGreaterThan(0);
      expect(c.outputFile).toMatch(/tasks\/.+\.output$/);
      // The label is the launch's own description, not the shell one-liner: that is what the row
      // shows, and what Claude Code quotes back in the sentence beside it.
      expect(c.sentence).toContain(c.label);
    }
  });
});
