import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { anon } from '../src/core/text.ts';
import { parseLine } from '../src/server/parser.ts';

const ctx = { sessionId: 's1', root: 'cli' as const, seq: 7 };

test('malformed JSON yields no events, never throws', () => {
  assert.deepEqual(parseLine('{not json', ctx), []);
  assert.deepEqual(parseLine('', ctx), []);
});

test('ignored line types yield no events', () => {
  for (const t of ['mode', 'attachment', 'file-history-snapshot', 'ai-title', 'last-prompt']) {
    assert.deepEqual(parseLine(JSON.stringify({ type: t }), ctx), [], `type ${t} should be ignored`);
  }
});

test('assistant line with usage yields a usage event with correct fill', () => {
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-11T17:37:37.566Z',
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: 39695,
        output_tokens: 724,
        cache_creation_input_tokens: 14252,
        cache_read_input_tokens: 14252,
      },
    },
  });
  const evs = parseLine(line, ctx);
  const usage = evs.find((e) => e.type === 'usage');
  assert.ok(usage && usage.type === 'usage');
  assert.deepEqual(usage.delta, { input: 39695, output: 724, cacheRead: 14252, cacheCreation: 14252 });
  assert.equal(usage.fill, 39695 + 14252 + 14252); // input + cacheRead + cacheCreation
});

// The model is a property of the CALL, not of the session: it sits on the same assistant
// line as the usage block and can differ from the one the session opened with. Reading it
// from the session head alone is what made the context window wrong.
test('assistant usage carries the model of that call', () => {
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-11T17:37:37.566Z',
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      id: 'msg_1',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });
  const usage = parseLine(line, ctx).find((e) => e.type === 'usage');
  assert.ok(usage && usage.type === 'usage');
  assert.equal(usage.model, 'claude-sonnet-4-6');
});

test('usage model is null when the line carries none', () => {
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-11T17:37:37.566Z',
    message: {
      role: 'assistant',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });
  const usage = parseLine(line, ctx).find((e) => e.type === 'usage');
  assert.ok(usage && usage.type === 'usage');
  assert.equal(usage.model, null);
});

test('usage model is null for a <synthetic> line (not a real model call)', () => {
  // Claude Code stamps message.model '<synthetic>' on lines that did NOT come from a model call
  // (API errors, "No response requested." auto-continue lines). It must not read as a model.
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-11T17:37:37.566Z',
    isApiErrorMessage: true,
    message: {
      role: 'assistant',
      model: '<synthetic>',
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });
  const usage = parseLine(line, ctx).find((e) => e.type === 'usage');
  assert.ok(usage && usage.type === 'usage');
  assert.equal(usage.model, null);
});

test('assistant line emits attribution events only for non-null values', () => {
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-11T17:37:37.566Z',
    attributionMcpServer: 'linear',
    attributionMcpTool: 'get_issue',
    attributionSkill: null,
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });
  const kinds = parseLine(line, ctx)
    .filter((e) => e.type === 'attribution')
    .map((e) => (e as any).kind);
  assert.deepEqual(kinds.sort(), ['mcpServer', 'mcpTool']); // skill is null → omitted
});

test('compaction line yields a compaction event', () => {
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-11T00:00:00.000Z',
    isCompactSummary: true,
    message: { role: 'assistant' },
  });
  const evs = parseLine(line, ctx);
  assert.ok(evs.some((e) => e.type === 'compaction' && e.isSummary === true));
});

test('assistant tool_use blocks yield tool-start events with id and name', () => {
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-11T00:00:00.000Z',
    message: {
      role: 'assistant',
      model: 'm',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      content: [
        { type: 'text', text: 'x' },
        { type: 'tool_use', id: 'toolu_A', name: 'Grep', input: {} },
      ],
    },
  });
  const starts = parseLine(line, ctx).filter((e) => e.type === 'tool-start');
  assert.equal(starts.length, 1);
  assert.equal((starts[0] as any).id, 'toolu_A');
  assert.equal((starts[0] as any).name, 'Grep');
});

test('user tool_result blocks yield tool-end events with the matching toolUseId', () => {
  const line = JSON.stringify({
    type: 'user',
    timestamp: '2026-07-11T00:00:01.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_A', content: [] }] },
  });
  const ends = parseLine(line, ctx).filter((e) => e.type === 'tool-end');
  assert.equal(ends.length, 1);
  assert.equal((ends[0] as any).toolUseId, 'toolu_A');
});

test('system line with compactMetadata yields a compaction event with real numbers', () => {
  const line = JSON.stringify({
    type: 'system',
    timestamp: '2026-07-11T00:00:02.000Z',
    compactMetadata: { preTokens: 423000, postTokens: 12000, durationMs: 150 },
  });
  const comp = parseLine(line, ctx).find((e) => e.type === 'compaction');
  assert.ok(comp && comp.type === 'compaction');
  assert.equal((comp as any).preTokens, 423000);
  assert.equal((comp as any).postTokens, 12000);
  assert.equal((comp as any).durationMs, 150);
});

test('isCompactSummary line still yields a compaction event (numbers null)', () => {
  const line = JSON.stringify({
    type: 'user',
    timestamp: '2026-07-11T00:00:03.000Z',
    isCompactSummary: true,
    message: { role: 'user' },
  });
  const comp = parseLine(line, ctx).find((e) => e.type === 'compaction');
  assert.ok(comp && comp.type === 'compaction' && comp.isSummary === true);
  assert.equal((comp as any).preTokens, null);
});

test('every emitted event carries ctx.seq', () => {
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-11T00:00:00.000Z',
    attributionSkill: 'brainstorming',
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });
  const evs = parseLine(line, { sessionId: 's1', root: 'cli', seq: 42 });
  assert.ok(evs.length >= 2);
  for (const e of evs) assert.equal(e.seq, 42);
});

test('tool-start carries anonymized arg by tool kind; tool-end carries output size', () => {
  const read = JSON.stringify({
    type: 'assistant',
    timestamp: 't',
    message: {
      content: [{ type: 'tool_use', id: 'toolu_R', name: 'Read', input: { file_path: '/Us' + 'ers/bob/x.ts' } }],
    },
  });
  assert.equal((parseLine(read, ctx).find((e) => e.type === 'tool-start') as any).arg, '~/x.ts');
  const bash = JSON.stringify({
    type: 'assistant',
    timestamp: 't',
    message: { content: [{ type: 'tool_use', id: 'toolu_B', name: 'Bash', input: { command: 'ls -la' } }] },
  });
  assert.equal((parseLine(bash, ctx).find((e) => e.type === 'tool-start') as any).arg, 'ls -la');
  const skill = JSON.stringify({
    type: 'assistant',
    timestamp: 't',
    message: {
      content: [{ type: 'tool_use', id: 'toolu_S', name: 'Skill', input: { skill: 'superpowers:brainstorming' } }],
    },
  });
  assert.equal((parseLine(skill, ctx).find((e) => e.type === 'tool-start') as any).arg, 'superpowers:brainstorming');
  // output size: string content and array content both measured
  const endStr = JSON.stringify({
    type: 'user',
    timestamp: 't',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_R', content: '12345' }] },
  });
  assert.equal((parseLine(endStr, ctx).find((e) => e.type === 'tool-end') as any).outputSize, 5);
  const endArr = JSON.stringify({
    type: 'user',
    timestamp: 't',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'toolu_R', content: [{ type: 'text', text: 'abcdefg' }] }],
    },
  });
  assert.equal((parseLine(endArr, ctx).find((e) => e.type === 'tool-end') as any).outputSize, 7);
});

test("tool-end carries a short anonymized outputPreview (the next call's input), absent when empty", () => {
  const withPath = JSON.stringify({
    type: 'user',
    timestamp: 't',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_R', content: 'read /Us' + 'ers/bob/app.ts' }] },
  });
  assert.equal(
    (parseLine(withPath, ctx).find((e) => e.type === 'tool-end') as any).outputPreview,
    'read ~/app.ts',
    'the preview is anonymized, like every other displayed slice',
  );
  const empty = JSON.stringify({
    type: 'user',
    timestamp: 't',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_R', content: '' }] },
  });
  assert.equal(
    (parseLine(empty, ctx).find((e) => e.type === 'tool-end') as any).outputPreview,
    undefined,
    'an empty result carries no preview',
  );
});

test('ReportFindings arg is the finding count, with level appended when present', () => {
  // Measured over real logs: `findings` is always an array; `level` is present on ~89%
  // of calls. The generic first-string fallback surfaced `level` by accident (or em-dash
  // when level was absent), never the count — so the row could not say HOW MANY findings.
  const argFor = (input: unknown): string | undefined => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: 't',
      message: { content: [{ type: 'tool_use', id: 'toolu_RF', name: 'ReportFindings', input }] },
    });
    return (parseLine(line, ctx).find((e) => e.type === 'tool-start') as any)?.arg;
  };
  assert.equal(argFor({ findings: [{}, {}, {}], level: 'high' }), '3 · high');
  assert.equal(argFor({ findings: [{}, {}, {}] }), '3', 'no level → count only');
  assert.equal(argFor({ findings: [], level: 'low' }), '0 · low', 'zero findings is a real, meaningful outcome');
  // A malformed payload without a findings ARRAY must yield no arg (em-dash), not crash:
  // the guard protects `.length`. Without it, `{ level: 'high' }` would throw on undefined.
  assert.equal(argFor({ level: 'high' }), undefined, 'no findings array → no arg');
  assert.equal(argFor({ findings: 'oops' }), undefined, 'non-array findings → no arg');
});

test('ScheduleWakeup arg is the reason, or "stop" when the loop is ended', () => {
  const argFor = (input: unknown): string | undefined => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: 't',
      message: { content: [{ type: 'tool_use', id: 'toolu_SW', name: 'ScheduleWakeup', input }] },
    });
    return (parseLine(line, ctx).find((e) => e.type === 'tool-start') as any)?.arg;
  };
  assert.equal(argFor({ delaySeconds: 480, prompt: 'x', reason: 'watching CI run' }), 'watching CI run');
  assert.equal(argFor({ stop: true }), 'stop', '{stop:true} carries no reason/delay — the action is "stop"');
  // Neither stop nor a string reason → no arg (em-dash). Guards against a future change
  // silently falling back to `prompt` (the pre-fix behaviour this mapping replaced).
  assert.equal(argFor({ delaySeconds: 60, prompt: 'x' }), undefined, 'no reason and not stopping → no arg');
});

test('Agent arg is the description, deterministically (not order-dependent subagent_type)', () => {
  const argFor = (input: unknown): string | undefined => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: 't',
      message: { content: [{ type: 'tool_use', id: 'toolu_AG', name: 'Agent', input }] },
    });
    return (parseLine(line, ctx).find((e) => e.type === 'tool-start') as any)?.arg;
  };
  // subagent_type FIRST in key order: the generic first-string fallback picked it on ~6%
  // of real Agent calls, showing "general-purpose" instead of the task. The explicit
  // mapping must always take `description`.
  assert.equal(
    argFor({ subagent_type: 'general-purpose', description: 'find flaky tests', prompt: 'p' }),
    'find flaky tests',
  );
  // description is still anonymized like every other arg (public-screenshot safety).
  assert.equal(argFor({ description: 'inspect /Us' + 'ers/bob/x.ts', prompt: 'p' }), 'inspect ~/x.ts');
});

test('Artifact arg is the published file, or the action when the call publishes nothing', () => {
  const argFor = (input: unknown): string | undefined => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: 't',
      message: { content: [{ type: 'tool_use', id: 'toolu_AR', name: 'Artifact', input }] },
    });
    return (parseLine(line, ctx).find((e) => e.type === 'tool-start') as any)?.arg;
  };
  // Every publish carries `file_path` (30 of 31 real calls) — with `favicon` and `description`
  // ahead of it, the first-string fallback would label the row with an emoji or a sentence.
  assert.equal(
    argFor({ favicon: '📊', description: 'A chart of the week', file_path: '/ho' + 'me/bob/page.html' }),
    '~/page.html',
  );
  // The other form (`action: "list"`, 1 of 31) has no file_path. Its action is the only thing
  // worth showing, and `scope` must not win it by arriving first.
  assert.equal(argFor({ scope: 'mine', action: 'list', limit: 25 }), 'list');
  assert.equal(argFor({ limit: 25 }), undefined, 'neither a file nor an action → no arg');
});

// origin.kind is the canonical discriminator for a real human turn. Tests use the
// same field values observed in real jsonl (verified on session 5ada6fdb).
const humanOrigin = { kind: 'human' };
const taskNotifOrigin = { kind: 'task-notification' };

test('slash-command line yields BOTH a command event and a turn, with NO origin field', () => {
  // The real shape: a slash command carries no `origin` and no `promptSource` — gating on
  // origin.kind === 'human' (as this once did) dropped the line entirely, so a `/paste-image`
  // round produced no turn at all and nothing was ever live while Claude worked.
  const line = JSON.stringify({
    type: 'user',
    timestamp: 't',
    uuid: 'u1',
    message: {
      role: 'user',
      content: '<command-name>/paste-image</command-name> <command-args>look at this</command-args>',
    },
  });
  const evs = parseLine(line, ctx);

  const cmd = evs.find((e) => e.type === 'command') as any;
  assert.ok(cmd, 'command event emitted');
  assert.equal(cmd.name, 'paste-image');

  const turn = evs.find((e) => e.type === 'user-turn') as any;
  assert.ok(turn, 'the command also opens a turn — it is a round the user sent');
  assert.equal(turn.command, 'paste-image');
  assert.equal(turn.prompt, 'look at this', 'the args ARE the prompt');
});

test('a slash command with no arguments uses the command itself as the prompt', () => {
  const line = JSON.stringify({
    type: 'user',
    timestamp: 't',
    uuid: 'u1',
    message: { role: 'user', content: '<command-name>/clear</command-name> <command-args></command-args>' },
  });
  const turn = parseLine(line, ctx).find((e) => e.type === 'user-turn') as any;
  assert.equal(turn.prompt, '/clear');
  assert.equal(turn.command, 'clear');
});

test('a local-command-stdout line is not something the user sent — no turn, no command', () => {
  const line = JSON.stringify({
    type: 'user',
    timestamp: 't',
    message: { role: 'user', content: '<local-command-stdout>Set model to Opus</local-command-stdout>' },
  });
  assert.deepEqual(parseLine(line, ctx), []);
});

test('a real user prompt yields a user-turn; a tool_result user line does not', () => {
  const prompt = JSON.stringify({
    type: 'user',
    timestamp: 't',
    origin: humanOrigin,
    message: { role: 'user', content: 'fix the bug please' },
  });
  assert.ok(
    parseLine(prompt, ctx).some((e) => e.type === 'user-turn'),
    'prompt is a turn',
  );
  const toolResult = JSON.stringify({
    type: 'user',
    timestamp: 't',
    origin: humanOrigin,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_A', content: 'ok' }] },
  });
  assert.equal(
    parseLine(toolResult, ctx).some((e) => e.type === 'user-turn'),
    false,
    'tool_result is not a turn',
  );
});

test('task-notification user line is not a human turn', () => {
  const line = JSON.stringify({
    type: 'user',
    timestamp: 't',
    origin: taskNotifOrigin,
    promptSource: 'system',
    message: { role: 'user', content: '<task-notification>\n<task-id>abc</task-id>\n</task-notification>' },
  });
  assert.equal(
    parseLine(line, ctx).some((e) => e.type === 'user-turn'),
    false,
  );
});

test('user line with no origin (local-command-stdout, interrupted request) is not a human turn', () => {
  const line = JSON.stringify({
    type: 'user',
    timestamp: 't',
    message: { role: 'user', content: '<local-command-stdout>Set model to Haiku</local-command-stdout>' },
  });
  assert.equal(
    parseLine(line, ctx).some((e) => e.type === 'user-turn'),
    false,
  );
});

test('a subagent user line (agentId set) is not a human turn', () => {
  const childCtx = { sessionId: 's1', root: 'cli' as const, seq: 9, agentId: 'child_A' };
  const line = JSON.stringify({
    type: 'user',
    timestamp: 't',
    origin: humanOrigin,
    message: { role: 'user', content: 'do the thing' },
  });
  assert.equal(
    parseLine(line, childCtx).some((e) => e.type === 'user-turn'),
    false,
  );
});

test('anon strips every machine/user-revealing path form (privacy — public screenshots)', () => {
  // Real leak forms seen in a live screenshot: a username must never survive.
  const argFor = (name: string, s: string): string => {
    const input = name === 'Bash' ? { command: s } : { file_path: s };
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: 't',
      message: { content: [{ type: 'tool_use', id: 'toolu_x', name, input }] },
    });
    return (parseLine(line, ctx).find((e) => e.type === 'tool-start') as any).arg as string;
  };
  // Inputs use SYNTHETIC usernames (carol/alice/bob), assembled from fragments so no
  // literal `/Users/<name>` or `/home/<name>` string sits in this public file (the
  // point is only that anon() removes whatever real form would appear at runtime).
  const U = '/' + 'Users' + '/',
    H = '/' + 'home' + '/';
  const args = [
    argFor('Read', '/private/tmp/claude-502/-' + 'Users-carol-Documents-AI-personal-plumb/scratch/x'),
    argFor('Read', U + 'carol/Documents/AI/personal/plumb/x.ts'),
    argFor('Read', H + 'alice/project/y.ts'),
    argFor('Bash', 'cat ' + U + 'bob/.ssh/id_rsa'),
    argFor('Bash', 'ls ~/.claude/projects/-' + 'Users-carol'), // slug username at end-of-token (no trailing segment)
  ];
  for (const arg of args) {
    assert.ok(!/\/Users\/[^/\s]+/.test(arg), `no /Users/<name> leak in: ${arg}`);
    assert.ok(!/\/home\/[^/\s]+/.test(arg), `no /home/<name> leak in: ${arg}`);
    assert.ok(!/-Users-[a-z0-9]+-/i.test(arg), `no -Users-<realname>- leak in: ${arg}`); // -Users-<x>- placeholder is ok
    assert.ok(!/claude-\d+/.test(arg), `no claude-<pid> scratchpad leak in: ${arg}`);
    for (const name of ['carol', 'alice', 'bob']) assert.ok(!arg.includes(name), `no username '${name}' in: ${arg}`);
  }
});

// The one id anon() lets through, and only where it is an ADDRESS rather than an identifier. The
// masked form was not a safer version of the URL — it was a link that goes nowhere, which is why
// the drawer could not offer the page it had just watched being published.
test('anon keeps a published artifact’s id, and only inside its own URL', () => {
  const out = (s: string) => anon(s, 400);
  const uuid = 'b830fa94-60be-4c86-9faa-af976df638a8';

  assert.equal(
    out(`Published x.html at https://claude.ai/code/artifact/${uuid}`),
    `Published x.html at https://claude.ai/code/artifact/${uuid}`,
  );
  // Every other id is still masked — the same uuid, one character off the artifact path, goes.
  assert.equal(out(`session ${uuid} resumed`), 'session <id> resumed');
  assert.equal(out(`https://claude.ai/code/artifacts/${uuid}`), 'https://claude.ai/code/artifacts/<id>');
  assert.equal(out(`https://example.test/code/artifact-${uuid}`), 'https://example.test/code/artifact-<id>');
  // A line carrying both keeps only the address: the exemption is the PATH, not the value.
  assert.equal(
    out(`agent ${uuid} published https://claude.ai/code/artifact/${uuid}`),
    `agent <id> published https://claude.ai/code/artifact/${uuid}`,
  );
});

test('Agent tool_use carries launchPrompt + subagentType on tool-start (anonymized)', () => {
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-12T00:00:00Z',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_A',
          name: 'Agent',
          input: { prompt: 'inspect /Us' + 'ers/bob/x.ts then report', subagent_type: 'general-purpose' },
        },
      ],
    },
  });
  const start = parseLine(line, ctx).find((e) => e.type === 'tool-start') as any;
  assert.equal(start.name, 'Agent');
  assert.equal(start.launchPrompt, 'inspect ~/x.ts then report'); // home path anonymized
  assert.equal(start.subagentType, 'general-purpose');
});

test('non-Agent tool-start has no launchPrompt/subagentType', () => {
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-12T00:00:00Z',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_G', name: 'Grep', input: { pattern: 'x' } }],
    },
  });
  const start = parseLine(line, ctx).find((e) => e.type === 'tool-start') as any;
  assert.equal(start.launchPrompt, undefined);
  assert.equal(start.subagentType, undefined);
});

test('subagent result carries returned output on tool-end (from toolUseResult)', () => {
  const line = JSON.stringify({
    type: 'user',
    timestamp: '2026-07-12T00:05:00Z',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_A', content: [{ type: 'text', text: 'RESULT' }] }],
    },
    toolUseResult: {
      content: [{ type: 'text', text: 'RESULT' }],
      status: 'completed',
      totalTokens: 59715,
      totalDurationMs: 383566,
    },
  });
  const end = parseLine(line, ctx).find((e) => e.type === 'tool-end') as any;
  assert.equal(end.toolUseId, 'toolu_A');
  assert.ok(end.returned, 'returned payload present');
  assert.equal(end.returned.outputFull, 'RESULT');
  assert.equal(end.returned.outLen, 6);
  assert.equal(end.returned.totalTokens, 59715);
  assert.equal(end.returned.totalDurationMs, 383566);
  assert.equal(end.returned.status, 'completed');
});

test('ordinary tool result (no toolUseResult.content array) has no returned payload', () => {
  const line = JSON.stringify({
    type: 'user',
    timestamp: '2026-07-12T00:05:00Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_R', content: 'file text' }] },
    toolUseResult: { file: { content: 'file text' } }, // Read shape — no top-level content array
  });
  const end = parseLine(line, ctx).find((e) => e.type === 'tool-end') as any;
  assert.equal(end.toolUseId, 'toolu_R');
  assert.equal(end.returned, undefined);
});

test('returned output strips control chars and caps length', () => {
  const big = 'A'.repeat(30000);
  const line = JSON.stringify({
    type: 'user',
    timestamp: '2026-07-12T00:05:00Z',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_A', content: [{ type: 'text', text: 'x' }] }],
    },
    toolUseResult: { content: [{ type: 'text', text: 'line1line2' + big }], status: 'completed' },
  });
  const end = parseLine(line, ctx).find((e) => e.type === 'tool-end') as any;
  assert.ok(!end.returned.outputFull.includes(''), 'bell control char stripped');
  assert.ok(end.returned.outputFull.length <= 20000, 'capped at 20000');
});

test('child end_turn assistant line yields a subagent-output event (returned output)', () => {
  const childCtx = { sessionId: 's1', root: 'cli' as const, seq: 9, agentId: 'child_A' };
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-12T00:03:00Z',
    message: {
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'the final answer at /Us' + 'ers/bob/x' }],
    },
  });
  const ev = parseLine(line, childCtx).find((e) => e.type === 'subagent-output') as any;
  assert.ok(ev, 'subagent-output emitted');
  assert.equal(ev.agentId, 'child_A');
  assert.equal(ev.outputFull, 'the final answer at ~/x'); // home path anonymized to ~, trailing /x kept
  assert.equal(ev.outLen, 23);
});

test('mid-stream child text (stop_reason null) yields NO subagent-output', () => {
  const childCtx = { sessionId: 's1', root: 'cli' as const, seq: 9, agentId: 'child_A' };
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-12T00:02:00Z',
    message: { role: 'assistant', stop_reason: null, content: [{ type: 'text', text: 'thinking...' }] },
  });
  assert.equal(
    parseLine(line, childCtx).some((e) => e.type === 'subagent-output'),
    false,
  );
});

test('a MAIN end_turn line (agentId null) yields NO subagent-output', () => {
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-12T00:02:00Z',
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'main answer' }] },
  });
  assert.equal(
    parseLine(line, ctx).some((e) => e.type === 'subagent-output'),
    false,
  ); // ctx has no agentId
});

test('main session end_turn emits turn-result (not subagent-output)', () => {
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-12T00:02:00Z',
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done.' }] },
  });
  const evs = parseLine(line, ctx);
  assert.ok(
    evs.some((e) => e.type === 'turn-result'),
    'turn-result emitted for main session',
  );
  assert.equal(
    evs.some((e) => e.type === 'subagent-output'),
    false,
    'no subagent-output from main session',
  );
  const r = evs.find((e) => e.type === 'turn-result') as any;
  assert.equal(r.outputFull, 'done.');
  assert.equal(r.outLen, 5);
});

test('child end_turn emits subagent-output (NOT turn-result)', () => {
  const childCtx = { sessionId: 's1', root: 'cli' as const, seq: 9, agentId: 'child_Z' };
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-12T00:02:00Z',
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'child answer' }] },
  });
  const evs = parseLine(line, childCtx);
  assert.ok(
    evs.some((e) => e.type === 'subagent-output'),
    'subagent-output from child',
  );
  assert.equal(
    evs.some((e) => e.type === 'turn-result'),
    false,
    'no turn-result from child',
  );
});

test('mid-stream turn line (stop_reason null) yields neither subagent-output nor turn-result', () => {
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-12T00:02:00Z',
    message: { role: 'assistant', stop_reason: null, content: [{ type: 'text', text: 'thinking...' }] },
  });
  assert.equal(
    parseLine(line, ctx).some((e) => e.type === 'turn-result'),
    false,
  );
});

test('user-turn carries the WHOLE anonymized prompt (every line)', () => {
  // The GUI shows one line in the banner but opens the prompt in full — it can shorten
  // what the parser gives it, it cannot recover what the parser dropped.
  const line = JSON.stringify({
    type: 'user',
    timestamp: 't',
    uuid: 'uuid-abc',
    origin: { kind: 'human' },
    message: { role: 'user', content: 'fix the bug in /Us' + 'ers/carol/app.ts\nmore details here' },
  });
  const ev = parseLine(line, ctx).find((e) => e.type === 'user-turn') as any;
  assert.ok(ev, 'user-turn emitted');
  assert.equal(ev.prompt, 'fix the bug in ~/app.ts\nmore details here', 'all lines, home path anonymized');
});

test('system/turn_duration emits turn-end (main session only)', () => {
  const line = JSON.stringify({
    type: 'system',
    subtype: 'turn_duration',
    timestamp: 't',
    durationMs: 12345,
    messageCount: 8,
  });
  const ev = parseLine(line, ctx).find((e) => e.type === 'turn-end') as any;
  assert.ok(ev, 'turn-end emitted');
  assert.equal(ev.durationMs, 12345);
  assert.equal(ev.messageCount, 8);
  // agentId set → should not emit turn-end for child sessions
  const childCtx = { sessionId: 's', root: 'cli' as const, seq: 1, agentId: 'child_X' };
  assert.equal(
    parseLine(line, childCtx).some((e) => e.type === 'turn-end'),
    false,
  );
});

test('user row with interruptedMessageId emits turn-interrupted before user-turn', () => {
  const line = JSON.stringify({
    type: 'user',
    timestamp: 't',
    uuid: 'new-uuid',
    interruptedMessageId: 'old-uuid',
    origin: { kind: 'human' },
    message: { role: 'user', content: 'continue please' },
  });
  const evs = parseLine(line, ctx);
  const types = evs.map((e) => e.type);
  const intIdx = types.indexOf('turn-interrupted');
  const turnIdx = types.indexOf('user-turn');
  assert.ok(intIdx >= 0, 'turn-interrupted emitted');
  assert.ok(turnIdx >= 0, 'user-turn also emitted');
  assert.ok(intIdx < turnIdx, 'turn-interrupted comes before user-turn');
  const _int = evs[intIdx] as any;
});

test('tool_result user row with interruptedMessageId emits turn-interrupted (no user-turn)', () => {
  const line = JSON.stringify({
    type: 'user',
    timestamp: 't',
    interruptedMessageId: 'old-uuid',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_X', content: 'ok' }] },
  });
  const evs = parseLine(line, ctx);
  assert.ok(
    evs.some((e) => e.type === 'turn-interrupted'),
    'turn-interrupted emitted',
  );
  assert.equal(
    evs.some((e) => e.type === 'user-turn'),
    false,
    'no user-turn for tool_result row',
  );
});

test('synthetic fixture parses into the expected event mix', () => {
  const path = fileURLToPath(new URL('./fixtures/graph-sample.jsonl', import.meta.url));
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const evs = lines.flatMap((l, i) => parseLine(l, { sessionId: 's', root: 'cli', seq: i }));
  const kinds = evs.map((e) => e.type);
  assert.ok(kinds.includes('usage'), 'has usage');
  assert.ok(kinds.filter((k) => k === 'tool-start').length >= 2, 'has >=2 tool-start (Grep, Agent)');
  assert.ok(kinds.includes('tool-end'), 'has tool-end');
  const comp = evs.find((e) => e.type === 'compaction');
  assert.ok(comp && comp.type === 'compaction' && comp.preTokens === 41000, 'compaction with real preTokens');
});

// A background subagent's only end signal is a `queue-operation` line carrying a
// `<task-notification>`, and that line names its subject TWICE: `<tool-use-id>` (the spawn)
// and `<task-id>` (the child's agentId). The spawn name is not always there — a skill forked
// into the background has no spawning tool call at all — and gating on it dropped the whole
// event, so those subagents could never stop. The parser reports the fact; deciding what the
// fact can be attached to belongs to the reducer, which is the only layer that knows.
const notif = (body: string) =>
  JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    content: `<task-notification>\n${body}\n</task-notification>`,
  });

test('a terminal task-notification without a tool-use-id still reports the end', () => {
  const out = parseLine(notif('<task-id>a49c476</task-id>\n<status>completed</status>'), ctx);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.type, 'agent-end');
  assert.equal((out[0] as any).toolUseId, null, 'the missing spawn name is null, not a fake id');
  assert.equal((out[0] as any).taskId, 'a49c476');
  assert.equal((out[0] as any).status, 'completed');
});

test('a task-notification with no status is progress, not an end', () => {
  // 72 of these in the local corpus: `event` + `summary`, no status, nothing has finished.
  // The gate tests for the PRESENCE of a terminal status — an absence test would break the
  // day Claude Code adds a field. It IS reported, as progress: a Monitor's events are the only
  // thing it ever produces, and reading them as an end would stop a task still watching.
  const out = parseLine(notif('<task-id>a49c476</task-id>\n<event>tool_use</event>'), ctx);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.type, 'background-event');
  assert.equal((out[0] as any).taskId, 'a49c476');
  assert.equal((out[0] as any).event, 'tool_use');
});

test('the drain copy of a progress notification is not a second event', () => {
  // Claude Code writes the same payload again as `remove` when the queue drains (42 enqueue /
  // 6 remove locally, every remove repeating an enqueue). Counting the line would double it.
  const drained = JSON.stringify({
    type: 'queue-operation',
    operation: 'remove',
    content: '<task-notification>\n<task-id>a49c476</task-id>\n<event>tool_use</event>\n</task-notification>',
  });
  assert.deepEqual(parseLine(drained, ctx), []);
});

test('a terminal task-notification with a tool-use-id is unchanged', () => {
  const out = parseLine(
    notif('<task-id>a1</task-id>\n<tool-use-id>toolu_9</tool-use-id>\n<status>failed</status>'),
    ctx,
  );
  assert.equal(out.length, 1);
  assert.equal((out[0] as any).toolUseId, 'toolu_9');
  assert.equal((out[0] as any).status, 'failed');
});
