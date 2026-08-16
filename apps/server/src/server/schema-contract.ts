/**
 * What seedeep REQUIRES Claude Code to keep writing.
 *
 * Every claim names the site that reads it, so a failure says what BREAKS, not
 * merely what is missing. The probe provokes each scene and evaluates these.
 *
 * The two-field split is the heart of it:
 *   `provoked` — did the scene actually happen? Answered from GROUND TRUTH (the
 *     raw text the probe typed), never from the field under test. Deciding
 *     "should I check origin?" by looking at origin would make a real removal
 *     look like a scene that never ran.
 *   `holds` — is the field there, in the shape the parser expects?
 */

export type ClaimKind = 'gesture' | 'model';

export interface ClaimContext {
  /** Parsed lines of the driven session's transcript. */
  lines: any[];
  /** Raw text of the transcript, for ground-truth marker checks. */
  raw: string;
  /** Subagent children of this session. */
  children: Array<{ agentId: string; lines: any[]; meta: any }>;
  /**
   * ~/.claude/sessions/<PID>.json entries captured WHILE the session was alive — every
   * DISTINCT state it passed through, not just the first: a pending approval is a state
   * that comes and goes, and one sample per session would always miss it.
   */
  openSessions: Array<{
    pid: number;
    sessionId: string;
    cwd: string;
    status?: string | null;
    waitingFor?: string | null;
  }>;
}

export interface Claim {
  id: string;
  scene: number;
  describe: string;
  reader: string;
  /** What a human should go and look at when this does not hold. */
  investigate: string;
  /**
   * How to test this BY HAND, for the checklist a run prints when it could not
   * prove the claim itself. Written as an instruction, not a description —
   * "a thing the probe could not check" is only useful if it says what to do.
   */
  manual?: string;
  /**
   * 'gesture' — the probe caused the event itself, so absence is PROOF (BROKEN).
   * 'model'  — the model had to choose to do it, so absence is inconclusive
   *             (UNPROVEN): CC may have changed, or Claude just answered
   *             differently. Never report a model claim as broken.
   */
  kind: ClaimKind;
  provoked(ctx: ClaimContext): boolean;
  holds(ctx: ClaimContext): boolean;
}

const typed = (ctx: ClaimContext, t: string) => ctx.lines.filter((d) => d?.type === t);

/** The user line carrying `marker` — found by raw text, not by structure. */
function userLineWith(ctx: ClaimContext, marker: string): any | null {
  for (const d of typed(ctx, 'user')) {
    if (JSON.stringify(d).includes(marker)) return d;
  }
  return null;
}

const blocks = (d: any): any[] => (Array.isArray(d?.message?.content) ? d.message.content : []);

function anyAssistant(ctx: ClaimContext, pred: (d: any) => boolean): boolean {
  return typed(ctx, 'assistant').some(pred);
}

/**
 * The launch receipt of the background command whose `tool_use` ran `commandMarker`, with the
 * input that asked for it — walked tool_use → tool_result rather than found by text, because a
 * probe run writes SEVERAL background receipts (scene 13 writes one of its own) and the wrong
 * one proves nothing about the gesture under test.
 */
function backgroundReceiptOf(ctx: ClaimContext, commandMarker: string): { result: any; input: any } | null {
  const inputs = new Map<string, any>();
  for (const d of typed(ctx, 'assistant')) {
    for (const b of blocks(d)) {
      if (b?.type === 'tool_use' && typeof b?.input?.command === 'string' && b.input.command.includes(commandMarker)) {
        inputs.set(b.id, b.input);
      }
    }
  }
  for (const d of typed(ctx, 'user')) {
    const res = blocks(d).find((b: any) => b?.type === 'tool_result' && inputs.has(b.tool_use_id));
    if (!res) continue;
    const tur = d.toolUseResult;
    if (!tur || typeof tur !== 'object' || typeof tur.backgroundTaskId !== 'string') continue;
    return { result: tur, input: inputs.get(res.tool_use_id) };
  }
  return null;
}

/** The probe's scene-1 prompt; the marker that proves a typed prompt happened. */
export const SCENE1_MARKER = 'say only the word ok';
export const ECHO_MARKER = 'probe-echo';
// The word the probe's skill REPLIES with — proof the skill actually ran, which
// is not the same as proof it was invoked by name. Measured 2026-07-17: typing
// `/probe-skill` runs the skill but attributes NOTHING (attributionSkill=[]),
// while a prompt matching its description yields attributionSkill twice. The
// field records MODEL invocation, not user invocation — so the scene must let
// Claude choose the skill, and the marker is how we know it did.
export const SKILL_MARKER = 'probeskillok';
// The EXACT prompt scene 5 types — scenes.ts imports it rather than keeping its
// own copy. They drifted apart once and C17 then reported "scene 5 never
// happened" for a scene that had run perfectly.
export const ESC_MARKER = 'count slowly from 1 to 200, one number per line';
export const POST_ESC_MARKER = 'say only the word done';
// The command scene 14 runs in the FOREGROUND and then takes away with Ctrl+B. Short on purpose:
// a Bash that outlives its call's own timeout is promoted to the background by Claude Code, and
// that receipt looks the same but for `timedOutAfterMs` — so a command the timeout could reach
// would make the gesture prove nothing. The timeout is the CALL's, not a constant: measured over
// 22 promotions locally it ranges 45s–600s and matches the `timeout` the model asked for (16 of
// 22 named one), the rest falling to the tool's 2-minute default. 47s is under that default and
// the scene never asks for another. scenes.ts imports it — see ESC_MARKER's note on what two
// copies of a scene's own text cost.
export const CTRLB_COMMAND = 'sleep 47';

export const CLAIMS: Claim[] = [
  // ── Scene 1: a typed prompt ────────────────────────────────────────────────
  {
    id: 'C1',
    scene: 1,
    describe: "origin.kind === 'human' on a typed prompt",
    reader: 'parser.ts:110',
    investigate:
      "open a real session's jsonl, find a line you typed, and see what replaced `origin`. seedeep's turn detection keys off it.",
    kind: 'gesture',
    provoked: (ctx) => userLineWith(ctx, SCENE1_MARKER) !== null,
    holds: (ctx) => userLineWith(ctx, SCENE1_MARKER)?.origin?.kind === 'human',
  },
  {
    id: 'C2',
    scene: 1,
    describe: 'message.usage carries the four token counters',
    reader: 'parser.ts:151',
    investigate: 'check an assistant line: are the counters renamed, nested, or gone? The context bar reads them.',
    kind: 'gesture',
    provoked: (ctx) => typed(ctx, 'assistant').length > 0,
    holds: (ctx) =>
      anyAssistant(ctx, (d) => {
        const u = d?.message?.usage;
        return (
          !!u &&
          typeof u.input_tokens === 'number' &&
          typeof u.output_tokens === 'number' &&
          typeof u.cache_read_input_tokens === 'number' &&
          typeof u.cache_creation_input_tokens === 'number'
        );
      }),
  },
  {
    id: 'C3',
    scene: 1,
    describe: 'message.id identifies the API call',
    reader: 'parser.ts:155',
    investigate: "seedeep groups a turn's usage by call id; without it the per-call breakdown collapses.",
    kind: 'gesture',
    provoked: (ctx) => typed(ctx, 'assistant').length > 0,
    holds: (ctx) => anyAssistant(ctx, (d) => typeof d?.message?.id === 'string'),
  },
  {
    id: 'C4',
    scene: 1,
    describe: 'system/turn_duration with durationMs + messageCount',
    reader: 'parser.ts:277',
    investigate: 'this is the end-of-turn marker. Without it a turn never closes and the live bar stays stuck.',
    kind: 'gesture',
    provoked: (ctx) => userLineWith(ctx, SCENE1_MARKER) !== null,
    holds: (ctx) =>
      typed(ctx, 'system').some(
        (d) =>
          d?.subtype === 'turn_duration' && typeof d?.durationMs === 'number' && typeof d?.messageCount === 'number',
      ),
  },
  {
    id: 'C5',
    scene: 1,
    describe: "stop_reason 'end_turn' with a text block = the turn's answer",
    reader: 'parser.ts:189',
    investigate:
      'seedeep shows the turn result from this. Mid-stream lines have stop_reason null, so the gate matters.',
    kind: 'gesture',
    provoked: (ctx) => typed(ctx, 'assistant').length > 0,
    holds: (ctx) =>
      anyAssistant(
        ctx,
        (d) =>
          d?.message?.stop_reason === 'end_turn' &&
          blocks(d).some((b) => b?.type === 'text' && typeof b.text === 'string'),
      ),
  },
  {
    id: 'C6',
    scene: 1,
    describe: 'the three line types seedeep parses still exist',
    reader: 'parser.ts:138',
    investigate: 'if a type was renamed, the parser drops every line of it silently.',
    kind: 'gesture',
    provoked: (ctx) => ctx.lines.length > 0,
    holds: (ctx) => ['assistant', 'user', 'system'].every((t) => typed(ctx, t).length > 0),
  },
  {
    id: 'C7',
    scene: 1,
    describe: 'sessionId / cwd / entrypoint / message.model — the discovery anchors',
    reader: 'discovery.ts:85',
    investigate: 'these label a session in the picker; without them sessions are unnamed or invisible.',
    kind: 'gesture',
    provoked: (ctx) => ctx.lines.length > 0,
    holds: (ctx) =>
      ctx.lines.some((d) => typeof d?.sessionId === 'string') &&
      ctx.lines.some((d) => typeof d?.cwd === 'string') &&
      ctx.lines.some((d) => typeof d?.entrypoint === 'string') &&
      anyAssistant(ctx, (d) => typeof d?.message?.model === 'string'),
  },
  {
    id: 'C8',
    scene: 1,
    describe: 'the session is a `cli` entrypoint (the species seedeep observes)',
    reader: 'discovery.ts:87',
    investigate: "if a driven TUI now reports something other than 'cli', every species assumption needs re-measuring.",
    kind: 'gesture',
    provoked: (ctx) => ctx.lines.some((d) => typeof d?.entrypoint === 'string'),
    holds: (ctx) => ctx.lines.some((d) => d?.entrypoint === 'cli'),
  },
  {
    id: 'C9',
    scene: 1,
    describe: '~/.claude/sessions/<PID>.json marks the session open while it lives',
    reader: 'open-sessions.ts:59',
    investigate: 'seedeep badges live sessions from this file; if it moved, everything looks closed.',
    kind: 'gesture',
    provoked: () => true,
    holds: (ctx) => ctx.openSessions.some((s) => typeof s.sessionId === 'string' && typeof s.cwd === 'string'),
  },

  // ── Scene 2: slash commands ────────────────────────────────────────────────
  {
    id: 'C10',
    scene: 2,
    describe: '<command-name> + <command-args>, and NO origin on a command line',
    reader: 'parser.ts:91,114',
    investigate:
      'the parser trusts the tag ONLY on a line without human origin. If commands gained an `origin`, every typed prompt quoting a tag gets misread.',
    kind: 'gesture',
    provoked: (ctx) => userLineWith(ctx, ECHO_MARKER) !== null,
    holds: (ctx) => {
      const d = userLineWith(ctx, `<command-name>/${ECHO_MARKER}`) ?? userLineWith(ctx, ECHO_MARKER);
      if (!d) return false;
      const s = JSON.stringify(d);
      return s.includes('<command-name>') && s.includes('<command-args>') && d.origin === undefined;
    },
  },

  {
    id: 'C11',
    scene: 2,
    describe: 'an argument-less command still writes <command-name>',
    reader: 'parser.ts:118',
    investigate: 'a bare /command must still open a turn; when it did not, the live bar showed nothing for it.',
    kind: 'gesture',
    provoked: (ctx) => userLineWith(ctx, ECHO_MARKER) !== null,
    holds: (ctx) =>
      typed(ctx, 'user').some((d) => {
        const s = JSON.stringify(d);
        return s.includes('<command-name>') && s.includes(ECHO_MARKER) && !s.includes('hello world');
      }),
  },

  // ── Scene 11: a headless session (a DIFFERENT session — see the runner) ────
  {
    id: 'C23',
    scene: 11,
    describe: "promptSource === 'sdk' on a headless prompt",
    reader: 'parser.ts:120',
    investigate:
      'the sdk branch exists for `claude -p` sessions (a git hook, a script). A cli session can never prove it — this claim is evaluated against a separate headless run.',
    kind: 'gesture',
    provoked: (ctx) => ctx.lines.length > 0,
    holds: (ctx) => typed(ctx, 'user').some((d) => d?.promptSource === 'sdk'),
  },

  // ── Scene 4: a background subagent ─────────────────────────────────────────
  {
    id: 'C14',
    scene: 4,
    describe: "toolUseResult.status 'async_launched' + agentId = a background launch",
    reader: 'parser.ts:237',
    investigate:
      'without this the launch receipt reads as a completion and ~92% of subagents show as finished at birth (the bug that made background subagents look finished at birth).',
    manual:
      'open a real session, ask Claude something broad enough that it spawns a subagent, and confirm seedeep shows it as RUNNING (not instantly finished).',

    kind: 'model',
    provoked: (ctx) => typed(ctx, 'user').some((d) => d?.toolUseResult),
    holds: (ctx) =>
      typed(ctx, 'user').some(
        (d) => d?.toolUseResult?.status === 'async_launched' && typeof d.toolUseResult.agentId === 'string',
      ),
  },
  {
    id: 'C15',
    scene: 4,
    describe: 'queue-operation carrying <task-notification> with <tool-use-id>',
    reader: 'parser.ts:290',
    investigate: 'this line ENDS a background subagent. Without it they stay running forever.',
    manual: 'wait for that subagent to finish and confirm seedeep stops showing it as running.',

    kind: 'model',
    provoked: (ctx) => typed(ctx, 'user').some((d) => d?.toolUseResult?.status === 'async_launched'),
    holds: (ctx) =>
      typed(ctx, 'queue-operation').some(
        (d) =>
          typeof d?.content === 'string' &&
          d.content.includes('<task-notification>') &&
          d.content.includes('<tool-use-id>'),
      ),
  },
  {
    id: 'C16',
    scene: 4,
    describe: 'the child transcript exists, with a meta.json naming its toolUseId',
    reader: 'replay.ts:24,45',
    investigate: 'seedeep reads a subagent from its own file; if the layout moved, subagents vanish from the tree.',
    manual: "with a subagent spawned, confirm it appears as its own node in seedeep's tree.",
    kind: 'model',
    provoked: (ctx) => typed(ctx, 'user').some((d) => d?.toolUseResult?.status === 'async_launched'),
    holds: (ctx) => ctx.children.length > 0 && ctx.children.some((c) => typeof c.meta?.toolUseId === 'string'),
  },
  {
    id: 'C16b',
    scene: 4,
    describe: "the child's own lines carry message.usage (a subagent's fill)",
    reader: 'parser.ts:148',
    investigate: "a subagent's context fill is read from its own transcript, not the parent's.",
    manual: "click that subagent in seedeep and confirm it reports its own token fill, not the parent's.",
    kind: 'model',
    provoked: (ctx) => ctx.children.length > 0,
    holds: (ctx) => ctx.children.some((c) => c.lines.some((d) => d?.message?.usage)),
  },
  {
    id: 'C16c',
    scene: 4,
    describe: "the child's end_turn text = the subagent's RETURNED OUTPUT",
    reader: 'parser.ts:401',
    investigate:
      "seedeep's differentiator. If this line stops being written, every subagent renders output-less while everything else still 'works'.",
    manual:
      'click that subagent and confirm seedeep shows the text it RETURNED. This is the differentiator — check it first.',

    kind: 'model',
    provoked: (ctx) => ctx.children.length > 0,
    holds: (ctx) =>
      ctx.children.some((c) =>
        c.lines.some(
          (d) =>
            d?.type === 'assistant' &&
            d?.message?.stop_reason === 'end_turn' &&
            (Array.isArray(d?.message?.content) ? d.message.content : []).some(
              (b: any) => b?.type === 'text' && b.text,
            ),
        ),
      ),
  },

  // ── Scene 5: Esc ───────────────────────────────────────────────────────────
  {
    id: 'C17',
    scene: 5,
    describe: 'interruptedMessageId on the user line after an Esc',
    reader: 'parser.ts:251',
    investigate: 'seedeep marks a turn interrupted from this. Without it an Esc looks like a normal turn.',
    kind: 'gesture',
    // Ground truth: the post-Esc prompt was typed AND the interrupted one exists.
    provoked: (ctx) => userLineWith(ctx, POST_ESC_MARKER) !== null && userLineWith(ctx, ESC_MARKER) !== null,
    holds: (ctx) =>
      typed(ctx, 'user').some((d) => typeof d?.interruptedMessageId === 'string' && d.interruptedMessageId),
  },

  // ── Scene 6: a foreground subagent (ORDERED — see the design's caveat) ──────
  {
    id: 'C18',
    scene: 6,
    describe: 'toolUseResult.content + totalTokens/totalDurationMs/status (inline result)',
    reader: 'parser.ts:222',
    investigate:
      'the synchronous subagent branch. Background launches never carry inline output, so only this proves it.',
    manual:
      'ask Claude to do something it must wait for before continuing; confirm the inline subagent result still renders.',

    kind: 'model',
    provoked: (ctx) => typed(ctx, 'user').some((d) => d?.toolUseResult),
    holds: (ctx) => typed(ctx, 'user').some((d) => Array.isArray(d?.toolUseResult?.content)),
  },

  // ── Scene 7: a skill ───────────────────────────────────────────────────────
  {
    id: 'C19',
    scene: 7,
    describe: 'attributionSkill when the model invokes a skill',
    reader: 'parser.ts:160',
    investigate:
      'the Skills widget reads this; without it skill activity is invisible. Note it records MODEL invocation only — a user-typed /skill runs the skill and attributes nothing.',
    manual:
      "in a real session, phrase a request so Claude picks a skill on its own (do NOT type /skill — that runs it without attribution), then confirm seedeep's Skills widget lists it.",
    // NOT a gesture: the probe cannot MAKE the model choose a skill, and only a
    // model-chosen skill is attributed at all. Marking it a gesture would have
    // blocked certification forever on a run where Claude simply answered
    // directly. It belongs on the manual checklist instead.
    kind: 'model',
    provoked: (ctx) => ctx.raw.includes(SKILL_MARKER),
    holds: (ctx) => anyAssistant(ctx, (d) => typeof d?.attributionSkill === 'string' && d.attributionSkill.length > 0),
  },

  // ── Scene 8: MCP (env-dependent — usually UNPROVEN) ────────────────────────
  {
    id: 'C20',
    scene: 8,
    describe: 'attributionMcpServer + attributionMcpTool',
    reader: 'parser.ts:160',
    investigate:
      'MCP attribution. Needs a configured, authenticated server — absence here usually means no server answered.',
    manual: 'call any MCP tool in a real session and confirm seedeep attributes it to the right server.',

    kind: 'model',
    provoked: (ctx) => anyAssistant(ctx, (d) => d?.attributionMcpServer || d?.attributionMcpTool),
    holds: (ctx) =>
      anyAssistant(
        ctx,
        (d) => typeof d?.attributionMcpServer === 'string' && typeof d?.attributionMcpTool === 'string',
      ),
  },

  // ── Scene 9: TaskCreate ────────────────────────────────────────────────────
  {
    id: 'C21',
    scene: 9,
    describe: "the 'Task #N created successfully: <subject>' result text",
    reader: 'parser.ts:56',
    investigate:
      'the ONLY claim that is a text shape, so a reworded message breaks it silently. It maps a todo to its number.',
    manual:
      'give Claude a multi-step job so it creates tasks, and confirm seedeep labels them by subject rather than by a bare id.',

    kind: 'model',
    provoked: (ctx) => ctx.raw.includes('created successfully'),
    holds: (ctx) => /Task #\d+ created successfully: /.test(ctx.raw),
  },

  // ── Scene 3: a tool call ───────────────────────────────────────────────────
  {
    id: 'C12',
    scene: 3,
    describe: 'tool_use blocks carry id + name + input',
    reader: 'parser.ts:170',
    investigate: 'every tool seedeep shows starts here.',
    manual: "open a real session, ask Claude to read a file, and confirm seedeep's feed shows the tool starting.",
    kind: 'model',
    provoked: (ctx) => anyAssistant(ctx, (d) => blocks(d).some((b) => b?.type === 'tool_use')),
    holds: (ctx) =>
      anyAssistant(ctx, (d) =>
        blocks(d).some((b) => b?.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string'),
      ),
  },
  {
    id: 'C13',
    scene: 3,
    describe: 'tool_result blocks carry tool_use_id (the link back to the call)',
    reader: 'parser.ts:209',
    investigate: 'without the id a tool never ends and stays spinning in the feed.',
    manual:
      'same session as C12: confirm the tool row STOPS spinning and shows a duration — that is the tool_result link working.',

    kind: 'model',
    provoked: (ctx) => typed(ctx, 'user').some((d) => blocks(d).some((b) => b?.type === 'tool_result')),
    holds: (ctx) =>
      typed(ctx, 'user').some((d) =>
        blocks(d).some((b) => b?.type === 'tool_result' && typeof b.tool_use_id === 'string'),
      ),
  },

  // ── Scene 10: /compact ─────────────────────────────────────────────────────
  {
    id: 'C22',
    scene: 10,
    describe: 'compactMetadata (preTokens/postTokens) or isCompactSummary',
    reader: 'parser.ts:300',
    investigate: 'seedeep shows compaction as a context event; without it a compaction is invisible.',
    manual:
      'run /compact in a session big enough to actually compact, and confirm seedeep shows the compaction with its before/after token numbers.',

    // NOT a gesture: typing /compact does not MAKE a compaction happen — Claude
    // Code refuses on a session as small as the probe's, so this can never be
    // provoked on demand and would block certification forever. The manual
    // checklist is where it belongs.
    kind: 'model',
    // `raw.includes('compact')` is NOT proof either: it is true the moment the
    // probe types /compact, which made run 1 report seedeep BROKEN for an event
    // that never happened. A compaction leaves a `system/compact_boundary` line
    // (69 in the real logs); THAT is evidence the event occurred.
    provoked: (ctx) => ctx.lines.some((d) => d?.type === 'system' && d?.subtype === 'compact_boundary'),
    holds: (ctx) =>
      ctx.lines.some(
        (d) => d?.isCompactSummary === true || (d?.compactMetadata && typeof d.compactMetadata === 'object'),
      ),
  },

  // ── Scene 12: a pending approval ───────────────────────────────────────────
  // Numbered after /compact because it RUNS after it (scene 11 is the headless
  // species, driven separately). Nothing about a pending prompt reaches the
  // transcript, so this is the one claim that lives entirely in the PID file.
  {
    id: 'C24',
    scene: 12,
    describe:
      "a pending approval writes status 'waiting' + waitingFor 'permission prompt' in ~/.claude/sessions/<PID>.json",
    reader: 'open-sessions.ts:60, sessions.ts pendingInput',
    investigate:
      'seedeep badges a session that is blocked on the user from this pair. If the label changed, the tab badge, the amber NOW panel and the toast all go silent — and silently, because a session that never says it is waiting looks like one that is simply idle.',
    manual:
      'run a command that needs approval in a real session and, while the dialog is up, read ~/.claude/sessions/<PID>.json: status must be "waiting" and waitingFor "permission prompt".',

    // A gesture: the probe DECLINED the prompt, so the refusal is proof the dialog
    // really was on screen. If it was, and the file did not say so, seedeep is broken.
    kind: 'gesture',
    // Ground truth from the transcript, never from the field under test: Claude Code
    // writes this tool_result only when a human answered "no" to a real prompt.
    provoked: (ctx) => ctx.raw.includes("The user doesn't want to proceed with this tool use"),
    holds: (ctx) => ctx.openSessions.some((s) => s.status === 'waiting' && s.waitingFor === 'permission prompt'),
  },

  // The claim this guard did NOT have, and the one that cost a release. Every other claim here
  // asks whether a FIELD is still written; this one asks whether a VALUE is still spelled the same.
  // Nothing in the radar can cover it — it watches field names, in transcripts, and this is a value
  // in the PID file — so the probe is the only mechanism that can hold Claude Code to it.
  {
    id: 'C25',
    scene: 13,
    describe: "a background command outliving its turn writes status 'shell' in ~/.claude/sessions/<PID>.json",
    reader: 'open-sessions.ts:31',
    investigate:
      'seedeep reads this to keep a session under Working while a command it launched runs on. Unknown values become null, and a session with no status is filed under Idle — so a renamed value does not fail, it silently demotes the session, which is exactly how this was found (reported by a user, not by a test).',
    manual:
      'launch a long command with run_in_background, let the turn end, and read ~/.claude/sessions/<PID>.json while it runs: status must be "shell".',

    // A gesture: the probe asked for the background launch, and the receipt proves it happened.
    kind: 'gesture',
    // Ground truth from the TRANSCRIPT, never from the field under test: `backgroundTaskId` is
    // written on the launch receipt of a background command and nowhere else.
    provoked: (ctx) => ctx.raw.includes('"backgroundTaskId"'),
    holds: (ctx) => ctx.openSessions.some((s) => s.status === 'shell'),
  },

  // Not a field and not a value: a PATH LAYOUT. seedeep finds a background command's output file
  // by its task id, because that file is the only thing that can be asked whether the command's
  // process still exists — so the shape of the path IS the mechanism. Nothing else can watch it:
  // the radar reads field names, and a layout that moved would simply stop resolving, leaving a
  // feature that answers "cannot say" for ever and looks exactly like one with nothing to report.
  {
    id: 'C26',
    scene: 13,
    describe: "a background command's output file is <tmp>/claude-<uid>/<slug>/<session>/tasks/<taskId>.output",
    reader: 'command-liveness.ts:58',
    investigate:
      'seedeep resolves that file from the launch receipt\'s task id to ask whether any process still holds it open — the only way a command whose end Claude Code never writes can stop counting. The parsed path itself cannot be used (anon() masks the session uuid inside it), so the LAYOUT is what the search depends on. If it moved, resolveOutputFile returns null, every probe answers "no verdict", and the rows silently go back to counting for ever.',
    manual:
      'launch anything with run_in_background and read the tool_result: the sentence "Output is being written to: …" must name a path under /tmp/claude-<uid> with the task id as the file name inside a tasks/ directory.',

    kind: 'gesture',
    // Ground truth from the receipt's own marker, never from the path under test.
    provoked: (ctx) => ctx.raw.includes('"backgroundTaskId"'),
    holds: (ctx) => {
      const line = userLineWith(ctx, '"backgroundTaskId"');
      const taskId = line?.toolUseResult?.backgroundTaskId;
      if (typeof taskId !== 'string' || !taskId) return false;
      const text = blocks(line)
        .map((b: any) => (typeof b?.content === 'string' ? b.content : ''))
        .join(' ');
      const named = /Output is being written to:\s*(\S+?)\.\s/.exec(text);
      if (!named) return false;
      // The exact shape `resolveOutputFile` walks: root, project slug, session, `tasks`, and the
      // task id as the file's own name.
      return new RegExp(`^(?:/private)?/tmp/claude-\\d+/[^/]+/[^/]+/tasks/${taskId}\\.output$`).test(named[1]!);
    },
  },

  // ── Scene 14: the user takes a running command away ────────────────────────
  // A background command has THREE possible authors, and the receipt names each with a different
  // field: the model asked (`run_in_background` in the input), the call's timeout promoted it
  // (`timedOutAfterMs`), or the user pressed Ctrl+B (this one). Measured 2026-08-09 over 221
  // background receipts in 515 local sessions: the three are mutually exclusive, never two at
  // once. This is the only POSITIVE marker of the third author — without it the case can only be
  // inferred from the absence of the other two, which is exactly the reading that mislabels the
  // pre-2.1.211 receipts (no timeout field existed yet, so a timeout reads as a model choice).
  {
    id: 'C27',
    scene: 14,
    describe: 'toolUseResult.backgroundedByUser marks a command the USER moved to the background (Ctrl+B)',
    reader: 'parser.ts:415',
    investigate:
      'the receipt of a Ctrl+B background carries no other signal of its own — no `run_in_background` in the input, no `timedOutAfterMs` — so if this field goes, the command becomes indistinguishable from one the model chose to background, and the live row, the catalogue row and the drawer can only tell the majority story about it.',
    manual:
      'start a long foreground command in a real session, press Ctrl+B while it runs, and read the tool_result line: toolUseResult must carry backgroundedByUser: true beside backgroundTaskId.',

    kind: 'gesture',
    // Ground truth from the SHAPE of the receipt, never from the field under test: a command the
    // model launched in the foreground that nonetheless came back with a task id, and not from
    // the timeout (which cannot reach a 47s command anyway), can only have been taken away by the
    // Ctrl+B the probe pressed.
    provoked: (ctx) => {
      const r = backgroundReceiptOf(ctx, CTRLB_COMMAND);
      return !!r && r.input?.run_in_background !== true && r.result.timedOutAfterMs === undefined;
    },
    // `holds` is deliberately NOT tied to the probe's own command, unlike `provoked`: the same
    // predicate is re-run by `closeWithEvidence` over REAL sessions, where nothing ever runs the
    // scene's command — an anchored one could never close this claim from evidence, and a Ctrl+B
    // the probe failed to land would leave it open for ever even with a real sighting on disk.
    holds: (ctx) => typed(ctx, 'user').some((d) => d?.toolUseResult?.backgroundedByUser === true),
  },
];

/** Claims for one scene, in declaration order. */
export function claimsForScene(scene: number): Claim[] {
  return CLAIMS.filter((c) => c.scene === scene);
}
