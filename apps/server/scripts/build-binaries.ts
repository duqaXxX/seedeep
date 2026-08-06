/**
 * Builds the server as a standalone executable — the artifact a user downloads and runs, with no
 * Bun and no Node to install first (CLAUDE.md's distribution invariant).
 *
 * Run it, do not hand-roll the `bun build` line: the client bundle is rebuilt here, and a compile
 * that skips it embeds whatever `public/lib/app.js` happened to be lying around — a binary serving
 * a GUI from an older commit, which nothing downstream can detect.
 *
 *   bun run build:server        # this machine's target only
 *   bun run build:server:all    # every platform, cross-compiled from here
 */

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { VERSION } from '../src/server/version.ts';
import { hostTarget, TARGETS } from './targets.ts';

/** Where the executables land. Gitignored: a build artifact is never committed. */
const OUT_DIR = 'dist';

/** The entry point that becomes the executable. */
const ENTRY = 'apps/server/src/server/main.ts';

/**
 * What every file this produces is called, before the version and the platform.
 *
 * `seedeep-server`, never `seedeep`: a release page carries the tray's installers too, and two
 * macOS files sharing a `seedeep_<version>_` prefix say nothing about which one is the thing that
 * reads your sessions. The tray's own assets are renamed to match in `release.yml` — the app is
 * still called `seedeep` in the menu bar, since what needs disambiguating is the download, not the
 * product.
 */
const PREFIX = 'seedeep-server';

/**
 * Fail the build when an executable carries the path of the machine that produced it.
 *
 * A distributable that names a directory only the builder has is broken for everyone else, and it
 * is broken in the one way testing on the build machine can never reveal — there, the path exists.
 * That is exactly how v0.6.0 shipped five servers that died at startup. The check is crude on
 * purpose: any occurrence at all is the bug, and it is deterministic on any machine.
 */
async function assertNoBuildPath(outfile: string): Promise<void> {
  const bytes = Buffer.from(await Bun.file(outfile).arrayBuffer());
  if (!bytes.includes(Buffer.from(process.cwd()))) return;
  throw new Error(
    `${outfile} embeds this machine's path (${process.cwd()}) — it would look for it on the user's.\n` +
      '  A dependency is being resolved at runtime instead of bundled. Leave it out with\n' +
      '  `--external` and import it lazily, or stop importing it from code that runs at startup.',
  );
}

/** Run a command, streaming its output, and throw with the command line when it fails. */
async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: 'inherit', stderr: 'inherit' });
  if ((await proc.exited) !== 0) throw new Error(`failed: ${cmd.join(' ')}`);
}

async function main(): Promise<void> {
  const hostOnly = process.argv.includes('--host');
  const host = hostTarget();
  if (hostOnly && !host) throw new Error(`no seedeep target for ${process.platform}-${process.arch}`);
  const targets = hostOnly && host ? [host] : TARGETS;

  // The GUI the binary will carry, first: `assets.ts` embeds this file by path, so what is on disk
  // at compile time is what every download serves until the next release.
  await run(['bun', 'run', 'build:client']);

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  for (const target of targets) {
    const outfile = join(OUT_DIR, `${PREFIX}_${VERSION}_${target.asset}`);
    await run(['bun', 'build', '--compile', `--target=${target.bun}`, ENTRY, '--outfile', outfile]);
    await assertNoBuildPath(outfile);
    console.log(`  → ${outfile}`);
  }
}

await main();
