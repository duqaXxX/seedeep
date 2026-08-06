import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The Trace renders inside the same document as the rest of the app, and its stylesheet
 * comment says every prototype class name is scoped under `.trace-modal` precisely to
 * avoid clashing with the generic ones. One escaped: the tail block carried `.live`,
 * which is ALSO the global badge class — `display:inline-flex`, `text-transform:uppercase`
 * and `letter-spacing` landed on the block, turning its label uppercase and pushing the
 * text out of its box. A fake-dom test cannot see that: it does no layout. This one reads
 * the stylesheet and the renderer as text, which is where the collision actually lives.
 */

const ROOT = join(import.meta.dir, '..');
const CSS_DIR = join(ROOT, 'public/css');
// The whole stylesheet, whatever it is split into: read the directory rather than a list, or a
// new file would silently fall outside the guard the day it is added.
const cssFiles = readdirSync(CSS_DIR)
  .filter((f) => f.endsWith('.css'))
  .sort();
const css = cssFiles.map((f) => readFileSync(join(CSS_DIR, f), 'utf8')).join('\n');
const trace = readFileSync(join(ROOT, 'src/client/trace.ts'), 'utf8');

/**
 * Class names targeted by a rule whose whole selector is that ONE class — the only shape
 * that can reach a Trace node unbidden. A qualified selector (`.nowpanel.hidden`,
 * `.tab-busy.on`) needs a class the Trace never writes, and a descendant selector
 * (`.feed .row`) needs an ancestor that is always a `.trace-*` node.
 *
 * Comments are stripped first: the stylesheet's own note lists `.drawer, .card, .dot,
 * .badge, .conn` as examples of generics to avoid, and reading that as five rules
 * produced a false positive on `.conn` — which is in fact defined only as
 * `.trace-modal .conn`, and measures `position:static` in the browser.
 */
function globalClasses(): Set<string> {
  const out = new Set<string>();
  const style = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of style.matchAll(/(^|[}])\s*([^{}@]+)\{/g)) {
    for (const sel of (m[2] ?? '').split(',')) {
      const s = sel.trim();
      if (/^\.[\w-]+$/.test(s) && !s.startsWith('.trace-')) out.add(s.slice(1));
    }
  }
  return out;
}

/** Class names the Trace renderer writes onto its own nodes. */
function traceClasses(): Set<string> {
  const out = new Set<string>();
  // className assignments and classList mutations, including the composed forms.
  for (const m of trace.matchAll(/className\s*=\s*'([^']+)'/g)) for (const c of m[1]!.split(/\s+/)) if (c) out.add(c);
  // `classList?.` too: the optional-chaining form is what `hit` uses, and a regex demanding
  // `classList.` silently left that class outside the guard entirely.
  for (const m of trace.matchAll(/classList\??\.(?:add|toggle)\('([\w-]+)'/g)) out.add(m[1]!);
  // Ternary fragments inside a composed className, e.g. ' has-err' / 'end' + (mid ? ' mid' : '')
  for (const m of trace.matchAll(/\?\s*'\s*([\w-]+)'\s*:/g)) out.add(m[1]!);
  out.delete('');
  return out;
}

/**
 * Prefixes of class names BUILT at runtime (`'t-' + type` for the sparkline bins). The
 * whole name never appears as a literal, so no extractor can list it — the guard is
 * therefore on the family: no unscoped global rule may target anything under that prefix.
 */
function tracePrefixes(): string[] {
  return [...new Set([...trace.matchAll(/'([\w-]+-)'\s*\+/g)].map((m) => m[1]!))];
}

/**
 * Collisions that are deliberate. `hidden` is a shared utility (`.hidden{display:none}`)
 * and the Trace wants exactly that effect on its follow button. Everything else must be
 * scoped, so a new entry here is a decision, not a silencer.
 */
const ALLOWED = new Set(['hidden']);

test('no Trace block class collides with an unscoped global class', () => {
  const globals = globalClasses();
  const used = traceClasses();
  const clashes = [...used].filter((c) => globals.has(c) && !c.startsWith('trace-') && !ALLOWED.has(c));
  expect(clashes).toEqual([]);
});

test('no global class falls inside a runtime-built Trace class family', () => {
  // The sparkline writes `t-api`, `t-tool`, … by concatenation. A literal-only extractor
  // cannot see them, so a future global `.t-…` rule would reach the bins unnoticed.
  const prefixes = tracePrefixes();
  expect(prefixes.length).toBeGreaterThan(0); // …and this stays true if the code changes
  const globals = [...globalClasses()];
  const clashes = prefixes.flatMap((p) => globals.filter((c) => c.startsWith(p)).map((c) => p + '… ↔ .' + c));
  expect(clashes).toEqual([]);
});

test('the tail marker is not the global badge class', () => {
  // Guards the specific escape: `.live` is the Live-activity badge, uppercase and
  // inline-flex. Renaming it back would silently deform every live turn's newest block.
  expect(trace.includes("classList.add('live')")).toBe(false);
  expect(globalClasses().has('live')).toBe(true); // the global rule still exists…
  expect(traceClasses().has('live')).toBe(false); // …and the Trace no longer touches it
});
