/**
 * The staleness rule is the only thing standing between a code change and a figure that quietly
 * lies — nothing else in the suite can look at a PNG. So the rule itself is tested, and the manifest
 * is checked against the repo: a shot mapped to a file that no longer exists is a shot that can
 * never be reported stale again.
 */

import { describe, expect, test } from 'bun:test';
import { hostname } from 'node:os';
import {
  type DocShot,
  type DocShotManifest,
  readManifest,
  staleShots,
  verifyVerdicts,
} from '../scripts/doc-shots-check.ts';

const manifest: DocShotManifest = {
  usedIn: 'docs/features.md',
  outDir: 'docs/assets/shots',
  shots: [
    {
      id: 'alpha',
      subject: 'the alpha widget',
      cue: 'end',
      selector: '.alpha',
      invalidatedBy: ['src/alpha.ts', 'css/alpha.css'],
    },
    {
      id: 'beta',
      subject: 'the beta widget',
      cue: 'end',
      selector: '.beta',
      invalidatedBy: ['src/beta.ts'],
    },
  ],
};

describe('staleShots', () => {
  test('a shot whose source changed is reported', () => {
    expect(staleShots(['src/alpha.ts'], manifest).map((s) => s.id)).toEqual(['alpha']);
  });

  test('the CSS of a widget counts as its source — a layout-only change still moves the picture', () => {
    expect(staleShots(['css/alpha.css'], manifest).map((s) => s.id)).toEqual(['alpha']);
  });

  test('a shot re-cut in the same change is in sync, not stale', () => {
    expect(staleShots(['src/alpha.ts', 'docs/assets/shots/alpha.png'], manifest)).toEqual([]);
  });

  test('an unrelated change reports nothing', () => {
    expect(staleShots(['README.md', 'src/gamma.ts'], manifest)).toEqual([]);
  });

  test('one change can invalidate several shots', () => {
    expect(staleShots(['src/alpha.ts', 'src/beta.ts'], manifest).map((s) => s.id)).toEqual(['alpha', 'beta']);
  });

  test('re-cutting one shot does not excuse the other', () => {
    const changed = ['src/alpha.ts', 'src/beta.ts', 'docs/assets/shots/beta.png'];
    expect(staleShots(changed, manifest).map((s) => s.id)).toEqual(['alpha']);
  });
});

describe('the real manifest', () => {
  test('every mapped source exists, or the shot can never be reported stale', async () => {
    const real = await readManifest();
    const missing: string[] = [];
    for (const shot of real.shots) {
      for (const src of shot.invalidatedBy) {
        if (!(await Bun.file(src).exists())) missing.push(`${shot.id} → ${src}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test('every declared shot is actually used, and every figure used is declared', async () => {
    // Both halves fail silently otherwise: a shot nobody embeds is a PNG cut on every run for
    // nothing, and a figure nobody declares is one the staleness check can never report.
    const real = await readManifest();
    const doc = await Bun.file(real.usedIn).text();
    const used = new Set(
      [...doc.matchAll(new RegExp(`${real.outDir.replace('docs/', '')}/([a-z0-9-]+)\\.png`, 'g'))]
        .map((m) => m[1])
        .filter((id): id is string => id !== undefined),
    );
    const declared = real.shots.map((s) => s.id);
    expect(declared.filter((id) => !used.has(id))).toEqual([]);
    expect([...used].filter((id) => !declared.includes(id))).toEqual([]);
  });

  test('every shot declares what it must contain, or nothing can tell a wrong figure from a right one', async () => {
    // `waitFor` is the only place a figure states its own subject in a form the run can CHECK, and
    // an unmet one now fails. That protection is worth exactly as much as the declarations exist:
    // a shot without one is photographed whenever the page happens to be there, and the three
    // faults this rule came from were all figures of a state that never happened — subagents that
    // had finished but showed as running, a Trace with no child data, a list with nothing indented.
    // Not one of them was visible to the suite; only to a person looking at the picture.
    const real = await readManifest();
    expect(real.shots.filter((s) => !s.waitFor).map((s) => s.id)).toEqual([]);
  });

  test('a posture is synthetic and has a scene of its own', async () => {
    // Two ways this one goes wrong, and neither is visible in the picture it produces. A posture on
    // a RECORDED shot would apply to every figure of that bundle, because they share one server —
    // the run throws, but only after the build. And the common name is what the panel PRINTS in its
    // access URL, so the machine's own name would be published by a figure nobody re-reads.
    const real = await readManifest();
    for (const shot of real.shots.filter((s) => s.server)) {
      expect(shot.scene, `${shot.id}: a posture needs a scene`).toBeString();
      expect(shot.server!.commonName).toMatch(/^[a-z0-9-]+\.local$/);
      expect(shot.server!.commonName.toLowerCase()).not.toBe(hostname().toLowerCase());
    }
  });

  test('ids are unique and file-safe, since each one names a PNG', async () => {
    const real = await readManifest();
    const ids = real.shots.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });
});

/**
 * Sections without a figure are allowed, but only ON PURPOSE. Each one names the reason here, so a
 * NEW section arrives with neither a figure nor an excuse and this test fails — which is the only
 * moment anybody would notice. Nothing else can: the manifest is a declaration, and a surface that
 * was never declared makes no noise at all.
 *
 * To add a section without a figure, add it here with why. To add one WITH a figure, declare the
 * shot in `doc-shots.json`, run `bun run doc-shots`, and embed it.
 */
const SECTIONS_WITHOUT_A_FIGURE: Record<string, string> = {
  'The engine underneath': 'describes the watcher, the server and the shell — internals, with no surface to crop',
};

describe('docs/features.md — a figure per surface', () => {
  test('every section either carries a figure or is listed as deliberately without one', async () => {
    const real = await readManifest();
    const doc = await Bun.file(real.usedIn).text();
    // Split on `## ` headings only: a `###` belongs to the section above it, and its figure counts
    // for that section — the live session view is one surface explained in six parts.
    const parts = doc.split(/^## /m).slice(1);
    const bare: string[] = [];
    for (const part of parts) {
      const title = (part.split('\n')[0] ?? '').trim();
      const hasFigure = /!\[[^\]]*\]\(assets\/|<img src="assets\//.test(part);
      if (!hasFigure && !(title in SECTIONS_WITHOUT_A_FIGURE)) bare.push(title);
    }
    expect(bare).toEqual([]);
  });

  test('the exemption list has no dead entries — a renamed or illustrated section loses its excuse', async () => {
    // Two ways an entry dies, and both must fail rather than linger: the section was renamed (so the
    // exemption now covers nothing and the real section slipped through), or it finally got its
    // figure (so a PENDING note is stale, and stale notes are how a temporary excuse becomes
    // permanent).
    const real = await readManifest();
    const doc = await Bun.file(real.usedIn).text();
    const sections = new Map(
      doc
        .split(/^## /m)
        .slice(1)
        .map((p) => [(p.split('\n')[0] ?? '').trim(), p] as const),
    );
    const dead: string[] = [];
    for (const listed of Object.keys(SECTIONS_WITHOUT_A_FIGURE)) {
      const body = sections.get(listed);
      if (body === undefined) dead.push(`${listed} — no such section`);
      else if (/!\[[^\]]*\]\(assets\/|<img src="assets\//.test(body)) dead.push(`${listed} — has a figure now`);
    }
    expect(dead).toEqual([]);
  });
});

/**
 * The verifier is what turns "these figures MAY be stale" into "this one changed", and until now
 * nothing ran it. Its two real defects were both found by running it and neither by reading it: an
 * absolute temp path joined onto the cwd, which wrote a directory of PNGs INTO the repo, and one
 * missing bundle making it give up on the scene figures too. Both are shapes these fakes reproduce.
 */
describe('verifyVerdicts', () => {
  const shot = (id: string, extra: Partial<DocShot> = {}): DocShot => ({
    id,
    subject: `the ${id} widget`,
    cue: 'end',
    selector: `.${id}`,
    invalidatedBy: [`src/${id}.ts`],
    ...extra,
  });
  const PUBLISHED = '/pub';
  const FRESH = '/fresh';
  /** A world made of paths and bytes: what was published, and what a re-cut would produce. */
  const world = (published: Record<string, string>, recut: Record<string, string>, fail?: string) => {
    const files = new Map<string, Uint8Array>();
    for (const [id, body] of Object.entries(published)) files.set(`${PUBLISHED}/${id}.png`, Buffer.from(body));
    const cutWith: Array<{ ids: string[]; outDir: string }> = [];
    return {
      cutWith,
      deps: {
        cut: async (ids: string[], outDir: string) => {
          cutWith.push({ ids, outDir });
          if (fail && ids.includes(fail)) throw new Error('no transcript lines — run `record` first');
          for (const id of ids) {
            const body = recut[id];
            if (body !== undefined) files.set(`${outDir}/${id}.png`, Buffer.from(body));
          }
        },
        bytes: async (path: string) => files.get(path) ?? null,
      },
    };
  };

  test('a figure that re-cuts to the same bytes is SAME', async () => {
    const w = world({ alpha: 'pixels' }, { alpha: 'pixels' });
    const { lines } = await verifyVerdicts([shot('alpha')], FRESH, PUBLISHED, w.deps);
    expect(lines).toEqual(['SAME alpha']);
  });

  test('one byte of difference is DIFFERS — no tolerance, or a moved label hides inside it', async () => {
    const w = world({ alpha: 'pixels' }, { alpha: 'pixelt' });
    const { lines } = await verifyVerdicts([shot('alpha')], FRESH, PUBLISHED, w.deps);
    expect(lines).toEqual(['DIFFERS alpha']);
  });

  test('a figure that could not be re-cut is UNCUT, never silently clean', async () => {
    const w = world({ alpha: 'pixels' }, {});
    const { lines } = await verifyVerdicts([shot('alpha')], FRESH, PUBLISHED, w.deps);
    expect(lines).toEqual(['UNCUT alpha']);
  });

  test('a volatile figure is reported as such and never re-cut', async () => {
    const w = world({ now: 'pixels' }, { now: 'pixels' });
    const { lines } = await verifyVerdicts([shot('now', { volatile: true })], FRESH, PUBLISHED, w.deps);
    expect(lines).toEqual(['VOLATILE now']);
    expect(w.cutWith).toEqual([]);
  });

  test('the recorded group failing does not lose the scene figures with it', async () => {
    // The exact shape of the missing bundle: the recorded shots cannot be cut at all, and the scene
    // shots need nothing but the generator. One verdict each, and the failure is reported.
    const w = world({ live: 'a', corpus: 'b' }, { corpus: 'b' }, 'live');
    const { lines, errors } = await verifyVerdicts(
      [shot('live'), shot('corpus', { scene: 'corpus' })],
      FRESH,
      PUBLISHED,
      w.deps,
    );
    expect(lines).toEqual(['UNCUT live', 'SAME corpus']);
    expect(errors).toHaveLength(1);
    expect(w.cutWith.map((c) => c.ids)).toEqual([['live'], ['corpus']]);
  });

  test('the output directory reaches the cut exactly as given — it is absolute', async () => {
    // An absolute temp dir joined onto the cwd wrote `<repo>/var/folders/…` and then found nothing
    // where it looked, so every figure came back unverified. The path must travel untouched.
    const w = world({ alpha: 'x' }, { alpha: 'x' });
    await verifyVerdicts([shot('alpha')], FRESH, PUBLISHED, w.deps);
    expect(w.cutWith[0]?.outDir).toBe(FRESH);
  });

  test('a figure with nothing published yet DIFFERS rather than passing', async () => {
    const w = world({}, { alpha: 'pixels' });
    const { lines } = await verifyVerdicts([shot('alpha')], FRESH, PUBLISHED, w.deps);
    expect(lines).toEqual(['DIFFERS alpha']);
  });
});

// `volatile` is what lets the pixel comparison be EXACT. It is a claim about a figure — its
// content moves on its own — and a wrong one is silent: the shot would be reported for a human
// every time instead of being compared, or worse, a genuinely ticking figure would be compared
// and differ on every run, which is the noise this whole mechanism exists to remove.
describe('the volatile flag', () => {
  test('is claimed only where the figure really carries something that moves', async () => {
    const manifest = await readManifest();
    const flagged = manifest.shots.filter((s) => s.volatile).map((s) => s.id);
    // One figure, and the reason is recorded next to it: the NOW panel prints an age relative to
    // the clock, so two cuts of the same code differ (`4444m ago` → `4775m ago`, measured).
    expect(flagged).toEqual(['broken-session']);
  });
});
