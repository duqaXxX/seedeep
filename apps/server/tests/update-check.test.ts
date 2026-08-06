import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { seedDeepDir } from '../src/server/config.ts';
import {
  compareVersions,
  RETRY_AFTER_FAILURE_MS,
  type Standing,
  TTL_MS,
  type UpdateStatus,
  updateCheckFile,
  updateNotice,
  updateStatus,
} from '../src/server/update-check.ts';

const T0 = Date.parse('2026-08-05T12:00:00.000Z');

/** A fetch that answers with a dist-tags body and counts how many times it was asked. */
function registry(latest: string) {
  let calls = 0;
  const impl = (async () => {
    calls++;
    return new Response(JSON.stringify({ latest }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}

const dead = (() => {
  let calls = 0;
  const impl = (async () => {
    calls++;
    throw new Error('getaddrinfo ENOTFOUND');
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
})();

async function withCache(fn: (file: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'seedeep-update-'));
  try {
    await fn(join(dir, 'update-check.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('the cache is the clock: one fetch an hour, however many callers', async () => {
  await withCache(async (file) => {
    const npm = registry('1.2.0');
    const ask = (now: number) => updateStatus({ file, version: '1.0.0', fetchImpl: npm.impl, now });

    assert.deepEqual(await ask(T0), {
      current: '1.0.0',
      latest: '1.2.0',
      standing: 'behind',
      checkedAt: '2026-08-05T12:00:00.000Z',
      reason: null,
    });
    // Four more callers within the hour — the registry is asked exactly once.
    for (const t of [T0 + 1, T0 + 1000, T0 + TTL_MS / 2, T0 + TTL_MS - 1]) await ask(t);
    assert.equal(npm.calls(), 1);

    await ask(T0 + TTL_MS + 1);
    assert.equal(npm.calls(), 2);
  });
});

// The cache outlives the binary that wrote it, so a stored standing would keep saying `behind` to
// an executable that has since been updated.
test('the standing is derived on read, never stored', async () => {
  await withCache(async (file) => {
    const npm = registry('1.2.0');
    const at = (version: string) => updateStatus({ file, version, fetchImpl: npm.impl, now: T0 });

    assert.equal((await at('1.0.0')).standing, 'behind');
    assert.equal((await at('1.2.0')).standing, 'current');
    assert.equal((await at('1.3.0')).standing, 'ahead');
    assert.equal(npm.calls(), 1);

    const onDisk = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(Object.keys(onDisk).sort(), ['checkedAt', 'latest']);
  });
});

test('an unreachable registry is a standing, not a throw — and does not retry every call', async () => {
  await withCache(async (file) => {
    const before = dead.calls();
    const ask = (now: number) => updateStatus({ file, version: '1.0.0', fetchImpl: dead.impl, now });

    assert.deepEqual(await ask(T0), {
      current: '1.0.0',
      latest: null,
      standing: 'unknown',
      checkedAt: null,
      reason: 'no network',
    });
    await ask(T0 + RETRY_AFTER_FAILURE_MS - 1);
    assert.equal(dead.calls() - before, 1, 'a failure is left alone for the cooldown');

    await ask(T0 + RETRY_AFTER_FAILURE_MS + 1);
    assert.equal(dead.calls() - before, 2);
  });
});

// An offline hour is not evidence that yesterday's answer was wrong.
test('a failed check keeps the last known version', async () => {
  await withCache(async (file) => {
    const npm = registry('1.2.0');
    await updateStatus({ file, version: '1.0.0', fetchImpl: npm.impl, now: T0 });

    const later = await updateStatus({ file, version: '1.0.0', fetchImpl: dead.impl, now: T0 + TTL_MS + 1 });
    assert.equal(later.latest, '1.2.0');
    assert.equal(later.standing, 'behind');
    assert.equal(later.checkedAt, '2026-08-05T12:00:00.000Z', 'the timestamp is the ANSWER, not the attempt');
  });
});

test('offline never touches the network, and still reports what is known', async () => {
  await withCache(async (file) => {
    const npm = registry('1.2.0');
    await updateStatus({ file, version: '1.0.0', fetchImpl: npm.impl, now: T0 });

    const status = await updateStatus({
      file,
      version: '1.0.0',
      fetchImpl: npm.impl,
      now: T0 + 10 * TTL_MS,
      offline: true,
    });
    assert.equal(npm.calls(), 1);
    assert.equal(status.latest, '1.2.0');
  });
});

test('a corrupt or missing cache costs a request, never an error', async () => {
  await withCache(async (file) => {
    await writeFile(file, 'not json at all');
    const npm = registry('1.2.0');
    assert.equal((await updateStatus({ file, version: '1.0.0', fetchImpl: npm.impl, now: T0 })).latest, '1.2.0');
  });
});

// A clock moved backwards leaves an age below zero, which is not freshness.
test('a timestamp in the future is refetched, not trusted', async () => {
  await withCache(async (file) => {
    await writeFile(file, JSON.stringify({ latest: '9.9.9', checkedAt: new Date(T0 + TTL_MS).toISOString() }));
    const npm = registry('1.2.0');
    assert.equal((await updateStatus({ file, version: '1.0.0', fetchImpl: npm.impl, now: T0 })).latest, '1.2.0');
  });
});

test('concurrent callers share one fetch', async () => {
  await withCache(async (file) => {
    const npm = registry('1.2.0');
    const all = await Promise.all(
      Array.from({ length: 5 }, () => updateStatus({ file, version: '1.0.0', fetchImpl: npm.impl, now: T0 })),
    );
    assert.equal(npm.calls(), 1);
    for (const s of all) assert.equal(s.latest, '1.2.0');
  });
});

test('versions compare by their numbers, and a prerelease suffix does not order anything', () => {
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1);
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(compareVersions('1.0.0-rc1', '1.0.0'), 0);
});

// The two ways a reachable registry still says nothing usable.
test('a bad status or a body naming no version is unreachable, with the reason kept', async () => {
  const answering = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  await withCache(async (file) => {
    const s = await updateStatus({ file, version: '1.0.0', fetchImpl: answering({ latest: '1.2.0' }, 503), now: T0 });
    assert.equal(s.standing, 'unknown');
    assert.match(s.reason ?? '', /answered 503/);
  });
  await withCache(async (file) => {
    const s = await updateStatus({ file, version: '1.0.0', fetchImpl: answering({}), now: T0 });
    assert.equal(s.standing, 'unknown');
    assert.match(s.reason ?? '', /named no version/);
  });
});

test('the notice speaks only when there is something to say', () => {
  const s = (current: string, latest: string | null, standing: Standing): UpdateStatus => ({
    current,
    latest,
    standing,
    checkedAt: null,
    reason: null,
  });
  assert.match(updateNotice(s('1.0.0', '1.2.0', 'behind')) ?? '', /1\.2\.0.*1\.0\.0/);
  assert.equal(updateNotice(s('1.2.0', '1.2.0', 'current')), null);
  assert.equal(updateNotice(s('1.0.0', null, 'unknown')), null);
  assert.equal(updateNotice(s('1.3.0', '1.2.0', 'ahead')), null);
});

// Asserted as a RELATION rather than an absolute path: `seedDeepDir` honours SEEDEEP_HOME, and a
// test that hardcodes `~/.seedeep` fails for anyone whose shell has the variable set.
test('the cache lives beside the rest of the state, wherever that is', () => {
  assert.equal(updateCheckFile('/home/dev'), join(seedDeepDir('/home/dev'), 'update-check.json'));
});

// Regression: the cooldown used to be dead whenever a `latest` had ever been cached. `isFresh` read
// `checkedAt ?? failedAt` and picked the TTL from which one existed — but a failure PRESERVES the old
// `checkedAt`, and a failure can only happen once that timestamp is already past the TTL. So every
// call after the first failure looked stale and went back to the network: an offline laptop paying
// the 3s timeout on every request. Measured before the fix: 4 attempts where 2 were due.
test('the failure cooldown holds even when a version is already cached', async () => {
  await withCache(async (file) => {
    const npm = registry('1.2.0');
    const before = dead.calls();
    await updateStatus({ file, version: '1.0.0', fetchImpl: npm.impl, now: T0 });

    // A failure is only reachable once the successful answer has expired.
    const failedAt = T0 + TTL_MS + 1;
    await updateStatus({ file, version: '1.0.0', fetchImpl: dead.impl, now: failedAt });
    assert.equal(dead.calls() - before, 1);

    await updateStatus({ file, version: '1.0.0', fetchImpl: dead.impl, now: failedAt + 1 });
    await updateStatus({ file, version: '1.0.0', fetchImpl: dead.impl, now: failedAt + RETRY_AFTER_FAILURE_MS - 1 });
    assert.equal(dead.calls() - before, 1, 'the cooldown absorbs both');

    await updateStatus({ file, version: '1.0.0', fetchImpl: dead.impl, now: failedAt + RETRY_AFTER_FAILURE_MS + 1 });
    assert.equal(dead.calls() - before, 2, 'and lets one through when it expires');
  });
});

// The last KNOWN version keeps being reported throughout, which is the other half of the contract.
test('a cached version survives a cooldown it is not refreshed during', async () => {
  await withCache(async (file) => {
    const npm = registry('1.2.0');
    await updateStatus({ file, version: '1.0.0', fetchImpl: npm.impl, now: T0 });
    const failedAt = T0 + TTL_MS + 1;
    await updateStatus({ file, version: '1.0.0', fetchImpl: dead.impl, now: failedAt });

    const during = await updateStatus({ file, version: '1.0.0', fetchImpl: dead.impl, now: failedAt + 60_000 });
    assert.equal(during.latest, '1.2.0');
    assert.equal(during.standing, 'behind');
    assert.equal(during.reason, 'no network');
  });
});
