/**
 * The manifests the npm channel publishes, as data — separated from the packager that writes them
 * so they can be asserted without compiling five executables first.
 *
 * The shape is the one Claude Code itself ships with (verified on the registry, 2.1.220): a wrapper
 * whose `bin` points at a file inside itself, and one `optionalDependency` per platform carrying
 * the real executable. npm resolves those against each package's `os`/`cpu`, so a machine downloads
 * one binary, not five.
 */

import { TARGETS, type Target } from './targets.ts';

/** The package a user installs. Every other one is an implementation detail of this one. */
export const WRAPPER = 'seedeep';

/** Where `build-npm.ts` assembles the packages. Under `dist/`, so it is gitignored. */
export const NPM_DIR = 'dist/npm';

/**
 * The executable's path inside every package, wrapper and platform alike.
 *
 * `.exe` on macOS and Linux too, where the extension means nothing: it is what makes npm's Windows
 * shim exec the file directly rather than hand it to an interpreter, and the shim is generated from
 * the placeholder before the postinstall has replaced it. `apps/server/npm/stub.sh` carries the
 * whole reason, because that file is where getting it wrong would be invisible.
 */
export const BIN_PATH = 'bin/seedeep.exe';

/** The public repository — the only URL these packages carry. */
const REPO = 'https://github.com/duqaXxX/seedeep';

/**
 * Fields identical on all six manifests. `author` deliberately carries a name and NO email: the
 * registry takes the maintainer address from the npm ACCOUNT, and a personal address in a
 * versioned file is a leak the pre-commit hook is right to refuse.
 */
const COMMON = {
  license: 'MIT',
  author: 'duqaXxX (https://github.com/duqaXxX)',
  homepage: `${REPO}#readme`,
  repository: { type: 'git', url: `git+${REPO}.git` },
  bugs: { url: `${REPO}/issues` },
};

export interface PlatformPackage {
  /** The platform this package exists for. */
  target: Target;
  /** Its `package.json`, ready to write. */
  manifest: Record<string, unknown> & { name: string };
}

/** The npm channel's manifests for one version: the wrapper, and one package per platform. */
export function npmManifests(version: string): {
  wrapper: Record<string, unknown>;
  platforms: PlatformPackage[];
} {
  const platforms: PlatformPackage[] = TARGETS.map((target) => ({
    target,
    manifest: {
      name: `${WRAPPER}-${target.npm}`,
      version,
      description: `The seedeep server executable for ${target.label}.`,
      ...COMMON,
      os: [target.os],
      cpu: [target.cpu],
      files: ['bin'],
    },
  }));

  const wrapper = {
    name: WRAPPER,
    version,
    description: 'Live context & subagent visualizer for Claude Code — see deep into your agent.',
    keywords: ['claude-code', 'claude', 'observability', 'context-window', 'subagents', 'cli'],
    ...COMMON,
    bin: { [WRAPPER]: BIN_PATH },
    // Not a build step to skip: without it the placeholder stays on PATH and `seedeep` explains
    // itself instead of running. `install.cjs` is the whole channel's moving part.
    scripts: { postinstall: 'node install.cjs' },
    // Exact versions, never a range: the wrapper and its binary are the same build, and one tag
    // publishes both. A caret here would let npm pair a wrapper with an older executable.
    optionalDependencies: Object.fromEntries(platforms.map((p) => [p.manifest.name, version])),
    // npm refuses the install outright on anything outside these — the error names the platform,
    // which is the point. They are a cross product, so they admit one combination seedeep does not
    // build (Windows on arm64); the postinstall is what refuses that one.
    os: [...new Set(TARGETS.map((t) => t.os))],
    cpu: [...new Set(TARGETS.map((t) => t.cpu))],
    engines: { node: '>=18' },
    files: ['bin', 'install.cjs'],
  };

  return { wrapper, platforms };
}
