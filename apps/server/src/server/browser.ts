import { spawn } from 'node:child_process';

export function openCommand(platform: NodeJS.Platform, url: string): string[] {
  switch (platform) {
    case 'darwin':
      return ['open', url];
    case 'win32':
      return ['cmd', '/c', 'start', '', url];
    default:
      return ['xdg-open', url];
  }
}

export function openBrowser(url: string, run: (argv: string[]) => void = defaultRun): void {
  run(openCommand(process.platform, url));
}

function defaultRun(argv: string[]): void {
  const [cmd, ...rest] = argv;
  spawn(cmd!, rest, { stdio: 'ignore', detached: true, windowsHide: true }).unref();
}
