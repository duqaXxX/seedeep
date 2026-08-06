// Markdown → DOM nodes. The ONE hard rule: never innerHTML. Session content (prompts,
// results, subagent output) is arbitrary text from the user's own work — rendering it as
// markup would make any `<img onerror=…>` in a prompt executable inside seedeep. Every
// node here is created with createElement/createTextNode, so markup in the source is
// text, always, by construction.
//
// A deliberate subset — what a Claude Code prompt or answer actually contains: fenced
// code, headings, lists, tables, blockquotes, rules, and inline code/bold/italic/links.
// LIMIT: no nested lists, reference links, or HTML passthrough — each renders as its
// literal text rather than as structure, which is the safe failure direction.

const FENCE = /^\s*(`{3,}|~{3,})\s*(\S*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*(\d+)[.)]\s+(.*)$/;
// A GFM table is a header row followed by a separator of dashes: both are required, so a
// lone pipe-bearing line stays a paragraph rather than being mangled into a one-cell table.
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const TABLE_SEP = /^\s*\|[\s:|-]+\|\s*$/;
// Inline: code span, bold, italic, link. Code is first so `**x**` inside backticks stays literal.
const INLINE =
  /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\n]+?)\*|_([^_\n]+?)_|\[([^\]\n]+)\]\(([^()\s]+)\)/;
// Only schemes that cannot execute script. A `javascript:` (or data:) href is dropped to
// plain text rather than linked — the source is untrusted session content.
const SAFE_HREF = /^(https?:\/\/|mailto:)/i;

function el(tag: string, cls?: string) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}

/** Inline markdown (code/bold/italic/link) of one text run → an array of DOM nodes. */
function inline(text: string): Node[] {
  const out: Node[] = [];
  let rest = text;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push(document.createTextNode(rest));
      break;
    }
    if (m.index > 0) out.push(document.createTextNode(rest.slice(0, m.index)));
    const [, , code, bold1, bold2, it1, it2, linkText, href] = m;
    if (code !== undefined) {
      const c = el('code');
      c.textContent = code.trim();
      out.push(c);
    } else if (bold1 !== undefined || bold2 !== undefined) {
      const b = el('strong');
      for (const n of inline(bold1 ?? bold2 ?? '')) b.append(n);
      out.push(b);
    } else if (it1 !== undefined || it2 !== undefined) {
      const i = el('em');
      for (const n of inline(it1 ?? it2 ?? '')) i.append(n);
      out.push(i);
    } else if (linkText !== undefined) {
      // `href` is checked here, not in the branch condition: linkText and href are one
      // alternative of INLINE so it can never actually be missing, but hoisting the check
      // into the condition would drop the whole match instead of keeping its raw text.
      if (href !== undefined && SAFE_HREF.test(href)) {
        const a = el('a');
        a.textContent = linkText;
        a.setAttribute('href', href);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noreferrer noopener');
        out.push(a);
      } else {
        out.push(document.createTextNode(m[0])); // unsafe scheme → keep the raw markdown text
      }
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

function para(tag: string, text: string, cls?: string) {
  const p = el(tag, cls);
  for (const n of inline(text)) p.append(n);
  return p;
}

/**
 * Render markdown `src` to an array of DOM nodes (block elements), safe by construction:
 * built with createElement/createTextNode only, so no markup in `src` can ever execute.
 * Returns [] for empty input. Spread it into `replaceChildren(...)`.
 */
export function renderMarkdown(src: string | null | undefined): Node[] {
  const out: Node[] = [];
  const lines = String(src ?? '').split('\n');
  // Every read of `lines` goes through `at`, so an out-of-range index is an empty line
  // rather than `undefined`. The loops all guard on `i < lines.length` already; this
  // keeps that invariant in the types without scattering non-null assertions.
  const at = (n: number) => lines[n] ?? '';
  const isTableStart = (n: number) => TABLE_ROW.test(at(n)) && TABLE_SEP.test(at(n + 1));
  let i = 0;

  while (i < lines.length) {
    const line = at(i);

    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = (fence[1] ?? '')[0];
      const closes = (l: string) => {
        const f = FENCE.exec(l);
        return !!f && (f[1] ?? '')[0] === marker;
      };
      const body: string[] = [];
      i++;
      // An unterminated fence (a truncated log, a half-written answer) runs to the end —
      // treating it as code is closer to the author's intent than re-parsing it as prose.
      while (i < lines.length && !closes(at(i))) body.push(at(i++));
      i++; // consume the closing fence
      const pre = el('pre');
      const code = el('code');
      if (fence[2]) code.className = 'lang-' + fence[2];
      code.textContent = body.join('\n');
      pre.append(code);
      out.push(pre);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      out.push(para('h' + (heading[1] ?? '').length, heading[2] ?? ''));
      i++;
      continue;
    }

    if (RULE.test(line)) {
      out.push(el('hr'));
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      // One exec per line instead of test-then-exec: the match IS the loop condition, so
      // the captured text needs no non-null assertion to prove the test already passed.
      while (i < lines.length) {
        const quoted = QUOTE.exec(at(i));
        if (!quoted) break;
        body.push(quoted[1] ?? '');
        i++;
      }
      const q = el('blockquote');
      for (const n of renderMarkdown(body.join('\n'))) q.append(n);
      out.push(q);
      continue;
    }

    // table: header + separator + rows (Claude answers are full of them)
    if (isTableStart(i)) {
      const cells = (l: string) => (TABLE_ROW.exec(l)?.[1] ?? '').split('|').map((c) => c.trim());
      const table = el('table');
      const thead = el('thead'),
        htr = el('tr');
      for (const c of cells(line)) {
        const th = el('th');
        for (const n of inline(c)) th.append(n);
        htr.append(th);
      }
      thead.append(htr);
      table.append(thead);
      i += 2; // header + separator
      const tbody = el('tbody');
      while (i < lines.length && TABLE_ROW.test(at(i)) && !TABLE_SEP.test(at(i))) {
        const tr = el('tr');
        for (const c of cells(at(i))) {
          const td = el('td');
          for (const n of inline(c)) td.append(n);
          tr.append(td);
        }
        tbody.append(tr);
        i++;
      }
      table.append(tbody);
      out.push(table);
      continue;
    }

    const isItem = (l: string) => BULLET.exec(l) || ORDERED.exec(l);
    if (isItem(line)) {
      const ordered = !!ORDERED.exec(line);
      const list = el(ordered ? 'ol' : 'ul');
      // A list ends at the first line that is not an item of the SAME kind, so a bullet
      // list directly followed by a numbered one renders as two lists, not one mangled.
      while (i < lines.length && at(i).trim() && !!ORDERED.exec(at(i)) === ordered && isItem(at(i))) {
        const m = ordered ? ORDERED.exec(at(i)) : BULLET.exec(at(i));
        list.append(para('li', (ordered ? m?.[2] : m?.[1]) ?? ''));
        i++;
      }
      out.push(list);
      continue;
    }

    // paragraph: consecutive lines until a blank line or the start of another block
    const body: string[] = [];
    while (
      i < lines.length &&
      at(i).trim() &&
      !FENCE.test(at(i)) &&
      !HEADING.test(at(i)) &&
      !RULE.test(at(i)) &&
      !QUOTE.test(at(i)) &&
      !isItem(at(i)) &&
      !isTableStart(i)
    ) {
      body.push(at(i++));
    }
    out.push(para('p', body.join('\n')));
  }

  return out;
}
