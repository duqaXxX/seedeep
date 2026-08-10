import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactLabel, mergeArtifacts, type SessionArtifact } from '../src/core/session-artifacts.ts';
import { scanLines, scanSession } from '../src/server/transcript-scan.ts';

// Raw lines, in the shape Claude Code writes them (verified 2026-08-10 against a real publish: the
// result's `content` is a STRING, and the URL appears only there — the call itself never names it).
// A hand-built ArtifactPublish would carry the shape I believe, and the belief is what the parser
// has to be tested against.
const publish = (id: string, path: string, description: string, ts: string, url?: string) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      content: [
        {
          type: 'tool_use',
          id,
          name: 'Artifact',
          input: { file_path: path, description, favicon: '📊', ...(url ? { url } : {}) },
        },
      ],
    },
  });

const result = (id: string, text: string, ts: string) =>
  JSON.stringify({
    type: 'user',
    timestamp: ts,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  });

const PAGE = 'https://claude.ai/code/artifact/11111111-2222-4333-8444-555555555555';
const OTHER = 'https://claude.ai/code/artifact/99999999-8888-4777-8666-555555555555';

test('scanLines collects a publish, with the URL its result reported', () => {
  const scan = scanLines([
    publish('toolu_1', '~scratch/p/proto.html', 'Where should a session note live?', '2026-08-10T10:00:00.000Z'),
    result(
      'toolu_1',
      `Published ~scratch/p/proto.html at ${PAGE}\n\nLive subscription: skipped`,
      '2026-08-10T10:00:02.000Z',
    ),
  ]);
  expect(scan.artifacts).toEqual([
    {
      at: Date.parse('2026-08-10T10:00:02.000Z'),
      url: PAGE,
      description: 'Where should a session note live?',
      path: '~scratch/p/proto.html',
    },
  ]);
});

// The trap this test exists for: `action: "list"` returns a result FULL of artifact URLs, one per
// page the user owns. Matching on the URL alone would have turned a single listing into a dozen
// rows claiming this session published them all — so the publish is recognised by `file_path`.
test('a reading call publishes nothing, however many URLs its result names', () => {
  const scan = scanLines([
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-10T10:00:00.000Z',
      message: {
        content: [{ type: 'tool_use', id: 'toolu_l', name: 'Artifact', input: { action: 'list', limit: 25 } }],
      },
    }),
    result(
      'toolu_l',
      `2 published artifacts (most recent first):\n- A — ${PAGE} — updated 2026-08-10\n- B — ${OTHER} — updated 2026-07-12`,
      '2026-08-10T10:00:01.000Z',
    ),
  ]);
  expect(scan.artifacts).toEqual([]);
});

test('a publish whose result names no page leaves no row', () => {
  const scan = scanLines([
    publish('toolu_x', '~scratch/p/broken.html', 'A page that never landed', '2026-08-10T10:00:00.000Z'),
    result('toolu_x', 'Error: the page exceeds the 16MB limit.', '2026-08-10T10:00:01.000Z'),
  ]);
  expect(scan.artifacts).toEqual([]);
});

// A FAILED publish routinely names the very page it failed against — the tool's 409-conflict path
// tells the caller to re-read that artifact and try again. Reading the URL out of an error would
// put a page on the card the session never published, labelled with the call that was rejected.
test('an errored publish is not a page, even when its message names one', () => {
  const scan = scanLines([
    publish('toolu_c', '~scratch/p/proto.html', 'A redeploy that lost the race', '2026-08-10T10:00:00.000Z', PAGE),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-08-10T10:00:01.000Z',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_c',
            is_error: true,
            content: `<tool_use_error>409: ${PAGE} was updated by another session. Re-read it and publish again.</tool_use_error>`,
          },
        ],
      },
    }),
  ]);
  expect(scan.artifacts).toEqual([]);
});

// A `Bash` that prints an artifact link — a `cat` of a log, a grep of the corpus — published
// nothing. Only an `Artifact` call did.
test('another tool printing an artifact URL is not a publish', () => {
  const scan = scanLines([
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-10T10:00:00.000Z',
      message: { content: [{ type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'cat notes.md' } }] },
    }),
    result('toolu_b', `see ${PAGE}`, '2026-08-10T10:00:01.000Z'),
  ]);
  expect(scan.artifacts).toEqual([]);
});

test('a whole session collapses to its pages, the last publish naming each', () => {
  const lines = [
    publish('toolu_1', '~scratch/p/proto.html', 'First cut', '2026-08-10T10:00:00.000Z'),
    result('toolu_1', `Published ~scratch/p/proto.html at ${PAGE}`, '2026-08-10T10:00:02.000Z'),
    // The redeploy: same page, passed back as `url`, with the description it carries NOW.
    publish('toolu_2', '~scratch/p/proto.html', 'Second cut, after his notes', '2026-08-10T11:00:00.000Z', PAGE),
    result('toolu_2', `Published ~scratch/p/proto.html at ${PAGE}`, '2026-08-10T11:00:01.000Z'),
    publish('toolu_3', '~scratch/p/other.html', 'A different page', '2026-08-10T12:00:00.000Z'),
    result('toolu_3', `Published ~scratch/p/other.html at ${OTHER}`, '2026-08-10T12:00:01.000Z'),
  ];
  const scan = scanLines(lines);
  expect(scan.artifacts.length).toBe(3); // three publishes on disk…

  const pages = mergeArtifacts(
    scan.artifacts.map((a) => ({ url: a.url, label: artifactLabel(a.description, a.path), path: a.path, at: a.at })),
  );
  expect(pages.length).toBe(2); // …two pages online
  expect(pages.map((p) => p.url)).toEqual([OTHER, PAGE]); // newest first
  // The LAST publish to a page is the one whose description matches what is online now.
  expect(pages.find((p) => p.url === PAGE)?.label).toBe('Second cut, after his notes');
});

test('mergeArtifacts keeps the later LINE when two publishes share an instant', () => {
  const at = Date.parse('2026-08-10T10:00:00.000Z');
  const rows: SessionArtifact[] = [
    { url: PAGE, label: 'first', path: '~scratch/p/a.html', at },
    { url: PAGE, label: 'second', path: '~scratch/p/a.html', at },
  ];
  expect(mergeArtifacts(rows).map((p) => p.label)).toEqual(['second']);
});

// A subagent publishes on the parent's behalf, so its sidecar counts — and the merged list has to
// come back in TIME order: `mergeArtifacts` resolves a tie on array position, and sidecar rows are
// appended after every parent row whenever they happened. Driven through `scanSession` on real
// files, because sidecar discovery is the part `scanLines` cannot exercise.
test('a subagent sidecar publish counts, and lands in time order', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seedeep-artifacts-'));
  const id = '00000000-1111-4222-8333-444444444444';
  writeFileSync(
    join(dir, `${id}.jsonl`),
    [
      publish('toolu_p', '~scratch/p/parent.html', 'Published by the parent, later', '2026-08-10T12:00:00.000Z'),
      result('toolu_p', `Published ~scratch/p/parent.html at ${PAGE}`, '2026-08-10T12:00:01.000Z'),
    ].join('\n') + '\n',
  );
  mkdirSync(join(dir, id, 'subagents'), { recursive: true });
  writeFileSync(
    join(dir, id, 'subagents', 'agent-1.jsonl'),
    [
      publish('toolu_s', '~scratch/p/child.html', 'Published by the subagent, earlier', '2026-08-10T10:00:00.000Z'),
      result('toolu_s', `Published ~scratch/p/child.html at ${OTHER}`, '2026-08-10T10:00:01.000Z'),
    ].join('\n') + '\n',
  );

  const scan = await scanSession(join(dir, `${id}.jsonl`));
  expect(scan.artifacts.map((a) => a.description)).toEqual([
    'Published by the subagent, earlier',
    'Published by the parent, later',
  ]);
  expect(mergeArtifacts(scan.artifacts.map((a) => ({ ...a, label: a.description }))).map((p) => p.url)).toEqual([
    PAGE,
    OTHER,
  ]);
});

test('a publish with no description is named by its file', () => {
  expect(artifactLabel('', '~scratch/p/proto-note.html')).toBe('proto-note.html');
  expect(artifactLabel('   ', 'C:\\Temp\\claude\\p\\win.html')).toBe('win.html');
  expect(artifactLabel('A real description', '~scratch/p/proto-note.html')).toBe('A real description');
});
