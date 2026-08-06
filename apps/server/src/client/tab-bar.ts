// Renders the tab strip. Emits intent via callbacks; owns no data.
//
// State is carried by CLASSES, never by words in the label. '· ended' ate the horizontal
// room the subject needs, and the strip is where you find a session at a glance:
//   dot PULSE  → whether it is generating right now
//   dot AMBER  → it stopped and is waiting for YOU (an approval, or an answer)
//   dot RED    → its last model call FAILED and nothing has succeeded since
//   tab dimmed → ended; everything in it is frozen history, which is a property of the
//                whole tab, not a badge to hang off it
//
// Waiting and failed reuse the busy dot rather than adding a second marker: they are the
// same question ("what is this session doing?"), and two dots would make the strip a
// dashboard. Precedence red > amber > pulse, decided by the CSS order, so a poll that
// momentarily sets two of them still says the more serious thing.
//
// `title` still spells the ended state out on hover (and to assistive tech), and gives the
// 30-char-cut label its full text back for free. A class is never the only channel.
import type { PendingKind } from './sessions.ts';

interface Tab {
  el: HTMLElement;
  busy: HTMLElement;
  name: HTMLElement;
  label: string;
  waiting: PendingKind | null;
  failed: boolean;
}

/**
 * Tab strip over `container`; emits switch/close intent, owns no session data.
 * Sessions only — the fixed surfaces live in the header menu (see nav-menu.ts), which is why
 * `setActive` accepts an id the strip holds no tab for and simply lights nothing.
 */
export function createTabBar(
  container: HTMLElement,
  { onSwitch, onClose }: { onSwitch: (sessionId: string) => void; onClose: (sessionId: string) => void },
) {
  const tabs = new Map<string, Tab>();
  let activeId: string | null = null;

  function render() {
    for (const [id, t] of tabs) t.el.classList.toggle('active', id === activeId);
  }
  // A class is never the only channel — the state is spelled out on hover and to assistive tech.
  // Failed comes first for the same reason it wins in the CSS: it is the more serious answer to
  // the one question the strip asks.
  const titleFor = (label: string, ended: boolean | undefined, waiting: PendingKind | null = null, failed = false) =>
    label +
    (ended
      ? ' — ended'
      : failed
        ? ' — its last API call failed'
        : waiting === 'permission'
          ? ' — waiting for your approval'
          : waiting === 'input'
            ? ' — waiting for your answer'
            : '');
  return {
    add(sessionId: string, { label, ended, busy: isBusy }: { label: string; ended?: boolean; busy?: boolean }) {
      if (tabs.has(sessionId)) return;
      const el = document.createElement('div');
      el.className = 'tab' + (ended ? ' ended' : '');
      el.title = titleFor(label, ended);
      const busy = document.createElement('span');
      busy.className = 'tab-busy' + (isBusy && !ended ? ' on' : ''); // lit while the session generates
      const name = document.createElement('span');
      name.textContent = label;
      const closeEl = document.createElement('button');
      closeEl.className = 'tab-close';
      closeEl.textContent = '×';
      closeEl.onclick = (e) => {
        e.stopPropagation();
        onClose(sessionId);
      };
      el.onclick = () => onSwitch(sessionId);
      el.append(busy, name, closeEl);
      container.append(el);
      tabs.set(sessionId, { el, busy, name, label, waiting: null, failed: false });
      render();
    },
    setEnded(sessionId: string) {
      const t = tabs.get(sessionId);
      if (!t) return;
      t.waiting = null; // nobody is waiting on a session that is gone
      t.failed = false; // nor can a closed session still be failing: the tab is history now
      t.busy.classList.remove('wait', 'err');
      // A class, so this is idempotent by construction — no `ended` flag to keep, and the
      // old hazard is gone with the text: a project NAMED 'extended-api' once suppressed
      // the marker forever, because the guard read the label instead of tracking state.
      t.el.classList.add('ended');
      t.el.title = titleFor(t.label, true);
      t.busy.classList.remove('on'); // a closed session is never busy
    },
    setBusy(sessionId: string, busy: boolean) {
      const t = tabs.get(sessionId);
      if (t) t.busy.classList.toggle('on', busy);
    },
    /**
     * The session is blocked on the user (or no longer is). Survives a tab switch, unlike
     * a toast: the strip is the only surface that keeps saying so until it is answered.
     */
    setWaiting(sessionId: string, waiting: PendingKind | null) {
      const t = tabs.get(sessionId);
      if (!t || t.el.classList.contains('ended')) return;
      t.waiting = waiting;
      t.busy.classList.toggle('wait', waiting !== null);
      t.el.title = titleFor(t.label, false, waiting, t.failed);
    },
    /**
     * The session's last model call failed (or one has since succeeded). Like `setWaiting`, this
     * survives a tab switch — a toast scrolls away, and a session nobody is looking at is exactly
     * the one that stays broken unnoticed.
     */
    setFailed(sessionId: string, failed: boolean) {
      const t = tabs.get(sessionId);
      if (!t || t.el.classList.contains('ended')) return;
      // Unlike the roster-driven setters beside it, this one is called on EVERY applied event (the
      // reducer notifies per event, and a backgrounded tab cannot wait for a frame), so an unchanged
      // value must cost nothing: a replay of a long session would otherwise rewrite the class and
      // the title thousands of times to say what they already said.
      if (t.failed === failed) return;
      t.failed = failed;
      t.busy.classList.toggle('err', failed);
      t.el.title = titleFor(t.label, false, t.waiting, failed);
    },
    /** Update the tab label when the session subject becomes available after the initial open. */
    setLabel(sessionId: string, label: string) {
      const t = tabs.get(sessionId);
      if (!t || t.label === label) return;
      t.label = label;
      t.name.textContent = label;
      t.el.title = titleFor(label, t.el.classList.contains('ended'), t.waiting, t.failed);
    },
    setActive(sessionId: string) {
      activeId = sessionId;
      render();
    },
    remove(sessionId: string) {
      const t = tabs.get(sessionId);
      if (t) {
        t.el.remove();
        tabs.delete(sessionId);
      }
    },
  };
}
