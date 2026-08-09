/**
 * Reports the doc shots a change has invalidated. A screenshot is a claim about the current UI with
 * no test behind it — the suite cannot notice one has gone false, and the docs gate reads text, not
 * pixels. This is the deterministic half: the manifest says which sources each shot depends on, so
 * "you changed that widget and did not re-cut its figure" is a FACT, not a judgement.
 *
 *   bun run doc-shots:check                 # against the working tree + index
 *   bun run doc-shots:check <git-range>     # e.g. origin/main..HEAD, for a hook or CI
 *
 * Warns, never blocks: a change under a mapped file can leave the picture identical. Silence is the
 * failure mode it exists to prevent, not a wrong verdict.
 */

import { join } from 'node:path';

/** One declared still: where it comes from, and what makes it stale. */
export interface DocShot {
  id: string;
  subject: string;
  cue: string;
  selector: string;
  /** Controls to click, in order, before the crop — a widget can sit behind a closed panel. */
  click?: string[];
  /** Text to type before the crop, for a surface whose subject IS the query (Search). */
  type?: { selector: string; text: string };
  /**
   * A selector that must be on screen before the crop. Some panels render their frame first and
   * their content after a fetch: the settings drawer was photographed empty, and being large it
   * sailed past the size floor.
   */
  waitFor?: string;
  /**
   * An element to scroll into view before the crop. A list the PRODUCT scrolls (the verdict list
   * is capped at 190px) otherwise gets photographed at its top, cutting the very row the caption
   * names in half. Scrolling is what a reader would do; widening the crop would show a panel the
   * product does not have.
   */
  scrollTo?: string;
  /**
   * The viewport height, in CSS px, this one shot is taken at. A fixed panel sizes itself from the
   * window and nothing else: the settings drawer is `height: 100%`, so at the run's 1150 it was
   * cropped with 45% of the figure empty under its last row. Only for those — everything that grows
   * with its content is photographed at the shared height.
   */
  viewportHeight?: number;
  /**
   * The synthetic scene this shot is photographed on (`scripts/doc-scenes.ts`). Absent means the
   * RECORDED session — a real one, replayed. A scene exists only for states no recording can
   * honestly produce: a failed call, a compaction, a corpus of sessions.
   */
  scene?: string;
  /**
   * The posture the SERVER is photographed in. Absent means the default — loopback, no TLS, no
   * token — which is how every install starts and what every other figure shows. Naming a host is
   * the only way to photograph the other half of the settings panel: the TLS block and the
   * fingerprint come from the running process, so no click on the form can produce them. The
   * common name is what the throwaway certificate is issued for, and it is the host the panel
   * then prints in its access URL — so it must be SYNTHETIC, never the machine's own name.
   */
  server?: { host: string; commonName: string };
  /**
   * This figure's content moves on its own, so two cuts of the SAME code differ and no comparison
   * can decide it. Only the NOW panel's relative age does this today (`4444m ago` became
   * `4775m ago` between two runs), and marking it is what keeps `--verify` from needing a
   * tolerance — a threshold wide enough to absorb a ticking number is wide enough to hide a
   * changed label. A volatile figure the dependency scan flags is reported for a human to look at.
   */
  volatile?: boolean;
  invalidatedBy: string[];
}

/** The manifest as it sits in `apps/server/data/doc-shots.json`. */
export interface DocShotManifest {
  usedIn: string;
  outDir: string;
  shots: DocShot[];
}

export const MANIFEST_PATH = 'apps/server/data/doc-shots.json';

/** Reads and parses the shot manifest, relative to the repo root. */
export async function readManifest(root = process.cwd()): Promise<DocShotManifest> {
  return (await Bun.file(join(root, MANIFEST_PATH)).json()) as DocShotManifest;
}

/**
 * The shots whose sources changed while their own PNG did not — i.e. the figures that now claim
 * something the code may no longer do. Pure, so the rule itself is testable without a git repo.
 */
export function staleShots(changed: readonly string[], manifest: DocShotManifest): DocShot[] {
  const touched = new Set(changed);
  return manifest.shots.filter((shot) => {
    const png = `${manifest.outDir}/${shot.id}.png`;
    if (touched.has(png)) return false; // re-cut in this same change: in sync
    return shot.invalidatedBy.some((src) => touched.has(src));
  });
}

/** What a verification run needs from the world: re-cutting figures, and reading bytes. */
export interface VerifyDeps {
  /** Re-cut exactly these ids into `outDir`. Throws when the whole group cannot be cut. */
  cut: (ids: string[], outDir: string) => Promise<void>;
  /** A file's bytes, or null when it is not there. */
  bytes: (path: string) => Promise<Uint8Array | null>;
}

/**
 * Decide, per shot, whether its PICTURE changed: `VOLATILE`/`SAME`/`DIFFERS`/`UNCUT`, in that order
 * of precedence. Returns the verdict lines and the failures worth printing beside them — the
 * printing itself belongs to the caller, which is what makes the rule testable at all.
 *
 * Two properties here are the whole point, and both were once broken in the real thing:
 * a group that cannot be re-cut (the recorded bundle is gone) must not take the OTHER groups down
 * with it, and a shot that was not re-cut is `UNCUT` — never quietly absent, which reads as clean.
 */
export async function verifyVerdicts(
  shots: readonly DocShot[],
  outDir: string,
  publishedDir: string,
  deps: VerifyDeps,
): Promise<{ lines: string[]; errors: string[] }> {
  const lines: string[] = [];
  const errors: string[] = [];
  const comparable = shots.filter((s) => !s.volatile);
  for (const s of shots) if (s.volatile) lines.push(`VOLATILE ${s.id}`);
  if (comparable.length === 0) return { lines, errors };

  // By GROUP, each guarded on its own: the recorded shots need a bundle the OS may have deleted,
  // and one missing bundle must not lose the scene shots too.
  const groups = new Map<string, DocShot[]>();
  for (const s of comparable) groups.set(s.scene ?? 'recorded', [...(groups.get(s.scene ?? 'recorded') ?? []), s]);
  for (const group of groups.values()) {
    await deps
      .cut(
        group.map((s) => s.id),
        outDir,
      )
      .catch((e: unknown) => errors.push(e instanceof Error ? e.message : String(e)));
  }

  for (const s of comparable) {
    const fresh = await deps.bytes(`${outDir}/${s.id}.png`);
    if (!fresh) {
      lines.push(`UNCUT ${s.id}`);
      continue;
    }
    const published = await deps.bytes(`${publishedDir}/${s.id}.png`);
    const same = published !== null && published.length === fresh.length && fresh.every((v, i) => v === published[i]);
    lines.push(`${same ? 'SAME' : 'DIFFERS'} ${s.id}`);
  }
  return { lines, errors };
}

/** The files a git range (or the working tree, when no range is given) touches. */
async function changedFiles(range: string | undefined): Promise<string[]> {
  const args = range ? ['diff', '--name-only', range] : ['diff', '--name-only', 'HEAD'];
  const p = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'ignore' });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.split('\n').filter(Boolean);
}

/**
 * Ask the pictures themselves which of these candidates actually changed.
 *
 * The dependency map is deliberately coarse — every figure declares `client/graph.ts`, so any edit
 * to that file names all fourteen — and a warning that fires when nothing is wrong is one people
 * learn to scroll past. Re-cutting costs a browser run, so it is spent only on the shots the cheap
 * scan already suspects, and only when asked.
 *
 * Returns the ones still worth reporting, each with WHY: the picture differs, or it could not be
 * compared at all. Never narrows silently — if the verification cannot run, everything it was
 * given comes back unverified.
 */
async function verify(stale: readonly DocShot[]): Promise<Map<string, 'DIFFERS' | 'VOLATILE' | 'UNCUT'>> {
  const out = new Map<string, 'DIFFERS' | 'VOLATILE' | 'UNCUT'>();
  const p = Bun.spawn(
    ['bun', 'run', 'apps/server/scripts/capture-demo.ts', 'doc-shots-verify', stale.map((s) => s.id).join(',')],
    { stdout: 'pipe', stderr: 'ignore' },
  );
  const text = await new Response(p.stdout).text();
  await p.exited;
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const [verdict, id] = line.trim().split(/\s+/);
    if (!id) continue;
    seen.add(id);
    if (verdict === 'DIFFERS' || verdict === 'VOLATILE' || verdict === 'UNCUT') out.set(id, verdict);
  }
  // Anything the verifier did not answer for is unverified, never verified-clean.
  for (const s of stale) if (!seen.has(s.id)) out.set(s.id, 'UNCUT');
  return out;
}

const WHY: Record<'DIFFERS' | 'VOLATILE' | 'UNCUT', string> = {
  DIFFERS: 'the picture CHANGED',
  VOLATILE: 'its content moves on its own — look at it',
  UNCUT: 'could not be re-cut, so nothing checked it',
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const wantVerify = args.includes('--verify');
  const manifest = await readManifest();
  const stale = staleShots(await changedFiles(args.find((a) => a !== '--verify')), manifest);
  if (stale.length === 0) process.exit(0);

  // Without --verify these are CANDIDATES, not stale figures, and the wording says so: the map is
  // per-FILE, and `client/graph.ts` draws every widget there is, so one edit anywhere in it names
  // 15 of the 20. Measured on the change that prompted this wording: 20 re-cut, 18 byte-identical.
  // A warning that is wrong nine times in ten is one you learn to scroll past, so it asks for the
  // judgement it actually needs — did what this figure SHOWS change? — instead of announcing a
  // staleness it cannot know.
  if (!wantVerify) {
    console.error('');
    console.error(`ℹ️  ${stale.length} doc figure(s) depend on files this change touched — candidates, not verdicts:`);
    for (const shot of stale) console.error(`    ${manifest.outDir}/${shot.id}.png — ${shot.subject}`);
    console.error('    → if what one of them SHOWS changed, re-cut with `bun run doc-shots` (no tokens).');
    console.error('    → the pixels decide: `bun run doc-shots:check --verify` re-cuts and compares (minutes).');
    console.error('');
    process.exit(0);
  }

  const verdicts = await verify(stale);
  const report = stale.filter((s) => verdicts.has(s.id));
  const same = stale.length - report.length;
  if (report.length === 0) {
    if (same > 0) console.error(`✓  ${same} doc shot(s) depend on what changed; re-cut, all identical.`);
    process.exit(0);
  }
  console.error('');
  console.error(`⚠️  ${report.length} doc shot(s) need a look${same ? ` (${same} others re-cut identical)` : ''}:`);
  for (const shot of report) {
    console.error(`    ${manifest.outDir}/${shot.id}.png — ${WHY[verdicts.get(shot.id)!]} — ${shot.subject}`);
  }
  console.error('    → re-cut them with `bun run doc-shots` (replays the saved bundle, costs no tokens)');
  console.error('');
}
