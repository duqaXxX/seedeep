/**
 * Synthetic sessions for the figures no recording can honestly produce.
 *
 * `doc-shots` cuts most of `docs/features.md`'s figures from a REAL recorded session. Some states
 * cannot be provoked that way: an API call does not fail on request, Claude Code refuses `/compact`
 * on a small session, and a retrospective is about a corpus rather than a session. Those come from
 * here — transcripts written line by line, **synthetic in content and faithful in SHAPE**, which is
 * the same rule the test fixtures follow.
 *
 * The shapes are not invented. Every field below is one the parser actually reads
 * (`src/server/parser.ts`) or one copied from a recorded line: `isApiErrorMessage` +
 * `apiErrorStatus`, `compactMetadata.{preTokens,postTokens,durationMs}`, an `Agent` tool_use whose
 * `input` carries `description`/`subagent_type`/`model`, and a child transcript under
 * `<session>/subagents/agent-<id>.jsonl` beside its `.meta.json`.
 *
 * A wrong shape does not produce a wrong picture — it produces an EMPTY one, and
 * `tests/doc-scenes.test.ts` runs every scene through the real parser and the real reducer and
 * asserts the state each figure depends on. That test is what makes a synthetic transcript safe to
 * publish a figure from: it fails in `bun test`, not silently on a page.
 *
 * Nothing here touches a real session: paths are the fictional `/tmp/orbit`, and every id is made
 * up on the spot.
 */

/** A synthetic session, ready to be materialised into a `CLAUDE_CONFIG_DIR`-shaped tree. */
export interface Scene {
  id: string;
  cwd: string;
  sessionId: string;
  /** The parent transcript, one JSON line per element. */
  lines: string[];
  /** Subagent transcripts, keyed by agent id, each with the meta file Claude Code writes. */
  children?: Record<string, { meta: Record<string, unknown>; lines: string[] }>;
  /** Finished sessions that only need to EXIST, for the surfaces that read the whole corpus. */
  archive?: Array<{ cwd: string; sessionId: string; lines: string[] }>;
  /** What the live-session record should claim while the shot is taken. */
  status?: 'busy' | 'idle' | 'waiting';
}

const OPUS = 'claude-opus-5';
const SONNET = 'claude-sonnet-5';
const HAIKU = 'claude-haiku-4-5-20251001';

/** Claude Code's slug for a working directory: every non-alphanumeric run becomes one dash. */
export function slugOf(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * A clock that hands out timestamps in order. Real time is never used: a figure re-cut tomorrow
 * must look the same as today, or every run would show a diff.
 */
function clock(startISO: string): () => string {
  let t = Date.parse(startISO);
  return () => {
    t += 1_400;
    return new Date(t).toISOString();
  };
}

/** The fields every line of a `cli` session carries, whatever its type. */
function envelope(sessionId: string, cwd: string, uuid: string, at: string): Record<string, unknown> {
  return {
    uuid,
    timestamp: at,
    sessionId,
    session_id: sessionId,
    cwd,
    version: '2.1.220',
    entrypoint: 'cli',
    userType: 'external',
    gitBranch: 'main',
    isSidechain: false,
    parentUuid: null,
  };
}

/** A usage block with the four counters the context bar is computed from. */
function usage(cacheRead: number, cacheWrite: number, out: number): Record<string, unknown> {
  return {
    input_tokens: 3,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    output_tokens: out,
    service_tier: 'standard',
  };
}

/** Everything needed to write one scene's lines: ids, the clock, and the envelope. */
class Writer {
  private n = 0;
  readonly lines: string[] = [];
  constructor(
    readonly sessionId: string,
    readonly cwd: string,
    private readonly at: () => string,
  ) {}

  private uuid(): string {
    return `u${String(++this.n).padStart(4, '0')}-${this.sessionId.slice(0, 8)}`;
  }

  private push(extra: Record<string, unknown>): string {
    const uuid = this.uuid();
    this.lines.push(JSON.stringify({ ...envelope(this.sessionId, this.cwd, uuid, this.at()), ...extra }));
    return uuid;
  }

  /** A prompt the human typed: `origin.kind` and `promptSource` are what make it one. */
  typed(text: string, interruptedMessageId?: string): string {
    return this.push({
      type: 'user',
      origin: { kind: 'human' },
      promptSource: 'typed',
      ...(interruptedMessageId ? { interruptedMessageId } : {}),
      message: { role: 'user', content: text },
    });
  }

  /** A slash command, in the shape that carries the expansion. */
  command(name: string, args = ''): string {
    return this.push({
      type: 'user',
      promptId: `p-${name}-${this.n}`,
      message: {
        role: 'user',
        content:
          `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>` +
          `<command-args>${args}</command-args>`,
      },
    });
  }

  /** The stdout a local command leaves behind — the whole cost of a `/model`. */
  localStdout(text: string): string {
    return this.push({
      type: 'user',
      message: { role: 'user', content: `<local-command-stdout>${text}</local-command-stdout>` },
    });
  }

  /** One call to the model: its text, the tools it fired, its usage, optionally its failure. */
  call(o: {
    text?: string;
    model?: string;
    cacheRead: number;
    cacheWrite?: number;
    out?: number;
    tools?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    skill?: string;
    apiError?: { status: number; message: string };
  }): string {
    const content: Array<Record<string, unknown>> = [];
    if (o.text) content.push({ type: 'text', text: o.text });
    for (const t of o.tools ?? []) content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input });
    return this.push({
      type: 'assistant',
      requestId: `req_${this.n}`,
      effort: 'high',
      ...(o.skill ? { attributionSkill: o.skill } : {}),
      ...(o.apiError ? { isApiErrorMessage: true, apiErrorStatus: o.apiError.status } : {}),
      message: {
        role: 'assistant',
        model: o.model ?? OPUS,
        content: o.apiError ? [{ type: 'text', text: o.apiError.message }] : content,
        usage: usage(o.cacheRead, o.cacheWrite ?? 0, o.out ?? 220),
      },
    });
  }

  /** A tool's result, as the user-role line that carries it, with its rendered output. */
  result(toolUseId: string, text: string, isError = false): string {
    return this.push({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: isError }],
      },
      toolUseResult: { content: [{ type: 'text', text }] },
    });
  }

  /**
   * A background command's LAUNCH RECEIPT — the shape that says a Bash went to the background:
   * an empty stdout and a `backgroundTaskId`. Not `status: 'async_launched'`, which is the
   * subagent shape; and not `run_in_background` in the input either, since a foreground command
   * PROMOTED by the timeout carries none.
   */
  backgroundLaunch(toolUseId: string, taskId: string): string {
    return this.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: '' }] },
      toolUseResult: {
        stdout: '',
        stderr: '',
        interrupted: false,
        isImage: false,
        noOutputExpected: false,
        backgroundTaskId: taskId,
      },
    });
  }

  /**
   * The notification that ends a background command, minutes or hours later. Its `<summary>` is
   * the only place the exit code is ever written, and the `<status>` is what makes it terminal —
   * the same line type is written for progress and ends nothing.
   */
  notification(toolUseId: string, taskId: string, status: string, summary: string): string {
    return this.push({
      type: 'queue-operation',
      operation: 'enqueue',
      content:
        `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n` +
        `<output-file>/tmp/orbit/tasks/${taskId}.output</output-file>\n<status>${status}</status>\n` +
        `<summary>${summary}</summary>\n</task-notification>`,
    });
  }

  /** The line that closes a turn. Its absence is what makes a turn read as interrupted. */
  turnEnd(durationMs: number, messageCount: number): string {
    return this.push({ type: 'system', subtype: 'turn_duration', durationMs, messageCount });
  }

  /** A compaction: the context deflating, with the sizes it went between. */
  compaction(preTokens: number, postTokens: number): string {
    return this.push({
      type: 'user',
      isCompactSummary: true,
      compactMetadata: { preTokens, postTokens, durationMs: 7_400, trigger: 'manual' },
      message: { role: 'user', content: 'This session is being continued from a previous conversation.' },
    });
  }
}

/** A subagent's child transcript: what it was asked, what it did, what it handed back. */
function child(o: {
  agentId: string;
  sessionId: string;
  cwd: string;
  prompt: string;
  model: string;
  returned: string;
  cacheRead: number;
  out: number;
  at: () => string;
}): { meta: Record<string, unknown>; lines: string[] } {
  const lines = [
    JSON.stringify({
      ...envelope(o.sessionId, o.cwd, `c1-${o.agentId}`, o.at()),
      isSidechain: true,
      agentId: o.agentId,
      promptId: `pr-${o.agentId}`,
      type: 'user',
      message: { role: 'user', content: o.prompt },
    }),
    JSON.stringify({
      ...envelope(o.sessionId, o.cwd, `c2-${o.agentId}`, o.at()),
      isSidechain: true,
      agentId: o.agentId,
      type: 'assistant',
      requestId: `req-${o.agentId}`,
      message: {
        role: 'assistant',
        model: o.model,
        content: [{ type: 'text', text: o.returned }],
        usage: usage(o.cacheRead, 2_100, o.out),
      },
    }),
  ];
  return {
    meta: {
      agentType: 'general-purpose',
      description: o.prompt.slice(0, 60),
      toolUseId: `toolu_${o.agentId}`,
      spawnDepth: 1,
      model: o.model.includes('haiku') ? 'haiku' : o.model.includes('sonnet') ? 'sonnet' : 'opus',
    },
    lines,
  };
}

/**
 * A report over 5,000 characters, because that is the threshold the verdict's wasted-subagent check
 * uses (`WASTED_OUTLEN` in `core/verdict.ts`). A shorter one would be a perfectly good report and a
 * useless scene: the finding the figure exists to show would never fire.
 */
function longReport(): string {
  const finding = (n: number) =>
    `**${n}. \`src/routes.ts:${10 + n}\`** — a parameter is consumed with no presence or type check, so a ` +
    `malformed body reaches the store and writes a key nothing will ever clean up. Failure case: a POST ` +
    `whose body omits the id, which succeeds silently and returns 200, leaving an \`undefined\` key that no ` +
    `sweep will ever collect. Fix: validate presence and type at the edge, and reject with 400 rather ` +
    `than storing what cannot be addressed again.`;
  const ns = Array.from({ length: 18 }, (_, i) => i + 1);
  return `## Input validation audit\n\n${ns.map(finding).join('\n\n')}\n`;
}

/**
 * A day of work in one session: five things sent, of five different kinds, and the last of them
 * wasteful. This is the scene the timeline, the verdict lens, the compaction, the Skills and
 * Commands cards and the failure badges all need — none of which a single clean turn can show.
 */
function busyDay(): Scene {
  const sessionId = '7c1e4f80-a1b2-4c3d-9e5f-0a1b2c3d4e5f';
  const cwd = '/tmp/orbit';
  const at = clock('2026-08-05T09:12:00.000Z');
  const w = new Writer(sessionId, cwd, at);

  // 1 — a normal turn of work, with one tool that failed. A failure is a badge, not a broken
  // session: the call after it succeeds.
  w.typed('Find why /v1/passes returns 503 under load and tell me what to change.');
  w.call({
    text: 'Reading the route table and the limiter.',
    cacheRead: 18_400,
    cacheWrite: 12_000,
    out: 180,
    tools: [{ id: 'tu1', name: 'Read', input: { file_path: `${cwd}/src/routes.ts` } }],
  });
  w.result('tu1', 'export const routes = { …240 lines… }');
  w.call({
    cacheRead: 31_000,
    out: 140,
    tools: [{ id: 'tu2', name: 'Read', input: { file_path: `${cwd}/logs/access.log`, limit: 4000 } }],
  });
  w.result('tu2', 'File content (53981 tokens) exceeds maximum allowed tokens (25000). Use offset and limit.', true);
  w.call({
    cacheRead: 33_500,
    out: 260,
    tools: [{ id: 'tu3', name: 'Read', input: { file_path: `${cwd}/logs/access.log`, offset: 1, limit: 1000 } }],
  });
  w.result('tu3', '2026-07-14T00:00:00Z 10.4.11.9 POST /v1/passes 503 3812ms\n…1000 lines…');
  w.call({ text: 'The limiter refills one token per second against a burst of sixty.', cacheRead: 58_200, out: 320 });
  w.turnEnd(48_000, 9);

  // 2 — a local command: grey on the timeline, because it cost nothing.
  w.command('model', 'sonnet');
  w.localStdout('Set model to Sonnet 5');

  // 3 — a turn the human cut off with Esc: everything it consumed, no answer to show for it.
  const cut = w.typed('Actually, rewrite the limiter as a leaky bucket.');
  w.call({ text: 'Sketching the leaky bucket…', model: SONNET, cacheRead: 61_000, out: 410 });
  w.typed('No, keep the token bucket — just raise the refill.', cut);
  w.call({ text: 'Raising the refill rate.', model: SONNET, cacheRead: 64_800, out: 150 });
  w.turnEnd(12_000, 3);

  // 4 — a skill, then a compaction: the context event that deflates everything.
  w.command('code-review');
  w.call({ text: 'Reviewing the diff.', model: SONNET, cacheRead: 88_000, out: 900, skill: 'code-review' });
  w.turnEnd(30_000, 2);
  w.command('compact');
  w.compaction(191_400, 42_800);

  // 5 — an exploration that changed nothing: nine reads, no edit, and NO subagent. The check
  // excludes a turn that delegated (`ev.subs === 0`), because delegating is what it recommends —
  // so the exploration finding and the wasted-subagent finding cannot live in the same turn.
  w.typed('Before we ship: is anything else in this project missing input validation?');
  for (const [i, f] of [
    'src/server.ts',
    'src/routes.ts',
    'src/rate-limit.ts',
    'src/passes.ts',
    'src/telemetry.ts',
    'src/keys.ts',
    'src/store.ts',
    'src/auth.ts',
    'src/index.ts',
  ].entries()) {
    const id = `tr${i}`;
    w.call({
      cacheRead: 44_000 + i * 3_000,
      out: 90,
      tools: [{ id, name: 'Read', input: { file_path: `${cwd}/${f}` } }],
    });
    w.result(id, `// ${f}\n…`);
  }
  w.call({ text: 'Nine files read, nothing changed — I still need the audit itself.', cacheRead: 92_000, out: 210 });
  w.turnEnd(74_000, 19);

  // 6 — the wasteful delegation: the subagent's report comes back over the 5,000-char threshold,
  // so the turn is flagged for what it pulled INTO the main context.
  w.typed('Run the audit properly and give me everything it finds.');
  w.call({
    text: 'Delegating the audit so the detail does not land in this context.',
    cacheRead: 96_000,
    out: 2_100,
    tools: [
      {
        id: 'toolu_a99',
        name: 'Agent',
        input: {
          description: 'Audit input validation across the project',
          subagent_type: 'general-purpose',
          model: 'sonnet',
          prompt: 'Read every file under src/ and audit it for missing input validation. Report every finding in full.',
        },
      },
    ],
  });
  w.result('toolu_a99', longReport());
  w.call({
    text: 'Six handlers take input without a presence check. The audit is in full above.',
    cacheRead: 132_000,
    out: 640,
  });
  w.turnEnd(96_000, 21);

  return {
    id: 'busy-day',
    cwd,
    sessionId,
    lines: w.lines,
    status: 'idle',
    children: {
      a99: child({
        agentId: 'a99',
        sessionId,
        cwd,
        prompt: 'Read every file under src/ and audit it for missing input validation. Report every finding in full.',
        model: SONNET,
        returned: longReport(),
        cacheRead: 26_400,
        out: 2_900,
        at,
      }),
    },
  };
}

/**
 * A session whose last call FAILED — the quietest failure there is, and the one state that cannot
 * be provoked: an API call does not fail because a script asked it to.
 */
function brokenSession(): Scene {
  const sessionId = '3b9d0c11-77aa-4bd2-8f13-6c5e4d3b2a10';
  const cwd = '/tmp/orbit';
  const w = new Writer(sessionId, cwd, clock('2026-08-05T14:41:00.000Z'));
  w.typed('Walk the whole log and summarise every 5xx by route.');
  w.call({
    text: 'Reading the access log in slices.',
    cacheRead: 22_000,
    cacheWrite: 14_000,
    out: 240,
    tools: [{ id: 'b1', name: 'Read', input: { file_path: `${cwd}/logs/access.log`, limit: 1000 } }],
  });
  w.result('b1', '…1000 lines…');
  w.call({
    cacheRead: 78_400,
    out: 180,
    tools: [{ id: 'b2', name: 'Read', input: { file_path: `${cwd}/logs/access.log`, offset: 1001, limit: 1000 } }],
  });
  w.result('b2', '…1000 lines…');
  // The failure, and nothing after it: 39 of 47 real failures were the last line their session wrote.
  w.call({
    cacheRead: 121_000,
    out: 0,
    apiError: { status: 429, message: "You've hit your session limit. Your limit resets at 6pm." },
  });
  return { id: 'broken', cwd, sessionId, lines: w.lines, status: 'idle' };
}

/**
 * Five finished sessions of different sizes and models, sharing one phrase. Home, Compare and
 * Search are about a CORPUS: on a single session the distribution is one bar, the weighted ranking
 * has nothing to rank, and a density ordering cannot be told from a recency one.
 */
function corpus(): Scene {
  // Each session says the shared phrase ITS OWN way. They were identical once, and five rows of
  // one sentence read as generated rather than recorded — the figure's job is to show a ranking,
  // not to advertise that it came from a script.
  const specs: Array<{
    name: string;
    prompt: string;
    model: string;
    turns: number;
    read: number;
    out: number;
    says: string;
  }> = [
    {
      name: 'orbit',
      prompt: 'Find why /v1/passes returns 503 under load',
      model: OPUS,
      turns: 9,
      read: 184_000,
      out: 2_400,
      says: 'The 503 spike tracks the refill rate exactly: sixty tokens of burst, one per second back.',
    },
    {
      name: 'atlas',
      prompt: 'Port the rate limiter to the new store',
      model: SONNET,
      turns: 5,
      read: 62_000,
      out: 900,
      says: 'Porting the bucket will not change the 503 spike on its own — the refill is the cause.',
    },
    {
      name: 'beacon',
      prompt: 'Rename the telemetry fields across the client',
      model: HAIKU,
      turns: 4,
      read: 18_000,
      out: 400,
      says: 'Renaming the fields leaves the 503 spike untouched; it is a limiter problem, not a schema one.',
    },
    {
      name: 'harbor',
      prompt: 'Write the incident note for the 503 spike',
      model: SONNET,
      turns: 2,
      read: 7_000,
      out: 260,
      says: 'Draft: the 503 spike lasted eleven minutes, caused by the limiter refill, resolved by raising it.',
    },
    {
      name: 'lantern',
      prompt: 'Audit the keys endpoint for missing input validation',
      model: OPUS,
      turns: 6,
      read: 96_000,
      out: 1_100,
      says: 'Unrelated to the 503 spike, but the keys endpoint takes a body with no presence check at all.',
    },
  ];
  const archive = specs.map((s, i) => {
    const cwd = `/tmp/${s.name}`;
    const sessionId = `c${i}0000000-0000-4000-8000-00000000000${i}`;
    const w = new Writer(sessionId, cwd, clock(`2026-08-0${i + 1}T08:00:00.000Z`));
    w.typed(s.prompt);
    for (let t = 0; t < s.turns; t++) {
      w.call({
        // The phrase every session shares, at different densities: what makes a density ranking
        // visibly different from a recency one.
        text: t === 0 ? s.says : `Pass ${t + 1}: reading the store.`,
        model: s.model,
        cacheRead: s.read + t * 4_000,
        cacheWrite: t === 0 ? 9_000 : 0,
        out: s.out,
      });
      w.turnEnd(18_000 + t * 3_000, 2);
      if (t < s.turns - 1) w.typed(`Keep going — pass ${t + 2}.`);
    }
    return { cwd, sessionId, lines: w.lines };
  });
  // The scene's own session is the first of the archive, so the page has something to open.
  const first = archive[0]!;
  return {
    id: 'corpus',
    cwd: first.cwd,
    sessionId: first.sessionId,
    lines: first.lines,
    archive: archive.slice(1),
    status: 'idle',
  };
}

/** Every synthetic scene, by the id a shot names in `doc-shots.json`. */

/**
 * A session that leaned on the background: five shell commands launched to run while the turn went
 * on, two subagents beside them, and among the commands the state no recording can be relied on to
 * produce — one that FAILED, one still running, one whose fate was never reported.
 *
 * It exists for the bottom card: with both catalogues non-empty it grows its two tabs, which is
 * precisely the state a figure has to show and which a quiet session never reaches.
 */
function commands(): Scene {
  const cwd = '/tmp/orbit';
  const sessionId = '5f2a91c4-3d7e-4b18-9a06-2c8e5d1f7b43';
  const at = clock('2026-03-04T09:12:00.000Z');
  const w = new Writer(sessionId, cwd, at);

  w.typed('Cut the release: build every target, run the suite, and watch the tag.');
  w.call({
    text: 'Launching the long ones in the background so the turn is not blocked.',
    cacheRead: 48_000,
    out: 340,
    tools: [
      {
        id: 'toolu_c1',
        name: 'Bash',
        input: {
          command: 'bun run build:server:all',
          description: 'Build every platform binary',
          run_in_background: true,
        },
      },
      {
        id: 'toolu_c2',
        name: 'Bash',
        input: {
          command: 'bun run test --coverage',
          description: 'Run the suite with coverage',
          run_in_background: true,
        },
      },
    ],
  });
  w.backgroundLaunch('toolu_c1', 'b1k4m9x2z');
  w.backgroundLaunch('toolu_c2', 'b7p3q8w5v');
  w.notification(
    'toolu_c2',
    'b7p3q8w5v',
    'completed',
    'Background command "Run the suite with coverage" completed (exit code 0)',
  );
  w.call({ text: 'The suite is green. The build is still going.', cacheRead: 61_000, out: 180 });
  w.turnEnd(41_000, 9);

  w.typed('While that runs, review the diff and watch the release.');
  w.call({
    text: 'Two reviewers on the diff, and a watcher on the tag.',
    cacheRead: 74_000,
    out: 620,
    tools: [
      {
        id: 'toolu_a1',
        name: 'Agent',
        input: {
          description: 'Review the diff for correctness',
          subagent_type: 'general-purpose',
          model: 'sonnet',
          prompt: 'Read the diff of the last three commits and report defects only.',
        },
      },
      {
        id: 'toolu_a2',
        name: 'Agent',
        input: {
          description: 'Check the docs against the code',
          subagent_type: 'general-purpose',
          model: 'sonnet',
          prompt: 'Read docs/ and report every sentence the code contradicts.',
        },
      },
      {
        id: 'toolu_c3',
        name: 'Bash',
        input: {
          command: 'gh run watch --exit-status',
          description: 'Watch the release workflow',
          run_in_background: true,
        },
      },
    ],
  });
  w.result('toolu_a1', 'Two defects, both in the parser branch. Detail above.');
  w.result('toolu_a2', 'Three sentences no longer true, listed with their line numbers.');
  w.backgroundLaunch('toolu_c3', 'b2n6r4t8y');
  w.notification(
    'toolu_c1',
    'b1k4m9x2z',
    'completed',
    'Background command "Build every platform binary" completed (exit code 0)',
  );
  w.notification(
    'toolu_c3',
    'b2n6r4t8y',
    'failed',
    'Background command "Watch the release workflow" failed with exit code 1',
  );
  w.call({
    text: 'The build is done, the reviewers came back, and the workflow watcher exited 1 — the tag never landed.',
    cacheRead: 96_000,
    out: 720,
    tools: [
      {
        id: 'toolu_c4',
        name: 'Bash',
        input: {
          command: 'until gh release view v0.13.0 >/dev/null 2>&1; do sleep 20; done',
          description: 'Wait for the release to appear',
          run_in_background: true,
        },
      },
      {
        id: 'toolu_c5',
        name: 'Bash',
        input: {
          command: 'tail -f /tmp/orbit/logs/publish.log',
          description: 'Follow the publish log',
          run_in_background: true,
        },
      },
    ],
  });
  w.backgroundLaunch('toolu_c4', 'b9j5h1k7l');
  w.backgroundLaunch('toolu_c5', 'b3d8f2g6s');
  // c4 is killed from outside — the case that produces the failure nobody is told about in words,
  // and c5 is simply never reported, which is what 8% of real launches do.
  w.notification(
    'toolu_c4',
    'b9j5h1k7l',
    'failed',
    'Background command "Wait for the release to appear" failed with exit code 144',
  );
  w.turnEnd(88_000, 17);

  return {
    id: 'commands',
    cwd,
    sessionId,
    lines: w.lines,
    status: 'busy',
    children: {
      a1: child({
        agentId: 'a1',
        sessionId,
        cwd,
        prompt: 'Read the diff of the last three commits and report defects only.',
        model: SONNET,
        returned: 'Two defects, both in the parser branch.',
        cacheRead: 18_200,
        out: 900,
        at,
      }),
      a2: child({
        agentId: 'a2',
        sessionId,
        cwd,
        prompt: 'Read docs/ and report every sentence the code contradicts.',
        model: SONNET,
        returned: 'Three sentences no longer true, listed with their line numbers.',
        cacheRead: 14_800,
        out: 640,
        at,
      }),
    },
  };
}

export const SCENES: Record<string, () => Scene> = {
  commands,
  'busy-day': busyDay,
  broken: brokenSession,
  corpus,
};

/**
 * Materialise a scene into a `CLAUDE_CONFIG_DIR`-shaped tree — the same layout Claude Code writes,
 * which is the only thing seedeep knows how to read. Returns the session the page should open.
 *
 * Archive sessions are written WITHOUT a live record: they are finished sessions, which is what the
 * corpus surfaces are about.
 */
export async function writeScene(
  cfg: string,
  scene: Scene,
  fs: {
    mkdir: (p: string, o: { recursive: true }) => Promise<unknown>;
    writeFile: (p: string, s: string) => Promise<unknown>;
  },
  join: (...p: string[]) => string,
): Promise<{ sessionId: string; cwd: string }> {
  const sessions: Array<{ cwd: string; sessionId: string; lines: string[] }> = [
    { cwd: scene.cwd, sessionId: scene.sessionId, lines: scene.lines },
    ...(scene.archive ?? []),
  ];
  for (const s of sessions) {
    const dir = join(cfg, 'projects', slugOf(s.cwd));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, `${s.sessionId}.jsonl`), `${s.lines.join('\n')}\n`);
  }
  for (const [agentId, c] of Object.entries(scene.children ?? {})) {
    const dir = join(cfg, 'projects', slugOf(scene.cwd), scene.sessionId, 'subagents');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, `agent-${agentId}.jsonl`), `${c.lines.join('\n')}\n`);
    // The meta file is what links a child to the `Agent` tool_use that spawned it. Without it the
    // spawn and the child become two nodes, one of them empty.
    await fs.writeFile(join(dir, `agent-${agentId}.meta.json`), JSON.stringify(c.meta));
  }
  return { sessionId: scene.sessionId, cwd: scene.cwd };
}
