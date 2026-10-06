/**
 * Opening a URL in the person's browser, shared by the init-offense wizard
 * (cli/wizard-io.ts) and `bun github:review-app`. The caller always prints
 * the URL too, so a missing opener costs nothing.
 */
import { spawn } from 'node:child_process';

/** `open` / `xdg-open` / `start` for the platform. */
export function openerCommand(
  platform: string,
  url: string,
): readonly string[] {
  if (platform === 'darwin') return ['open', url];
  if (platform === 'win32') return ['cmd', '/c', 'start', '', url];
  return ['xdg-open', url];
}

/** Opens `url` detached; never throws. */
export function openInBrowser(url: string): void {
  const [file = '', ...args] = openerCommand(process.platform, url);
  try {
    spawn(file, args, { stdio: 'ignore', detached: true })
      .on('error', () => {})
      .unref();
  } catch {
    // The URL is printed beside every open.
  }
}
