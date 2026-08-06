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
   * The synthetic scene this shot is photographed on (`scripts/doc-scenes.ts`). Absent means the
   * RECORDED session — a real one, replayed. A scene exists only for states no recording can
   * honestly produce: a failed call, a compaction, a corpus of sessions.
   */
  scene?: string;
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

if (import.meta.main) {
  const manifest = await readManifest();
  const stale = staleShots(await changedFiles(process.argv[2]), manifest);
  if (stale.length === 0) process.exit(0);
  console.error('');
  console.error(`⚠️  ${stale.length} doc shot(s) may be stale — the code they show changed:`);
  for (const shot of stale) {
    console.error(`    ${manifest.outDir}/${shot.id}.png — ${shot.subject}`);
  }
  console.error('    → re-cut them with `bun run doc-shots` (replays the saved bundle, costs no tokens)');
  console.error('');
}
