import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ClaimResult } from '../probe/verify.ts';
import { closeWithEvidence } from '../probe/verify.ts';
import type { Claim } from '../src/server/schema-contract.ts';
import { evidenceForVersion, versionsIn } from '../src/server/schema-evidence.ts';

const line = (o: any) => JSON.stringify(o);

async function fakeRoot(
  sessions: Record<string, { parent: any[]; children?: Record<string, any[]> }>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'seedeep-ev-'));
  const slug = join(root, 'proj');
  await mkdir(slug, { recursive: true });
  for (const [uuid, s] of Object.entries(sessions)) {
    await writeFile(join(slug, `${uuid}.jsonl`), s.parent.map(line).join('\n') + '\n');
    for (const [agentId, lines] of Object.entries(s.children ?? {})) {
      const dir = join(slug, uuid, 'subagents');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `agent-${agentId}.jsonl`), lines.map(line).join('\n') + '\n');
      await writeFile(join(dir, `agent-${agentId}.meta.json`), line({ toolUseId: 'tu-1' }));
    }
  }
  return root;
}

const claim = (holds: (c: any) => boolean): Claim => ({
  id: 'CX',
  scene: 1,
  describe: 'x',
  reader: 'parser.ts:1',
  investigate: 'look',
  kind: 'model',
  provoked: () => true,
  holds,
});
const unproven = (c: Claim): ClaimResult => ({ claim: c, outcome: 'UNPROVEN', reason: 'not provoked' });

test('versionsIn spots a session that spans an upgrade', () => {
  assert.deepEqual([...versionsIn([{ version: '2.1.211' }, { version: '2.1.212' }])].sort(), ['2.1.211', '2.1.212']);
});

test('only sessions written by the target version are evidence', async () => {
  const root = await fakeRoot({
    old: { parent: [{ type: 'assistant', version: '2.1.211', attributionSkill: 'x' }] },
    now: { parent: [{ type: 'assistant', version: '2.1.212', attributionSkill: 'y' }] },
  });
  const ev = await evidenceForVersion('2.1.212', { root });
  assert.equal(ev.sessionsAttributed, 1);
  assert.equal(ev.contexts[0]!.lines[0].attributionSkill, 'y');
});

test('a session spanning an upgrade is DISCARDED, never guessed', async () => {
  // Its children carry no version, so attributing them would be a guess — and a
  // guess here means confirming the new version with the old version's data.
  const root = await fakeRoot({
    mixed: {
      parent: [
        { type: 'assistant', version: '2.1.211' },
        { type: 'assistant', version: '2.1.212' },
      ],
      children: {
        a1: [{ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] } }],
      },
    },
  });
  const ev = await evidenceForVersion('2.1.212', { root });
  assert.equal(ev.sessionsAttributed, 0);
  assert.equal(ev.sessionsAmbiguous, 1);
  assert.equal(ev.contexts.length, 0);
});

test("a child inherits its parent's version when that parent has exactly one", async () => {
  const root = await fakeRoot({
    s1: {
      parent: [{ type: 'assistant', version: '2.1.212' }],
      children: { a1: [{ type: 'assistant', message: { usage: { input_tokens: 1 } } }] },
    },
  });
  const ev = await evidenceForVersion('2.1.212', { root });
  assert.equal(ev.contexts[0]!.children.length, 1);
  assert.equal(ev.contexts[0]!.children[0]!.meta.toolUseId, 'tu-1');
});

test('a field found in a real session of the version CLOSES an unproven claim', () => {
  const c = claim((ctx) => ctx.lines.some((d: any) => d.attributionSkill));
  const out = closeWithEvidence(
    [unproven(c)],
    [{ lines: [{ attributionSkill: 'probe-skill' }], raw: '', children: [], openSessions: [] }],
    '2.1.212',
  );
  assert.equal(out[0]!.outcome, 'HOLDS');
  assert.match(out[0]!.reason, /real session written by 2\.1\.212/);
});

test('no evidence leaves the claim open — absence never proves anything', () => {
  const c = claim(() => false);
  const out = closeWithEvidence([unproven(c)], [{ lines: [], raw: '', children: [], openSessions: [] }], '2.1.212');
  assert.equal(out[0]!.outcome, 'UNPROVEN');
});

test('evidence must NEVER paper over a BROKEN claim', () => {
  // The probe caused that event and watched the field fail. Another session
  // writing the field elsewhere does not resurrect the case that failed.
  const c = claim(() => true);
  const broken: ClaimResult = { claim: { ...c, kind: 'gesture' }, outcome: 'BROKEN', reason: 'caused and absent' };
  const out = closeWithEvidence(
    [broken],
    [{ lines: [{ any: 1 }], raw: '', children: [], openSessions: [] }],
    '2.1.212',
  );
  assert.equal(out[0]!.outcome, 'BROKEN');
});

test('with no sessions on that version, nothing is closed', () => {
  const c = claim(() => true);
  assert.equal(closeWithEvidence([unproven(c)], [], '2.1.213')[0]!.outcome, 'UNPROVEN');
});
