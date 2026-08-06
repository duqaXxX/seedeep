/**
 * The staleness rule is the only thing standing between a code change and a figure that quietly
 * lies — nothing else in the suite can look at a PNG. So the rule itself is tested, and the manifest
 * is checked against the repo: a shot mapped to a file that no longer exists is a shot that can
 * never be reported stale again.
 */

import { describe, expect, test } from 'bun:test';
import { type DocShotManifest, readManifest, staleShots } from '../scripts/doc-shots-check.ts';

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
  // The two below are PENDING, not permanent: each is tracked, and the test right after this one
  // fails the moment either gains a figure and keeps its excuse.
  'Nothing is hidden from you':
    'PENDING — the Expand all crop is declared work, not a decision: it needs one capture run',
  'Local by default, remote on purpose':
    'PENDING — the settings drawer renders its frame before its content, so the crop came back with 1 character of text and was refused',
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
