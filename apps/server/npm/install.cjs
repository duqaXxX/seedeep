/**
 * The `seedeep` package's postinstall: it puts the platform's native executable where the `bin`
 * entry already points, so what npm linked onto PATH IS the server.
 *
 * Node is needed to INSTALL, never to RUN — that is the whole point of the channel, and it is why
 * this copies the binary over `bin/seedeep.exe` instead of leaving a JS launcher that would spawn
 * it. A launcher would also put a Node process between a supervisor and the server, which is
 * exactly what the tray's start/stop must not have to reason about.
 *
 * It never fetches anything: the binaries arrive as `optionalDependencies`, one per platform, each
 * declaring the `os`/`cpu` that npm resolves against. This script only chooses among what npm
 * already decided to place on disk.
 *
 * It is not guaranteed to run: bun blocks a dependency's lifecycle scripts by default (measured),
 * and `--ignore-scripts` exists everywhere. That is why the file it replaces is a placeholder that
 * explains itself rather than an empty one — see `stub.sh`.
 */

const { spawnSync } = require('node:child_process');
const { chmodSync, copyFileSync, linkSync, unlinkSync } = require('node:fs');
const { dirname, join } = require('node:path');

/**
 * npm's `os` values (Node's `process.platform`) mapped to the word used in a package NAME.
 * `win32` is the only one that differs: the platform packages are named after the system people
 * call it, and npm's own field keeps the value npm requires.
 */
const OS_NAMES = { darwin: 'darwin', linux: 'linux', win32: 'windows' };

/**
 * Where the executable sits in every package, the wrapper's and the platform's alike. One name on
 * every platform — including `.exe` on macOS and Linux, where it is meaningless — because the `bin`
 * field must point at a path that exists before this script runs, and npm's Windows shim is
 * generated from it at that moment (see `stub.sh` for why the extension is load-bearing).
 */
const BIN_PATH = join('bin', 'seedeep.exe');

/**
 * The package carrying the binary for a platform, or null when seedeep names no package for it.
 * Exported so a test can prove this agrees with the names the packager actually publishes — the two
 * are computed in different places and a rename that touched only one would strand every install.
 */
function platformPackage(platform, arch) {
  const os = OS_NAMES[platform];
  return os ? `seedeep-${os}-${arch}` : null;
}

/** True when this is an x64 Node being translated by Rosetta 2 on an Apple Silicon Mac. */
function underRosetta() {
  if (process.platform !== 'darwin' || process.arch !== 'x64') return false;
  const r = spawnSync('sysctl', ['-n', 'sysctl.proc_translated'], { encoding: 'utf8' });
  return r.stdout?.trim() === '1';
}

/**
 * Put `src` at `dest`, replacing whatever is there. Hardlink first — both live under the same
 * `node_modules`, so it is instant and costs no second copy of a 60 MB file — and fall back to a
 * copy when the filesystem refuses (a different device, or no permission to link).
 */
function placeBinary(src, dest) {
  try {
    // Linked BEFORE dest is touched: if src is missing, this throws and the stub survives to
    // explain itself, rather than leaving `seedeep` as a file that no longer exists.
    linkSync(src, dest);
  } catch (err) {
    if (err.code !== 'EEXIST' && err.code !== 'EXDEV' && err.code !== 'EPERM') throw err;
    if (err.code === 'EEXIST') {
      unlinkSync(dest);
      try {
        linkSync(src, dest);
      } catch {
        copyFileSync(src, dest);
      }
    } else {
      copyFileSync(src, dest);
    }
  }
  // The tarball's mode is not something to depend on; the file has to be executable either way.
  if (process.platform !== 'win32') chmodSync(dest, 0o755);
}

function main() {
  const manifest = require('./package.json');
  const supported = Object.keys(manifest.optionalDependencies || {});
  const name = platformPackage(process.platform, process.arch);

  // The wrapper's own `os`/`cpu` already refuse most platforms, with npm's own EBADPLATFORM, and
  // every combination those two independent lists admit as a cross product is now a package that
  // exists — so nothing reaches here today. It stays because the lists are independent: adding a
  // platform to one of them alone reopens the hole, which is precisely what left Windows on arm64
  // installable and unrunnable until Bun had a target for it. Failing is the honest answer — the
  // install cannot produce a runnable `seedeep`, and saying so now beats a command that is not one.
  if (!name || !supported.includes(name)) {
    console.error(`seedeep: no build for ${process.platform} ${process.arch}.`);
    console.error(`  Built for: ${supported.map((p) => p.replace(/^seedeep-/, '')).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  let src;
  try {
    src = join(dirname(require.resolve(`${name}/package.json`)), BIN_PATH);
  } catch {
    // Not a failure of the install: `--omit=optional` asked for exactly this, and so does a
    // registry that was unreachable for one package. The stub stays, and says the same thing when
    // the command is run.
    console.error(`seedeep: the platform package "${name}" is not installed.`);
    if (underRosetta()) {
      console.error('  This Node is x64 under Rosetta 2, so npm resolved the x64 build — while');
      console.error('  the machine is Apple Silicon, which seedeep builds for natively. Install an');
      console.error('  arm64 Node and reinstall to get the native binary.');
    } else {
      console.error('  It is skipped by --omit=optional; reinstall without it to get the server.');
    }
    return;
  }

  try {
    placeBinary(src, join(__dirname, BIN_PATH));
  } catch (err) {
    console.error(`seedeep: could not install the binary: ${err.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { OS_NAMES, BIN_PATH, platformPackage };
