import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { SessionRecord } from '../src/core/types.ts';
import { defaultConfig } from '../src/server/config.ts';
import type { DigestEntry } from '../src/server/digest.ts';
import { createNotifyEngine } from '../src/server/notify-engine.ts';
import { startServer } from '../src/server/server.ts';

function entry(o: { id: string; status: DigestEntry['status']; waitingFor?: string }): DigestEntry {
  return {
    sessionId: o.id,
    project: 'atlas',
    subject: 'add a retry to the uploader',
    status: o.status,
    waitingFor: o.waitingFor ?? null,
    pendingTool: null,
    error: null,
    turn: { state: 'done', now: { text: '' } },
  } as unknown as DigestEntry;
}

function notifications() {
  return defaultConfig('/home/dev').notifications;
}

test('the engine gates delivery per channel', () => {
  const delivered: Array<[string, string]> = [];
  const config = notifications();
  config.tray = { needsYou: true, fails: false, finishes: false, updates: true };
  config.webhook = { ...config.webhook, url: '', needsYou: true };
  const engine = createNotifyEngine({ config: () => config, deliver: (a, ch) => delivered.push([ch, a.kind]) });
  engine.feed([entry({ id: 'a', status: 'busy' })]);
  engine.feed([entry({ id: 'a', status: 'waiting', waitingFor: 'permission prompt' })]);
  // The webhook wants this kind but has no URL: an unconfigured channel is an absent one.
  assert.deepEqual(delivered, [['tray', 'needsYou']]);
});

test('a configured webhook gets its own switches, independent of the tray', () => {
  const delivered: Array<[string, string]> = [];
  const config = notifications();
  config.tray = { needsYou: false, fails: true, finishes: true, updates: true };
  config.webhook = { ...config.webhook, url: 'https://example.test/hook', needsYou: true };
  const engine = createNotifyEngine({ config: () => config, deliver: (a, ch) => delivered.push([ch, a.kind]) });
  engine.feed([entry({ id: 'a', status: 'busy' })]);
  engine.feed([entry({ id: 'a', status: 'waiting', waitingFor: 'permission prompt' })]);
  assert.deepEqual(delivered, [['webhook', 'needsYou']], 'per channel means the two can disagree');
});

test('turning a switch on does not replay what happened while it was off', () => {
  // The bookkeeping runs whatever the switches say. Gating the PRODUCTION of an event instead
  // would make switching a notification back on announce every session that had been waiting all
  // along — the exact lie the seed rule exists to prevent.
  const delivered: string[] = [];
  const config = notifications();
  config.tray = { needsYou: false, fails: true, finishes: true, updates: true };
  const engine = createNotifyEngine({ config: () => config, deliver: (a) => delivered.push(a.kind) });
  engine.feed([entry({ id: 'a', status: 'busy' })]);
  engine.feed([entry({ id: 'a', status: 'waiting', waitingFor: 'permission prompt' })]);
  assert.deepEqual(delivered, []);

  config.tray.needsYou = true;
  engine.feed([entry({ id: 'a', status: 'waiting', waitingFor: 'permission prompt' })]);
  assert.deepEqual(delivered, [], 'the wait is not new — it was tracked while the switch was off');
});

test('a reading it could not make re-seeds instead of announcing', () => {
  const delivered: string[] = [];
  const config = notifications();
  const engine = createNotifyEngine({ config: () => config, deliver: (a) => delivered.push(a.kind) });
  engine.feed([entry({ id: 'a', status: 'busy' })]);
  engine.feed(null);
  engine.feed([entry({ id: 'a', status: 'idle' })]);
  assert.deepEqual(delivered, []);
});

test('a failing deliverer never stops the others, nor the bookkeeping', () => {
  // A user's broken webhook must not take the tray's banner down with it.
  const delivered: string[] = [];
  const config = notifications();
  config.tray = { needsYou: true, fails: true, finishes: true, updates: true };
  config.webhook = { ...config.webhook, url: 'https://example.test/hook', needsYou: true };
  const engine = createNotifyEngine({
    config: () => config,
    deliver: (a, ch) => {
      if (ch === 'webhook') throw new Error('ECONNREFUSED');
      delivered.push(`${ch}:${a.kind}`);
    },
  });
  engine.feed([entry({ id: 'a', status: 'busy' })]);
  engine.feed([entry({ id: 'a', status: 'waiting', waitingFor: 'permission prompt' })]);
  assert.deepEqual(delivered, ['tray:needsYou']);
  // And the transition was still recorded: the same state is not announced twice.
  engine.feed([entry({ id: 'a', status: 'waiting', waitingFor: 'permission prompt' })]);
  assert.deepEqual(delivered, ['tray:needsYou']);
});

test('nobody to tell means nothing to evaluate — but the reading still seeds', () => {
  // The tray channel is worth evaluating only when a client is subscribed: a closed tray has no
  // one to deliver to, and an open one is already asking for the digest itself. This is what keeps
  // an unwatched process idle when the webhook is off.
  const delivered: string[] = [];
  const config = notifications();
  config.webhook = { ...config.webhook, url: '' };
  const engine = createNotifyEngine({
    config: () => config,
    deliver: (a) => delivered.push(a.kind),
    hasListeners: () => false,
  });
  assert.equal(engine.wanted(), false, 'no subscriber and no webhook URL: nothing to do');
  config.webhook.url = 'https://example.test/hook';
  assert.equal(engine.wanted(), true, 'a configured webhook is a destination off this machine');
});

test('the server really emits a notification on the stream when a session stops on you', async () => {
  // The unit tests above prove the engine decides correctly; this proves it is CONNECTED — that a
  // transcript event reaches it and its verdict reaches a subscriber. A wiring nobody drives is the
  // failure a passing unit test cannot see.
  const watcher = new EventEmitter();
  let status: SessionRecord['status'] = 'busy';
  const session = (): SessionRecord => ({
    sessionId: 'S1',
    project: 'atlas',
    model: 'm',
    lastActivity: Date.now(),
    isActive: true,
    isOpen: true,
    status,
    waitingFor: status === 'waiting' ? 'permission prompt' : null,
    waitingSince: null,
    subject: 'add a retry to the uploader',
    entrypoint: 'cli',
    root: 'cli',
    path: '/x/S1.jsonl',
  });
  const srv = await startServer({ watcher, discover: async () => [session()], port: 0 });
  try {
    // A subscriber has to exist, or the engine correctly decides there is nobody to tell.
    const res = await fetch(`${srv.url}/api/stream`);
    const reader = res.body!.getReader();
    const seen: string[] = [];
    const pump = (async () => {
      const decoder = new TextDecoder();
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) return;
        seen.push(decoder.decode(value));
        if (seen.join('').includes('event: notification')) return;
      }
    })();

    watcher.emit('event', { type: 'tick', sessionId: 'S1' });
    await new Promise((r) => setTimeout(r, 500));
    status = 'waiting';
    watcher.emit('event', { type: 'tick', sessionId: 'S1' });
    await pump;
    await reader.cancel().catch(() => {});

    const frames = seen.join('');
    assert.ok(frames.includes('event: notification'), `no notification frame in:\n${frames.slice(0, 400)}`);
    assert.ok(frames.includes('Waiting for your approval'), "and it carries the panel's own words");
  } finally {
    srv.stop();
  }
});
