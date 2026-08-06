// A custom "glass" combobox for picking a session. Replaces the native <select>,
// which renders single-line, OS-drawn <option>s that can't be styled or made
// multi-line. Built with DOM nodes + textContent only (never innerHTML), so a
// session-derived value (subject, project, id) can never inject markup.

import { modelFamily } from '../core/tree-format.ts';
import { isLive, type SessionRecord } from '../core/types.ts';
import { authFetch } from './auth.ts';
import { createIdChip } from './id-chip.ts';
import { isAutomated } from './sessions.ts';

/** The picker's two roster tabs. `render` derives the shown set from `tab === 'automated'`,
 * so a third value would silently list nothing. */
type PickerTab = 'human' | 'automated';

const p2 = (n: number) => String(n).padStart(2, '0');

// Epoch ms → a short relative stamp ("now", "5m", "3h", "2d", then "Jul 15"). The list
// is read top-down by recency, so a compact relative age scans faster than a full date.
function fmtWhen(ms: number) {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'now';
  if (min < 60) return min + 'm';
  const h = Math.floor(min / 60);
  if (h < 24) return h + 'h';
  const days = Math.floor(h / 24);
  if (days < 7) return days + 'd';
  const d = new Date(ms);
  return `${d.toLocaleString(undefined, { month: 'short' })} ${p2(d.getDate())}`;
}

// Long model id → capitalized family name (claude-opus-4-8 → 'Opus'); '?' when unset.
function shortModel(model: string | null | undefined) {
  if (!model) return '?';
  const fam = modelFamily(model);
  return fam ? fam.charAt(0).toUpperCase() + fam.slice(1) : model;
}

// `isAutomated` is imported, not redefined: the Human/Automated split and the auto-open rule
// must answer this question identically, or a run gets filed under Human here and silently
// never opened there.
const isAuto = isAutomated;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string | null,
  text?: string | null,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

/**
 * Build the session picker into `mount` (a plain element). Returns
 * `{ update(rows), setOpenTabs(ids) }`; picking a row calls `onOpen(sessionId)`, and a
 * session named by `setOpenTabs` is pinned — it already has a tab, so picking it switches
 * to that tab rather than opening another. Two tabs split the roster — Human (default)
 * vs Automated (headless sdk-* runs) — so the ~1000 docs-gate rows never drown the human
 * sessions. The popover renders lazily (only while open). Interactions: trigger toggles;
 * click-outside and Esc close; the search box filters the active tab; ↑/↓ move the
 * highlight and Enter opens it. ARIA: the trigger is a listbox combobox, the tabs a
 * tablist, the list a listbox of options.
 */
export function createDropdown(mount: HTMLElement, { onOpen }: { onOpen: (id: string) => void }) {
  let rows: SessionRecord[] = [];
  let openTabs = new Set<string>(); // sessionIds currently showing in a tab — pinned in the list
  let stats = new Map<string, { turns: number; totalTokens: number }>(); // from /api/session-stats
  let query = '';
  let open = false;
  let tab: PickerTab = 'human';
  let flat: Array<{ node: HTMLElement; id: string }> = []; // [{ node, id }] in visual order — the keyboard-navigable rows
  let hi = -1; // index into `flat` of the highlighted row

  mount.classList.add('picker');
  const trigger = el('button', 'pk-trigger');
  trigger.type = 'button';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.append(el('span', 'pk-tlabel', 'Open a session…'), el('span', 'pk-caret', '▾'));
  const input = el('input', 'pk-input');
  input.type = 'text';
  input.placeholder = 'Filter sessions…';
  input.setAttribute('aria-label', 'Filter sessions');
  const searchIcon = el('span', 'pk-sicon', '⌕');
  const search = el('div', 'pk-search');
  search.append(searchIcon, input);

  // Human (default) vs Automated tabs, each showing its live count. The ~1000 automated
  // docs-gate rows would otherwise bury the handful of human sessions the user picks.
  const mkTab = (key: PickerTab, label: string) => {
    const b = el('button', 'pk-tab');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    const cnt = el('span', 'pk-count', '0');
    b.append(el('span', null, label), cnt);
    b.onclick = () => {
      tab = key;
      render();
    };
    return { b, cnt };
  };
  const tHuman = mkTab('human', 'Human');
  const tAuto = mkTab('automated', 'Automated');
  const tabbar = el('div', 'pk-tabs');
  tabbar.setAttribute('role', 'tablist');
  tabbar.append(tHuman.b, tAuto.b);

  const listEl = el('div', 'pk-list');
  listEl.setAttribute('role', 'listbox');
  const pop = el('div', 'pk-pop');
  pop.append(tabbar, search, listEl);
  mount.replaceChildren(trigger, pop);

  function matches(s: SessionRecord, q: string) {
    if (!q) return true;
    const hay = `${s.subject || ''} ${s.model || ''} ${s.project || ''} ${s.sessionId}${isAuto(s) ? ' automated' : ''}`;
    return hay.toLowerCase().includes(q);
  }

  function rowNode(s: SessionRecord) {
    let cls = 'pk-row';
    if (isLive(s)) cls += ' active'; // the row's dot must agree with the section it sits in
    const row = el('div', cls);
    row.setAttribute('role', 'option');
    row.append(el('span', 'pk-dot'));
    const body = el('div', 'pk-body');

    const line1 = el('div', 'pk-p1');
    // The prompt leads every row (automated runs show their real prompt too).
    const promptText = s.subject && s.subject.trim() ? s.subject.trim() : `session ${s.sessionId.slice(0, 8)}`;
    line1.append(el('span', 'pk-prompt', promptText));
    // Already in a tab: picking it switches there rather than opening a second one. The
    // pin says so up front, instead of letting the click be the only way to find out.
    if (openTabs.has(s.sessionId)) line1.append(el('span', 'pk-badge pin', '📌'));
    body.append(line1);

    const meta = el('div', 'pk-meta');
    const model = shortModel(s.model);
    meta.append(el('span', 'pk-mchip m-' + model, model));
    meta.append(el('span', 'pk-sep', '·'), el('span', null, fmtWhen(s.lastActivity)));
    // The id was dead text here; it is the one thing `claude --resume` needs, so it copies.
    meta.append(el('span', 'pk-sep', '·'), createIdChip(s.sessionId, { className: 'pk-id' }));
    const ss = stats.get(s.sessionId);
    if (ss) {
      meta.append(el('span', 'pk-sep', '·'), el('span', 'pk-turns', ss.turns + ' turn' + (ss.turns === 1 ? '' : 's')));
    }
    body.append(meta);

    row.append(body);
    row.onclick = () => select(s.sessionId);
    return row;
  }

  // `preserve` keeps the highlighted session and scroll across a background roster refresh;
  // a fresh open / query change / tab switch starts at the top (first match pre-highlighted).
  function render(preserve?: boolean) {
    const entry = flat[hi];
    const keepId = preserve && hi >= 0 && entry ? entry.id : null;
    const keepScroll = preserve ? listEl.scrollTop : 0;
    const q = query.trim().toLowerCase();
    // Tab counts reflect the search, so you can see which tab holds the matches.
    tHuman.cnt.textContent = String(rows.filter((s) => !isAuto(s) && matches(s, q)).length);
    tAuto.cnt.textContent = String(rows.filter((s) => isAuto(s) && matches(s, q)).length);
    for (const [t, key] of [
      [tHuman, 'human'],
      [tAuto, 'automated'],
    ] as const) {
      t.b.classList.toggle('on', tab === key);
      t.b.setAttribute('aria-selected', String(tab === key));
    }

    const current = rows.filter((s) => isAuto(s) === (tab === 'automated') && matches(s, q));
    // "Live" is the live PROCESS (`isLive`), the same signal the tab strip opens a session
    // with — reading the mtime window here filed a running session under Inactive while its
    // own tab said LIVE, one UI answering the question two ways.
    const active = current.filter(isLive);
    const inactive = current.filter((s) => !isLive(s));
    const nodes: HTMLElement[] = [];
    flat = [];
    const section = (label: string, list: SessionRecord[]) => {
      if (!list.length) return;
      nodes.push(el('div', 'pk-ghead', label));
      for (const s of list) {
        const node = rowNode(s);
        flat.push({ node, id: s.sessionId });
        nodes.push(node);
      }
    };
    section('Live', active);
    section('Inactive', inactive);
    if (!nodes.length)
      nodes.push(el('div', 'pk-empty', q ? `No ${tab} sessions match “${query.trim()}”` : `No ${tab} sessions`));
    listEl.replaceChildren(...nodes);

    hi = keepId ? flat.findIndex((f) => f.id === keepId) : -1;
    if (hi < 0) hi = flat.length ? 0 : -1; // the kept session vanished → fall back to the first
    applyHi();
    if (preserve) listEl.scrollTop = keepScroll;
  }

  function applyHi() {
    flat.forEach((f, i) => f.node.classList.toggle('hl', i === hi));
  }
  function moveHi(delta: number) {
    if (!flat.length) return;
    hi = Math.max(0, Math.min(hi + delta, flat.length - 1));
    applyHi();
    // hi is clamped to [0, flat.length-1] and flat.length > 0 (checked above)
    flat[hi]!.node.scrollIntoView?.({ block: 'nearest' });
  }

  // Fetch session stats once per open (fire-and-forget; re-renders when the data arrives).
  // Called every open so the data stays fresh after long idle periods.
  function fetchStats(): void {
    authFetch('/api/session-stats')
      .then((r) => r.json() as Promise<Record<string, { turns: number; totalTokens: number }>>)
      .then((data) => {
        stats = new Map(Object.entries(data));
        if (open) render(true);
      })
      .catch(() => {
        /* stats stay as-is; rows render without the counts */
      });
  }

  function setOpen(v: boolean) {
    open = v;
    mount.classList.toggle('open', v);
    trigger.setAttribute('aria-expanded', String(v));
    if (v) {
      // Open on the tab that has sessions — Human by default, unless it's empty and
      // Automated isn't (never greet the user with an empty default tab).
      tab = !rows.some((s) => !isAuto(s)) && rows.some(isAuto) ? 'automated' : 'human';
      input.value = query;
      render();
      input.focus?.();
      fetchStats();
    } else {
      query = '';
    }
  }

  function select(id: string) {
    setOpen(false);
    onOpen(id);
  }

  trigger.onclick = () => setOpen(!open);
  input.oninput = () => {
    query = input.value;
    render();
  };

  // Document-level so a click anywhere outside, or Esc, closes it. One instance lives for
  // the app's lifetime, so these listeners are never removed (no destroy in the contract).
  document.addEventListener('click', (e) => {
    if (open && !mount.contains(e.target as Node | null)) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (!open) return;
    if (e.key === 'Escape') {
      setOpen(false);
      trigger.focus?.();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveHi(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveHi(-1);
    } else if (e.key === 'Enter') {
      const entry = flat[hi];
      if (hi >= 0 && entry) select(entry.id);
    }
  });

  return {
    /** Open the picker programmatically — the Home tab's "Pick a session" CTA. */
    open() {
      setOpen(true);
    },
    update(next: SessionRecord[]) {
      rows = next || [];
      if (open) render(true); // preserve the highlight/scroll across background refreshes
    },
    // Which sessions currently have a tab. Driven by app.ts on every open/close, NOT by the
    // roster: opening a tab changes nothing a session RECORD can express, so `rosterKey`
    // (sessions.ts) cannot notice it and a roster-driven pin would never appear.
    // Iterable, not string[]: the only caller passes `openTabs.keys()` straight from a Map,
    // and the body just feeds it to `new Set(...)`.
    setOpenTabs(ids: Iterable<string>) {
      openTabs = new Set(ids);
      if (open) render(true);
    },
  };
}
