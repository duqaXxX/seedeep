import type { NotifyWebhook } from './config.ts';
import type { Announcement } from './notify-watch.ts';

/**
 * How long a webhook has to answer before it is given up on.
 *
 * A notification is worth nothing late, and the engine must not be held while a user's endpoint
 * hangs — the next event would then be delayed by an address that may never answer at all.
 */
const TIMEOUT_MS = 5_000;

/** What the placeholders resolve to. Kept in one place so the panel's help text can name them. */
export const PLACEHOLDERS = ['title', 'body', 'project', 'subject', 'kind'] as const;

/**
 * Fill a user's template with one announcement's fields.
 *
 * An empty template renders the body alone, so pasting a URL is enough to have a working webhook.
 * An unknown placeholder is left VERBATIM rather than blanked: a service whose payload legitimately
 * contains braces must not have them eaten, and a typo the user can see in the notification they
 * received is one they can fix.
 */
export function renderTemplate(template: string, a: Announcement, contentType = ''): string {
  if (template === '') return a.body;
  // A JSON body needs its values escaped, and the values here are the least safe text in seedeep:
  // a prompt, and a shell command the user is being asked to approve. A quote or a newline in
  // either would produce a payload the service rejects — silently, since nothing here retries.
  // The content type the user declared is what says which escaping is right.
  const json = contentType.toLowerCase().includes('application/json');
  const enc = (v: string) => (json ? JSON.stringify(v).slice(1, -1) : v);
  const values: Record<string, string> = {
    title: enc(a.title),
    body: enc(a.body),
    project: enc(a.project),
    subject: enc(a.subject ?? ''),
    kind: a.kind,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => values[name] ?? whole);
}

/** The declared content type, whatever case the user typed the header name in. */
function findContentType(headers: Record<string, string>): string {
  return Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
}

/**
 * POST one announcement to the user's endpoint.
 *
 * Never throws and never retries: a broken URL must not take down the notification path, and a
 * missed notification is better than a queue that replays a stale one minutes later. The caller
 * gets the outcome so it can be logged once.
 *
 * `fetchImpl` is injectable so a test can assert what was sent without a network.
 */
export async function sendWebhook(
  cfg: NotifyWebhook,
  a: Announcement,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number | null }> {
  // An unconfigured channel is an absent one — not an error, and not a request.
  if (cfg.url === '') return { ok: false, status: null };
  try {
    const res = await fetchImpl(cfg.url, {
      method: 'POST',
      headers: { ...cfg.headers },
      body: renderTemplate(cfg.template, a, findContentType(cfg.headers)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: null };
  }
}
