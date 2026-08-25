import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * What a documentation set rots into, checked mechanically.
 *
 * The pre-push gate asks a model whether the pushed DIFF leaves a doc out of date. That question
 * cannot see the rot that actually accumulated here: a claim goes false because the code grew
 * around it, and no diff ever touches it. `graph.ts` was documented as "~1500 lines" while it
 * reached 4867; three code paths kept a `src/` prefix a directory move had removed; a contract
 * table pointed at `parser.ts:194`, which by then was a comment. None of those is a diff.
 *
 * So the checks below run over the WHOLE doc set on every test run, and they are deterministic —
 * a deterministic check never has an off day.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Every markdown file git tracks. Untracked scratch files are nobody's contract. */
function trackedMarkdown(): string[] {
  return execFileSync('git', ['ls-files', '*.md'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
}

/** The changelogs are a historical record: the prose rules below do not apply to them. */
const isChangelog = (f: string) => f.includes('CHANGELOG');

/**
 * GitHub's own heading slug: lowercase, drop punctuation, and map EACH remaining space to a
 * hyphen — it does not collapse runs, so `a — b` becomes `a--b`. Duplicates get `-1`, `-2`.
 */
function anchorsOf(markdown: string): Set<string> {
  const out = new Set<string>();
  const seen = new Map<string, number>();
  for (const line of markdown.split('\n')) {
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (!m) continue;
    const base = m[1]!
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .toLowerCase()
      .replace(/`/g, '')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/ /g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

/** `../../issues` and friends resolve against the repository URL on github.com, not on disk. */
const isGithubRelative = (target: string) => /^(\.\.\/)+(issues|releases|security|pulls|wiki)(\/|$)/.test(target);

const links = (markdown: string): Array<{ line: number; target: string }> => {
  const out: Array<{ line: number; target: string }> = [];
  markdown.split('\n').forEach((raw, i) => {
    for (const m of raw.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      out.push({ line: i + 1, target: m[1]! });
    }
  });
  return out;
};

test('every link in a doc resolves, and so does every anchor', () => {
  const files = trackedMarkdown();
  assert.ok(files.length > 10, 'the file list itself must not come back empty');
  const anchors = new Map(files.map((f) => [f, anchorsOf(readFileSync(join(ROOT, f), 'utf8'))]));
  const broken: string[] = [];

  for (const f of files) {
    for (const { line, target } of links(readFileSync(join(ROOT, f), 'utf8'))) {
      if (/^(https?:|mailto:)/.test(target) || isGithubRelative(target)) continue;
      if (target.startsWith('#')) {
        if (!anchors.get(f)!.has(target.slice(1).toLowerCase())) broken.push(`${f}:${line} → ${target}`);
        continue;
      }
      const [path, anchor] = target.split('#');
      const abs = resolve(dirname(join(ROOT, f)), decodeURIComponent(path!));
      if (!existsSync(abs)) {
        broken.push(`${f}:${line} → ${target} (no such file)`);
        continue;
      }
      const set = anchors.get(abs.slice(ROOT.length + 1));
      if (anchor && set && !set.has(anchor.toLowerCase())) broken.push(`${f}:${line} → ${target} (no such anchor)`);
    }
  }
  assert.deepEqual(broken, [], 'a doc points somewhere that is not there');
});

// The rot that outlived every other check: a directory move left ten paths spelled `src/…` in two
// references, and `docs/tray.md` named a `panel_height` function that had never existed. Both read
// as precise and both sent a contributor nowhere.
test('every source path a doc names exists', () => {
  const missing: string[] = [];
  for (const f of trackedMarkdown()) {
    if (isChangelog(f)) continue; // it describes the tree as it was at each release
    const text = readFileSync(join(ROOT, f), 'utf8');
    for (const m of text.matchAll(/`(apps\/[\w./-]+\.(?:ts|rs|json|jsonc|css|sh|yml))`/g)) {
      if (!existsSync(join(ROOT, m[1]!))) missing.push(`${f} → ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], 'a doc names a source file that is not there');
});

// A line number is unfalsifiable: nothing can tell a right one from a wrong one, and every sampled
// pointer in the schema contract had rotted into a `}` or a comment before anyone noticed.
test('no doc points at a source line number', () => {
  const hits: string[] = [];
  for (const f of trackedMarkdown()) {
    if (isChangelog(f)) continue;
    readFileSync(join(ROOT, f), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const m of line.matchAll(/`[\w/.-]+\.(?:ts|rs):\d+`/g)) hits.push(`${f}:${i + 1} → ${m[0]}`);
      });
  }
  assert.deepEqual(hits, [], 'name the symbol, not the line — a line number rots silently');
});

// A doc nobody links is a doc nobody reads, and it is how a reference goes stale unnoticed.
test('every doc under docs/ is linked from somewhere', () => {
  const files = trackedMarkdown();
  const corpus = files.map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n');
  const orphans = files
    .filter((f) => f.startsWith('docs/') && f.endsWith('.md'))
    .filter((f) => !corpus.includes(f.slice('docs/'.length)) || corpus.split(f.slice('docs/'.length)).length < 3);
  assert.deepEqual(orphans, [], 'these docs are reachable from nothing but themselves');
});

/**
 * Prose outside a heading, a fenced block or a backtick span, with every inline code span removed.
 * The three exemptions are not stylistic: a heading's em dash is part of an anchor other docs link
 * to, and a backtick span quotes a literal seedeep prints (`Waiting for your approval — Bash`),
 * which the doc would be lying about if it rewrote it.
 */
function proseLines(markdown: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const raw of markdown.split('\n')) {
    const line = raw.trimStart();
    if (line.startsWith('```')) {
      fenced = !fenced;
      out.push('');
      continue;
    }
    out.push(fenced || line.startsWith('#') ? '' : raw.replace(/`[^`]*`/g, ''));
  }
  return out;
}

// The one tell of AI-written prose a regex can settle. A stranger's only public comment on seedeep
// was that its README read as generated, and the corpus held 1094 em dashes at the time. The rest
// of the register — paragraphs closing on an aphorism, "not X but Y", bold lead-ins — needs
// judgement and lives in the project's writing rules; this catches the one that can be counted.
test('no em dash in a public doc’s prose', () => {
  const hits: string[] = [];
  for (const f of trackedMarkdown()) {
    if (isChangelog(f)) continue; // a released entry is a historical record, never rewritten
    proseLines(readFileSync(join(ROOT, f), 'utf8')).forEach((line, i) => {
      if (line.includes('—')) hits.push(`${f}:${i + 1} → ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(hits, [], 'use : , . ; or parentheses — a literal seedeep prints goes in backticks');
});
