import pkg from '../../../../package.json';

/**
 * The version this build IS — the one number both apps show.
 *
 * Imported, not read from disk at runtime: the server ships as a `bun build --compile` executable
 * with no `package.json` beside it, and a static import is inlined into the bundle (verified: a
 * compiled binary prints the value with no manifest in its cwd). The tray reaches the same number by
 * a different road — `tauri.conf.json > version` points at this very file, which tauri resolves at
 * build time — so one tag cannot produce two versions.
 */
export const VERSION: string = pkg.version;

/**
 * Whether this process is a CHECKOUT rather than a released executable.
 *
 * `Bun.embeddedFiles` is Bun's own answer to "am I a standalone binary": every file compiled in
 * with `with { type: 'file' }` is in it, and there are none when the same code runs from source
 * (measured on bun 1.3.13 — 0 from `bun run`, 1 from `bun build --compile`, on a probe built for
 * this). Preferred over testing an asset path for `/$bunfs/`, which is an internal spelling that
 * differs on Windows and would make the answer a guess there.
 *
 * NOT `SEEDEEP_HOME`: a user is entitled to move their state without their portal calling itself a
 * development build. This is a fact about how the binary was produced.
 */
export const FROM_SOURCE: boolean = Bun.embeddedFiles.length === 0;
