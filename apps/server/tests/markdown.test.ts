import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdown } from '../src/client/markdown.ts';
import { textOf } from './fake-dom.ts';

// Fake DOM that records the tag, so a test can assert STRUCTURE (h2, pre>code, ul>li),
// not just text. It has no innerHTML by construction — which is the point: if the
// renderer ever reached for one, these tests would crash rather than pass silently.
function fakeDoc() {
  const make = (tag: string) => ({
    tag,
    className: '',
    textContent: '',
    attrs: {} as Record<string, string>,
    children: [] as any[],
    append(...n: any[]) {
      this.children.push(...n);
    },
    setAttribute(k: string, v: string) {
      this.attrs[k] = v;
    },
  });
  return {
    createElement: (tag: string) => make(tag),
    createTextNode: (t: string) => ({ tag: '#text', textContent: t, children: [] as any[] }),
  };
}

/** All text a node subtree renders, in order — what the reader actually sees. */
function tags(nodes: any[]): string[] {
  return nodes.map((n) => n.tag);
}

function render(src: string): any[] {
  const g = globalThis as any;
  const prev = g.document;
  g.document = fakeDoc();
  try {
    return renderMarkdown(src);
  } finally {
    g.document = prev;
  }
}

test('blocks: headings, paragraphs, rules and lists become real elements', () => {
  const out = render('# Title\n\nsome text\n\n---\n\n- one\n- two\n\n1. first\n2. second');
  assert.deepEqual(tags(out), ['h1', 'p', 'hr', 'ul', 'ol']);
  assert.equal(textOf(out[0]), 'Title');
  assert.equal(textOf(out[1]), 'some text');
  assert.deepEqual(tags(out[3].children), ['li', 'li']);
  assert.deepEqual(out[3].children.map(textOf), ['one', 'two']);
  assert.deepEqual(out[4].children.map(textOf), ['first', 'second']);
});

test('a bullet list followed by a numbered list renders as two lists', () => {
  const out = render('- a\n1. b');
  assert.deepEqual(tags(out), ['ul', 'ol']);
});

test('fenced code keeps its content verbatim (markdown inside is NOT parsed)', () => {
  const out = render('before\n\n```ts\nconst a = **not bold**;\n  indented\n```\n\nafter');
  assert.deepEqual(tags(out), ['p', 'pre', 'p']);
  const code = out[1].children[0];
  assert.equal(code.tag, 'code');
  assert.equal(code.className, 'lang-ts');
  assert.equal(code.textContent, 'const a = **not bold**;\n  indented');
});

test('an unterminated fence runs to the end as code, not as prose', () => {
  const out = render('```\nhalf a log line');
  assert.deepEqual(tags(out), ['pre']);
  assert.equal(out[0].children[0].textContent, 'half a log line');
});

test('inline: code, bold, italic and links', () => {
  const out = render('run `bun test` for **speed** and *clarity* — see [docs](https://example.com/x)');
  const p = out[0];
  assert.equal(p.tag, 'p');
  assert.deepEqual(
    p.children.filter((c: any) => c.tag !== '#text').map((c: any) => c.tag),
    ['code', 'strong', 'em', 'a'],
  );
  assert.equal(textOf(p), 'run bun test for speed and clarity — see docs');
  const a = p.children.find((c: any) => c.tag === 'a');
  assert.equal(a.attrs.href, 'https://example.com/x');
  assert.equal(a.attrs.rel, 'noreferrer noopener');
});

test('markup in the source is TEXT, never structure (no innerHTML, ever)', () => {
  // A prompt or a tool output can contain anything; seedeep renders session content, so
  // this is the invariant that keeps a crafted prompt from executing inside the UI.
  const out = render('<img src=x onerror="alert(1)"> and <script>bad()</script>');
  assert.deepEqual(tags(out), ['p']);
  assert.equal(textOf(out[0]), '<img src=x onerror="alert(1)"> and <script>bad()</script>');
  assert.equal(
    out[0].children.every((c: any) => c.tag === '#text'),
    true,
    'no element nodes were created from the markup',
  );
});

test('a link with a dangerous scheme is REFUSED by the scheme check, not by luck', () => {
  // The hrefs are percent-encoded on purpose: the link regex excludes parentheses, so
  // `javascript:alert(1)` never matches it at all — a test using that form passes even with
  // the SAFE_HREF guard deleted, i.e. it tests nothing. These forms DO match the regex, so
  // the only thing standing between them and an <a href> is the scheme check.
  for (const href of ['javascript:alert%281%29', 'data:text/html,%3Cscript%3E1%3C/script%3E', 'vbscript:msgbox']) {
    const out = render(`click [here](${href})`);
    const p = out[0];
    assert.equal(
      p.children.some((c: any) => c.tag === 'a'),
      false,
      `${href} must never become an anchor`,
    );
    assert.equal(textOf(p), `click [here](${href})`, 'it stays literal text');
  }
});

test('tables: header + separator + rows become a real table, cells keep inline markup', () => {
  const out = render('| Widget | Scoped |\n|---|---|\n| Context | **yes** |\n| `feed` | no |');
  assert.deepEqual(tags(out), ['table']);
  const [thead, tbody] = out[0].children;
  assert.deepEqual(thead.children[0].children.map(textOf), ['Widget', 'Scoped']);
  assert.equal(tbody.children.length, 2);
  assert.deepEqual(tbody.children[0].children.map(textOf), ['Context', 'yes']);
  assert.equal(tbody.children[0].children[1].children[0].tag, 'strong', 'bold survives inside a cell');
  assert.equal(tbody.children[1].children[0].children[0].tag, 'code', 'inline code survives inside a cell');
});

test('tables: a pipe line without a separator row stays a paragraph', () => {
  const out = render('a | b | c');
  assert.deepEqual(tags(out), ['p']);
  assert.equal(textOf(out[0]), 'a | b | c');
});

test('tables: a table right after a paragraph is not swallowed by it', () => {
  const out = render('intro line\n| a |\n|---|\n| 1 |');
  assert.deepEqual(tags(out), ['p', 'table']);
});

test('blockquote nests its own blocks', () => {
  const out = render('> quoted **line**\n> still quoted');
  assert.equal(out[0].tag, 'blockquote');
  assert.deepEqual(tags(out[0].children), ['p']);
  assert.equal(textOf(out[0]), 'quoted line\nstill quoted');
});

test('empty input renders nothing', () => {
  assert.deepEqual(render(''), []);
  assert.deepEqual(render('\n\n  \n'), []);
});
