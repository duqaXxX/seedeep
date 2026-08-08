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
   * The synthetic scene this shot is photographed on (`scripts/doc-scenes.ts`). Absent means the
   * RECORDED session — a real one, replayed. A scene exists only for states no recording can
   * honestly produce: a failed call, a compaction, a corpus of sessions.
   */
  scene?: string;
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

  // Without --verify: the sources say these MAY be stale, which is all the scan can know.
  if (!wantVerify) {
    console.error('');
    console.error(`⚠️  ${stale.length} doc shot(s) may be stale — the code they show changed:`);
    for (const shot of stale) console.error(`    ${manifest.outDir}/${shot.id}.png — ${shot.subject}`);
    console.error('    → re-cut them with `bun run doc-shots` (replays the saved bundle, costs no tokens)');
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
