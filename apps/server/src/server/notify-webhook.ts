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
export function renderTemplate(template: string, a: Announcement): string {
  if (template === '') return a.body;
  const values: Record<string, string> = {
    title: a.title,
    body: a.body,
    project: a.project,
    subject: a.subject ?? '',
    kind: a.kind,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => values[name] ?? whole);
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
      body: renderTemplate(cfg.template, a),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: null };
  }
}
