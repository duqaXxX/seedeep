/**
 * Every file the browser GUI is made of, named one by one so the executable can carry them.
 *
 * `bun build --compile` embeds a file only when something IMPORTS it — a directory is not an
 * input. So the GUI's assets, which nothing in the server's code imports (the browser fetches them
 * over HTTP), would be missing from the binary: measured on a first compile, `/api/*` answered and
 * every static path 404'd. The `with { type: 'file' }` import is what puts them in, and it answers
 * with a path that is readable in BOTH worlds — the real file on disk under `bun start` (absolute,
 * whatever the cwd), `/$bunfs/root/…` inside the executable — so there is one static-serving path
 * and not a dev one beside a shipped one.
 *
 * The cost is that this list is hand-kept, and a file added to `public/` without a line here is a
 * file the GUI silently loses. `assets.test.ts` walks `public/` and fails on exactly that.
 */

import changedFilesCss from '../../public/css/changed-files.css' with { type: 'file' };
import chromeCss from '../../public/css/chrome.css' with { type: 'file' };
import commitsCss from '../../public/css/commits.css' with { type: 'file' };
import compareCss from '../../public/css/compare.css' with { type: 'file' };
import contextDialCss from '../../public/css/context-dial.css' with { type: 'file' };
import drawerCss from '../../public/css/drawer.css' with { type: 'file' };
import feedCss from '../../public/css/feed.css' with { type: 'file' };
import homeCss from '../../public/css/home.css' with { type: 'file' };
import layoutCss from '../../public/css/layout.css' with { type: 'file' };
import liveMonitorCss from '../../public/css/live-monitor.css' with { type: 'file' };
import nowPanelCss from '../../public/css/now-panel.css' with { type: 'file' };
import pickerCss from '../../public/css/picker.css' with { type: 'file' };
import searchCss from '../../public/css/search.css' with { type: 'file' };
import sessionCardsCss from '../../public/css/session-cards.css' with { type: 'file' };
import settingsCss from '../../public/css/settings.css' with { type: 'file' };
import timelineCss from '../../public/css/timeline.css' with { type: 'file' };
import toastsCss from '../../public/css/toasts.css' with { type: 'file' };
import tokensCss from '../../public/css/tokens.css' with { type: 'file' };
import traceCss from '../../public/css/trace.css' with { type: 'file' };
import trackerCardsCss from '../../public/css/tracker-cards.css' with { type: 'file' };
import utilitiesCss from '../../public/css/utilities.css' with { type: 'file' };
import faviconIco from '../../public/favicon.ico' with { type: 'file' };
import faviconSvg from '../../public/favicon.svg' with { type: 'file' };
import indexHtml from '../../public/index.html' with { type: 'file' };
// @ts-expect-error TypeScript resolves this to the client bundle `build:client` writes and objects
// that it is not a module. It is not imported AS one: the attribute above asks for its path. The
// two extensions TypeScript already has an opinion about are the two this file has to override —
// see `filePath` and `asset-imports.d.ts`.
import appJs from '../../public/lib/app.js' with { type: 'file' };

/**
 * The path Bun answers a `type: 'file'` import with, whatever TypeScript believes the specifier is.
 * It types these by EXTENSION, having no model for the attribute: `.html` comes back as
 * `bun-types`' `HTMLBundle` and `.js` as the client bundle. At runtime both are a string path.
 *
 * Named rather than inlined because an `as string` here is a claim about Bun's behaviour, and it is
 * the same claim in both places.
 */
const filePath = (imported: unknown): string => imported as string;

/**
 * URL path → the file that answers it. The keys are what a browser asks for, so `/` is absent:
 * it is resolved to `/index.html` by {@link assetPath}, which keeps the map one entry per file.
 */
export const ASSETS: ReadonlyMap<string, string> = new Map([
  ['/index.html', filePath(indexHtml)],
  ['/favicon.ico', faviconIco],
  ['/favicon.svg', faviconSvg],
  ['/lib/app.js', filePath(appJs)],
  ['/css/changed-files.css', changedFilesCss],
  ['/css/chrome.css', chromeCss],
  ['/css/commits.css', commitsCss],
  ['/css/compare.css', compareCss],
  ['/css/context-dial.css', contextDialCss],
  ['/css/drawer.css', drawerCss],
  ['/css/feed.css', feedCss],
  ['/css/home.css', homeCss],
  ['/css/layout.css', layoutCss],
  ['/css/live-monitor.css', liveMonitorCss],
  ['/css/now-panel.css', nowPanelCss],
  ['/css/picker.css', pickerCss],
  ['/css/search.css', searchCss],
  ['/css/session-cards.css', sessionCardsCss],
  ['/css/settings.css', settingsCss],
  ['/css/timeline.css', timelineCss],
  ['/css/toasts.css', toastsCss],
  ['/css/tokens.css', tokensCss],
  ['/css/trace.css', traceCss],
  ['/css/tracker-cards.css', trackerCardsCss],
  ['/css/utilities.css', utilitiesCss],
]);

/**
 * The file behind a request path, or null when nothing is mapped there.
 *
 * A lookup, not a filesystem walk, which is why the path-traversal guard this replaced is gone
 * rather than reimplemented: `/../etc/passwd` is simply not a key. It also means the server can
 * only ever serve what was compiled into it — a file dropped into `public/` at runtime is not
 * reachable, by construction.
 */
export function assetPath(pathname: string): string | null {
  return ASSETS.get(pathname === '/' ? '/index.html' : pathname) ?? null;
}
