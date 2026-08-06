import type { SessionCard, SessionCards } from '../core/tracker-cards.ts';

/**
 * The Cards card and its drawer list — which tracker card the session worked on.
 *
 * The mirror of Commits: that one is what the session shipped, this one is what it was working on.
 * A row opens the card on its tracker, and says WHEN it cannot: a `read` chip marks the 20% of rows
 * the session only looked at, so "worked on" never over-claims.
 */

function el(tag: string, className?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

/** HH:MM of the last touch, in the reader's own timezone. */
function hhmm(at: number): string {
  const d = new Date(at);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function openCard(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * One card: id, `read` when the session only looked, title, time.
 *
 * The title is what makes the row readable, and it is there 99% of the time — but an id alone is
 * still a true row, not a broken one, so it renders without apology when no call returned a title.
 */
function cardRow(c: SessionCard, withTime: boolean): HTMLElement {
  const row = el('div', 'crdrow' + (c.url ? '' : ' nolink') + (c.evidence === 'read' ? ' read' : ''));
  row.append(el('span', 'crdid', c.id));
  if (c.evidence === 'read') row.append(el('span', 'crdlvl', 'read'));
  row.append(el('span', 'crdt', c.title ?? '—'));
  if (withTime) row.append(el('span', 'crdtime', hhmm(c.at)));
  if (c.url) {
    const url = c.url;
    row.title = c.evidence === 'read' ? 'Only read — open it on the tracker' : 'Open it on the tracker';
    row.onclick = () => openCard(url);
  } else {
    row.title = 'No link came back from the tracker for this card';
  }
  return row;
}

/**
 * What the card promises, given what it holds. It must not invite a click when nothing is
 * clickable — the same rule the Commits card follows, for the same reason.
 */
function describe(cards: readonly SessionCard[]): string {
  const wrote = cards.filter((c) => c.evidence === 'wrote').length;
  const what =
    wrote === cards.length ? 'Cards this session changed.' : `Cards this session worked on — ${wrote} changed.`;
  return cards.some((c) => c.url) ? `${what} Click one to open it on the tracker.` : what;
}

/** Every card, newest first, titles wrapped rather than clipped. */
export function cardsList(cards: readonly SessionCard[]): HTMLElement {
  const box = el('div', 'crddlist');
  for (const c of cards) {
    const row = el('div', 'crddrow' + (c.url ? '' : ' nolink'));
    row.append(el('span', 'crdid', c.id));
    if (c.evidence === 'read') row.append(el('span', 'crdlvl', 'read'));
    row.append(el('span', 'crdt wrap', c.title ?? '—'));
    // Spelled out, not `×4`: the number is how many calls named this card, and a bare multiplier
    // reads as a quantity of cards. The drawer has the room the card does not.
    if (c.touches > 1) row.append(el('span', 'crdn', `${c.touches} calls`));
    row.append(el('span', 'crdtime', hhmm(c.at)));
    if (c.url) {
      const url = c.url;
      row.onclick = () => openCard(url);
    }
    box.append(row);
  }
  return box;
}

/** How many rows the card shows before deferring to the drawer. Median is 2, max measured 30. */
export const CARD_ROWS = 4;

/**
 * Fill the card body: hero count, the newest `CARD_ROWS` cards, and a pointer to the drawer for the
 * rest. `data` null means the fetch has not answered yet — the card says so rather than claiming
 * zero, which would be a lie for the two seconds before the answer lands.
 */
export function renderCardsCard(host: HTMLElement, data: SessionCards | null, onExpand: () => void): void {
  host.replaceChildren();
  if (!data) {
    host.append(el('div', 'wdesc', 'Reading the tracker calls…'));
    return;
  }
  const { cards } = data;
  if (!cards.length) {
    host.append(el('div', 'wdesc', 'No tracker card in scope yet.'));
    return;
  }
  host.append(el('div', 'wdesc', describe(cards)));
  const num = el('div', 'num');
  num.append(
    document.createTextNode(String(cards.length)),
    el('small', undefined, cards.length === 1 ? 'card' : 'cards'),
  );
  host.append(num);
  const list = el('div', 'crdlist');
  for (const c of cards.slice(0, CARD_ROWS)) list.append(cardRow(c, false));
  host.append(list);
  if (cards.length > CARD_ROWS) {
    const more = el('div', 'crdmore', `+ ${cards.length - CARD_ROWS} more →`);
    more.onclick = onExpand;
    host.append(more);
  }
}
