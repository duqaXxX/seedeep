import type { SessionCommit, SessionCommits } from '../core/commit-attribution.ts';

/**
 * The Commits card and its drawer list.
 *
 * A commit row is the one thing on this page that leaves seedeep: clicking it opens the commit on
 * the forge. A row without a link is not a broken row — it is a commit that is not pushed, or a
 * repo with no `origin`, and saying so is more useful than a link that 404s.
 */

function el(tag: string, className?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

/** HH:MM of a commit's author date, in the reader's own timezone. */
function hhmm(at: number): string {
  const d = new Date(at);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function openCommit(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * One commit: short hash, `local` when it has nowhere to open, subject, time.
 *
 * The chip is not decoration: a row that does nothing when clicked reads as broken, and a
 * `title` only tells whoever hovers for a second. It says WHY on the row itself, and disappears
 * the moment the commit is pushed.
 */
function commitRow(c: SessionCommit, withTime: boolean): HTMLElement {
  const row = el('div', 'cmtrow' + (c.url ? '' : ' nolink'));
  row.append(el('span', 'cmth', c.short));
  if (!c.url) row.append(el('span', 'cmtlocal', 'local'));
  row.append(el('span', 'cmts', c.subject));
  if (withTime) row.append(el('span', 'cmtt', hhmm(c.at)));
  if (c.url) {
    const url = c.url;
    row.title = 'Open on the forge';
    row.onclick = () => openCommit(url);
  } else {
    row.title = 'Not pushed yet — it has no page on the forge';
  }
  return row;
}

/**
 * What the card promises, given what it actually holds. Inviting a click when nothing is
 * clickable is the card lying about itself — measured on the session that first showed the
 * problem: one commit, freshly made, with no page to open.
 */
function describe(commits: readonly SessionCommit[]): string {
  if (commits.some((c) => c.url)) return 'Commits this session produced. Click one to open it on the forge.';
  return 'Commits this session produced. None is pushed yet, so none has a page to open.';
}

/** Every commit, oldest first: the drawer is the only place a long subject is not truncated. */
export function commitsList(commits: readonly SessionCommit[]): HTMLElement {
  const box = el('div', 'cmtdlist');
  for (const c of [...commits].reverse()) {
    const row = el('div', 'cmtdrow' + (c.url ? '' : ' nolink'));
    row.append(el('span', 'cmth', c.short));
    if (!c.url) row.append(el('span', 'cmtlocal', 'local'));
    row.append(el('span', 'cmts wrap', c.subject), el('span', 'cmtt', hhmm(c.at)));
    if (c.url) {
      const url = c.url;
      row.onclick = () => openCommit(url);
    }
    box.append(row);
  }
  return box;
}

/** How many rows the card shows before deferring to the drawer. */
export const CARD_ROWS = 4;

/**
 * Fill the card body: hero count, the newest `CARD_ROWS` commits, and a pointer to the drawer for
 * the rest. `data` null means the fetch has not answered yet — the card says so rather than
 * claiming zero, which would be a lie for the two seconds before the answer lands.
 */
export function renderCommitsCard(host: HTMLElement, data: SessionCommits | null, onExpand: () => void): void {
  host.replaceChildren();
  if (!data) {
    host.append(el('div', 'wdesc', 'Reading the repository…'));
    return;
  }
  const { commits } = data;
  if (!commits.length) {
    // "Refused" and "none" are not the same statement, and only one of them is the user's to act
    // on. This session ran `git commit` and its directory could not be entered — on macOS that is
    // a privacy gate on Documents/Desktop/Downloads, which stays shut until a dialog is answered.
    // Saying "no commits" there is the card asserting something it never checked.
    host.append(
      el(
        'div',
        'wdesc',
        data.denied
          ? 'Cannot read this session’s folder, so its commits are unknown. On macOS, allow access when the system asks — or grant it under Privacy & Security → Files and Folders.'
          : 'No commits in scope yet.',
      ),
    );
    return;
  }
  host.append(el('div', 'wdesc', describe(commits)));
  const num = el('div', 'num');
  num.append(
    document.createTextNode(String(commits.length)),
    el('small', undefined, commits.length === 1 ? 'commit' : 'commits'),
  );
  host.append(num);
  const list = el('div', 'cmtlist');
  for (const c of commits.slice(0, CARD_ROWS)) list.append(commitRow(c, false));
  host.append(list);
  if (commits.length > CARD_ROWS) {
    const more = el('div', 'cmtmore', `+ ${commits.length - CARD_ROWS} more →`);
    more.onclick = onExpand;
    host.append(more);
  }
}
