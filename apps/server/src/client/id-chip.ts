// The session id, made useful. seedeep already printed the first 8 characters in the picker; the
// full uuid — the thing `claude --resume` and a grep of the transcripts actually need — was
// nowhere in the GUI. One component, used by every surface that shows the short form, so the id
// never becomes a copy-button in one place and dead text in another.

/** How long the chip stays in its confirmed state before showing the id again. */
const CONFIRM_MS = 1600;
/** Characters of the uuid shown at rest — the prefix the picker has always displayed. */
const SHORT = 8;

export interface IdChipOptions {
  /** Extra class on the button, for the host surface's own layout. */
  className?: string;
  /** Label shown while confirming. Defaults to `copied`. */
  confirmLabel?: string;
  /**
   * Show the WHOLE uuid instead of the 8-character prefix. The prefix identifies a session well
   * enough to tell two rows apart, but it is not what you paste into `claude --resume` — where the
   * row has the width, the id is worth reading without clicking first (the maintainer, 2026-07-29).
   */
  full?: boolean;
}

/**
 * A button showing `sessionId` — its first 8 characters, or the whole uuid with `full` — which
 * copies the FULL uuid on click and confirms for {@link CONFIRM_MS}. A copy the browser refuses
 * leaves the chip untouched: a chip that says "copied" over an empty clipboard is worse than one
 * that says nothing.
 */
export function createIdChip(sessionId: string, opts: IdChipOptions = {}): HTMLButtonElement {
  const label = opts.full ? sessionId : sessionId.slice(0, SHORT);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'idchip' + (opts.className ? ' ' + opts.className : '');
  btn.textContent = label;
  btn.title = `copy the full session id — ${sessionId}`;
  btn.setAttribute('aria-label', `copy the full session id ${sessionId}`);

  let timer: ReturnType<typeof setTimeout> | null = null;
  btn.onclick = (e: MouseEvent) => {
    // The chip lives inside rows that open a session on click; copying the id is not opening it.
    e.stopPropagation();
    const done = () => {
      if (timer !== null) clearTimeout(timer);
      btn.classList.add('copied');
      btn.textContent = opts.confirmLabel ?? 'copied';
      timer = setTimeout(() => {
        btn.classList.remove('copied');
        btn.textContent = label;
        timer = null;
      }, CONFIRM_MS);
    };
    const p = navigator.clipboard?.writeText(sessionId);
    if (p)
      p.then(done, () => {
        /* refused (no permission, insecure context): stay silent */
      });
  };
  return btn;
}
