import { anon, renderedText } from '../core/text.ts';
import type { NormalizedEvent, Root, TaskRef, TokenCounts } from '../core/types.ts';
import { SPAWN_TOOL_NAMES } from '../core/types.ts';
import { toolOutcome } from './failure.ts';

// Only these types carry no signal we use. `user`/`system` are now inspected
// (tool_result blocks, compactMetadata) so they are no longer blanket-ignored.
const IGNORED = new Set(['mode', 'attachment', 'file-history-snapshot', 'ai-title', 'last-prompt']);

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// The one place a `<tag>value</tag>` shape is read: a task-notification's content is a plain
// string, not JSON. Deliberately not a general XML parse — the payload is a flat, fixed set of
// single-line tags written by Claude Code.
function tag(s: string, name: string): string | null {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(s);
  return m ? m[1]!.trim() || null : null;
}

// Tools that take a task REFERENCE rather than an argument, split by WHICH task system they
// address — the two are not interchangeable, and telling them apart is the whole job:
//   todo  — the task list. Ids are sequential ("1"), the field is `taskId`.
//   agent — background tasks. Ids are hex and ARE a subagent's agentId; the field is `task_id`.
// `TaskCreate` is in neither: it states a real subject, so it is labelled by that field (see
// argOf). `TaskList` is in neither either: its input is `{}` on every real call, so there is
// nothing to reference and nothing to show.
const TASK_REF_TOOLS = new Map<string, TaskRef['kind']>([
  ['TaskUpdate', 'todo'],
  ['TaskGet', 'todo'],
  ['TaskOutput', 'agent'],
  ['TaskStop', 'agent'],
]);

// The reference a Task-family tool points at, or undefined when the tool takes none.
function taskRefOf(input: unknown, name: string): TaskRef | undefined {
  const kind = TASK_REF_TOOLS.get(name);
  if (!input || typeof input !== 'object' || !kind) return undefined;
  const o = input as Record<string, unknown>;
  // The id field is spelled per system, and reading the wrong one silently yields NO label —
  // TaskGet (`taskId`: absent from every historical log, so its shape was read off the tool's
  // schema and then confirmed by calling it) was read as a background task and lost its label
  // exactly that way.
  const raw = kind === 'todo' ? o.taskId : o.task_id;
  if (typeof raw !== 'string') return undefined;
  const ref: TaskRef = { id: anon(raw, 40), kind };
  // Only TaskUpdate moves a row: TaskGet reads one, so it has no status to state.
  if (name === 'TaskUpdate' && typeof o.status === 'string') ref.status = anon(o.status, 40);
  return ref;
}

// A TaskCreate result is the only line stating a todo's number — the input has none.
// Verified on 584/584 successful real results; the one non-match was a failed call
// (InputValidationError), which creates no task and must therefore map nothing.
const TASK_CREATED_RE = /^Task #(\d+) created successfully: (.+)$/s;

// Human-meaningful argument for a tool_use, by tool name (used by P2).
function argOf(input: unknown, name: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const o = input as Record<string, unknown>;
  if (name === 'AskUserQuestion') {
    const qs = o.questions;
    if (Array.isArray(qs) && qs.length > 0 && typeof qs[0]?.question === 'string') return anon(qs[0].question, 200);
  }
  // A referencing tool's id is NOT its label — the reducer resolves it (see taskRefOf).
  if (TASK_REF_TOOLS.has(name) || name === 'TaskList') return undefined;
  // TaskCreate states its subject; the generic fallback below would take `description`
  // whenever the key order differed (it already did, on a real call missing `subject`).
  if (name === 'TaskCreate') {
    const v = typeof o.subject === 'string' ? o.subject : o.description;
    return typeof v === 'string' ? anon(v, 200) : undefined;
  }
  // ReportFindings' payload is `{ findings: [...], level? }`. The count is the meaningful
  // detail (HOW MANY findings), but it is a number — the generic first-string fallback can
  // never reach it, so it surfaced `level` by accident, or em-dash when level was absent.
  if (name === 'ReportFindings') {
    if (!Array.isArray(o.findings)) return undefined;
    const level = typeof o.level === 'string' ? ` · ${anon(o.level, 40)}` : '';
    return `${o.findings.length}${level}`;
  }
  // ScheduleWakeup shows its `reason` (the field designed to be shown to the user). A
  // `{ stop: true }` call carries no reason/delay — its action is ending the loop.
  if (name === 'ScheduleWakeup') {
    if (o.stop === true) return 'stop';
    return typeof o.reason === 'string' ? anon(o.reason, 200) : undefined;
  }
  // SendMessage's `to` is the agentId it resumes — the reducer needs exactly that field, and
  // the generic first-string fallback below would pick whichever key happened to come first.
  // Agent is mapped to `description` for the same reason: the fallback picked `subagent_type`
  // on ~6% of real calls (key-order dependent), showing the agent type instead of the task.
  // Artifact publishes a file, so `file_path` (the default below) is already its subject — but a
  // non-publishing call (`action: "list"`) carries none, and its remaining keys are all fallback
  // candidates: `scope` before `action` would label the row `mine` instead of `list`.
  const byName =
    name === 'Bash'
      ? o.command
      : name === 'Skill'
        ? o.skill
        : name === 'SendMessage'
          ? o.to
          : name === 'Agent'
            ? o.description
            : name === 'Artifact'
              ? (o.file_path ?? o.action)
              : o.file_path;
  const v = typeof byName === 'string' ? byName : Object.values(o).find((x) => typeof x === 'string');
  return typeof v === 'string' ? anon(v, 200) : undefined;
}

// Slash commands that manage the session rather than state a task. They carry no
// subject worth showing, so the session-subject scan skips past them to the first
// real prompt (a session that opens with `/clear` then `/effort` then the task must
// still be labelled by the task).
export const CONTROL_COMMANDS = new Set([
  'clear',
  'compact',
  'model',
  'effort',
  'fast',
  'resume',
  'cost',
  'context',
  'config',
  'exit',
  'quit',
  'help',
  'status',
  'login',
  'logout',
  'doctor',
  'terminal-setup',
  'vim',
  'init',
]);

const COMMAND_NAME_RE = /^\s*(?:<command-message>[\s\S]*?<\/command-message>\s*)?<command-name>\s*\/?([a-zA-Z0-9:_-]+)/;
// The whole line is the command: `/name`, optionally followed by its arguments. Anchored at both
// ends so a line that merely BEGINS with something slash-shaped (a path, a quoted command inside a
// sentence) is not read as one.
const BARE_COMMAND_RE = /^\s*\/([a-zA-Z0-9:_-]+)(?:[ \t]+([\s\S]*))?$/;

/**
 * What the user actually sent on a `user`-type line, or null if the line carries no
 * user intent (a `tool_result`, or empty). `kind` names WHOSE line it is, `command` names its
 * SHAPE — the two are independent, which is the whole point of the ordering below:
 *   'human'   — a typed prompt (`origin.kind: 'human'`, the AUTHORITATIVE signal,
 *               checked first so a prompt that merely QUOTES a <command-name> tag is
 *               not mistaken for a command),
 *   'sdk'     — a headless/programmatic prompt (`promptSource: 'sdk'`, e.g. a git-hook
 *               `claude -p`). It carries a `command` when the headless prompt WAS one:
 *               being headless decides the kind, the shape only decides the text.
 *   'command' — a slash command from an interactive session (`command` is the name without
 *               the slash, `text` its args, or `/name` when it had none).
 * `text` is raw (NOT anonymized) — the caller anonymizes at its cap. Shared by
 * parseLine (turn detection, which ignores 'sdk') and discovery (subject, which keeps it).
 */
export function userLineIntent(
  d: any,
): { text: string; command: string | null; kind: 'human' | 'command' | 'sdk' } | null {
  const content = d?.message?.content;
  if (Array.isArray(content) && content.some((b: any) => b?.type === 'tool_result')) return null;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? renderedText(content) : '';
  const isHumanOrigin = typeof d?.origin === 'object' && d.origin !== null && d.origin.kind === 'human';
  if (isHumanOrigin) return text.trim() ? { text, command: null, kind: 'human' } : null;
  // A headless line is headless whatever it says. Decided BEFORE the shape because an sdk line
  // carries no `origin` either (0 of 5586 measured), so a shape-first reading would file
  // `claude -p "/review this"` as a slash command — and turn detection keeps a command while it
  // deliberately drops an sdk prompt, so a headless run would grow a turn it never had. The same
  // trap applies to the tagged shape, which is why `promptSource` is read before both rather than
  // guarded inside one of them.
  const sdk = d?.promptSource === 'sdk';
  const cmd = commandShape(text, d);
  if (cmd) return { ...cmd, kind: sdk ? 'sdk' : 'command' };
  if (sdk && text.trim()) return { text, command: null, kind: 'sdk' };
  return null;
}

/**
 * The two shapes a slash command is written in, or null when the text is neither. Returns the
 * command's name and the text a caller shows for it (its arguments, else `/name`).
 */
function commandShape(text: string, d: any): { text: string; command: string } | null {
  // The tag is believed only when the content STARTS with it (optionally behind the
  // <command-message> Claude Code writes first) — a prompt that merely quotes the tag is not one.
  const m = COMMAND_NAME_RE.exec(text);
  if (m) {
    const name = m[1]!;
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? '';
    return { text: args || '/' + name, command: name };
  }
  // The command as the user TYPED it, in plain text. Claude Code writes this shape for a command
  // it does not expand into the thread — `/code-review` (a forked skill) writes ONLY this, and
  // `/compact` writes it beside the tagged one. Measured 2026-08-02 over the real corpus: 20 such
  // lines, every one a real command (`/compact`, `/code-review`), zero false hits. Read as "not a
  // prompt" it dropped the entire round — the turn never existed and its work was credited to the
  // previous one.
  //
  // The gate is `origin` ABSENT, not merely "not human": a task-notification is a `user` line with
  // an origin of its own, and only a line Claude Code wrote with no origin at all is the user's
  // own keystrokes. `isMeta` is excluded for the same reason it is everywhere else — the caveat
  // Claude Code injects around a command is not the command. Nothing here reads `promptSource`:
  // whose line it is was settled before this was called.
  if (d?.origin == null && d?.isMeta !== true) {
    const bare = BARE_COMMAND_RE.exec(text);
    if (bare) {
      const args = (bare[2] ?? '').trim();
      return { text: args || '/' + bare[1]!, command: bare[1]! };
    }
  }
  return null;
}

/**
 * Turn one raw `.jsonl` line into zero or more normalized events. Pure and total —
 * never throws, malformed input yields `[]`. An assistant line can emit a `usage`,
 * one `attribution` per source, and a `tool-start` per `tool_use` block. A user
 * line emits a `tool-end` per `tool_result` block. A `system`/`user` line with
 * compaction info emits a `compaction` (with real numbers when present). Cross-line
 * correlation (tool timing, subagent state) is the reducer's job, not this one's.
 */
export function parseLine(
  line: string,
  ctx: { sessionId: string; root: Root; seq: number; agentId?: string | null },
): NormalizedEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let d: any;
  try {
    d = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!d || typeof d !== 'object') return [];
  const type = d.type;
  if (typeof type !== 'string' || IGNORED.has(type)) return [];

  const timestamp: string = typeof d.timestamp === 'string' ? d.timestamp : '';
  const agentId = ctx.agentId ?? null;
  const base = { sessionId: ctx.sessionId, root: ctx.root, timestamp, seq: ctx.seq, agentId };
  const out: NormalizedEvent[] = [];

  if (type === 'assistant') {
    const usage = d.message?.usage;
    if (usage && typeof usage === 'object') {
      const delta: TokenCounts = {
        input: num(usage.input_tokens),
        output: num(usage.output_tokens),
        cacheRead: num(usage.cache_read_input_tokens),
        cacheCreation: num(usage.cache_creation_input_tokens),
      };
      const callId = typeof d.message?.id === 'string' ? d.message.id : null;
      const effort = typeof d.effort === 'string' && d.effort.length > 0 ? d.effort : null;
      // `<synthetic>` is not a model — it is the placeholder Claude Code stamps on assistant lines
      // that did NOT come from a model call (API errors, and "No response requested." lines when a
      // turn is auto-continued/cut off). Treat it as no model, so it never poisons the model chip
      // (a session that hit one would read "<synthetic> · was opus"), the context-window
      // denominator, or the by-model split.
      const rawModel = d.message?.model;
      const model = typeof rawModel === 'string' && rawModel.length > 0 && rawModel !== '<synthetic>' ? rawModel : null;
      const ev: NormalizedEvent = {
        type: 'usage',
        ...base,
        delta,
        fill: delta.input + delta.cacheRead + delta.cacheCreation,
        callId,
        effort,
        model,
      };
      // A FAILED call. The line still carries a usage block (verified on all 63 real ones),
      // so it flows down this same path — the flag is the only thing that separates it from
      // a normal call. The status is often absent; the text is the message the user was
      // shown ("You've hit your session limit", "Prompt is too long"), 18–186 chars.
      if (d.isApiErrorMessage === true) {
        const status =
          typeof d.apiErrorStatus === 'number' || typeof d.apiErrorStatus === 'string'
            ? String(d.apiErrorStatus)
            : typeof d.apiError === 'string' && d.apiError.length > 0
              ? d.apiError
              : null;
        ev.apiError = { status, message: anon(renderedText(d.message?.content), 300) };
      }
      out.push(ev);
    }

    const attrMap: Array<['skill' | 'mcpServer' | 'mcpTool', string]> = [
      ['skill', 'attributionSkill'],
      ['mcpServer', 'attributionMcpServer'],
      ['mcpTool', 'attributionMcpTool'],
    ];
    for (const [kind, key] of attrMap) {
      const v = d[key];
      if (typeof v === 'string' && v.length > 0) out.push({ type: 'attribution', ...base, kind, name: v });
    }

    const content = d.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
          const ev: NormalizedEvent = { type: 'tool-start', ...base, id: block.id, name: block.name };
          // Agent spawn carries the prompt/type the subagent was launched with.
          if (SPAWN_TOOL_NAMES.has(block.name) && block.input && typeof block.input === 'object') {
            const p = block.input.prompt,
              st = block.input.subagent_type,
              md = block.input.model,
              ds = block.input.description;
            if (typeof p === 'string') ev.launchPrompt = anon(p, 8000);
            if (typeof st === 'string') ev.subagentType = st;
            if (typeof md === 'string' && md.length > 0) ev.spawnModel = md;
            if (typeof ds === 'string' && ds.length > 0) ev.description = anon(ds, 200);
          }
          const arg = argOf(block.input, block.name);
          if (arg !== undefined) ev.arg = arg;
          const ref = taskRefOf(block.input, block.name);
          if (ref !== undefined) ev.taskRef = ref;
          out.push(ev);
        }
      }
      // A text block on an assistant line is one of two things, told apart by stop_reason:
      //   - stop_reason "end_turn"  → the FINAL answer (subagent output on a child, the turn's
      //     conclusion on the main session).
      //   - anything else ("tool_use" on 79% of text-bearing lines, measured 2026-07-20; the
      //     stale claim here was "null") → mid-turn NARRATION: the model saying what it is about
      //     to do. Kept only for the main session — a subagent's narration has no consumer.
      const text = content
        .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
        .map((b: any) => b.text)
        .join('');
      if (text) {
        if (d.message?.stop_reason === 'end_turn') {
          const full = anon(text, 20000);
          if (agentId !== null) {
            out.push({ type: 'subagent-output', ...base, outputFull: full, outLen: full.length });
          } else {
            out.push({ type: 'turn-result', ...base, outputFull: full, outLen: full.length });
          }
        } else if (agentId === null) {
          // Narration is short by design (the harness makes the model narrate in brief phrases —
          // measured p50 ~139 chars), so a tighter cap than the 20k answer cap is plenty.
          out.push({
            type: 'turn-narration',
            ...base,
            text: anon(text, 2000),
            callId: typeof d.message?.id === 'string' ? d.message.id : null,
          });
        }
      }
    }
  }

  if (type === 'user') {
    const content = d.message?.content;
    let hadToolResult = false;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          hadToolResult = true;
          const ev: NormalizedEvent = { type: 'tool-end', ...base, toolUseId: block.tool_use_id };
          // Output size for every tool (P2): the rendered tool_result text length.
          const resultText = renderedText(block.content);
          // A refusal ('denied') is NOT flagged: the user stopping a tool is not a failure.
          if (toolOutcome(block.is_error, resultText, d.toolDenialKind) === 'failed') ev.error = true;
          ev.outputSize = resultText.length;
          // A short slice of the result, anonymized: the input that fed the next API call, kept
          // for that call's feed row. Same 200-char cap as a tool's argOf label.
          if (resultText.trim()) ev.outputPreview = anon(resultText, 200);
          // The todo number a TaskCreate was given. Matched on the result's own shape rather
          // than on the tool name (which a tool-end does not carry), exactly as the async
          // launch receipt below is recognised by its status.
          const created = TASK_CREATED_RE.exec(resultText.trim());
          if (created) ev.taskCreated = { id: created[1]!, subject: anon(created[2]!, 200) };
          // A subagent (`Agent`) result: the full verbatim returned output + totals
          // live on the top-level `toolUseResult`, whose `content` is a text array.
          const tur = d.toolUseResult;
          if (tur && typeof tur === 'object' && Array.isArray(tur.content)) {
            const full = anon(renderedText(tur.content), 20000);
            ev.returned = {
              outputFull: full,
              outLen: full.length,
              totalTokens: numOrNull(tur.totalTokens),
              totalDurationMs: numOrNull(tur.totalDurationMs),
              status: typeof tur.status === 'string' ? tur.status : null,
            };
          }
          // A BACKGROUND launch receipt. It has NO `content` array (verified on real lines),
          // so the branch above never sees it and the status would be lost — which is exactly
          // how a launch came to be read as a completion. Flagging it here is what keeps the
          // ~92% background case (CC's default since v2.1.198) from ending at +0.07s, while
          // leaving every foreground result (status "completed") on its existing path.
          if (tur && typeof tur === 'object' && tur.status === 'async_launched') {
            ev.launched = { agentId: typeof tur.agentId === 'string' ? tur.agentId : null };
            // A Workflow launch takes the same receipt shape but names a RUN, not one agent
            // (`taskId`/`runId` instead of `agentId`).
            if (typeof tur.runId === 'string') {
              ev.workflow = { runId: tur.runId, name: typeof tur.workflowName === 'string' ? tur.workflowName : null };
            }
          }
          // A BACKGROUND COMMAND's receipt: a different shape from the subagent one above (no
          // `status`, an empty stdout, and this id). Recorded so the notification that arrives
          // minutes later can be recognised as this command's outcome — without it the failure
          // has nothing to attach to and is dropped, which is how a command that exited 144
          // read as a clean 74ms call.
          if (tur && typeof tur === 'object' && typeof tur.backgroundTaskId === 'string') {
            ev.background = { taskId: tur.backgroundTaskId };
          }
          out.push(ev);
        }
      }
    }
    // Interrupted turn: the next user line after an Esc carries interruptedMessageId.
    // Emitted before user-turn so the reducer marks the old turn interrupted before opening the new one.
    if (agentId === null && typeof d.interruptedMessageId === 'string' && d.interruptedMessageId) {
      out.push({ type: 'turn-interrupted', ...base });
    }

    // What the USER sent opens a turn. `userLineIntent` (shared with discovery's subject
    // scan) classifies the two on-the-wire shapes — a typed prompt and a slash command —
    // and a headless 'sdk' prompt. Gating on origin alone once dropped every slash command:
    // `/paste-image …` runs a full round yet produced no turn, so the strip showed nothing
    // live and its `turn_duration` landed on the previous turn.
    if (!hadToolResult && agentId === null) {
      const intent = userLineIntent(d);
      // A headless 'sdk' prompt (e.g. a git-hook `claude -p`) is not a round in THIS
      // session, so turn detection drops it — the subject scan is the one that keeps it.
      if (intent && intent.kind !== 'sdk') {
        // ORDER MATTERS: the turn opens FIRST, so a command counts against the turn it
        // started — emitting `command` first credited it to the PREVIOUS turn (an empty
        // Commands widget when scoping to a `/model`). Whether a command COSTS anything
        // (local `/model` vs token-burning `/compact`, indistinguishable here) is the
        // reducer's call: the parser reports what was sent. The WHOLE prompt is carried
        // (20k cap) so the "show full prompt" view has something to show.
        out.push({
          type: 'user-turn',
          ...base,
          prompt: anon(intent.text, 20000),
          command: intent.command,
          // Carried so the reducer can fold the two lines one invocation can write into one turn.
          promptId: typeof d.promptId === 'string' ? d.promptId : null,
        });
        if (intent.command) out.push({ type: 'command', ...base, name: intent.command });
      }
    }
  }

  // A forked skill's launch. `/code-review` and friends run as a background agent that NO `Agent`
  // tool_use ever names — the only record in the parent transcript is this line, so without it the
  // agent belongs to no turn, has no launch instant, and is left reading its bare type.
  if (type === 'system' && d.subtype === 'local_command' && agentId === null && typeof d.content === 'string') {
    const m = /<forked-skill-launch>([\s\S]*?)<\/forked-skill-launch>/.exec(d.content);
    if (m) {
      try {
        const j = JSON.parse(m[1]!);
        // The id is the whole point of the event: a launch that cannot name its agent links nothing.
        if (typeof j?.agentId === 'string' && j.agentId) {
          out.push({
            type: 'agent-launch',
            ...base,
            launchedAgentId: j.agentId,
            skillName: typeof j.skillName === 'string' ? j.skillName : '',
            description: typeof j.description === 'string' ? anon(j.description, 200) : null,
          });
        }
      } catch {
        /* a launch we cannot read is one we do not report — never a guessed agent */
      }
    }
  }

  if (type === 'system' && d.subtype === 'turn_duration' && agentId === null) {
    out.push({
      type: 'turn-end',
      ...base,
      durationMs: numOrNull(d.durationMs),
      messageCount: numOrNull(d.messageCount),
    });
  }

  // The end of a BACKGROUND subagent. Claude Code writes it as its own line type, whose
  // `content` is an XML-ish string (no uuid, no message) — nothing like a tool_result, which
  // is why it stayed unparsed and background subagents looked finished from birth.
  // Written TWICE per notification (operation 'enqueue' then 'remove', 662 + 78 in real logs)
  // with an identical payload; the reducer is last-wins per toolUseId, so the repeat is inert.
  if (type === 'queue-operation' && typeof d.content === 'string' && d.content.includes('<task-notification>')) {
    const toolUseId = tag(d.content, 'tool-use-id');
    const status = tag(d.content, 'status');
    // A TERMINAL notification is one carrying a status; the same line type is also written for
    // progress (`event` + `summary`, no status — 72 in the local corpus), which ends nothing.
    // Gating on the PRESENCE of a status, not on the absence of something else: an absence
    // test breaks the day Claude Code adds a field.
    //
    // `tool-use-id` is NOT the gate. It is one of the two names the notification gives its
    // subject, and the subject is an AGENT: a skill forked into the background has no spawning
    // tool call, so requiring the spawn name dropped the only signal that agent ever gets.
    // Reporting the fact is this layer's job; deciding what it can be attached to is the
    // reducer's, which is the only one that knows what it holds.
    if (toolUseId || status) {
      // LIMIT: a few background launches never get this line at all; they stay `running` and the
      // view renders them `unknown` once the session is closed. Re-measured 2026-07-29 with the
      // REAL reducer over 910 ended sessions: 3 of 1327 subagents (0.2%), in 2.2% of the sessions
      // that spawn any. The 4.5% (20/446) this comment used to claim was measured on 2026-07-16,
      // eleven days before the end-routing rework, and on a corpus half of which Claude Code has
      // since deleted (it drops transcripts at 30 days) — so it cannot be compared to this one.
      const summary = tag(d.content, 'summary');
      out.push({
        type: 'agent-end',
        ...base,
        toolUseId,
        taskId: tag(d.content, 'task-id'),
        status,
        // Anonymized: a summary names the command's `description`, and when the launch had none
        // Claude Code falls back to quoting the command itself, paths included.
        summary: summary === null ? null : anon(summary, 300),
      });
    }
  }

  // A `file-history-delta`: Claude Code backed up a file it changed (its /rewind ledger).
  // `trackingPath` is the file; the reducer attributes it to the open turn. The sibling
  // `file-history-snapshot` stays in IGNORED — the baseline adds nothing once we only count
  // changes. Anonymized like every other path we surface (argOf uses anon on file_path too).
  if (type === 'file-history-delta') {
    const path = typeof d.trackingPath === 'string' ? d.trackingPath : null;
    if (path) out.push({ type: 'file-change', ...base, path: anon(path, 200) });
    return out;
  }

  const cm = d.compactMetadata;
  const hasCompaction = d.isCompactSummary === true || (cm && typeof cm === 'object');
  if (hasCompaction) {
    out.push({
      type: 'compaction',
      ...base,
      isSummary: d.isCompactSummary === true,
      preTokens: cm ? numOrNull(cm.preTokens) : null,
      postTokens: cm ? numOrNull(cm.postTokens) : null,
      durationMs: cm ? numOrNull(cm.durationMs) : null,
    });
  }

  return out;
}
