import { expect, test } from 'bun:test';
import type { TraceSpan } from '../src/core/span-store.ts';
import { groupTurnSpans, isLandmark, leafSpans } from '../src/core/trace-group.ts';

let id = 0;
// `label` is annotated, not inferred: `= type` would infer SpanType and reject
// the tool names ('Bash', 'Skill') that every landmark test passes.
const sp = (type: TraceSpan['type'], label: string = type, ms = 1000): TraceSpan => ({
  id: 'sp-' + id++,
  type,
  label,
  detail: null,
  t0: 0,
  t1: ms,
  turnIndex: 1,
  lane: 0,
  parentId: null,
  agent: null,
  status: 'ok',
  handle: null,
});
const seq = (...specs: Array<[TraceSpan['type'], string?]>) => specs.map(([t, l]) => sp(t, l ?? t));

test('a round = api + its tools; a lone round is NOT wrapped in a chapter', () => {
  const items = groupTurnSpans(seq(['prompt'], ['api'], ['tool', 'Bash'], ['tool', 'Read'], ['result']));
  // prompt, one round group, result
  expect(items.length).toBe(3);
  expect(items[0]).toMatchObject({ kind: 'step' });
  expect(items[1]).toMatchObject({ kind: 'group', label: '#1 round', rounds: 1, steps: 3 });
  expect(items[2]).toMatchObject({ kind: 'step' });
});

test('11 rounds fold into a chapter of 10 + a lone round', () => {
  const specs: Array<[TraceSpan['type'], string?]> = [['prompt']];
  for (let i = 0; i < 11; i++) {
    specs.push(['api'], ['tool', 'Edit']);
  }
  specs.push(['result']);
  const items = groupTurnSpans(seq(...specs));
  // prompt, chapter R1–10, round #11, result
  expect(items.length).toBe(4);
  expect(items[1]).toMatchObject({ kind: 'group', label: 'R1–10', rounds: 10, steps: 20 });
  expect(items[2]).toMatchObject({ kind: 'group', label: '#11 round' });
});

test('a group carries hasError iff any leaf span failed (round and chapter)', () => {
  // A failed tool inside a round: the round, and the chapter that folds it, must both flag it —
  // otherwise a collapsed group hides the failure it contains.
  const specs: Array<[TraceSpan['type'], string?]> = [['prompt']];
  for (let i = 0; i < 11; i++) {
    specs.push(['api'], ['tool', 'Edit']);
  }
  specs.push(['result']);
  const spans = seq(...specs);
  // Fail the Edit of the 3rd round (inside the R1–10 chapter) and of the 11th (a lone round).
  spans[5]!.status = 'error'; // prompt, api, Edit, api, Edit, [Edit#3]…
  spans[spans.length - 2]!.status = 'error'; // the 11th Edit
  const items = groupTurnSpans(spans);
  const chapter = items.find((i) => i.kind === 'group' && i.label === 'R1–10') as any;
  const lone = items.find((i) => i.kind === 'group' && i.label === '#11 round') as any;
  expect(chapter.hasError).toBe(true);
  expect(lone.hasError).toBe(true);
});

test('a group with no failed leaf has hasError false', () => {
  const items = groupTurnSpans(seq(['prompt'], ['api'], ['tool', 'Bash'], ['tool', 'Read'], ['result']));
  expect((items[1] as any).hasError).toBe(false);
});

test('a landmark breaks the chapter early and stays top-level', () => {
  const specs: Array<[TraceSpan['type'], string?]> = [['prompt']];
  for (let i = 0; i < 3; i++) specs.push(['api'], ['tool', 'Bash']);
  specs.push(['spawn', 'Agent']);
  for (let i = 0; i < 2; i++) specs.push(['api'], ['tool', 'Read']);
  specs.push(['result']);
  const items = groupTurnSpans(seq(...specs));
  // prompt, chapter R1–3, spawn step, chapter R4–5, result
  expect(items.map((i) => i.kind)).toEqual(['step', 'group', 'step', 'group', 'step']);
  expect((items[2] as any).span.type).toBe('spawn');
  expect(items[1]).toMatchObject({ label: 'R1–3' });
  expect(items[3]).toMatchObject({ label: 'R4–5' });
});

test('landmark TOOLS (Skill) break like landmarks', () => {
  const items = groupTurnSpans(seq(['prompt'], ['api'], ['tool', 'Skill'], ['api'], ['tool', 'Bash'], ['result']));
  const skill = items.find((i) => i.kind === 'step' && i.span.label === 'Skill');
  expect(skill).toBeDefined();
  expect(isLandmark(sp('tool', 'Skill'))).toBe(true);
  expect(isLandmark(sp('tool', 'Bash'))).toBe(false);
});

test('liveTail keeps the LAST round as raw steps', () => {
  const items = groupTurnSpans(seq(['prompt'], ['api'], ['tool', 'Bash'], ['api'], ['tool', 'Edit']), {
    liveTail: true,
  });
  // prompt, round#1 group, then RAW: api step + tool step
  expect(items[1]).toMatchObject({ kind: 'group', label: '#1 round' });
  expect(items[2]).toMatchObject({ kind: 'step' });
  expect(items[3]).toMatchObject({ kind: 'step' });
  expect((items[3] as any).span.label).toBe('Edit');
});

test('a result with spans after it is marked midResult', () => {
  const items = groupTurnSpans(seq(['prompt'], ['api'], ['result'], ['api'], ['tool', 'Bash'], ['result']));
  const results = items.filter((i) => i.kind === 'step' && i.span.type === 'result') as any[];
  expect(results.length).toBe(2);
  expect(results[0].midResult).toBe(true);
  expect(results[1].midResult).toBeUndefined();
});

test('leading tools before any api still land in a round (never dropped)', () => {
  const items = groupTurnSpans(seq(['prompt'], ['tool', 'Read'], ['tool', 'Read'], ['api'], ['result']));
  // leading tools form round #1 (api-less), the api forms round #2 — both grouped.
  expect(items[1]!.kind).toBe('group');
  const leaves = leafSpans(items[1]!);
  expect(leaves.filter((s) => s.label === 'Read').length).toBe(2);
  expect(leaves.filter((s) => s.type === 'api').length).toBe(1);
});

test('the trailing chapter id is STABLE while a live turn grows', () => {
  const mk = (rounds: number) => {
    const specs: Array<[TraceSpan['type'], string?]> = [['prompt']];
    for (let i = 0; i < rounds; i++) specs.push(['api'], ['tool', 'Bash']);
    return groupTurnSpans(seq(...specs), { liveTail: true });
  };
  const chapterId = (items: any[]) => items.find((i) => i.kind === 'group' && i.rounds > 1)?.id;
  // 4 completed rounds + raw tail → trailing chapter; one more round must NOT change its id.
  expect(chapterId(mk(5))).toBe('ch1');
  expect(chapterId(mk(6))).toBe('ch1');
  expect(chapterId(mk(7))).toBe('ch1');
});

test('leafSpans flattens nested groups in order', () => {
  const items = groupTurnSpans(seq(['prompt'], ['api'], ['tool', 'Bash'], ['result']));
  const round = items[1] as any;
  expect(leafSpans(round).map((s: TraceSpan) => s.type)).toEqual(['api', 'tool']);
});

// ── intents travel with the group, and a chapter only COUNTS them ───────────

/** A span carrying the intent its call stated (only an api span ever does). */
const spoke = (text: string): TraceSpan => ({ ...sp('api'), narration: text });

test('a round exposes the intent of its own api call', () => {
  const items = groupTurnSpans([sp('prompt'), spoke('Reading the parser.'), sp('tool', 'Read'), sp('result')]);
  expect(items[1]).toMatchObject({ kind: 'group', label: '#1 round', intents: ['Reading the parser.'] });
});

test('a silent round exposes no intent, and keeps its number', () => {
  const items = groupTurnSpans([sp('prompt'), sp('api'), sp('tool', 'Read'), sp('result')]);
  expect(items[1]).toMatchObject({ kind: 'group', label: '#1 round', intents: [] });
});

test('a chapter counts every intent it folds and keeps its RANGE as its label', () => {
  // Naming a chapter after the first intent would describe one round out of ten as if it
  // described all ten. The range is what stays true; the count says there is a story inside.
  const spans: TraceSpan[] = [sp('prompt')];
  for (let i = 0; i < 10; i++) {
    spans.push(i % 3 === 0 ? spoke('Step ' + i) : sp('api'), sp('tool', 'Edit'));
  }
  spans.push(sp('result'));
  const items = groupTurnSpans(spans);
  expect(items[1]).toMatchObject({
    kind: 'group',
    label: 'R1–10',
    rounds: 10,
    intents: ['Step 0', 'Step 3', 'Step 6', 'Step 9'],
  });
});
