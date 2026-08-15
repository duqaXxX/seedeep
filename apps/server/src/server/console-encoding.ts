/**
 * Make what seedeep prints readable on a Windows console.
 *
 * A Windows console runs in a legacy code page unless something changes it — CP850 or CP437 under
 * `cmd`, CP1252 elsewhere — and seedeep writes UTF-8. So the characters it separates its lines with
 * arrive as `ΓÇö` and `â€"`. Measured on Windows 11, 2026-08-14: every line of every capture.
 * Invisible on macOS and Linux, which is how it shipped.
 *
 * **The table is measured, not imagined.** It came from running the CLI and reading what actually
 * left the process — `--help`, `--version`, `status`, `update` — plus the three sites a console run
 * cannot reach here (`restart` and `self-update` print `→`, `report` prints `≥`). Five characters.
 * The `▲ ✓ 🔒 × ↔` in `core/` never come near a console: they are rendered in the browser and in the
 * share card, where UTF-8 is not in question. A first attempt at this claimed one character on a
 * count of source lines rather than of printed output, and was wrong.
 *
 * **It wraps `console`, not the streams.** In Bun `console.log` does NOT route through
 * `process.stdout.write` — verified on 1.3.13 — so wrapping the streams translated nothing at all
 * while its test, which only ever wrote to a fake stream, passed. seedeep prints through
 * `console.log`, `console.error` and `console.warn` and through nothing else.
 *
 * One boundary rather than the ~70 sites that build these strings: a rule enforced in one place
 * cannot be forgotten by the next line somebody writes, and spelling the separators ASCII in the
 * sources would take the typography off macOS and Linux too, where it renders correctly.
 *
 * Setting the console's code page to UTF-8 would be the other repair, and it is not taken: it needs
 * `SetConsoleOutputCP` through FFI in a cross-compiled binary, and nothing here could verify it.
 */

// LIMIT: the table is seedeep's own typography, and it is applied to every string printed — the
// data included. So a commit subject or a project path carrying one of these five is rewritten too,
// which is harmless for a separator and a liberty on somebody else's text; while an accented
// directory or a curly apostrophe, which are not in the table, still garbles. Both halves of that
// need the console's code page set to UTF-8 (`SetConsoleOutputCP` through FFI), which is declined
// above — a longer table would fix neither.
/** What a legacy Windows console cannot show, and what it is spelled as instead. */
const ASCII: ReadonlyArray<readonly [string, string]> = [
  ['—', '-'],
  ['…', '...'],
  ['·', '-'],
  ['→', '->'],
  ['≥', '>='],
];

/** Spell `text` for a console that cannot show those five. Pure, so the table itself is testable. */
export function asciiFallback(text: string): string {
  let out = text;
  for (const [from, to] of ASCII) out = out.replaceAll(from, to);
  return out;
}

/** The console methods seedeep prints through, and the only ones this touches. */
export interface ConsoleLike {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

/**
 * Apply {@link asciiFallback} to everything `target` prints, on Windows only. Returns true when it
 * wrapped.
 *
 * Off Windows it does nothing at all — not even wrap — because a console that renders these
 * correctly should receive them. Strings only: an argument that is not a string was not encoded
 * here, and rewriting bytes it did not encode is how an encoder becomes a corruption.
 */
export function useAsciiConsole(
  target: ConsoleLike = console,
  platform: string = process.platform,
  isTty: boolean = process.stdout.isTTY === true,
): boolean {
  // A CONSOLE, not a redirect. The tray starts the server with its output going to `server.log`, and
  // `seedeep start` does the same: those are UTF-8 files that no code page touches, and degrading
  // them would be this module doing to a file what it exists to prevent on a terminal. It also
  // keeps the rewrite off anything piped into another program.
  if (platform !== 'win32' || !isTty) return false;
  for (const name of ['log', 'error', 'warn'] as const) {
    const original = target[name].bind(target);
    target[name] = (...args: unknown[]) => original(...args.map((a) => (typeof a === 'string' ? asciiFallback(a) : a)));
  }
  return true;
}
