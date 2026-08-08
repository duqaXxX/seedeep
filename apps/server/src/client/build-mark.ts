/**
 * The two marks the brand carries: the release this portal is served by, always, and — only on a
 * checkout — the chip that says it is not a release at all.
 *
 * Both seedeeps on a machine watch the SAME sessions — the transcripts belong to Claude Code, not
 * to seedeep — so a dev portal and an installed one show identical content, and the tab you are
 * about to change a setting in is a coin toss. The mark is the only thing that tells them apart.
 *
 * The TITLE first, because that is what a tab strip shows when the page itself is off screen, which
 * is exactly when the confusion happens. The chip is for when you are looking at it.
 *
 * The CHIP says nothing at all for a released build: a badge that is present on every install is a
 * badge nobody reads, and it would be claiming something about the user's setup rather than about
 * ours. The version label is the opposite case and is there on every portal — it is not a badge but
 * a fact, and it is the one number a bug report quotes.
 */

/** The chip's class, so the stylesheet and the test name the same thing. */
export const MARK_CLASS = 'build-mark';

/** The version label's class, named here for the same reason. */
export const VERSION_CLASS = 'version-mark';

/** What the title becomes, and what a tab strip therefore shows. */
export const DEV_TITLE = 'seedeep dev';

/**
 * The element the mark hangs on: the brand in the header. Narrow on purpose — this module needs to
 * append one node and nothing else, and a parameter typed to what it uses is a parameter a test can
 * satisfy without a browser.
 */
export interface MarkHost {
  append(node: unknown): void;
  querySelector(selector: string): unknown;
}

/**
 * Write the running server's version beside the brand, or leave the brand exactly as it was.
 *
 * `version` is the release the SERVER answering reported, never a number this bundle was built
 * from: `public/lib/` is a build artifact, so a stale `build:client` would otherwise print a
 * version nothing is running. Absent or empty means a server too old to report one, and that draws
 * nothing — a dash beside the wordmark reads as a broken page, and this is the value a bug report
 * quotes verbatim, so a guess here is worse than a silence.
 *
 * Idempotent, and independent of {@link markDevBuild}: on a checkout both marks show, version
 * first.
 */
export function markVersion(version: string | undefined, brand: MarkHost | null, doc: Document = document): void {
  if (!version || !brand || brand.querySelector(`.${VERSION_CLASS}`)) return;
  const label = doc.createElement('span');
  label.className = VERSION_CLASS;
  label.textContent = version;
  brand.append(label);
}

/**
 * Put the development mark on the page, or leave it exactly as it was.
 *
 * `brand` is passed in rather than looked up here: the fake DOM the tests run against understands
 * class selectors and not `header > strong`, and a module that reached for the second would be
 * untestable for the sake of one query app.ts is already the right place for.
 *
 * Idempotent: called once at startup today, and a second call must not stack a second chip.
 */
export function markDevBuild(dev: boolean, brand: MarkHost | null, doc: Document = document): void {
  if (!dev) return;
  doc.title = DEV_TITLE;
  if (!brand || brand.querySelector(`.${MARK_CLASS}`)) return;
  const chip = doc.createElement('span');
  chip.className = MARK_CLASS;
  chip.textContent = 'dev';
  // Titled, because "dev" alone says which build without saying what follows from it.
  chip.title = 'Served by a checkout, not by an installed release';
  brand.append(chip);
}
