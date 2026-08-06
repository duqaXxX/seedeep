/**
 * What is currently on the popover, so a reading that says nothing new leaves it alone.
 *
 * The panel is repainted by a clock — every second while it is open — and most of its surfaces are
 * ENTIRELY their status: nothing on a connection screen moves unless the status itself changes.
 * Rebuilding them anyway is not merely wasted work, it destroys the state the DOM is holding for
 * the user. It cost the tray its URL field: every keystroke was followed within a second by a fresh
 * `<input>`, so a remote server could not be typed in at all.
 *
 * A node, not a string: this owns the decision, never the markup.
 */

/** The part of a container this needs — a fake in tests, `HTMLElement` in the app. */
export interface Root {
  replaceChildren(node: never): void;
}

export class Surface {
  /** The key of what is on screen, or `null` when what is there answers to no key. */
  private painted: string | null = null;

  constructor(private readonly root: Root) {}

  /**
   * Draw unconditionally, and forget the key. Every surface that is NOT purely its status goes
   * through here — the live bands, whose data really does change each tick, and the transient
   * "Looking for seedeep…". Forgetting matters: without it, a status that comes back UNCHANGED
   * after one of those would be skipped, and the panel would sit on "Connecting…" for good.
   */
  put(node: unknown): void {
    this.root.replaceChildren(node as never);
    this.painted = null;
  }

  /**
   * Draw only if `key` differs from what is on screen. Returns whether it drew, which is what a
   * test can assert without reaching into the DOM.
   */
  putIfChanged(key: string, build: () => unknown): boolean {
    if (key === this.painted) return false;
    this.root.replaceChildren(build() as never);
    this.painted = key;
    return true;
  }
}
