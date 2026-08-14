/**
 * The platforms the server is built for — ONE list, read by the compiler and by the npm packager
 * alike, so a target cannot exist as a download and be missing from the registry (or the reverse).
 *
 * Three names appear per platform because three systems name platforms differently: Bun's
 * `--target`, the file a human downloads, and npm's `os`/`cpu` pair. They are kept side by side
 * rather than derived from each other — `macos` and `darwin` are the same machine under two
 * vocabularies, and a mapping function would only hide that.
 */

export interface Target {
  /** Bun's `--target` value for `bun build --compile`. */
  bun: string;
  /** What the downloaded file is called, after `seedeep-server_<version>_`. */
  asset: string;
  /** The npm package that carries this binary, after `seedeep-`. */
  npm: string;
  /** npm's `os` value — Node's `process.platform`, which calls Windows `win32`. */
  os: string;
  /** npm's `cpu` value — Node's `process.arch`. */
  cpu: string;
  /** The platform in words, for the one-line description on the package's registry page. */
  label: string;
}

export const TARGETS: Target[] = [
  {
    bun: 'bun-darwin-arm64',
    asset: 'macos-arm64',
    npm: 'darwin-arm64',
    os: 'darwin',
    cpu: 'arm64',
    label: 'macOS on Apple Silicon',
  },
  {
    bun: 'bun-darwin-x64',
    asset: 'macos-x64',
    npm: 'darwin-x64',
    os: 'darwin',
    cpu: 'x64',
    label: 'macOS on Intel',
  },
  {
    bun: 'bun-linux-x64',
    asset: 'linux-x64',
    npm: 'linux-x64',
    os: 'linux',
    cpu: 'x64',
    label: 'Linux on x86-64 (glibc)',
  },
  {
    bun: 'bun-linux-arm64',
    asset: 'linux-arm64',
    npm: 'linux-arm64',
    os: 'linux',
    cpu: 'arm64',
    label: 'Linux on arm64 (glibc)',
  },
  {
    bun: 'bun-windows-x64',
    asset: 'windows-x64.exe',
    npm: 'windows-x64',
    os: 'win32',
    cpu: 'x64',
    label: 'Windows on x86-64',
  },
  {
    bun: 'bun-windows-arm64',
    asset: 'windows-arm64.exe',
    npm: 'windows-arm64',
    os: 'win32',
    cpu: 'arm64',
    label: 'Windows on arm64',
  },
];

/** The target matching the machine this runs on, or null when it is not one seedeep builds for. */
export function hostTarget(): Target | null {
  const os = { darwin: 'darwin', linux: 'linux', win32: 'win32' }[process.platform as string];
  return TARGETS.find((t) => t.os === os && t.cpu === process.arch) ?? null;
}
