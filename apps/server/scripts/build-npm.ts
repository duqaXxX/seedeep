/**
 * Assembles the npm channel: the `seedeep` wrapper plus one package per platform, each carrying the
 * executable `build-binaries.ts` already compiled. Node is needed to INSTALL, never to run — the
 * wrapper's postinstall puts the native binary where npm linked `seedeep` onto PATH.
 *
 * It only ARRANGES files. Publishing is a separate, deliberate act (`release.yml`, and the first
 * one by hand): everything here can be proven with `npm pack` and a local install.
 *
 *   bun run build:server:all   # must come first — this reads dist/, it does not compile
 *   bun run build:npm          # writes dist/npm/<package>/ …
 *
 * That order is not interchangeable: `build-binaries.ts` wipes `dist/`, so building the binaries
 * afterwards would take these packages with it.
 */

import { chmod, cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VERSION } from '../src/server/version.ts';
import { BIN_PATH, NPM_DIR, npmManifests, WRAPPER } from './npm-manifests.ts';
import { TARGETS } from './targets.ts';

/** Where `build-binaries.ts` leaves the executables this reads. */
const DIST = 'dist';

/** The wrapper's own files, kept in the repo rather than generated — they are code, not manifest. */
const SOURCE_DIR = 'apps/server/npm';

/** Write a manifest with a trailing newline, the way every other JSON file in the repo ends. */
async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const { wrapper, platforms } = npmManifests(VERSION);

  // Checked before anything is written: a package published without its binary is the one failure
  // this whole channel cannot recover from, and `dist/` holding four of five is what a `--host`
  // build leaves behind.
  for (const target of TARGETS) {
    const binary = join(DIST, `seedeep-server_${VERSION}_${target.asset}`);
    if (!(await Bun.file(binary).exists())) {
      throw new Error(`missing ${binary} — run \`bun run build:server:all\` first`);
    }
  }

  await rm(NPM_DIR, { recursive: true, force: true });

  const wrapperDir = join(NPM_DIR, WRAPPER);
  await mkdir(join(wrapperDir, 'bin'), { recursive: true });
  await writeJson(join(wrapperDir, 'package.json'), wrapper);
  await cp(join(SOURCE_DIR, 'install.cjs'), join(wrapperDir, 'install.cjs'));
  await cp(join(SOURCE_DIR, 'README.md'), join(wrapperDir, 'README.md'));
  await cp('LICENSE', join(wrapperDir, 'LICENSE'));
  // The placeholder the `bin` field points at, and the postinstall overwrites. Executable, because
  // on a machine where the postinstall never ran this file is what `seedeep` runs.
  await cp(join(SOURCE_DIR, 'stub.sh'), join(wrapperDir, BIN_PATH));
  await chmod(join(wrapperDir, BIN_PATH), 0o755);
  console.log(`  → ${wrapperDir}`);

  for (const { target, manifest } of platforms) {
    const dir = join(NPM_DIR, manifest.name);
    await mkdir(join(dir, 'bin'), { recursive: true });
    await writeJson(join(dir, 'package.json'), manifest);
    await cp('LICENSE', join(dir, 'LICENSE'));
    await writeFile(
      join(dir, 'README.md'),
      `# ${manifest.name}\n\n` +
        `The [seedeep](https://github.com/duqaXxX/seedeep) server for ${target.label}.\n\n` +
        'This package carries nothing but that executable. Install `seedeep` instead — it picks\n' +
        'the right one for the machine it lands on:\n\n```sh\nnpm i -g seedeep\n```\n',
    );
    await cp(join(DIST, `seedeep-server_${VERSION}_${target.asset}`), join(dir, BIN_PATH));
    await chmod(join(dir, BIN_PATH), 0o755);
    console.log(`  → ${dir}`);
  }
}

await main();
