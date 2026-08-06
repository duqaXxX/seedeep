// The header menu holding the FIXED surfaces (Home, Compare, Search).
//
// They used to be three permanent pills at the head of the tab strip, which is the one place
// you find a SESSION: three pills that never change ate the horizontal room the session
// subjects need, and the subject is what you actually read there.
//
// The trigger adopts the current surface's NAME rather than staying a bare icon. With the
// pills gone, no tab in the strip is active while a fixed surface is on screen — a lit border
// alone would leave "where am I" to one pixel of colour, and Search's panel (an empty input)
// does not name itself either. On a session the label goes away: the active tab says it.

// safe: hardcoded constant, no user or server data — the only innerHTML in this module.
const BARS_SVG = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">
  <line x1="2.5" y1="4" x2="13.5" y2="4"/>
  <line x1="2.5" y1="8" x2="13.5" y2="8"/>
  <line x1="2.5" y1="12" x2="13.5" y2="12"/>
</svg>`;

// The reserved ids of the fixed surfaces. None is a sessionId (those are uuids), so they never
// collide with a real session in the tab store, the strip, or `switchTo`.
export const HOME_ID = '__home__';
/** The cross-session comparison. */
export const COMPARE_ID = '__compare__';
/** Full-text search over the sessions' dialogue. */
export const SEARCH_ID = '__search__';

/** One fixed surface: its reserved id, the menu label, and the noun under it. */
export interface NavItem {
  id: string;
  label: string;
  hint: string;
}

/**
 * Build the header menu into `mount`. Returns `{ setActive(id) }`; picking an item calls
 * `onSwitch(id)` and closes. `setActive` takes whatever is on screen — a fixed surface id
 * names the trigger and marks its row, any other id (a session) leaves the trigger bare.
 * Interactions: the trigger toggles; click-outside and Esc close; ↑/↓ walk the items.
 */
export function createNavMenu(
  mount: HTMLElement,
  { items, onSwitch }: { items: NavItem[]; onSwitch: (id: string) => void },
) {
  let open = false;
  let hi = -1; // index of the arrow-focused item, reset on every open

  mount.classList.add('nav');
  const btn = document.createElement('button');
  btn.className = 'nav-btn';
  btn.type = 'button';
  btn.title = 'Menu';
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-label', 'Menu');
  btn.innerHTML = BARS_SVG; // before the label is appended: innerHTML replaces the children
  const cur = document.createElement('span');
  cur.className = 'nav-cur';
  btn.append(cur);

  const pop = document.createElement('div');
  pop.className = 'nav-pop';
  pop.setAttribute('role', 'menu');
  const rows = new Map<string, HTMLElement>();
  for (const item of items) {
    const row = document.createElement('button');
    row.className = 'nav-item';
    row.type = 'button';
    row.setAttribute('role', 'menuitem');
    const icon = document.createElement('span');
    icon.className = 'ic';
    icon.textContent = '✦';
    const name = document.createElement('span');
    name.textContent = item.label;
    const hint = document.createElement('span');
    hint.className = 'sub';
    hint.textContent = item.hint;
    row.append(icon, name, hint);
    row.onclick = () => {
      setOpen(false);
      onSwitch(item.id);
    };
    pop.append(row);
    rows.set(item.id, row);
  }
  mount.replaceChildren(btn, pop);

  function setOpen(v: boolean) {
    open = v;
    hi = -1;
    mount.classList.toggle('open', v);
    btn.setAttribute('aria-expanded', String(v));
  }

  btn.onclick = () => setOpen(!open);

  // Document-level, like the picker's: one instance lives for the app's lifetime, so these
  // listeners are never removed (no destroy in the contract).
  document.addEventListener('click', (e) => {
    if (open && !mount.contains(e.target as Node | null)) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (!open) return;
    if (e.key === 'Escape') {
      setOpen(false);
      btn.focus?.();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const list = [...rows.values()];
    hi = (hi + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
    // Real focus, not a highlight class: the items are buttons, so Enter and Space come free.
    list[hi]?.focus?.();
  });

  return {
    /** Reflect what is on screen: names the trigger for a fixed surface, bare for a session. */
    setActive(id: string) {
      const item = items.find((i) => i.id === id);
      btn.classList.toggle('on', item !== undefined);
      cur.textContent = item ? item.label : '';
      btn.title = item ? item.label : 'Menu';
      for (const [rowId, row] of rows) {
        row.classList.toggle('active', rowId === id);
        row.setAttribute('aria-current', rowId === id ? 'page' : 'false');
      }
    },
  };
}
