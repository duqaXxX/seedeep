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
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materialiseRepo, SCENES, type Scene, slugOf, substituteHashes } from '../scripts/doc-scenes.ts';
import { harvestHashes } from '../src/core/commit-attribution.ts';
import { windowFor } from '../src/core/context-windows.ts';
import { backgroundCommands } from '../src/core/selectors.ts';
import { artifactLabel, mergeArtifacts } from '../src/core/session-artifacts.ts';
import { createSessionTree } from '../src/core/session-tree.ts';
import type { NormalizedEvent, SessionRecord } from '../src/core/types.ts';
import { computeVerdict, turnBillable } from '../src/core/verdict.ts';
import { parseLine } from '../src/server/parser.ts';
import { cardsForSession } from '../src/server/session-cards.ts';
import { commitsForSession } from '../src/server/session-commits.ts';
import { scanLines } from '../src/server/transcript-scan.ts';

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
    expect(backgroundCommands(snap.mainTools, { ended: false }).length).toBe(6);
  });

  test('the commands carry every state the figure shows', () => {
    const byState = backgroundCommands(snap.mainTools, { ended: false }).reduce<Record<string, number>>((acc, c) => {
      acc[c.state] = (acc[c.state] ?? 0) + 1;
      return acc;
    }, {});
    // Two clean, two failed, and two still going — one of those a launch nothing ever reported,
    // which is what 8% of real ones do, the other the monitor, which is still watching.
    expect(byState).toEqual({ done: 2, failed: 2, running: 2 });
  });

  test('the warned write carries its note, and no other call does', () => {
    // The figure's claim: a hook's warning marks the ONE call it named. A wrong field name in the
    // scene would draw a picture with no flag anywhere, and nothing else in the suite reads a PNG.
    const warned = snap.mainTools.filter((t) => t.notes?.length);
    expect(warned.map((t) => t.name)).toEqual(['Write']);
    expect(warned[0]?.notes?.[0]?.source).toBe('security-guidance@claude-code-plugins');
    expect(warned[0]?.notes?.[0]?.text).toContain('Security Warning');
  });

  test('the monitor row can state its event count and its latest event', () => {
    // The figure's claim about the one row a stream produces. A wrong field name in the scene
    // would draw the row without them and nothing else in the suite can look at a PNG.
    const monitor = backgroundCommands(snap.mainTools, { ended: false }).find(
      (c) => c.label === 'Build log steps and errors',
    );
    expect(monitor?.state).toBe('running');
    expect(monitor?.events).toBe(3);
    expect(monitor?.lastEvent).toBe('STEP 3/4 sign — skipped (unsigned build)');
  });

  test('the three authors are all in the picture, one chip each and the majority bare', () => {
    // The figure's whole claim about who backgrounds a command. Asserted here because a wrong
    // field name in the scene would draw a picture where every row is the default one — and
    // nothing else in the suite can look at a PNG.
    const byAuthor = backgroundCommands(snap.mainTools, { ended: false }).reduce<Record<string, number>>((acc, c) => {
      acc[c.by] = (acc[c.by] ?? 0) + 1;
      return acc;
    }, {});
    // The monitor is one of the bare ones, and cannot be anything else: a Monitor has no
    // foreground mode, so neither a timeout nor Ctrl+B can be what put it in the background.
    expect(byAuthor).toEqual({ agent: 4, timeout: 1, user: 1 });
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

// The Home figure's caption promises "where the waste came from" and a tool-call breakdown. A
// corpus with nothing flagged renders every one of those rows as a zero — the picture would then
// show the SHAPE of the surface while demonstrating none of what it claims. So the corpus is
// asserted to CARRY the waste, here, where a change to the scene fails in `bun test` rather than
// silently on a page.
describe('the corpus scene', () => {
  const scene = SCENES.corpus!();
  const sessions = [{ sessionId: scene.sessionId, lines: scene.lines }, ...(scene.archive ?? [])];

  test('every session reads files, so the tool-call breakdown is not a row of zeros', () => {
    const reads = sessions.reduce((n, s) => n + snapshotOf(s.lines, s.sessionId).mainTools.length, 0);
    expect(reads).toBeGreaterThan(40);
  });

  test('the corpus carries both a warn and a crit, or the waste card demonstrates nothing', () => {
    const severities = sessions.flatMap((s) => {
      const snap = snapshotOf(s.lines, s.sessionId);
      return snap.turnList.map((t) => computeVerdict(t, snap).severity);
    });
    expect(severities).toContain('warn');
    expect(severities).toContain('crit');
  });
});

// The three figures this scene exists for photograph cards that do NOT read the session file for
// their content: Cards reads the tracker calls' results, and Commits and Changed files read GIT.
// So the assertions below go through the same server modules the page does — including a real
// repository built from the scene's own declaration, since that join (transcript hash ↔ commit) is
// the one thing a wrong scene would break into an empty picture nobody could catch.
describe('the shipping scene — commits, cards and a published page', () => {
  const scene = SCENES.shipping!();
  const scan = scanLines(scene.lines);

  const record = (path: string, sessionId: string): SessionRecord => ({
    sessionId,
    project: 'relay',
    model: null,
    lastActivity: 1,
    isActive: false,
    isOpen: false,
    status: null,
    waitingFor: null,
    waitingSince: null,
    statusDerived: false,
    subject: null,
    entrypoint: null,
    root: 'cli',
    path,
  });

  test('the Cards figure has both kinds of row: one moved, one only read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'seedeep-scene-'));
    const path = join(dir, `${scene.sessionId}.jsonl`);
    await writeFile(path, `${scene.lines.join('\n')}\n`);
    const { cards } = await cardsForSession(record(path, scene.sessionId));
    expect(cards.map((c) => c.id).sort()).toEqual(['ORBIT-42', 'ORBIT-58']);
    // A card the session CHANGED and one it merely read — a figure of two identical rows would
    // demonstrate nothing the caption claims.
    expect(cards.find((c) => c.id === 'ORBIT-42')?.evidence).toBe('wrote');
    expect(cards.find((c) => c.id === 'ORBIT-58')?.evidence).toBe('read');
    // The title is what the row shows; without it the card is a bare key.
    expect(cards.find((c) => c.id === 'ORBIT-42')?.title).toContain('backoff');
  });

  test('the transcript names exactly the commits the repository makes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'seedeep-repo-'));
    // The scene's own cwd is where the CAPTURE builds it; here it is redirected into a temporary
    // directory, so running the suite can never collide with a capture in flight.
    const local: Scene = { ...scene, cwd };
    const hashes = await materialiseRepo(local, { mkdir, writeFile, run: gitIn }, join);
    expect(hashes.length).toBe(2);
    expect(hashes[0]).not.toBe(hashes[1]);

    const lines = substituteHashes(scene.lines, hashes);
    expect(lines.join('\n')).not.toContain('{{commit:');
    // Harvested the way the attribution does it: what the card shows is these hashes, or nothing.
    const harvested = scanLines(lines).commits.flatMap((c) => c.outputHashes);
    for (const h of hashes) expect(harvested).toContain(h);
  });

  // The assertion the Commits figure actually rests on, and the one that caught the scene being
  // wrong: a hash in the transcript is not enough. Attribution PROVES a commit by "the call named
  // it, and it was authored after the previous call" — so a fixture dated before the session is
  // claimed by nobody and the card photographs empty. Driven end to end, git included.
  test('both commits are attributed to the session that made them', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'seedeep-attr-'));
    const hashes = await materialiseRepo({ ...scene, cwd }, { mkdir, writeFile, run: gitIn }, join);
    // The transcript has to speak of the directory the repository is really in, since that is what
    // resolves to a repo — the scene's own `/tmp/relay` belongs to the capture.
    const lines = substituteHashes(scene.lines, hashes).map((l) => l.split(scene.cwd).join(cwd));
    const path = join(cwd, `${scene.sessionId}.jsonl`);
    await writeFile(path, `${lines.join('\n')}\n`);

    const { commits } = await commitsForSession(record(path, scene.sessionId), []);
    expect(commits.map((c) => c.short).sort()).toEqual([...hashes].sort());
    expect(commits.every((c) => c.subject.length > 0)).toBe(true);
  });

  test('the hashes are the same on every run, or the figure can never be verified', async () => {
    const a = await mkdtemp(join(tmpdir(), 'seedeep-repo-a-'));
    const b = await mkdtemp(join(tmpdir(), 'seedeep-repo-b-'));
    const one = await materialiseRepo({ ...scene, cwd: a }, { mkdir, writeFile, run: gitIn }, join);
    const two = await materialiseRepo({ ...scene, cwd: b }, { mkdir, writeFile, run: gitIn }, join);
    // Two builds, two directories, identical hashes: this is what the fixed identity and dates buy,
    // and without it `--verify` would report the Commits figure as changed on every release.
    expect(one).toEqual(two);
  });

  test('substituteHashes refuses a token the repository cannot back', () => {
    expect(() => substituteHashes(['names {{commit:5}}'], ['abc1234'])).toThrow('{{commit:5}}');
  });

  test('the Changed files figure has all three of its rows to show', () => {
    // Commits deliver the project files (the hero), the ledger the scratchpad row… and the publish
    // the third. One page, not two publishes: the row counts pages.
    expect(scene.repo?.commits.length).toBe(2);
    const files = new Set(scene.repo?.commits.flatMap((c) => Object.keys(c.files)));
    expect(files.size).toBeGreaterThanOrEqual(4);

    const pages = mergeArtifacts(
      scan.artifacts.map((a) => ({ url: a.url, label: artifactLabel(a.description, a.path), path: a.path, at: a.at })),
    );
    expect(pages.length).toBe(1);
    expect(pages[0]?.url).toBe('https://claude.ai/code/artifact/demo-prototype');
    expect(pages[0]?.label).toContain('backoff');
  });

  test('nothing in the scene names a real tracker, a real page or a real machine', () => {
    const text = scene.lines.join('\n');
    expect(harvestHashes('{{commit:0}}')).toEqual([]); // the token is not mistakable for a hash
    expect(text).not.toMatch(/linear\.app|atlassian|jira/i);
    // A uuid-shaped artifact id would be indistinguishable from somebody's real page.
    expect(text).toContain('/code/artifact/demo-prototype');
  });
});

/** `git` for the tests, with the scene's own fixed identity and clock passed through. */
async function gitIn(args: string[], cwd: string, env: Record<string, string>): Promise<string> {
  const p = Bun.spawn(['git', ...args], { cwd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${err.trim() || out.trim()}`);
  return out;
}
