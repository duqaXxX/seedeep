import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NotifyWebhook } from '../src/server/config.ts';
import type { Announcement } from '../src/server/notify-watch.ts';
import { renderTemplate, sendWebhook } from '../src/server/notify-webhook.ts';

const announcement: Announcement = {
  kind: 'needsYou',
  sessionId: 'S1',
  project: 'atlas',
  subject: 'add a retry to the uploader',
  title: 'atlas — add a retry to the uploader',
  body: 'Waiting for your approval — Bash\nrm -rf build',
};

function hook(o: Partial<NotifyWebhook> = {}): NotifyWebhook {
  return {
    needsYou: true,
    fails: true,
    finishes: true,
    updates: false,
    url: 'https://example.test/hook',
    headers: {},
    template: '{{body}}',
    ...o,
  };
}

test('placeholders are substituted; an unknown one is left alone', () => {
  assert.equal(renderTemplate('{{title}}\n{{body}}', announcement), `${announcement.title}\n${announcement.body}`);
  assert.equal(
    renderTemplate('{{project}} / {{subject}} / {{kind}}', announcement),
    'atlas / add a retry to the uploader / needsYou',
  );
  // Left verbatim rather than blanked: a service whose payload legitimately contains braces must
  // not have them eaten, and a typo the user can SEE in the notification is one they can fix.
  assert.equal(renderTemplate('{{nope}}', announcement), '{{nope}}');
});

test('an empty template posts the body, so a URL alone is a working webhook', () => {
  assert.equal(renderTemplate('', announcement), announcement.body);
});

test('a null subject renders as empty, never as the word null', () => {
  assert.equal(renderTemplate('{{subject}}', { ...announcement, subject: null }), '');
});

test('the POST carries the rendered body and the configured headers', async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(url), init: init ?? {} };
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;

  const r = await sendWebhook(hook({ headers: { Title: 'seedeep', Authorization: 'Bearer t' } }), announcement, fake);

  assert.deepEqual(r, { ok: true, status: 200 });
  assert.equal(seen!.url, 'https://example.test/hook');
  assert.equal(seen!.init.method, 'POST');
  assert.equal(seen!.init.body, announcement.body);
  const headers = seen!.init.headers as Record<string, string>;
  assert.equal(headers['Title'], 'seedeep');
  assert.equal(headers['Authorization'], 'Bearer t');
});

test('a non-2xx answer is reported, not thrown', async () => {
  const fake = (async () => new Response('nope', { status: 429 })) as unknown as typeof fetch;
  assert.deepEqual(await sendWebhook(hook(), announcement, fake), { ok: false, status: 429 });
});

test('an unreachable endpoint is reported, not thrown', async () => {
  // A user's broken URL must never take down the notification path, and there is no retry: a
  // missed notification is better than a queue that replays a stale one later.
  const fake = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  assert.deepEqual(await sendWebhook(hook(), announcement, fake), { ok: false, status: null });
});

test('an unconfigured webhook is never called at all', async () => {
  let called = false;
  const fake = (async () => {
    called = true;
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;
  assert.deepEqual(await sendWebhook(hook({ url: '' }), announcement, fake), { ok: false, status: null });
  assert.equal(called, false);
});
