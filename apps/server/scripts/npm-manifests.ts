/**
 * The manifests the npm channel publishes, as data — separated from the packager that writes them
 * so they can be asserted without compiling six executables first.
 *
 * The shape is the one Claude Code itself ships with (verified on the registry, 2.1.220): a wrapper
 * whose `bin` points at a file inside itself, and one `optionalDependency` per platform carrying
 * the real executable. npm resolves those against each package's `os`/`cpu`, so a machine downloads
 * one binary, not six.
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
 * Fields identical on all seven manifests — the six platform packages and the wrapper. `author`
 * deliberately carries a name and NO email: the
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
    description:
      'Live context-window & subagent visualizer for Claude Code. Reads your local session logs — nothing leaves your machine.',
    // The same list as the repository's GitHub topics, deliberately: they are the two shop windows
    // of one project, and a term that earns a search on one earns it on the other. The one topic
    // held back is `node`, which says nothing on a registry where every package is a Node package.
    // The order is measured rather than alphabetical — the narrow terms first. On npm this package
    // sits at #16 of the 426 carrying `context-window` and past #50 of the 19160 carrying
    // `claude-code` (measured 2026-08-12): a page small enough to be browsed to the end is the only
    // one where being found is a matter of being listed at all.
    keywords: [
      'llm-observability',
      'agent-observability',
      'context-window',
      'subagents',
      'token-usage',
      'usage-tracking',
      'cost-tracking',
      'context-engineering',
      'agentic-coding',
      'ai-coding',
      'claude-code',
      'claude',
      'anthropic',
      'ai-agents',
      'llm',
      'observability',
      'developer-tools',
      'typescript',
      'bun',
    ],
    ...COMMON,
    bin: { [WRAPPER]: BIN_PATH },
    // Not a build step to skip: without it the placeholder stays on PATH and `seedeep` explains
    // itself instead of running. `install.cjs` is the whole channel's moving part.
    scripts: { postinstall: 'node install.cjs' },
    // Exact versions, never a range: the wrapper and its binary are the same build, and one tag
    // publishes both. A caret here would let npm pair a wrapper with an older executable.
    optionalDependencies: Object.fromEntries(platforms.map((p) => [p.manifest.name, version])),
    // npm refuses the install outright on anything outside these — the error names the platform,
    // which is the point. npm reads them as a cross product, so a platform present in one list and
    // absent from the other is an install that begins and cannot finish: that was Windows on arm64
    // until Bun had a target for it. Every combination is a package today, and a test asserts it.
    os: [...new Set(TARGETS.map((t) => t.os))],
    cpu: [...new Set(TARGETS.map((t) => t.cpu))],
    engines: { node: '>=18' },
    files: ['bin', 'install.cjs'],
  };

  return { wrapper, platforms };
}
