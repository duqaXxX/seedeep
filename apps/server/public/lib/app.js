// apps/server/data/context-windows.json
var context_windows_default = {
  _note: "model -> max context window (tokens). Denominator for % full. Keys match by exact id first, then by longest prefix (dated ids like -20251001). LIMIT: hand-maintained; a new model falls back to 200000 + estimated:true until added here. sonnet-4-6 = 200000 is the subscription value; the direct API reports 1000000 for this model - a documented conflict, subscription chosen as the seedeep default.",
  "claude-fable-5": 1e6,
  "claude-opus-5": 1e6,
  "claude-opus-4-8": 1e6,
  "claude-opus-4-7": 1e6,
  "claude-opus-4-6": 1e6,
  "claude-sonnet-5": 1e6,
  "claude-sonnet-4-6": 200000,
  "claude-haiku-4-5": 200000,
  "claude-sonnet-4-5": 200000,
  "claude-opus-4-5": 200000,
  "claude-opus-4-1": 200000
};

// apps/server/src/core/context-windows.ts
var FALLBACK_WINDOW = 200000;
var TABLE = Object.entries(context_windows_default).filter(([, v]) => typeof v === "number").map(([k, v]) => [k, v]);
function windowFor(model) {
  if (model) {
    const exact = TABLE.find(([k]) => k === model);
    if (exact)
      return { window: exact[1], estimated: false };
    const prefix = TABLE.filter(([k]) => model.startsWith(k)).sort((a, b) => b[0].length - a[0].length)[0];
    if (prefix)
      return { window: prefix[1], estimated: false };
  }
  return { window: FALLBACK_WINDOW, estimated: true };
}

// apps/server/src/core/token-weight.ts
var TOKEN_TYPE_WEIGHT = { input: 1, cacheWrite: 2, cacheRead: 0.1, output: 5 };
var MODEL_WEIGHT = {
  "claude-haiku-4-5-20251001": 1,
  "claude-sonnet-5": 2,
  "claude-sonnet-4-6": 3,
  "claude-opus-4-5-20251101": 5,
  "claude-opus-4-6": 5,
  "claude-opus-4-7": 5,
  "claude-opus-4-8": 5,
  "claude-opus-5": 5,
  "claude-fable-5": 10
};
var FAMILY_WEIGHT = [
  [/^claude-haiku/, 1],
  [/^claude-sonnet/, 3],
  [/^claude-opus/, 5],
  [/^claude-fable/, 10]
];
function modelWeight(model) {
  if (!model)
    return 0;
  const exact = MODEL_WEIGHT[model];
  if (exact !== undefined)
    return exact;
  for (const [re, w] of FAMILY_WEIGHT)
    if (re.test(model))
      return w;
  return 0;
}
function callWeight(model, t) {
  const m = modelWeight(model);
  if (m === 0)
    return 0;
  return m * (t.input * TOKEN_TYPE_WEIGHT.input + t.cacheCreation * TOKEN_TYPE_WEIGHT.cacheWrite + t.cacheRead * TOKEN_TYPE_WEIGHT.cacheRead + t.output * TOKEN_TYPE_WEIGHT.output);
}

// apps/server/src/core/types.ts
var HIST_BINS = [
  { label: "<1k", min: 0, max: 1000 },
  { label: "1–3k", min: 1000, max: 3000 },
  { label: "3–10k", min: 3000, max: 1e4 },
  { label: "10–30k", min: 1e4, max: 30000 },
  { label: "30–100k", min: 30000, max: 1e5 },
  { label: "100–300k", min: 1e5, max: 300000 },
  { label: "300k+", min: 300000, max: Infinity }
];
function isLive(s) {
  return s.isOpen ?? s.isActive;
}
function isAutomated(s) {
  return !!s.entrypoint && s.entrypoint.startsWith("sdk");
}
function isWorking(s) {
  return s.status === "busy" || s.status === "shell";
}
function isModelBusy(s) {
  return s.status === "busy";
}
function pendingInput(s) {
  if (s.status !== "waiting")
    return null;
  if (s.waitingFor === "permission prompt")
    return "permission";
  if (s.waitingFor === "input needed")
    return "input";
  return null;
}
var ACTIVE_WINDOW_MS = 300000;
var SPAWN_TOOL_NAMES = new Set(["Agent", "Task"]);

// apps/server/src/core/session-tree.ts
function hasStarted(a) {
  return a.agentType !== null || a.fill > 0 || a.tools.length > 0 || a.outputFull !== null;
}
var CONTEXT_COMMANDS = new Set(["clear", "compact"]);
function sumTokensByModel(subagents) {
  const byModel = new Map;
  for (const a of subagents)
    for (const v of a.volumeByModel)
      byModel.set(v.model, (byModel.get(v.model) ?? 0) + v.tokens);
  return [...byModel.entries()].filter(([, tokens]) => tokens > 0).map(([model, tokens]) => ({ model, tokens })).sort((x, y) => y.tokens - x.tokens);
}
function resolveVolByModel(volByModel, fallback) {
  const merged = new Map;
  for (const [m, t] of volByModel) {
    const key = m || fallback;
    merged.set(key, (merged.get(key) ?? 0) + t);
  }
  return [...merged.entries()].map(([model, tokens]) => ({ model, tokens })).sort((x, y) => y.tokens - x.tokens);
}
function reportsWindow(e) {
  return Boolean(e.model) || e.fill > 0;
}
function createSessionTree(opts) {
  const windowFor2 = opts.windowFor;
  let mainModel = opts.mainModel ?? null;
  const mainModels = [];
  if (mainModel)
    mainModels.push(mainModel);
  let mainFill = 0;
  let usageInput = 0, usageOutput = 0;
  let usageThinking = 0, usageThinkingReported = false;
  let weightedMain = 0;
  const weightedByModel = new Map;
  const mainWeightedByModel = new Map;
  const breakdown = { input: 0, cacheRead: 0, cacheCreation: 0 };
  const cacheTotals = { read: 0, created: 0 };
  const pendingBgOutcome = new Map;
  const bgByTaskId = new Map;
  const bgEvents = new Map;
  let wakeup = null;
  const pendingNotes = new Map;
  const sessionNotes = [];
  const regions = new Set;
  const skillTurns = new Map;
  const skillInvokes = new Map;
  const commandCounts = new Map;
  let entries = 0;
  let apiCalls = 0;
  let sessionHadRealCall = false;
  let sessionError = null;
  const tools = new Map;
  const openMainCalls = new Set;
  const agents = new Map;
  const spawns = new Map;
  const spawnByAgentId = new Map;
  const agentIdByPendingSpawn = new Map;
  const taskSubjects = new Map;
  const runs = new Map;
  const runByAgentId = new Map;
  const endedToolUseIds = new Set;
  const endedAgentIds = new Map;
  const toolIdsByTurn = new Map;
  const groupCache = new Map;
  const dirtyGroups = new Set;
  const compactions = [];
  const compactionSeqs = new Set;
  const appliedLineSeqs = new Set;
  const appliedCommandKeys = new Set;
  const appliedCommandSeqs = new Set;
  const appliedSkillTurnSeqs = new Set;
  const countedSkillInvokeIds = new Set;
  const appliedUsageKeys = new Set;
  const lastInputHint = new Map;
  const lastActivityMs = new Map;
  let compactionSinceLastFirstCall = false;
  let seq = -1;
  let currentTurn = null;
  const completedTurns = [];
  const fileChanges = [];
  const appliedFileChangeSeqs = new Set;
  const listeners = new Set;
  const eventListeners = new Set;
  function tsMs(t) {
    const n = Date.parse(t ?? "");
    return Number.isFinite(n) ? n : null;
  }
  function bump(m, key) {
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  function turnIndexOf(owner) {
    if (owner === null)
      return currentTurn?.index ?? null;
    const a = agents.get(owner);
    const spawnTool = a?.toolUseId ? tools.get(a.toolUseId) : null;
    return spawnTool?.turnIndex ?? currentTurn?.index ?? null;
  }
  function linkSpawn(toolUseId, agentId) {
    spawnByAgentId.set(agentId, toolUseId);
    const sp = spawns.get(toolUseId);
    if (sp)
      sp.agentId = agentId;
    else
      agentIdByPendingSpawn.set(toolUseId, agentId);
  }
  function agentFor(id) {
    let a = agents.get(id);
    if (!a) {
      a = {
        agentId: id,
        agentType: null,
        model: null,
        fill: 0,
        toolUseId: null,
        outputFull: null,
        outLen: 0,
        firstMs: null,
        lastMs: null,
        volIn: 0,
        volOut: 0,
        volCacheRead: 0,
        volCacheCreation: 0,
        volByModel: new Map,
        weighted: 0,
        appliedVolumeKeys: new Set,
        efforts: new Set,
        description: null,
        launchedAt: null,
        turnIndex: null
      };
      agents.set(id, a);
    }
    return a;
  }
  function apply(e) {
    if (e.seq > seq)
      seq = e.seq;
    const owner = e.agentId ?? null;
    let usageNewCall = false;
    let usageCallMs = null;
    if (owner !== null && e.seq >= 0 && e.timestamp) {
      const ms = tsMs(e.timestamp);
      if (ms !== null) {
        const a = agentFor(owner);
        if (a.firstMs === null || ms < a.firstMs)
          a.firstMs = ms;
        if (a.lastMs === null || ms > a.lastMs)
          a.lastMs = ms;
      }
    }
    if (e.type === "usage") {
      if (e.apiError) {
        sessionError = {
          at: tsMs(e.timestamp),
          status: e.apiError.status,
          message: e.apiError.message,
          agentId: owner
        };
      } else if (e.model)
        sessionError = null;
      if (owner === null) {
        if (reportsWindow(e)) {
          mainFill = e.fill;
          breakdown.input = e.delta.input;
          breakdown.cacheRead = e.delta.cacheRead;
          breakdown.cacheCreation = e.delta.cacheCreation;
        }
        if (e.model) {
          mainModel = e.model;
          if (!mainModels.includes(e.model))
            mainModels.push(e.model);
        }
        if (currentTurn) {
          if (reportsWindow(e)) {
            currentTurn.fillEnd = e.fill;
            currentTurn.breakdown = {
              input: e.delta.input,
              cacheRead: e.delta.cacheRead,
              cacheCreation: e.delta.cacheCreation
            };
          }
          if (e.model)
            currentTurn.models.add(e.model);
          if (e.effort)
            currentTurn.efforts.add(e.effort);
        }
        const key = e.callId ?? `seq:${e.seq}`;
        usageNewCall = !appliedUsageKeys.has(key) && !e.noCall;
        if (usageNewCall) {
          appliedUsageKeys.add(key);
          apiCalls++;
          if (currentTurn && currentTurn.firstCall === null && (e.delta.cacheCreation > 0 || e.fill > 0)) {
            currentTurn.firstCall = { cacheCreation: e.delta.cacheCreation, fill: e.fill };
            currentTurn.rebuildExpected = !sessionHadRealCall || compactionSinceLastFirstCall;
            sessionHadRealCall = true;
            compactionSinceLastFirstCall = false;
          }
          usageInput += e.delta.input;
          usageOutput += e.delta.output;
          if (e.thinking !== null) {
            usageThinking += e.thinking;
            usageThinkingReported = true;
          }
          cacheTotals.read += e.delta.cacheRead;
          cacheTotals.created += e.delta.cacheCreation;
          const w = callWeight(e.model, e.delta);
          weightedMain += w;
          if (w > 0 && e.model) {
            weightedByModel.set(e.model, (weightedByModel.get(e.model) ?? 0) + w);
            mainWeightedByModel.set(e.model, (mainWeightedByModel.get(e.model) ?? 0) + w);
          }
          if (currentTurn) {
            if (currentTurn.closedByResult && currentTurn.state === "done")
              currentTurn.state = "live";
            currentTurn.inputTotal += e.delta.input;
            currentTurn.out += e.delta.output;
            if (e.thinking !== null) {
              currentTurn.thinking += e.thinking;
              currentTurn.thinkingReported = true;
            }
            currentTurn.apiCalls++;
            currentTurn.cacheTotals.read += e.delta.cacheRead;
            currentTurn.cacheTotals.created += e.delta.cacheCreation;
            currentTurn.weighted += w;
          }
        }
      } else {
        const a = agentFor(owner);
        if (reportsWindow(e))
          a.fill = e.fill;
        if (e.effort)
          a.efforts.add(e.effort);
        const key = e.callId ?? `seq:${e.seq}`;
        usageNewCall = !a.appliedVolumeKeys.has(key) && !e.noCall;
        if (usageNewCall) {
          a.appliedVolumeKeys.add(key);
          a.volIn += e.delta.input;
          a.volOut += e.delta.output;
          a.volCacheRead += e.delta.cacheRead;
          a.volCacheCreation += e.delta.cacheCreation;
          const mk = e.model ?? "";
          a.volByModel.set(mk, (a.volByModel.get(mk) ?? 0) + e.delta.input + e.delta.output + e.delta.cacheRead + e.delta.cacheCreation);
          const aw = callWeight(e.model, e.delta);
          a.weighted += aw;
          if (aw > 0 && e.model)
            weightedByModel.set(e.model, (weightedByModel.get(e.model) ?? 0) + aw);
        }
      }
      if (usageNewCall) {
        const anchor = lastActivityMs.get(owner);
        const now = tsMs(e.timestamp);
        usageCallMs = anchor != null && now != null && now >= anchor ? now - anchor : null;
      }
    } else if (e.type === "user-turn") {
      const twinKey = e.command && e.promptId ? e.promptId + ":" + e.command : null;
      if (owner === null && !appliedLineSeqs.has(e.seq) && !(twinKey && appliedCommandKeys.has(twinKey))) {
        appliedLineSeqs.add(e.seq);
        if (twinKey)
          appliedCommandKeys.add(twinKey);
        entries++;
        if (currentTurn) {
          if (currentTurn.state === "live" && currentTurn.apiCalls > 0)
            currentTurn.state = "interrupted";
          completedTurns.push(currentTurn);
        }
        currentTurn = {
          index: entries,
          prompt: e.prompt ?? "",
          command: e.command ?? null,
          startedAt: e.timestamp || null,
          state: "live",
          cutoff: false,
          durationMs: null,
          messageCount: null,
          apiCalls: 0,
          closedByResult: false,
          fillEnd: mainFill,
          breakdown: { ...breakdown },
          cacheTotals: { read: 0, created: 0 },
          inputTotal: 0,
          out: 0,
          thinking: 0,
          thinkingReported: false,
          weighted: 0,
          skillTurns: new Map,
          skillInvokes: new Map,
          commandCounts: new Map,
          models: new Set,
          efforts: new Set,
          compaction: false,
          firstCall: null,
          rebuildExpected: false,
          result: null,
          lastNarration: null,
          lastWordTs: null
        };
        lastInputHint.set(null, (e.prompt ?? "").slice(0, 200));
        const pt = tsMs(e.timestamp);
        if (pt !== null)
          lastActivityMs.set(null, pt);
      }
    } else if (e.type === "turn-end") {
      if (owner === null && currentTurn) {
        currentTurn.durationMs = e.durationMs;
        currentTurn.messageCount = e.messageCount;
        currentTurn.state = "done";
        currentTurn.closedByResult = false;
      }
    } else if (e.type === "turn-interrupted") {
      if (owner === null && currentTurn && (!e.cutoff || currentTurn.apiCalls > 0)) {
        if (e.cutoff && currentTurn.state !== "interrupted")
          currentTurn.cutoff = true;
        currentTurn.state = "interrupted";
      }
    } else if (e.type === "turn-result") {
      if (owner === null && currentTurn) {
        if (currentTurn.state === "live") {
          currentTurn.state = "done";
          currentTurn.closedByResult = true;
        }
        currentTurn.result = e.outputFull;
        currentTurn.lastWordTs = e.timestamp;
        dirtyGroups.add(currentTurn.index);
      }
    } else if (e.type === "turn-narration") {
      if (owner === null && currentTurn) {
        currentTurn.lastNarration = { ts: e.timestamp, text: e.text };
        currentTurn.lastWordTs = e.timestamp;
        dirtyGroups.add(currentTurn.index);
      }
    } else if (e.type === "command") {
      if (owner === null && !appliedCommandSeqs.has(e.seq)) {
        appliedCommandSeqs.add(e.seq);
        bump(commandCounts, e.name);
        if (currentTurn)
          bump(currentTurn.commandCounts, e.name);
      }
    } else if (e.type === "file-change") {
      if (owner === null && !appliedFileChangeSeqs.has(e.seq)) {
        appliedFileChangeSeqs.add(e.seq);
        fileChanges.push({ path: e.path, turnIndex: currentTurn?.index ?? null, ts: e.timestamp });
      }
    } else if (e.type === "attribution") {
      if (owner === null) {
        regions.add(e.name);
        if (e.kind === "skill" && !appliedSkillTurnSeqs.has(e.seq)) {
          appliedSkillTurnSeqs.add(e.seq);
          bump(skillTurns, e.name);
          if (currentTurn)
            bump(currentTurn.skillTurns, e.name);
        }
      }
    } else if (e.type === "subagent-meta") {
      if (e.agentId) {
        const a = agentFor(e.agentId);
        if (e.toolUseId) {
          a.toolUseId = e.toolUseId;
          linkSpawn(e.toolUseId, e.agentId);
        }
        if (e.model)
          a.model = e.model;
        if (e.agentType)
          a.agentType = e.agentType;
        if (e.description)
          a.description = e.description;
      }
    } else if (e.type === "agent-launch") {
      const a = agentFor(e.launchedAgentId);
      a.launchedAt = e.timestamp || null;
      if (e.description)
        a.description = e.description;
      if (owner === null && currentTurn)
        a.turnIndex = currentTurn.index;
    } else if (e.type === "subagent-output") {
      if (e.agentId) {
        const a = agentFor(e.agentId);
        a.outputFull = e.outputFull;
        a.outLen = e.outLen;
      }
    } else if (e.type === "tool-start") {
      tools.set(e.id, {
        name: e.name,
        startTs: e.timestamp,
        endTs: null,
        ownerAgentId: owner,
        arg: e.arg ?? null,
        ctx: 0,
        error: false,
        backgroundTaskId: null,
        backgroundBy: null,
        outcome: null,
        outcomeStatus: null,
        outcomeTs: null,
        outputFile: null,
        vanishedTs: null,
        lastSeenAliveTs: null,
        launchPrompt: e.launchPrompt ?? null,
        spawnModel: e.spawnModel ?? null,
        returned: null,
        taskRef: e.taskRef ?? null,
        subagentType: e.subagentType ?? null,
        description: e.description ?? null,
        turnIndex: owner === null ? currentTurn?.index ?? null : null,
        notes: pendingNotes.get(e.id) ?? null
      });
      pendingNotes.delete(e.id);
      if (owner === null) {
        if (endedToolUseIds.has(e.id))
          openMainCalls.delete(e.id);
        else
          openMainCalls.add(e.id);
      }
      if (owner === null && currentTurn) {
        const ids = toolIdsByTurn.get(currentTurn.index) ?? new Set;
        ids.add(e.id);
        toolIdsByTurn.set(currentTurn.index, ids);
        dirtyGroups.add(currentTurn.index);
      }
      if (owner === null && (SPAWN_TOOL_NAMES.has(e.name) || e.name === "Workflow") && !spawns.has(e.id)) {
        spawns.set(e.id, {
          toolUseId: e.id,
          agentId: agentIdByPendingSpawn.get(e.id) ?? null,
          runId: null,
          workflowName: null,
          launchedAsync: false,
          ended: false,
          endStatus: null
        });
        agentIdByPendingSpawn.delete(e.id);
      }
      if (owner === null && e.name === "SendMessage" && e.arg) {
        const sp = spawns.get(spawnByAgentId.get(e.arg) ?? "");
        if (sp) {
          sp.ended = false;
          sp.endStatus = null;
        }
      }
      if (owner === null && e.name === "Skill" && e.arg && !countedSkillInvokeIds.has(e.id)) {
        countedSkillInvokeIds.add(e.id);
        bump(skillInvokes, e.arg);
        if (currentTurn)
          bump(currentTurn.skillInvokes, e.arg);
      }
    } else if (e.type === "tool-end") {
      const t = tools.get(e.toolUseId);
      if (t) {
        if (t.turnIndex != null)
          dirtyGroups.add(t.turnIndex);
        t.endTs = e.timestamp;
        if (e.outputSize !== undefined)
          t.ctx = e.outputSize;
        if (e.error)
          t.error = true;
        if (e.returned)
          t.returned = e.returned;
        const parked = pendingBgOutcome.get(e.toolUseId);
        if (parked)
          pendingBgOutcome.delete(e.toolUseId);
        if (e.background) {
          t.backgroundTaskId = e.background.taskId;
          t.backgroundBy = e.background.by;
          bgByTaskId.set(e.background.taskId, t);
          if (parked) {
            t.outcome = parked.summary;
            t.outcomeStatus = parked.status;
            t.outcomeTs = parked.ts;
            t.outputFile = parked.outputFile;
            t.error = parked.status !== null && parked.status !== "completed" && parked.status !== "stopped";
          }
        }
      }
      if (e.outputPreview)
        lastInputHint.set(owner, e.outputPreview);
      const teMs = tsMs(e.timestamp);
      if (teMs !== null)
        lastActivityMs.set(owner, teMs);
      if (e.taskCreated)
        taskSubjects.set(e.taskCreated.id, e.taskCreated.subject);
      endedToolUseIds.add(e.toolUseId);
      openMainCalls.delete(e.toolUseId);
      const sp = spawns.get(e.toolUseId);
      if (sp) {
        if (e.launched) {
          sp.launchedAsync = true;
          if (e.launched.agentId) {
            linkSpawn(e.toolUseId, e.launched.agentId);
            const aid = e.launched.agentId;
            if (!lastInputHint.has(aid) && t?.launchPrompt)
              lastInputHint.set(aid, t.launchPrompt.slice(0, 200));
            const spawnMs = tsMs(t?.startTs ?? null);
            if (!lastActivityMs.has(aid) && spawnMs !== null)
              lastActivityMs.set(aid, spawnMs);
          }
          if (e.workflow?.runId) {
            sp.runId = e.workflow.runId;
            sp.workflowName = e.workflow.name;
          }
        } else {
          sp.ended = true;
          sp.endStatus = e.returned?.status ?? null;
        }
      }
    } else if (e.type === "workflow-agent") {
      let r = runs.get(e.runId);
      if (!r) {
        r = { runId: e.runId, members: new Set, started: new Set, finished: new Set };
        runs.set(e.runId, r);
      }
      if (e.agentId) {
        runByAgentId.set(e.agentId, e.runId);
        r.members.add(e.agentId);
        if (e.phase === "started")
          r.started.add(e.agentId);
        if (e.phase === "result")
          r.finished.add(e.agentId);
      }
    } else if (e.type === "agent-end") {
      const sp = (e.toolUseId ? spawns.get(e.toolUseId) : undefined) ?? (e.taskId ? spawns.get(spawnByAgentId.get(e.taskId) ?? "") : undefined);
      if (!sp && e.taskId)
        endedAgentIds.set(e.taskId, e.status);
      const bg = sp ? undefined : (e.toolUseId ? tools.get(e.toolUseId) : undefined) ?? bgByTaskId.get(e.taskId ?? "");
      if (!sp && e.toolUseId && !bg?.backgroundTaskId) {
        pendingBgOutcome.set(e.toolUseId, {
          summary: e.summary,
          status: e.status,
          ts: e.timestamp || null,
          outputFile: e.outputFile ?? null
        });
      }
      if (bg?.backgroundTaskId && e.status !== null) {
        bg.outcome = e.summary;
        bg.outcomeStatus = e.status;
        if (bg.outcomeTs === null)
          bg.outcomeTs = e.timestamp || null;
        if (e.outputFile)
          bg.outputFile = e.outputFile;
        bg.error = e.status !== null && e.status !== "completed" && e.status !== "stopped";
      }
      if (sp) {
        sp.ended = true;
        sp.endStatus = e.status;
        if (e.taskId && sp.runId === null)
          linkSpawn(sp.toolUseId, e.taskId);
      }
    } else if (e.type === "note") {
      const note = { source: e.source, hook: e.hook, text: e.text };
      if (e.toolUseId === null) {
        if (!sessionNotes.some((n) => n.text === note.text)) {
          sessionNotes.push({ ...note, at: e.timestamp, turnIndex: currentTurn?.index ?? null });
        }
      } else {
        const t = tools.get(e.toolUseId);
        const list = t ? t.notes ??= [] : pendingNotes.get(e.toolUseId) ?? [];
        if (!list.some((n) => n.text === note.text))
          list.push(note);
        if (!t)
          pendingNotes.set(e.toolUseId, list);
      }
    } else if (e.type === "wakeup") {
      wakeup = e.at === null ? null : { toolUseId: e.toolUseId, at: new Date(e.at).toISOString() };
    } else if (e.type === "background-event") {
      const seen = bgEvents.get(e.taskId);
      bgEvents.set(e.taskId, { count: (seen?.count ?? 0) + 1, last: e.event });
    } else if (e.type === "command-vanished") {
      const bg = tools.get(e.toolUseId);
      if (bg?.backgroundTaskId && bg.outcomeStatus === null) {
        bg.vanishedTs = e.timestamp;
        bg.lastSeenAliveTs = e.lastSeenAlive;
      }
    } else if (e.type === "compaction") {
      if (!compactionSeqs.has(e.seq)) {
        compactionSeqs.add(e.seq);
        const delta = e.preTokens !== null && e.postTokens !== null ? e.preTokens - e.postTokens : null;
        compactions.push({ pre: e.preTokens, post: e.postTokens, delta, ms: e.durationMs });
        if (owner === null) {
          if (!e.isSummary) {
            bump(commandCounts, "compact");
            if (currentTurn)
              bump(currentTurn.commandCounts, "compact");
          }
          if (currentTurn)
            currentTurn.compaction = true;
          compactionSinceLastFirstCall = true;
        }
      }
    }
    if (eventListeners.size > 0) {
      const ctx = {
        turnIndex: turnIndexOf(owner),
        label: e.type === "tool-start" ? toolLabel({ arg: e.arg ?? null, taskRef: e.taskRef ?? null }) : e.type === "usage" ? lastInputHint.get(owner) ?? null : null,
        newCall: e.type === "usage" ? usageNewCall : undefined,
        callMs: e.type === "usage" ? usageCallMs : undefined
      };
      for (const cb of eventListeners)
        cb(e, ctx);
    }
    for (const cb of listeners)
      cb();
  }
  function toolLabel(t) {
    const ref = t.taskRef;
    if (!ref)
      return t.arg;
    if (ref.kind === "todo") {
      const subject = taskSubjects.get(ref.id);
      const head = subject ? `#${ref.id} ${subject}` : `#${ref.id}`;
      return ref.status ? `${head} → ${ref.status}` : head;
    }
    return agentLabel(ref.id) ?? `${ref.id.slice(0, 8)}…`;
  }
  function agentLabel(agentId) {
    const own = agents.get(agentId)?.agentType;
    if (own)
      return own;
    const spawnId = spawnByAgentId.get(agentId);
    return (spawnId ? tools.get(spawnId)?.subagentType : null) ?? null;
  }
  function agentTitle(spawn, a, agentId) {
    const first = spawn?.launchPrompt ? spawn.launchPrompt.split(`
`, 1)[0].trim() : "";
    return spawn?.description || a?.description || (first.length > 0 ? first : null) || a?.agentType || spawn?.subagentType || agentId;
  }
  function toolNode(id, t) {
    const a = t.startTs ? tsMs(t.startTs) : null;
    const b = t.endTs ? tsMs(t.endTs) : null;
    const node = {
      id,
      name: t.name,
      ms: a !== null && b !== null ? b - a : null,
      arg: toolLabel(t),
      ctx: t.ctx,
      turnIndex: t.turnIndex
    };
    if (t.error)
      node.error = true;
    if (t.outcome)
      node.outcome = t.outcome;
    if (t.notes?.length)
      node.notes = t.notes.map((n) => ({ ...n }));
    if (t.backgroundTaskId) {
      node.background = true;
      node.backgroundTaskId = t.backgroundTaskId;
      node.backgroundBy = t.backgroundBy ?? "agent";
      if (t.startTs)
        node.startedTs = t.startTs;
      if (t.outcomeStatus !== null)
        node.outcomeStatus = t.outcomeStatus;
      if (t.outcomeTs)
        node.outcomeTs = t.outcomeTs;
      if (t.outputFile)
        node.outputFile = t.outputFile;
      if (t.description)
        node.description = t.description;
      if (t.vanishedTs)
        node.vanishedTs = t.vanishedTs;
      if (t.lastSeenAliveTs)
        node.lastSeenAliveTs = t.lastSeenAliveTs;
      const ev = bgEvents.get(t.backgroundTaskId);
      if (ev) {
        node.events = ev.count;
        node.lastEvent = ev.last;
      }
    }
    return node;
  }
  function skillNodes(turnsMap, invokesMap) {
    return [...new Set([...turnsMap.keys(), ...invokesMap.keys()])].map((name) => ({ name, turns: turnsMap.get(name) ?? 0, invokes: invokesMap.get(name) ?? 0 })).sort((a, b) => b.invokes - a.invokes || b.turns - a.turns || a.name.localeCompare(b.name));
  }
  function commandNodes(counts) {
    return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }
  function kindOf(t, delegated) {
    if (t.command && CONTEXT_COMMANDS.has(t.command))
      return "context";
    if (t.command && t.apiCalls === 0 && !delegated && t.state !== "interrupted")
      return "local";
    return "work";
  }
  function buildTurnList(subagents) {
    const all = [...completedTurns, ...currentTurn ? [currentTurn] : []];
    const agentsByTurn = new Map;
    for (const a of agents.values()) {
      const spawnTool = a.toolUseId !== null ? tools.get(a.toolUseId) : null;
      const idx = spawnTool?.turnIndex ?? a.turnIndex;
      if (idx == null)
        continue;
      const bucket = agentsByTurn.get(idx);
      if (bucket)
        bucket.push(a.agentId);
      else
        agentsByTurn.set(idx, [a.agentId]);
    }
    const delegating = new Set;
    for (const a of subagents) {
      if (a.state === "running" && hasStarted(a) && a.turnIndex != null)
        delegating.add(a.turnIndex);
    }
    for (const idx of dirtyGroups) {
      const turn = currentTurn?.index === idx ? currentTurn : all.find((t) => t.index === idx);
      const cutoff = turn?.lastWordTs ? tsMs(turn.lastWordTs) ?? -Infinity : -Infinity;
      let g = null;
      for (const id of toolIdsByTurn.get(idx) ?? []) {
        const tool = tools.get(id);
        if (!tool || tool.startTs === null)
          continue;
        const startTs = tool.startTs;
        const startMs = tsMs(startTs);
        if (startMs === null || startMs < cutoff)
          continue;
        if (!g)
          g = { counts: {}, startedTs: startTs, open: [] };
        g.counts[tool.name] = (g.counts[tool.name] ?? 0) + 1;
        if ((tsMs(g.startedTs) ?? Infinity) > startMs)
          g.startedTs = startTs;
        if (tool.endTs === null)
          g.open.push({ name: tool.name, startedTs: startTs });
      }
      if (g)
        g.open.sort((a, b) => (tsMs(a.startedTs) ?? 0) - (tsMs(b.startedTs) ?? 0));
      groupCache.set(idx, g);
    }
    dirtyGroups.clear();
    return all.map((t, i) => {
      const prevFill = i === 0 ? 0 : all[i - 1].fillEnd;
      const agentIds = agentsByTurn.get(t.index) ?? [];
      const state = t.state === "live" && t.apiCalls === 0 && !delegating.has(t.index) ? "done" : t.state;
      return {
        index: t.index,
        prompt: t.prompt,
        command: t.command,
        kind: kindOf(t, agentsByTurn.has(t.index)),
        startedAt: t.startedAt,
        state,
        cutoff: t.cutoff,
        durationMs: t.durationMs,
        thinking: t.thinkingReported ? t.thinking : null,
        messageCount: t.messageCount,
        apiCalls: t.apiCalls,
        deltaFill: t.fillEnd - prevFill,
        fillEnd: t.fillEnd,
        breakdown: { ...t.breakdown },
        cacheTotals: { ...t.cacheTotals },
        inputTotal: t.inputTotal,
        out: t.out,
        weighted: t.weighted,
        models: [...t.models],
        efforts: [...t.efforts],
        agentIds,
        skills: skillNodes(t.skillTurns, t.skillInvokes),
        commands: commandNodes(t.commandCounts),
        compaction: t.compaction,
        firstCall: t.firstCall ? { ...t.firstCall } : null,
        rebuildExpected: t.rebuildExpected,
        result: t.result,
        lastNarration: t.lastNarration ? { ...t.lastNarration } : null,
        activity: groupCache.get(t.index) ?? null,
        lastWordTs: t.lastWordTs
      };
    });
  }
  function stateOf(sp, toolUseId, acc) {
    if (acc && endedAgentIds.has(acc.agentId)) {
      const st = endedAgentIds.get(acc.agentId);
      return st === "failed" ? "failed" : st === "killed" ? "killed" : "done";
    }
    if (!sp)
      return toolUseId !== null && endedToolUseIds.has(toolUseId) ? "done" : "running";
    if (!sp.ended)
      return "running";
    if (sp.endStatus === "failed")
      return "failed";
    if (sp.endStatus === "killed")
      return "killed";
    return "done";
  }
  function workflowAgg(runId, name, r, byAgent) {
    const models = new Map;
    const tokens = new Map;
    const bd = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    let weighted = 0;
    let lastActivityAt = null;
    for (const id of r?.members ?? []) {
      const a = agents.get(id);
      if (!a)
        continue;
      weighted += a.weighted;
      bd.input += a.volIn;
      bd.output += a.volOut;
      bd.cacheRead += a.volCacheRead;
      bd.cacheCreation += a.volCacheCreation;
      for (const [m, t] of a.volByModel)
        tokens.set(m || (a.model ?? ""), (tokens.get(m || (a.model ?? "")) ?? 0) + t);
      if (a.model)
        bump(models, a.model);
      if (a.lastMs !== null && (lastActivityAt === null || a.lastMs > lastActivityAt))
        lastActivityAt = a.lastMs;
    }
    let running = 0;
    for (const id of r?.started ?? [])
      if (!r.finished.has(id))
        running++;
    const all = new Set([...r?.members ?? [], ...r?.started ?? []]);
    const memberList = [...all].map((id) => {
      const a = agents.get(id);
      const vol = a ? a.volIn + a.volOut + a.volCacheRead + a.volCacheCreation : 0;
      const dur = a?.firstMs != null && a?.lastMs != null ? a.lastMs - a.firstMs : null;
      const aw = windowFor2(a?.model ?? null);
      return {
        agentId: id,
        agentType: a?.agentType ?? null,
        model: a?.model ?? null,
        volume: vol,
        fill: a?.fill ?? 0,
        window: aw.window,
        returned: r?.finished.has(id) ?? false,
        durationMs: dur,
        outLen: a?.outLen ?? 0,
        efforts: a ? [...a.efforts] : [],
        toolCount: byAgent.get(id)?.length ?? 0
      };
    });
    return {
      name,
      runId,
      agents: all.size,
      running,
      volume: bd.input + bd.output + bd.cacheRead + bd.cacheCreation,
      breakdown: { ...bd },
      weighted,
      models: [...models.entries()].map(([model, agents2]) => ({ model, agents: agents2 })).sort((x, y) => y.agents - x.agents),
      tokensByModel: [...tokens.entries()].map(([model, tokens2]) => ({ model, tokens: tokens2 })).sort((x, y) => y.tokens - x.tokens),
      lastActivityAt,
      members: memberList
    };
  }
  function snapshot() {
    const w = windowFor2(mainModel);
    const mainTools = [];
    const byAgent = new Map;
    for (const [id, t] of tools.entries()) {
      const node = toolNode(id, t);
      if (t.ownerAgentId === null) {
        mainTools.push(node);
        continue;
      }
      let bucket = byAgent.get(t.ownerAgentId);
      if (!bucket) {
        bucket = [];
        byAgent.set(t.ownerAgentId, bucket);
      }
      bucket.push(node);
    }
    const claimed = new Set;
    const rows = [];
    for (const sp of spawns.values()) {
      const a = sp.agentId !== null ? agents.get(sp.agentId) ?? null : null;
      if (a)
        claimed.add(a.agentId);
      rows.push({ sp, a });
    }
    for (const a of agents.values())
      if (!claimed.has(a.agentId) && !runByAgentId.has(a.agentId))
        rows.push({ sp: null, a });
    const subagents = rows.map(({ sp, a }) => {
      const toolUseId = sp?.toolUseId ?? a?.toolUseId ?? null;
      const spawnTool = toolUseId !== null ? tools.get(toolUseId) ?? null : null;
      const model = a?.model ?? spawnTool?.spawnModel ?? null;
      const aw = windowFor2(model);
      const state = stateOf(sp, toolUseId, a ?? null);
      const startedAt = spawnTool?.startTs ?? a?.launchedAt ?? null;
      const returned = spawnTool?.returned ?? null;
      const outputFull = a?.outputFull ?? returned?.outputFull ?? null;
      const outLen = a?.outLen || returned?.outLen || 0;
      const childSpan = a && a.firstMs !== null && a.lastMs !== null && a.lastMs > a.firstMs ? a.lastMs - a.firstMs : null;
      const startMs = spawnTool?.startTs ? tsMs(spawnTool.startTs) : null;
      const endMs = spawnTool?.endTs ? tsMs(spawnTool.endTs) : null;
      const spawnDelta = sp?.launchedAsync ? null : startMs !== null && endMs !== null ? endMs - startMs : null;
      const durationMs = childSpan ?? returned?.totalDurationMs ?? spawnDelta;
      const volSum = a ? a.volIn + a.volOut + a.volCacheRead + a.volCacheCreation : 0;
      const hasVolume = volSum > 0;
      const wf = sp?.runId ? workflowAgg(sp.runId, sp.workflowName, runs.get(sp.runId) ?? null, byAgent) : null;
      const volume = wf ? wf.volume : hasVolume ? volSum : returned?.totalTokens ?? 0;
      const volumeBreakdown = wf ? { ...wf.breakdown } : hasVolume && a ? { input: a.volIn, output: a.volOut, cacheRead: a.volCacheRead, cacheCreation: a.volCacheCreation } : null;
      const volumeByModel = wf ? wf.tokensByModel.map((x) => ({ model: x.model || null, tokens: x.tokens })) : hasVolume && a ? resolveVolByModel(a.volByModel, model) : volume > 0 ? [{ model, tokens: volume }] : [];
      const fill = a?.fill ?? 0;
      return {
        kind: wf ? "workflow" : "subagent",
        workflow: wf,
        agentId: a?.agentId ?? sp?.agentId ?? toolUseId ?? "",
        agentType: a?.agentType ?? null,
        title: agentTitle(spawnTool, a ?? null, a?.agentId ?? sp?.agentId ?? toolUseId ?? ""),
        efforts: a ? [...a.efforts] : [],
        model,
        fill,
        window: aw.window,
        pct: aw.window > 0 ? Math.round(fill / aw.window * 100) : 0,
        estimated: aw.estimated,
        state,
        startedAt,
        durationMs,
        tools: (a ? byAgent.get(a.agentId) : undefined) ?? [],
        toolUseId,
        prompt: spawnTool?.launchPrompt ?? null,
        outputFull,
        outLen,
        volume,
        volumeEstimated: wf ? false : !hasVolume,
        volumeBreakdown,
        volumeByModel,
        weighted: wf ? wf.weighted : a?.weighted ?? 0,
        turnIndex: spawnTool?.turnIndex ?? a?.turnIndex ?? null
      };
    });
    const skills = skillNodes(skillTurns, skillInvokes);
    const commands = commandNodes(commandCounts);
    const turnList = buildTurnList(subagents);
    const subagentsTotal = subagents.reduce((n, a) => n + a.volume, 0);
    const subagentsEstimated = subagents.some((a) => a.volumeEstimated);
    const subagentTokensByModel = sumTokensByModel(subagents);
    let openCall = null;
    let openCallMs = -Infinity;
    for (const id of openMainCalls) {
      const t = tools.get(id);
      if (!t || t.startTs === null)
        continue;
      const ms = tsMs(t.startTs);
      if (ms === null || ms < openCallMs)
        continue;
      openCallMs = ms;
      openCall = { name: t.name, arg: t.arg, startedTs: t.startTs };
    }
    return {
      main: {
        fill: mainFill,
        window: w.window,
        pct: w.window > 0 ? Math.round(mainFill / w.window * 100) : 0,
        estimated: w.estimated,
        model: mainModel,
        models: [...mainModels],
        regions: [...regions],
        breakdown: { ...breakdown },
        cacheTotals: { ...cacheTotals },
        inputTotal: usageInput,
        outputTotal: usageOutput,
        thinkingTotal: usageThinkingReported ? usageThinking : null,
        weighted: weightedMain,
        weightedByModel: [...mainWeightedByModel].map(([model, weight]) => ({ model, weight })).sort((a, b) => b.weight - a.weight)
      },
      mainTools,
      filesChanged: [...fileChanges],
      subagents,
      subagentsTotal,
      subagentsEstimated,
      subagentTokensByModel,
      compactions: [...compactions],
      skills,
      commands,
      weightedSubagents: subagents.reduce((n, a) => n + a.weighted, 0),
      weightedByModel: [...weightedByModel].map(([model, weight]) => ({ model, weight })).sort((x, y) => y.weight - x.weight),
      turns: turnList.filter((t) => t.kind === "work").length,
      apiCalls,
      seq,
      turnList,
      openCall,
      error: sessionError && { ...sessionError },
      wakeup: wakeup && { ...wakeup, turnIndex: tools.get(wakeup.toolUseId)?.turnIndex ?? null },
      notes: sessionNotes.map((n) => ({ ...n }))
    };
  }
  function onChange(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }
  function onEvent(cb) {
    eventListeners.add(cb);
    return () => eventListeners.delete(cb);
  }
  const currentError = () => sessionError && { ...sessionError };
  const pendingBackground = () => {
    const out = [];
    for (const [id, t] of tools) {
      if (!t.backgroundTaskId || t.outcomeStatus !== null || t.vanishedTs !== null)
        continue;
      if (t.name === "Monitor")
        continue;
      out.push({ toolUseId: id, taskId: t.backgroundTaskId });
    }
    return out;
  };
  return { apply, snapshot, onChange, onEvent, currentError, pendingBackground };
}

// apps/server/src/core/tree-format.ts
function promptLine(prompt, max = 200) {
  const flat = (prompt ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max).trimEnd() + "…" : flat;
}
function entryText(prompt, command, max = 200) {
  const line = promptLine(prompt, max);
  if (!command)
    return line;
  return line && !line.startsWith("/") ? "/" + command + " " + line : line || "/" + command;
}
function tabLabel(s, max = 30) {
  return `${s.project} · ${promptLine(s.subject, max) || s.sessionId.slice(0, 8)}`;
}
function modelFamily(model) {
  if (!model)
    return null;
  const m = model.toLowerCase();
  for (const fam of ["opus", "sonnet", "haiku", "fable"])
    if (m.includes(fam))
      return fam;
  return null;
}
function formatDuration(ms) {
  if (ms === null)
    return "running…";
  if (ms < 1000)
    return "<1s";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60)
    return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) {
    const s = totalSec % 60;
    return s === 0 ? `${totalMin}m` : `${totalMin}m ${s}s`;
  }
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
function formatToolMs(ms) {
  if (ms == null)
    return formatDuration(null);
  if (ms < 1000)
    return `${ms}ms`;
  if (ms < 60000)
    return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  return formatDuration(ms);
}
function formatOffset(ms) {
  if (!Number.isFinite(ms) || ms < 1000)
    return "+0s";
  if (ms < 60000)
    return `+${Math.floor(ms / 1000)}s`;
  return `+${Math.floor(ms / 60000)}m${String(Math.floor(ms % 60000 / 1000)).padStart(2, "0")}`;
}
var LAUNCH_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false
});
function formatLaunchTime(iso) {
  if (!iso)
    return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()))
    return "";
  const p = {};
  for (const part of LAUNCH_FMT.formatToParts(d))
    p[part.type] = part.value;
  return `${p.month} ${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
function stripMarkdown(s) {
  const fence = /```[^\n]*\n([\s\S]*?)(?:```|$)/g;
  const parts = [];
  let last = 0;
  for (let m;(m = fence.exec(s)) !== null; ) {
    parts.push(stripProse(s.slice(last, m.index)), m[1] ?? "");
    last = fence.lastIndex;
  }
  parts.push(stripProse(s.slice(last)));
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
function stripProse(s) {
  return s.replace(/(`+)([^\n]+?)\1/g, "$2").replace(/\*\*([^*]+?)\*\*/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/^\s{0,3}#{1,6}\s+/gm, "").replace(/^\s{0,3}[-*>]\s+/gm, "");
}
function summarizeTools(tools) {
  const counts = new Map;
  for (const t of tools)
    counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  const breakdown = [...counts.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  return { count: tools.length, breakdown };
}

// apps/server/src/client/auth.ts
var STORAGE_KEY = "seedeep-token";
var authState = "ok";
var authListeners = new Set;
function currentAuthState() {
  return authState;
}
function onAuthState(cb) {
  authListeners.add(cb);
  return () => authListeners.delete(cb);
}
function setAuthState(next) {
  if (next === authState)
    return;
  authState = next;
  for (const cb of authListeners)
    cb(next);
}
function provesTheToken(url, method) {
  return !(method.toUpperCase() === "GET" && url.split("?")[0].endsWith("/api/config"));
}
function store() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}
function initAuth() {
  const s = store();
  if (!s)
    return;
  try {
    const params = new URLSearchParams(location.search);
    const urlToken = params.get("token");
    if (urlToken) {
      s.setItem(STORAGE_KEY, urlToken);
      params.delete("token");
      const search = params.toString();
      history.replaceState(null, "", location.pathname + (search ? "?" + search : "") + location.hash);
    }
  } catch {}
}
function getToken() {
  return store()?.getItem(STORAGE_KEY) ?? "";
}
function setToken(token) {
  store()?.setItem(STORAGE_KEY, token);
}
function authFetch(url, init) {
  const token = getToken();
  const method = init?.method ?? "GET";
  if (!token)
    return observe(fetch(url, init), url, method, "");
  const merged = {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...init?.headers ?? {}
    }
  };
  return observe(fetch(url, merged), url, method, token);
}
function observe(res, url, method, token) {
  return res.then((r) => {
    if (r.status === 401 && token === getToken())
      setAuthState(token ? "refused" : "missing");
    else if (r.ok && provesTheToken(url, method))
      setAuthState("ok");
    return r;
  });
}

class AuthEventSource {
  inner;
  constructor(url) {
    const token = getToken();
    if (token) {
      const u = new URL(url, location.origin);
      u.searchParams.set("token", token);
      this.inner = new EventSource(u.toString());
    } else {
      this.inner = new EventSource(url);
    }
  }
  addEventListener(type, cb) {
    this.inner.addEventListener(type, (ev) => cb(ev));
  }
  close() {
    this.inner.close();
  }
  get readyState() {
    return this.inner.readyState;
  }
}

// apps/server/src/client/build-mark.ts
var MARK_CLASS = "build-mark";
var VERSION_CLASS = "version-mark";
var DEV_TITLE = "seedeep dev";
function markVersion(version, brand, doc = document) {
  if (!version || !brand || brand.querySelector(`.${VERSION_CLASS}`))
    return;
  const label = doc.createElement("span");
  label.className = VERSION_CLASS;
  label.textContent = version;
  brand.append(label);
}
function markDevBuild(dev, brand, doc = document) {
  if (!dev)
    return;
  doc.title = DEV_TITLE;
  if (!brand || brand.querySelector(`.${MARK_CLASS}`))
    return;
  const chip = doc.createElement("span");
  chip.className = MARK_CLASS;
  chip.textContent = "dev";
  chip.title = "Served by a checkout, not by an installed release";
  brand.append(chip);
}

// apps/server/src/client/compare-view.ts
var WINDOWS = [
  { key: "d7", label: "7 days" },
  { key: "d30", label: "30 days" },
  { key: "all", label: "all" }
];
var MODEL_COLORS = {
  Opus: "#a78bfa",
  Sonnet: "#2dd4bf",
  Haiku: "#f472b6",
  Fable: "#818cf8",
  other: "#8593ad"
};
var FAMILY_ORDER = ["Fable", "Opus", "Sonnet", "Haiku", "other"];
var MODEL_FACTORS = [
  { family: "Haiku", factor: "×1" },
  { family: "Sonnet", factor: "×2–3" },
  { family: "Opus", factor: "×5" },
  { family: "Fable", factor: "×10" }
];
function fmt(n) {
  const a = Math.abs(n);
  if (a >= 1e9)
    return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (a >= 1e6)
    return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (a >= 1000)
    return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(Math.round(n));
}
var pct = (part, whole) => (whole ? Math.round(100 * part / whole) : 0) + "%";
function familyOf(model) {
  const m = /^claude-([a-z]+)/.exec(model);
  if (!m)
    return "other";
  const f = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return FAMILY_ORDER.includes(f) ? f : "other";
}
function modelLabel(id) {
  const m = /^claude-([a-z]+)-(.+)$/.exec(id);
  if (!m)
    return id.replace(/^<|>$/g, "");
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  const ver = m[2].split("-").filter((part) => /^\d{1,2}$/.test(part));
  return ver.length ? `${family} ${ver.join(".")}` : family;
}
function ago(ts, now) {
  const mins = Math.round((now - ts) / 60000);
  if (mins < 60)
    return Math.max(0, mins) + "m ago";
  const h = Math.round(mins / 60);
  return h < 24 ? h + "h ago" : Math.round(h / 24) + "d ago";
}
function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className)
    n.className = className;
  if (text != null)
    n.textContent = text;
  return n;
}
function labelOf(row) {
  if (row.subject)
    return row.subject.replace(/\s+/g, " ").trim();
  if (isAutomated(row))
    return "Automated run · " + row.entrypoint;
  return "Session " + row.sessionId.slice(0, 8);
}
function familyMix(row) {
  const by = new Map;
  for (const m of row.byModel)
    by.set(familyOf(m.model), (by.get(familyOf(m.model)) ?? 0) + m.weight);
  return FAMILY_ORDER.filter((f) => (by.get(f) ?? 0) > 0).map((family) => ({
    family,
    share: (by.get(family) ?? 0) / row.weight
  }));
}
function createCompareView(host, deps) {
  let data = null;
  let win = "all";
  function row(r, max, now, isTop) {
    const n = el("div", "cmp-row" + (isTop ? " cmp-top" : ""));
    n.onclick = () => deps.onOpenSession(r.sessionId);
    n.tabIndex = 0;
    n.setAttribute("role", "button");
    n.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        deps.onOpenSession(r.sessionId);
      }
    };
    n.append(el("div", "cmp-rank", String(r.rank)));
    const id = el("div", "cmp-id");
    const label = labelOf(r);
    const subj = el("div", "cmp-subj" + (r.subject ? "" : " cmp-unnamed"), label);
    subj.title = label;
    id.append(subj);
    const meta = el("div", "cmp-meta");
    const add = (text, cls, title) => {
      const span = el("span", cls, text);
      if (title)
        span.title = title;
      if (meta.children.length > 0)
        meta.append(el("span", "cmp-sep", "·"));
      meta.append(span);
    };
    add(r.project, "cmp-proj");
    if (r.mainModel) {
      add(modelLabel(r.mainModel) + (r.mainModels > 1 ? " +" + (r.mainModels - 1) : ""), "cmp-model", r.mainModels > 1 ? "the main thread’s dominant model, of " + r.mainModels + " it used — subagents excluded" : "the model the main thread ran on — subagents excluded");
    }
    add(ago(r.lastTs, now));
    add(r.apiCalls + " API calls");
    add(fmt(r.tokensComplete) + " tokens", "cmp-tok", "complete tokens processed: input + cache write + cache read + output, every model, subagents included");
    if (r.subagentWeight > 0)
      add(pct(r.subagentWeight, r.weight) + " subagents", "cmp-sub");
    const shift = r.rawRank - r.rank;
    if (Math.abs(shift) >= 3) {
      add((shift > 0 ? "▲" : "▼") + Math.abs(shift) + " vs unweighted", "cmp-shift" + (shift > 0 ? "" : " cmp-down"));
    }
    meta.title = [
      r.project,
      r.mainModel ? modelLabel(r.mainModel) : null,
      ago(r.lastTs, now),
      r.apiCalls + " API calls",
      fmt(r.tokensComplete) + " tokens"
    ].filter((x) => x !== null).join(" · ");
    id.append(meta);
    n.append(id);
    const track = el("div", "cmp-track");
    const fill = el("div", "cmp-fill");
    fill.style.width = Math.max(1.5, 100 * r.weight / max) + "%";
    for (const m of familyMix(r)) {
      if (m.share <= 0.004)
        continue;
      const seg = el("i");
      seg.style.width = m.share * 100 + "%";
      seg.style.background = MODEL_COLORS[m.family] ?? MODEL_COLORS.other;
      seg.title = m.family + " " + pct(m.share, 1);
      fill.append(seg);
    }
    track.append(fill);
    n.append(track, el("div", "cmp-val", fmt(r.weight)));
    return n;
  }
  function explainer() {
    const box = el("div", "cmp-src");
    box.append(el("div", "cmp-src-h", "how this is computed"));
    box.append(el("p", "cmp-lede", "Each API call is counted once, weighted twice — by the kind of token it spent and by the " + "model that spent it — then summed over the session and every subagent it launched."));
    const grid = el("div", "cmp-expl");
    grid.append(el("div", "cmp-el", "per token type"));
    const typeRow = el("div", "cmp-ev");
    typeRow.append(el("code", undefined, "cache read ×0.1 · cache write ×2 · input ×1 · output ×5"));
    const cite = el("a", "cmp-cite", "Anthropic burndown rates");
    cite.href = "https://platform.claude.com/docs/en/api/service-tiers";
    cite.target = "_blank";
    cite.rel = "noreferrer";
    typeRow.append(cite);
    grid.append(typeRow);
    grid.append(el("div", "cmp-el", "per model"));
    const modelRow = el("div", "cmp-ev");
    const chips = el("span", "cmp-chips");
    for (const f of MODEL_FACTORS) {
      const chip = el("span", "cmp-chip");
      const k = el("span", "cmp-k");
      k.style.background = MODEL_COLORS[f.family] ?? MODEL_COLORS.other;
      chip.append(k, document.createTextNode(f.family + " " + f.factor));
      chips.append(chip);
    }
    modelRow.append(chips, el("span", "cmp-cite cmp-ours", "seedeep’s own, from the price list"));
    grid.append(modelRow);
    box.append(grid);
    box.append(el("p", "cmp-lede cmp-last", "The result stays a token count — a heavier model simply counts for more. It is never a cost " + "in dollars, and Anthropic publishes no official ratio between models."));
    return box;
  }
  function segmented() {
    const box = el("div", "rt-seg");
    for (const w of WINDOWS) {
      const b = el("button", w.key === win ? "on" : "", w.label);
      b.onclick = () => {
        win = w.key;
        render();
      };
      box.append(b);
    }
    return box;
  }
  function render() {
    if (!data) {
      host.replaceChildren(el("div", "rt-empty", "No comparison yet — seedeep is reading your sessions."));
      return;
    }
    const w = data.windows[win];
    const now = data.generatedAt;
    const root = el("div", "cmp-root rt-root");
    const head = el("div", "rt-head");
    const left = el("div");
    left.append(el("div", "rt-kick", "compare sessions"));
    const title = el("h1", "rt-title");
    title.append(document.createTextNode("Which session weighed "), el("b", undefined, "the most"));
    left.append(title);
    left.append(el("div", "rt-scope", w.sessions + " session" + (w.sessions === 1 ? "" : "s") + " in window · tokens weighted by model · main + subagents"));
    head.append(left);
    const filter = el("div", "rt-filter");
    filter.append(el("span", "rt-seglbl", "window"), segmented());
    head.append(filter);
    root.append(head);
    const grid = el("div", "rt-grid");
    if (w.sessions === 0) {
      grid.append(el("div", "rt-empty", "No session in this window."));
      root.append(grid);
      host.replaceChildren(root);
      return;
    }
    const card = el("div", "rt-card cmp-rank-card");
    const ctitle = el("div", "rt-ctitle");
    ctitle.append(el("span", undefined, "weight by session"));
    const legend = el("div", "cmp-legend");
    const famTotal = new Map;
    for (const m of w.byModel)
      famTotal.set(familyOf(m.model), (famTotal.get(familyOf(m.model)) ?? 0) + m.weight);
    for (const family of FAMILY_ORDER) {
      const weight = famTotal.get(family) ?? 0;
      if (weight <= 0)
        continue;
      const item = el("span");
      const k = el("span", "cmp-k");
      k.style.background = MODEL_COLORS[family] ?? MODEL_COLORS.other;
      item.append(k, el("b", undefined, family), document.createTextNode(" " + (weight / w.weight < 0.005 ? "<1%" : pct(weight, w.weight))));
      legend.append(item);
    }
    ctitle.append(legend);
    card.append(ctitle);
    const list = el("div");
    list.style.marginTop = ".85rem";
    const max = w.top[0]?.weight ?? 1;
    w.top.forEach((r, i) => list.append(row(r, max, now, i === 0)));
    card.append(list);
    if (w.restSessions > 0) {
      const note = el("div", "rt-note", "+ " + w.restSessions + " lighter session" + (w.restSessions === 1 ? "" : "s") + ", " + fmt(w.restWeight) + " together (" + pct(w.restWeight, w.weight) + ")");
      note.style.marginTop = ".7rem";
      card.append(note);
    }
    card.append(explainer());
    grid.append(card);
    root.append(grid);
    host.replaceChildren(root);
  }
  async function refresh() {
    const next = await deps.loadComparison();
    if (next)
      data = next;
    render();
  }
  render();
  return { refresh };
}

// apps/server/src/client/id-chip.ts
var CONFIRM_MS = 1600;
var SHORT = 8;
function createIdChip(sessionId, opts = {}) {
  const label = opts.full ? sessionId : sessionId.slice(0, SHORT);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "idchip" + (opts.className ? " " + opts.className : "");
  btn.textContent = label;
  btn.title = `copy the full session id — ${sessionId}`;
  btn.setAttribute("aria-label", `copy the full session id ${sessionId}`);
  let timer = null;
  btn.onclick = (e) => {
    e.stopPropagation();
    const done = () => {
      if (timer !== null)
        clearTimeout(timer);
      btn.classList.add("copied");
      btn.textContent = opts.confirmLabel ?? "copied";
      timer = setTimeout(() => {
        btn.classList.remove("copied");
        btn.textContent = label;
        timer = null;
      }, CONFIRM_MS);
    };
    const p = navigator.clipboard?.writeText(sessionId);
    if (p)
      p.then(done, () => {});
  };
  return btn;
}

// apps/server/src/core/roster.ts
function mergeRoster(catalogue, live, now = Date.now()) {
  const liveById = new Map(live.sessions.map((s) => [s.sessionId, s]));
  const rows = catalogue.map((c) => liveById.get(c.sessionId) ?? (live.complete ? ended(c, live.pidVisible, now) : null)).filter((r) => r !== null);
  const known = new Set(catalogue.map((c) => c.sessionId));
  for (const s of live.sessions)
    if (!known.has(s.sessionId))
      rows.push(s);
  rows.sort((a, b) => b.lastActivity - a.lastActivity);
  return rows;
}
function ended(c, pidVisible, now) {
  const lastActivity = c.lastActivity ?? 0;
  return {
    sessionId: c.sessionId,
    project: c.project,
    model: c.model,
    subject: c.subject,
    entrypoint: c.entrypoint,
    root: c.root,
    path: c.path,
    lastActivity,
    isActive: now - lastActivity <= ACTIVE_WINDOW_MS,
    isOpen: pidVisible ? false : null,
    status: null,
    waitingFor: null,
    waitingSince: null
  };
}

// apps/server/src/client/deadline.ts
function withDeadline(read, ms) {
  const ctrl = new AbortController;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ctrl.abort();
      reject(new Error("seedeep: the request timed out"));
    }, ms);
    let p;
    try {
      p = read(ctrl.signal);
    } catch (e) {
      clearTimeout(t);
      reject(e);
      return;
    }
    p.then((v) => {
      clearTimeout(t);
      resolve(v);
    }, (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

// apps/server/src/client/sessions.ts
function sessionsToAutoOpen(rows, known, openIds) {
  return rows.filter((s) => isLive(s) && !isAutomated(s) && !known.has(s.sessionId) && !openIds.has(s.sessionId));
}
function requestedSession(search) {
  try {
    const id = new URLSearchParams(search).get("session")?.trim();
    return id && id.length <= 200 ? id : null;
  } catch {
    return null;
  }
}
function rosterKey(rows) {
  return rows.map((s) => `${s.sessionId}:${s.isActive ? 1 : 0}:${s.isOpen}:${s.status ?? ""}:${s.waitingFor ?? ""}:${s.subject ?? ""}`).sort().join("|");
}
function hasProvisional(cat, liveIds) {
  return cat.some((c) => c.lastActivity === null && !liveIds.has(c.sessionId));
}
var READING_TIMEOUT_MS = 1e4;
function createRoster(deps) {
  const pollMs = deps.pollMs ?? 3000;
  const timeoutMs = deps.timeoutMs ?? READING_TIMEOUT_MS;
  const schedule = deps.schedule ?? ((fn, ms) => {
    const t = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(t) };
  });
  let catalogue = [];
  let rows = [];
  let key = "";
  let timer = null;
  let stopped = false;
  let taken = 0;
  let complete = false;
  const listeners = new Set;
  async function refresh() {
    let live;
    try {
      live = await withDeadline(deps.fetchLive, timeoutMs);
    } catch {
      return;
    }
    const liveIds = new Set(live.sessions.map((s) => s.sessionId));
    if (live.total !== catalogue.length || hasProvisional(catalogue, liveIds)) {
      try {
        catalogue = await withDeadline(deps.fetchCatalogue, timeoutMs);
      } catch {
        return;
      }
    }
    const next = mergeRoster(catalogue, live);
    rows = next;
    taken++;
    complete = live.complete;
    const nextKey = rosterKey(next);
    if (nextKey !== key) {
      key = nextKey;
      for (const cb of listeners) {
        try {
          cb(rows);
        } catch (err) {
          console.error("seedeep: a roster listener threw", err);
        }
      }
    }
  }
  function arm() {
    if (stopped)
      return;
    timer = schedule(() => {
      refresh().then(arm, arm);
    }, pollMs);
  }
  return {
    async start() {
      await refresh();
      arm();
    },
    current: () => rows,
    readings: () => taken,
    complete: () => complete,
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    stop() {
      stopped = true;
      if (timer)
        timer.cancel();
    }
  };
}

// apps/server/src/client/dropdown.ts
var p2 = (n) => String(n).padStart(2, "0");
function fmtWhen(ms) {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1)
    return "now";
  if (min < 60)
    return min + "m";
  const h = Math.floor(min / 60);
  if (h < 24)
    return h + "h";
  const days = Math.floor(h / 24);
  if (days < 7)
    return days + "d";
  const d = new Date(ms);
  return `${d.toLocaleString(undefined, { month: "short" })} ${p2(d.getDate())}`;
}
function shortModel(model) {
  if (!model)
    return "?";
  const fam = modelFamily(model);
  return fam ? fam.charAt(0).toUpperCase() + fam.slice(1) : model;
}
var isAuto = isAutomated;
function el2(tag, className, text) {
  const n = document.createElement(tag);
  if (className)
    n.className = className;
  if (text != null)
    n.textContent = text;
  return n;
}
function createDropdown(mount, { onOpen }) {
  let rows = [];
  let openTabs = new Set;
  let stats = new Map;
  let query = "";
  let open = false;
  let tab = "human";
  let flat = [];
  let hi = -1;
  mount.classList.add("picker");
  const trigger = el2("button", "pk-trigger");
  trigger.type = "button";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.append(el2("span", "pk-tlabel", "Open a session…"), el2("span", "pk-caret", "▾"));
  const input = el2("input", "pk-input");
  input.type = "text";
  input.placeholder = "Filter sessions…";
  input.setAttribute("aria-label", "Filter sessions");
  const searchIcon = el2("span", "pk-sicon", "⌕");
  const search = el2("div", "pk-search");
  search.append(searchIcon, input);
  const mkTab = (key, label) => {
    const b = el2("button", "pk-tab");
    b.type = "button";
    b.setAttribute("role", "tab");
    const cnt = el2("span", "pk-count", "0");
    b.append(el2("span", null, label), cnt);
    b.onclick = () => {
      tab = key;
      render();
    };
    return { b, cnt };
  };
  const tHuman = mkTab("human", "Human");
  const tAuto = mkTab("automated", "Automated");
  const tabbar = el2("div", "pk-tabs");
  tabbar.setAttribute("role", "tablist");
  tabbar.append(tHuman.b, tAuto.b);
  const listEl = el2("div", "pk-list");
  listEl.setAttribute("role", "listbox");
  const pop = el2("div", "pk-pop");
  pop.append(tabbar, search, listEl);
  mount.replaceChildren(trigger, pop);
  function matches(s, q) {
    if (!q)
      return true;
    const hay = `${s.subject || ""} ${s.model || ""} ${s.project || ""} ${s.sessionId}${isAuto(s) ? " automated" : ""}`;
    return hay.toLowerCase().includes(q);
  }
  function rowNode(s) {
    let cls = "pk-row";
    if (isLive(s))
      cls += " active";
    const row = el2("div", cls);
    row.setAttribute("role", "option");
    row.append(el2("span", "pk-dot"));
    const body = el2("div", "pk-body");
    const line1 = el2("div", "pk-p1");
    const promptText = s.subject && s.subject.trim() ? s.subject.trim() : `session ${s.sessionId.slice(0, 8)}`;
    line1.append(el2("span", "pk-prompt", promptText));
    if (openTabs.has(s.sessionId))
      line1.append(el2("span", "pk-badge pin", "\uD83D\uDCCC"));
    body.append(line1);
    const meta = el2("div", "pk-meta");
    const model = shortModel(s.model);
    meta.append(el2("span", "pk-mchip m-" + model, model));
    meta.append(el2("span", "pk-sep", "·"), el2("span", null, fmtWhen(s.lastActivity)));
    meta.append(el2("span", "pk-sep", "·"), createIdChip(s.sessionId, { className: "pk-id" }));
    const ss = stats.get(s.sessionId);
    if (ss) {
      meta.append(el2("span", "pk-sep", "·"), el2("span", "pk-turns", ss.turns + " turn" + (ss.turns === 1 ? "" : "s")));
    }
    body.append(meta);
    row.append(body);
    row.onclick = () => select(s.sessionId);
    return row;
  }
  function render(preserve) {
    const entry = flat[hi];
    const keepId = preserve && hi >= 0 && entry ? entry.id : null;
    const keepScroll = preserve ? listEl.scrollTop : 0;
    const q = query.trim().toLowerCase();
    tHuman.cnt.textContent = String(rows.filter((s) => !isAuto(s) && matches(s, q)).length);
    tAuto.cnt.textContent = String(rows.filter((s) => isAuto(s) && matches(s, q)).length);
    for (const [t, key] of [
      [tHuman, "human"],
      [tAuto, "automated"]
    ]) {
      t.b.classList.toggle("on", tab === key);
      t.b.setAttribute("aria-selected", String(tab === key));
    }
    const current = rows.filter((s) => isAuto(s) === (tab === "automated") && matches(s, q));
    const active = current.filter(isLive);
    const inactive = current.filter((s) => !isLive(s));
    const nodes = [];
    flat = [];
    const section = (label, list) => {
      if (!list.length)
        return;
      nodes.push(el2("div", "pk-ghead", label));
      for (const s of list) {
        const node = rowNode(s);
        flat.push({ node, id: s.sessionId });
        nodes.push(node);
      }
    };
    section("Live", active);
    section("Inactive", inactive);
    if (!nodes.length)
      nodes.push(el2("div", "pk-empty", q ? `No ${tab} sessions match “${query.trim()}”` : `No ${tab} sessions`));
    listEl.replaceChildren(...nodes);
    hi = keepId ? flat.findIndex((f) => f.id === keepId) : -1;
    if (hi < 0)
      hi = flat.length ? 0 : -1;
    applyHi();
    if (preserve)
      listEl.scrollTop = keepScroll;
  }
  function applyHi() {
    flat.forEach((f, i) => f.node.classList.toggle("hl", i === hi));
  }
  function moveHi(delta) {
    if (!flat.length)
      return;
    hi = Math.max(0, Math.min(hi + delta, flat.length - 1));
    applyHi();
    flat[hi].node.scrollIntoView?.({ block: "nearest" });
  }
  function fetchStats() {
    authFetch("/api/session-stats").then((r) => r.json()).then((data) => {
      stats = new Map(Object.entries(data));
      if (open)
        render(true);
    }).catch(() => {});
  }
  function setOpen(v) {
    open = v;
    mount.classList.toggle("open", v);
    trigger.setAttribute("aria-expanded", String(v));
    if (v) {
      tab = !rows.some((s) => !isAuto(s)) && rows.some(isAuto) ? "automated" : "human";
      input.value = query;
      render();
      input.focus?.();
      fetchStats();
    } else {
      query = "";
    }
  }
  function select(id) {
    setOpen(false);
    onOpen(id);
  }
  trigger.onclick = () => setOpen(!open);
  input.oninput = () => {
    query = input.value;
    render();
  };
  document.addEventListener("click", (e) => {
    if (open && !mount.contains(e.target))
      setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (!open)
      return;
    if (e.key === "Escape") {
      setOpen(false);
      trigger.focus?.();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      moveHi(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveHi(-1);
    } else if (e.key === "Enter") {
      const entry = flat[hi];
      if (hi >= 0 && entry)
        select(entry.id);
    }
  });
  return {
    open() {
      setOpen(true);
    },
    update(next) {
      rows = next || [];
      if (open)
        render(true);
    },
    setOpenTabs(ids) {
      openTabs = new Set(ids);
      if (open)
        render(true);
    }
  };
}

// apps/server/src/client/end-guard.ts
function createEndGuard(deps) {
  const schedule = deps.schedule ?? ((fn, ms) => {
    const t = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(t) };
  });
  const pending = new Map;
  return {
    gone(sessionId) {
      if (pending.has(sessionId))
        return;
      const at = deps.reading();
      const arm = () => schedule(() => {
        if (deps.reading() <= at) {
          pending.set(sessionId, arm());
          return;
        }
        pending.delete(sessionId);
        if (deps.stillGone(sessionId))
          deps.end(sessionId);
      }, deps.delayMs);
      pending.set(sessionId, arm());
    },
    cancel(sessionId) {
      pending.get(sessionId)?.cancel();
      pending.delete(sessionId);
    }
  };
}

// apps/server/src/client/home-view.ts
var WEEK_METRICS = [
  {
    key: "tokens",
    label: "tokens",
    hint: (g) => `tokens / ${g} · incl. cache`,
    stacked: false,
    value: (w) => w.tokens,
    show: (w) => fmt2(w.tokens)
  },
  {
    key: "turns",
    label: "turns",
    hint: (g) => `turns / ${g}`,
    stacked: true,
    value: (w) => w.crit + w.warn + w.good,
    show: (w) => String(w.crit + w.warn + w.good)
  },
  {
    key: "hours",
    label: "hours",
    hint: (g) => `working time / ${g}`,
    stacked: false,
    value: (w) => w.workMs,
    show: (w) => dur(w.workMs)
  }
];
var MODEL_COLORS2 = ["#a78bfa", "#2dd4bf", "#f472b6", "#818cf8", "#8593ad"];
function fmt2(n) {
  const a = Math.abs(n);
  if (a >= 1e9)
    return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (a >= 1e6)
    return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (a >= 1000)
    return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(Math.round(n));
}
function dur(ms) {
  return ms >= 3600000 ? Math.round(ms / 3600000) + "h" : Math.round(ms / 60000) + "m";
}
var pct2 = (part, whole) => (whole ? Math.round(100 * part / whole) : 0) + "%";
function modelLabel2(id) {
  if (!id || id === "unknown")
    return "unknown";
  const m = id.match(/^claude-([a-z]+)-(.+)$/);
  if (!m)
    return id.replace(/^<|>$/g, "");
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  const ver = m[2].split("-").filter((p) => /^\d{1,2}$/.test(p));
  return ver.length ? `${family} ${ver.join(".")}` : family;
}
function el3(tag, className, text) {
  const n = document.createElement(tag);
  if (className)
    n.className = className;
  if (text != null)
    n.textContent = text;
  return n;
}
function plural(n, word) {
  return n === 1 ? word : `${word}s`;
}
function hasCorpus(r) {
  return !!r && !!r.windows?.all && r.windows.all.turns > 0 && !!r.baseline?.overall;
}
function histPos(x) {
  for (let i = 0;i < HIST_BINS.length; i++) {
    const b = HIST_BINS[i];
    if (x >= b.min && x < b.max) {
      const hi = b.max === Infinity ? b.min * 3 : b.max;
      const f = (Math.log(Math.max(1, x)) - Math.log(b.min || 1)) / (Math.log(hi) - Math.log(b.min || 1) || 1);
      return (i + Math.max(0, Math.min(1, f))) / HIST_BINS.length * 100;
    }
  }
  return 99;
}
function kpi(variant, num, label, sub) {
  const cardEl = el3("div", "rt-card rt-kpi" + (variant ? " " + variant : ""));
  cardEl.append(el3("div", "rt-num", num), el3("div", "rt-lbl", label), el3("div", "rt-sub", sub));
  return cardEl;
}
function card(cls, title, hint) {
  const c = el3("div", "rt-card " + cls);
  const t = el3("div", "rt-ctitle");
  t.append(el3("span", undefined, title), el3("span", "rt-hint", hint));
  c.append(t);
  return c;
}
function barRow(label, n, max, fill) {
  const row = el3("div", "rt-brow");
  const track = el3("span", "rt-btrack");
  const i = el3("i", fill);
  i.style.width = Math.round(100 * n / max) + "%";
  track.append(i);
  row.append(el3("span", "rt-bn", label), track, el3("span", "rt-bv", fmt2(n)));
  return row;
}
function legend(items) {
  const l = el3("div", "rt-legend");
  for (const it of items) {
    const s = el3("span");
    s.append(el3("span", "rt-k " + it.cls));
    s.append(el3("span", undefined, it.label + (it.value ? " " : "")));
    if (it.value)
      s.append(el3("b", undefined, it.value));
    l.append(s);
  }
  return l;
}
function createHomeView(container, opts) {
  let data = null;
  let win = "all";
  let metric = "tokens";
  const pick = (e) => {
    e?.stopPropagation?.();
    opts.onPickSession?.();
  };
  function emptyBox() {
    const box = el3("div", "rt-empty");
    const known = opts.sessionsOnDisk?.() ?? 0;
    const read = known > 0 || !!data;
    const hasSessions = known > 0;
    const lead = el3("div", "rt-empty-lead");
    lead.textContent = hasSessions ? "There are sessions here, none with a finished turn yet." : read ? "seedeep needs a Claude Code session. There is none on this machine yet." : "seedeep needs a Claude Code session.";
    const then = el3("div", "rt-empty-then");
    if (hasSessions) {
      then.append(document.createTextNode("A turn lands here the moment it ends — and the session itself is watchable "), el3("b", undefined, "now"), document.createTextNode(", from "), el3("span", "rt-strong", "Open a session…"), document.createTextNode(" above."));
    } else {
      then.append(document.createTextNode("Run "), el3("code", undefined, "claude"), document.createTextNode(" in any project and leave this tab open: it fills in "), el3("b", undefined, "while"), document.createTextNode(" the turn runs, not after it ends."));
    }
    const watch = el3("div", "rt-empty-watch");
    watch.append(el3("span", "rt-dot"), document.createTextNode("Watching "), el3("code", undefined, "~/.claude/projects"), document.createTextNode(" · it reads the logs Claude Code writes there, and nothing leaves this machine."));
    box.append(lead, then, watch);
    return box;
  }
  function empty() {
    const root = el3("div", "rt-root");
    const head = el3("div", "rt-head");
    const h = el3("div");
    h.append(el3("div", "rt-kick", "seedeep · your Claude Code, so far"), el3("div", "rt-title", "Your retrospective"));
    head.append(h);
    root.append(head, emptyBox());
    const foot = el3("div", "rt-foot");
    const cta = el3("button", "rt-cta", "Pick a session →");
    cta.onclick = pick;
    foot.append(cta);
    root.append(foot);
    container.replaceChildren(root);
  }
  function paint() {
    if (!hasCorpus(data)) {
      empty();
      return;
    }
    const r = data;
    const w = r.windows[win];
    const root = el3("div", "rt-root");
    const head = el3("div", "rt-head");
    const htext = el3("div");
    htext.append(el3("div", "rt-kick", "seedeep · your Claude Code, so far"));
    const title = el3("div", "rt-title");
    title.append(el3("b", undefined, w.turns.toLocaleString()), el3("span", undefined, win === "all" ? ` ${plural(w.turns, "turn")} across ${r.sessions.toLocaleString()} ${plural(r.sessions, "session")}` : ` ${plural(w.turns, "turn")}`));
    const scopeLabel = win === "d7" ? "last 7 days" : win === "d30" ? "last 30 days" : `all-time · ${r.spanDays}d on disk`;
    htext.append(title, el3("div", "rt-scope", `${scopeLabel} · ${dur(w.workMs)} working`));
    const filter = el3("div", "rt-filter");
    filter.append(el3("span", "rt-seglbl", "window"));
    const seg = el3("div", "rt-seg");
    for (const [key, label] of [
      ["d7", "7 days"],
      ["d30", "30 days"],
      ["all", "All-time"]
    ]) {
      const b = el3("button", key === win ? "on" : undefined, label);
      b.setAttribute("data-w", key);
      b.onclick = () => {
        win = key;
        paint();
      };
      seg.append(b);
    }
    filter.append(seg);
    head.append(htext, filter);
    root.append(head);
    const grid = el3("div", "rt-grid");
    grid.append(kpi("rt-accent", fmt2(w.p50Complete), "median turn", `complete · p95 ${fmt2(w.p95Complete)}`), kpi("rt-accent", fmt2(w.totalTokens), "tokens spent", `${fmt2(w.newTokens)} new · rest cache`), kpi("", fmt2(w.apiCalls), "API calls", `${fmt2(toolTotal(r))} tool calls`), kpi("rt-crit", pct2(w.crit, w.turns), "turns wasted tokens", `${w.crit.toLocaleString()} of ${w.turns.toLocaleString()}`), kpi("rt-crit", fmt2(w.esc.tokens), "abandoned to Esc", `${w.esc.turns.toLocaleString()} interrupted`), kpi("", dur(w.workMs), "spent working", `${w.turns.toLocaleString()} ${plural(w.turns, "turn")}`));
    const hero = card("rt-hero", "turn-size distribution", "new tokens / turn · excl. cache reads");
    hero.append(histChart(w));
    grid.append(hero);
    const gran = win === "d7" ? "day" : "week";
    const periods = win === "d7" ? r.days : win === "d30" ? r.weeks.slice(0, 5) : r.weeks;
    const act = el3("div", "rt-card rt-activity");
    const actTitle = el3("div", "rt-ctitle");
    const tabs = el3("div", "rt-mtabs");
    for (const m of WEEK_METRICS) {
      const b = el3("button", m.key === metric ? "on" : undefined, m.label);
      b.setAttribute("data-m", m.key);
      b.onclick = () => {
        metric = m.key;
        paint();
      };
      tabs.append(b);
    }
    actTitle.append(el3("span", undefined, "activity"), tabs);
    act.append(actTitle, weekChart(periods, metric, gran));
    const wl = el3("div", "rt-wklbl");
    if (gran === "day") {
      wl.append(el3("span", undefined, "6d ago"), el3("span", undefined, "today"));
    } else {
      wl.append(el3("span", undefined, `${periods.length}w ago`), el3("span", undefined, "this week"));
    }
    act.append(wl);
    const mActive = WEEK_METRICS.find((m) => m.key === metric);
    act.append(mActive.stacked ? legend([
      { cls: "rt-crit", label: "crit" },
      { cls: "rt-warn", label: "warn" },
      { cls: "rt-good", label: "clean" }
    ]) : legend([{ cls: "rt-solid", label: mActive.hint(gran) }]));
    grid.append(act);
    const waste = card("rt-third-wide", "where the waste comes from", w.resume.tokens > 0 ? `${fmt2(w.resume.tokens)} re-entering · ${r.reentrySessions} of ${r.sessions} ${plural(r.sessions, "session")} over 10%` : "turns flagged");
    const wr = [
      { k: "committed without tests", n: w.unverifiedShip, f: "rt-fill-crit" },
      { k: "context ≥70%", n: w.context, f: "rt-fill-warn" },
      { k: "explored, changed nothing", n: w.exploration, f: "rt-fill-warn" },
      { k: "resumed cold", n: w.resume.turns, f: "rt-fill-warn" },
      { k: "corrected twice", n: w.escStreak, f: "rt-fill-warn" },
      { k: "big subagent", n: w.subWaste, f: "rt-fill-crit" },
      { k: "compaction", n: w.compaction, f: "rt-fill-crit" }
    ];
    const wmax = Math.max(1, ...wr.map((x) => x.n));
    for (const x of wr)
      waste.append(barRow(x.k, x.n, wmax, x.f));
    grid.append(waste);
    grid.append(modelCard(w));
    const toolsCard = card("rt-third-narrow", "tool calls by type", `${fmt2(toolTotal(r))} calls`);
    const shownTools = foldTop(r.tools.map((t) => ({ label: t.name, value: t.count })), 7);
    const tmax = Math.max(1, ...shownTools.map((t) => t.value));
    for (const t of shownTools)
      toolsCard.append(barRow(t.label, t.value, tmax, "rt-fill-tool"));
    grid.append(toolsCard);
    const verdict = card("rt-verdict", "verdict split", `${w.turns.toLocaleString()} ${plural(w.turns, "turn")}`);
    const good = Math.max(0, w.turns - w.crit - w.warn);
    const bar = el3("div", "rt-rbar");
    const seg2 = (n, cls) => {
      const i = el3("i", cls);
      i.style.width = pct2(n, w.turns);
      return i;
    };
    bar.append(seg2(w.crit, "rt-crit"), seg2(w.warn, "rt-warn"), seg2(good, "rt-good"));
    verdict.append(bar, legend([
      { cls: "rt-crit", label: "crit", value: pct2(w.crit, w.turns) },
      { cls: "rt-warn", label: "warn", value: pct2(w.warn, w.turns) },
      { cls: "rt-good", label: "clean", value: pct2(good, w.turns) }
    ]));
    grid.append(verdict);
    const foot = el3("div", "rt-foot");
    const cta = el3("button", "rt-cta", "Pick a session →");
    cta.onclick = pick;
    foot.append(el3("span", "rt-note", "updates as new sessions land"), cta);
    grid.append(foot);
    root.append(grid);
    container.replaceChildren(root);
  }
  function refresh() {
    opts.loadRetro().then((r) => {
      data = r;
      paint();
    }).catch(() => {
      data = null;
      paint();
    });
  }
  paint();
  refresh();
  return { refresh, repaint: paint };
}
function toolTotal(r) {
  return r.tools.reduce((s, t) => s + t.count, 0);
}
function foldTop(rows, n) {
  if (rows.length <= n + 1)
    return rows;
  const top = rows.slice(0, n);
  const rest = rows.slice(n).reduce((s, x) => s + x.value, 0);
  return rest > 0 ? [...top, { label: "other", value: rest }] : top;
}
function histChart(w) {
  const host = el3("div", "rt-hist");
  const max = Math.max(1, ...w.hist);
  HIST_BINS.forEach((b, i) => {
    const n = w.hist[i] ?? 0;
    const bar = el3("div", "rt-hbar");
    bar.append(el3("span", "rt-hv", String(n)));
    const fill = el3("i");
    fill.style.height = Math.round(100 * n / max) + "%";
    bar.append(fill, el3("span", "rt-hl", b.label));
    host.append(bar);
  });
  for (const [p, x, cls] of [
    ["p50", w.p50, ""],
    ["p95", w.p95, "rt-p95"]
  ]) {
    if (!x)
      continue;
    const m = el3("div", "rt-pmark " + cls);
    m.style.left = histPos(x).toFixed(1) + "%";
    m.append(el3("span", undefined, `${p} ${fmt2(x)}`));
    host.append(m);
  }
  return host;
}
function weekChart(weeks, metric, granularity) {
  const m = WEEK_METRICS.find((x) => x.key === metric);
  const host = el3("div", "rt-weeks");
  const max = Math.max(1, ...weeks.map(m.value));
  const tipSuffix = (i) => granularity === "day" ? i === 0 ? "today" : i + "d ago" : i === 0 ? "this week" : i + "w ago";
  for (let i = weeks.length - 1;i >= 0; i--) {
    const wk = weeks[i];
    const colWrap = el3("div", "rt-wkcol");
    colWrap.title = `${m.show(wk)} · ${tipSuffix(i)}`;
    const col = el3("div", "rt-wk");
    col.style.height = Math.round(100 * m.value(wk) / max) + "%";
    if (m.stacked) {
      const t = wk.crit + wk.warn + wk.good;
      const stack = (n, cls) => {
        const s = el3("i", cls);
        s.style.height = t ? 100 * n / t + "%" : "0";
        return s;
      };
      col.append(stack(wk.good, "rt-good"), stack(wk.warn, "rt-warn"), stack(wk.crit, "rt-crit"));
    } else {
      const fill = el3("i", "rt-solid");
      fill.style.height = "100%";
      col.append(fill);
    }
    colWrap.append(el3("span", "rt-wkv", m.show(wk)), col);
    host.append(colWrap);
  }
  return host;
}
function modelCard(w) {
  const c = card("rt-third-narrow rt-model", "tokens by model", `${fmt2(w.totalTokens)} total · incl. cache`);
  const rows = foldTop(w.byModel.filter((m) => m.tokens > 0).map((m) => ({ label: modelLabel2(m.model), value: m.tokens })), 4);
  const total = Math.max(1, rows.reduce((s, m) => s + m.value, 0));
  const colorFor = (i, label) => label === "other" ? "var(--lo)" : MODEL_COLORS2[i % MODEL_COLORS2.length];
  const bar = el3("div", "rt-mbar");
  rows.forEach((m, i) => {
    const seg = el3("i");
    seg.style.width = 100 * m.value / total + "%";
    seg.style.background = colorFor(i, m.label);
    bar.append(seg);
  });
  c.append(bar);
  const leg = el3("div", "rt-mleg");
  rows.forEach((m, i) => {
    const row = el3("div", "rt-mrow");
    const k = el3("span", "rt-k");
    k.style.background = colorFor(i, m.label);
    row.append(k, el3("span", "rt-mn", m.label), el3("span", "rt-mv", `${fmt2(m.value)} · ${Math.round(100 * m.value / total)}%`));
    leg.append(row);
  });
  c.append(leg);
  return c;
}

// apps/server/src/client/nav-menu.ts
var BARS_SVG = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">
  <line x1="2.5" y1="4" x2="13.5" y2="4"/>
  <line x1="2.5" y1="8" x2="13.5" y2="8"/>
  <line x1="2.5" y1="12" x2="13.5" y2="12"/>
</svg>`;
var HOME_ID = "__home__";
var COMPARE_ID = "__compare__";
var SEARCH_ID = "__search__";
function createNavMenu(mount, { items, onSwitch }) {
  let open = false;
  let hi = -1;
  mount.classList.add("nav");
  const btn = document.createElement("button");
  btn.className = "nav-btn";
  btn.type = "button";
  btn.title = "Menu";
  btn.setAttribute("aria-haspopup", "menu");
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-label", "Menu");
  btn.innerHTML = BARS_SVG;
  const cur = document.createElement("span");
  cur.className = "nav-cur";
  btn.append(cur);
  const pop = document.createElement("div");
  pop.className = "nav-pop";
  pop.setAttribute("role", "menu");
  const rows = new Map;
  for (const item of items) {
    const row = document.createElement("button");
    row.className = "nav-item";
    row.type = "button";
    row.setAttribute("role", "menuitem");
    const icon = document.createElement("span");
    icon.className = "ic";
    icon.textContent = "✦";
    const name = document.createElement("span");
    name.textContent = item.label;
    const hint = document.createElement("span");
    hint.className = "sub";
    hint.textContent = item.hint;
    row.append(icon, name, hint);
    row.onclick = () => {
      setOpen(false);
      onSwitch(item.id);
    };
    pop.append(row);
    rows.set(item.id, row);
  }
  mount.replaceChildren(btn, pop);
  function setOpen(v) {
    open = v;
    hi = -1;
    mount.classList.toggle("open", v);
    btn.setAttribute("aria-expanded", String(v));
  }
  btn.onclick = () => setOpen(!open);
  document.addEventListener("click", (e) => {
    if (open && !mount.contains(e.target))
      setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (!open)
      return;
    if (e.key === "Escape") {
      setOpen(false);
      btn.focus?.();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp")
      return;
    e.preventDefault();
    const list = [...rows.values()];
    hi = (hi + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
    list[hi]?.focus?.();
  });
  return {
    setActive(id) {
      const item = items.find((i) => i.id === id);
      btn.classList.toggle("on", item !== undefined);
      cur.textContent = item ? item.label : "";
      btn.title = item ? item.label : "Menu";
      for (const [rowId, row] of rows) {
        row.classList.toggle("active", rowId === id);
        row.setAttribute("aria-current", rowId === id ? "page" : "false");
      }
    }
  };
}

// apps/server/src/client/event-types.ts
var LISTENED = {
  usage: true,
  attribution: true,
  compaction: true,
  "tool-start": true,
  "tool-end": true,
  "agent-end": true,
  "agent-launch": true,
  "background-event": true,
  note: true,
  wakeup: true,
  "command-vanished": true,
  "workflow-agent": true,
  "subagent-meta": true,
  "subagent-output": true,
  "user-turn": true,
  command: true,
  "turn-end": true,
  "turn-interrupted": true,
  "turn-result": true,
  "turn-narration": true,
  "file-change": true
};
var EVENT_TYPES = Object.keys(LISTENED);

// apps/server/src/client/replay.ts
var REPLAY_STALE_MS = 30000;
var RETRY_MS = 3000;
var MAX_RETRY_MS = 30000;
var MAX_STALE_REOPENS = 3;
function startReplay(sessionId, handler, deps) {
  const covered = new Map;
  const liveMax = new Map;
  const liveSeen = new Map;
  let buffering = true;
  let handedOff = false;
  let inFlight = true;
  let stopped = false;
  let resyncPending = false;
  let sawEnd = false;
  let retryTimer = null;
  const baseRetryMs = deps.retryMs ?? RETRY_MS;
  let nextRetryMs = baseRetryMs;
  let progressed = false;
  let staleReopens = 0;
  let historyComplete = false;
  const frontier = new Map;
  const readSeen = new Map;
  let floor = new Map;
  const applied = new Map;
  function bump(map, key, seq, n = 1) {
    let byLine = map.get(key);
    if (!byLine)
      map.set(key, byLine = new Map);
    const next = (byLine.get(seq) ?? 0) + n;
    byLine.set(seq, next);
    return next;
  }
  function holdApplied(key, seq, n) {
    if (n <= 0)
      return;
    let byLine = applied.get(key);
    if (!byLine)
      applied.set(key, byLine = new Map);
    byLine.set(seq, Math.max(byLine.get(seq) ?? 0, n));
  }
  const buffer = [];
  let unsubscribe = null;
  let es = null;
  const staleMs = deps.staleMs ?? REPLAY_STALE_MS;
  const checkMs = deps.checkMs ?? Math.max(1, Math.round(staleMs / 3));
  const now = deps.now ?? (() => Date.now());
  let lastFrameAt = now();
  const keyOf = (e) => e.agentId ?? "";
  function whole(key) {
    const c = covered.get(key);
    if (!historyComplete)
      return c;
    const l = liveMax.get(key);
    const lw = l === undefined ? undefined : l - 1;
    if (c === undefined)
      return lw;
    if (lw === undefined)
      return c;
    return Math.max(c, lw);
  }
  function deliver(e, source) {
    if (e.seq >= 0) {
      const key = keyOf(e);
      if (source === "replay") {
        const f = floor.get(key);
        if (f !== undefined && e.seq <= f)
          return;
        if (bump(readSeen, key, e.seq) <= (applied.get(key)?.get(e.seq) ?? 0))
          return;
        bump(applied, key, e.seq);
        const at = frontier.get(key);
        if (at === undefined || e.seq > at) {
          if (at !== undefined && at > (covered.get(key) ?? -1)) {
            covered.set(key, at);
            progressed = true;
          }
          frontier.set(key, e.seq);
        }
      } else {
        const c = covered.get(key);
        if (c !== undefined && e.seq <= c)
          return;
        const l = liveMax.get(key);
        if (l !== undefined && e.seq < l)
          return;
        if (l === e.seq)
          liveSeen.set(key, (liveSeen.get(key) ?? 0) + 1);
        else {
          liveMax.set(key, e.seq);
          liveSeen.set(key, 1);
        }
        if (!historyComplete)
          bump(applied, key, e.seq);
      }
    }
    handler(e);
  }
  if (deps.stream) {
    unsubscribe = deps.stream.subscribe(sessionId, (e) => {
      if (buffering)
        buffer.push(e);
      else
        deliver(e, "live");
    });
  }
  const urlFor = deps.replayUrl ?? ((id, from) => `/api/replay?sessionId=${encodeURIComponent(id)}` + (from ? `&from=${encodeURIComponent(from)}` : ""));
  function open(from) {
    buffering = true;
    inFlight = true;
    sawEnd = false;
    progressed = false;
    frontier.clear();
    readSeen.clear();
    lastFrameAt = now();
    const src = new deps.EventSourceImpl(urlFor(sessionId, from));
    es = src;
    for (const type of EVENT_TYPES) {
      src.addEventListener(type, (raw) => {
        if (es !== src)
          return;
        lastFrameAt = now();
        let e;
        try {
          e = JSON.parse(raw.data);
        } catch {
          return;
        }
        deliver(e, "replay");
      });
    }
    src.addEventListener("replay-end", () => {
      if (es !== src)
        return;
      sawEnd = true;
      for (const [key, seq] of frontier)
        covered.set(key, Math.max(covered.get(key) ?? -1, seq));
      applied.clear();
      finish();
    });
    src.addEventListener("error", () => {
      if (es !== src)
        return;
      finish();
    });
  }
  function watchSilence() {
    if (stopped || !inFlight)
      return;
    if (now() - lastFrameAt < staleMs)
      return;
    finish();
  }
  function finish() {
    if (!inFlight)
      return;
    inFlight = false;
    es?.close();
    es = null;
    if (sawEnd)
      historyComplete = true;
    if (!stopped && resyncPending) {
      resyncPending = false;
      askedFromOutside();
      if (sawEnd)
        handOff();
      doResync();
      return;
    }
    if (!sawEnd && !stopped) {
      staleReopens = progressed ? 0 : staleReopens + 1;
      if (staleReopens < MAX_STALE_REOPENS) {
        scheduleRetry();
        return;
      }
    }
    handOff();
    if (stopped)
      return;
    nextRetryMs = baseRetryMs;
  }
  function handOff() {
    buffering = false;
    for (const e of buffer)
      deliver(e, "live");
    buffer.length = 0;
    if (!handedOff) {
      handedOff = true;
      deps.onLive?.();
    }
  }
  function askedFromOutside() {
    nextRetryMs = baseRetryMs;
    staleReopens = 0;
  }
  function scheduleRetry() {
    if (stopped || retryTimer !== null)
      return;
    const wait = nextRetryMs;
    nextRetryMs = Math.min(nextRetryMs * 2, MAX_RETRY_MS);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (stopped || inFlight)
        return;
      if (deps.stillExists && !deps.stillExists()) {
        handOff();
        return;
      }
      doResync();
    }, wait);
    retryTimer.unref?.();
  }
  function doResync() {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    floor = new Map;
    const pairs = [];
    for (const key of new Set([...covered.keys(), ...liveMax.keys(), ...applied.keys()])) {
      const w = whole(key);
      if (w === undefined)
        continue;
      floor.set(key, w);
      const l = liveMax.get(key);
      if (historyComplete && l !== undefined && l > w)
        holdApplied(key, l, liveSeen.get(key) ?? 0);
      if (w >= 0)
        pairs.push(`${key}:${w}`);
    }
    open(pairs.join(",") || undefined);
  }
  open();
  const watchdog = setInterval(watchSilence, checkMs);
  watchdog.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(watchdog);
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (inFlight)
        finish();
      else
        handOff();
      if (unsubscribe)
        unsubscribe();
    },
    resync() {
      if (stopped)
        return;
      askedFromOutside();
      if (inFlight) {
        resyncPending = true;
        return;
      }
      doResync();
    }
  };
}

// apps/server/src/client/search-view.ts
var SORTS = [
  { key: "density", label: "density", cmp: (a, b) => density(b) - density(a) || b.lastActivity - a.lastActivity },
  { key: "hits", label: "occurrences", cmp: (a, b) => b.hits - a.hits || b.lastActivity - a.lastActivity },
  { key: "recent", label: "recent", cmp: (a, b) => b.lastActivity - a.lastActivity }
];
function density(r) {
  return r.chars > 0 ? 1000 * r.hits / r.chars : 0;
}
function el4(tag, className, text) {
  const n = document.createElement(tag);
  if (className)
    n.className = className;
  if (text != null)
    n.textContent = text;
  return n;
}
function ago2(ms, now) {
  const days = Math.floor((now - ms) / 86400000);
  if (days <= 0)
    return "today";
  if (days === 1)
    return "yesterday";
  if (days < 30)
    return days + "d ago";
  return new Date(ms).toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}
function kchars(n) {
  return n >= 1000 ? Math.round(n / 1000) + "k" : String(n);
}
function ageValue(ms, now) {
  const days = Math.floor((now - ms) / 86400000);
  if (days <= 0)
    return "today";
  if (days < 30)
    return days + "d";
  return new Date(ms).toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}
var SCORE = {
  density: (r) => ({ value: density(r).toFixed(1), unit: "per 1k" }),
  hits: (r) => ({ value: String(r.hits), unit: "times" }),
  recent: (r, now) => ({ value: ageValue(r.lastActivity, now), unit: "last run" })
};
function appendHighlighted(into, text, terms) {
  const low = text.toLowerCase();
  const ranges = [];
  for (const t of terms) {
    for (let at = low.indexOf(t);at >= 0; at = low.indexOf(t, at + t.length))
      ranges.push([at, at + t.length]);
  }
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let cur = 0;
  for (const [from, to] of ranges) {
    if (from < cur)
      continue;
    if (from > cur)
      into.append(document.createTextNode(text.slice(cur, from)));
    into.append(el4("mark", undefined, text.slice(from, to)));
    cur = to;
  }
  into.append(document.createTextNode(text.slice(cur)));
}
function labelOf2(r) {
  if (r.subject && r.subject.trim())
    return r.subject.replace(/\s+/g, " ").trim();
  if (isAutomated(r))
    return "Automated run · " + r.entrypoint;
  return "Session " + r.sessionId.slice(0, 8);
}
function createSearchView(host, deps) {
  const now = deps.now ?? Date.now;
  let query = "";
  let terms = [];
  let data = null;
  let sort = "density";
  let showAutomated = false;
  let pending = false;
  let failed = false;
  let timer = null;
  let seq = 0;
  const input = document.createElement("input");
  input.type = "search";
  input.className = "sr-input";
  input.placeholder = "words you remember…";
  input.setAttribute("aria-label", "Search sessions");
  function row(r) {
    const n = el4("div", "sr-row");
    n.tabIndex = 0;
    n.setAttribute("role", "button");
    n.onclick = () => deps.onOpenSession(r.sessionId);
    n.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        deps.onOpenSession(r.sessionId);
      }
    };
    const score = el4("div", "sr-score");
    const shown = SCORE[sort](r, now());
    score.append(el4("b", undefined, shown.value), el4("span", undefined, shown.unit));
    score.title = `${r.hits} occurrence${r.hits === 1 ? "" : "s"} in ${kchars(r.chars)} characters of dialogue`;
    n.append(score);
    const body = el4("div", "sr-body");
    const label = labelOf2(r);
    const subj = el4("div", "sr-subj" + (r.subject ? "" : " sr-unnamed"), label);
    subj.title = label;
    body.append(subj);
    const meta = el4("div", "sr-meta");
    meta.append(el4("span", "sr-proj", r.project));
    meta.append(el4("span", "sr-sep", "·"), el4("span", undefined, ago2(r.lastActivity, now())));
    meta.append(el4("span", "sr-sep", "·"), el4("span", undefined, `${r.hits}× · ${kchars(r.chars)}`));
    if (isAutomated(r))
      meta.append(el4("span", "sr-sep", "·"), el4("span", "sr-badge sr-auto", "automated"));
    meta.append(el4("span", "sr-sep", "·"), createIdChip(r.sessionId, { className: "sr-uid", full: true }));
    body.append(meta);
    for (const s of r.snippets)
      body.append(snippet(s));
    n.append(body);
    const acts = el4("div", "sr-acts");
    const open = el4("button", "sr-open", "Open in tab");
    open.onclick = (e) => {
      e.stopPropagation();
      deps.onOpenSession(r.sessionId);
    };
    acts.append(open);
    n.append(acts);
    return n;
  }
  function snippet(s) {
    const n = el4("div", "sr-snip");
    n.append(el4("span", "sr-who sr-" + s.who, s.who === "you" ? "you" : "claude"));
    appendHighlighted(n, s.text, terms);
    return n;
  }
  function segmented() {
    const box = el4("div", "rt-seg");
    for (const s of SORTS) {
      const b = el4("button", s.key === sort ? "on" : "", s.label);
      b.onclick = () => {
        sort = s.key;
        render();
      };
      box.append(b);
    }
    return box;
  }
  function results() {
    const list = el4("div", "sr-list");
    if (failed) {
      list.append(el4("div", "rt-empty", "The search could not run — seedeep could not reach its own server."));
      return list;
    }
    if (!terms.length) {
      list.append(el4("div", "rt-empty", "Type two or three words you remember from the session."));
      return list;
    }
    if (!data) {
      list.append(el4("div", "rt-empty", "Searching…"));
      return list;
    }
    const human = data.rows.filter((r) => !isAutomated(r));
    const automated = data.rows.filter((r) => isAutomated(r));
    if (!human.length && !automated.length) {
      list.append(el4("div", "rt-empty", "No session contains all of these words."));
      return list;
    }
    const cmp = SORTS.find((s) => s.key === sort).cmp;
    for (const r of [...human].sort(cmp))
      list.append(row(r));
    if (!human.length)
      list.append(el4("div", "rt-empty", "No session of your own — only automated runs."));
    if (automated.length) {
      if (!showAutomated) {
        const more = el4("button", "sr-more", `+ ${automated.length} automated run${automated.length === 1 ? "" : "s"} (docs gate, scripts) contain the same words — show`);
        more.onclick = () => {
          showAutomated = true;
          render();
        };
        list.append(more);
      } else {
        list.append(el4("div", "sr-autohead", "automated runs"));
        for (const r of [...automated].sort(cmp))
          list.append(row(r));
      }
    }
    return list;
  }
  function render() {
    const root = el4("div", "sr-root rt-root");
    const head = el4("div", "rt-head");
    const left = el4("div");
    left.append(el4("div", "rt-kick", "search sessions"));
    const title = el4("h1", "rt-title");
    title.append(document.createTextNode("Find the session that "), el4("b", undefined, "solved it"));
    left.append(title);
    left.append(el4("div", "rt-scope", "every word narrows · your prompts and Claude’s answers · automated runs kept aside"));
    head.append(left);
    const filter = el4("div", "rt-filter");
    filter.append(el4("span", "rt-seglbl", "order by"), segmented());
    head.append(filter);
    root.append(head);
    const form = el4("div", "sr-form");
    form.append(el4("span", "sr-icon", "⌕"), input);
    if (terms.length) {
      const chips = el4("div", "sr-terms");
      for (const t of terms)
        chips.append(el4("span", "sr-term", t));
      form.append(chips);
      const clear = el4("button", "sr-clear", "×");
      clear.setAttribute("aria-label", "Clear the search");
      clear.onclick = () => {
        input.value = "";
        run("");
      };
      form.append(clear);
    }
    root.append(form);
    const hint = el4("div", "sr-hint");
    if (pending) {
      hint.append(el4("b", undefined, "searching…"));
    } else if (data && terms.length) {
      const human = data.rows.filter((r) => !isAutomated(r)).length;
      hint.append(el4("b", undefined, `${human} of your sessions`));
      hint.append(document.createTextNode(` · ${data.rows.length - human} automated · ${SORTS.find((s) => s.key === sort).label} · ${data.ms} ms`));
    } else {
      hint.append(el4("b", undefined, "every word is an AND"));
      hint.append(document.createTextNode(pending ? " · searching…" : " · nothing is hidden, automated runs are just kept aside"));
    }
    root.append(hint);
    root.append(results());
    host.replaceChildren(root);
    if (document.activeElement !== input) {
      const end = input.value.length;
      input.focus?.();
      input.setSelectionRange?.(end, end);
    }
  }
  async function run(q) {
    query = q;
    showAutomated = false;
    const mine = ++seq;
    if (!q.trim()) {
      terms = [];
      data = null;
      pending = false;
      failed = false;
      render();
      return;
    }
    pending = true;
    failed = false;
    render();
    const res = await deps.search(q);
    if (mine !== seq)
      return;
    pending = false;
    failed = res === null;
    data = res;
    terms = res?.terms ?? [];
    render();
  }
  input.oninput = () => {
    if (timer !== null)
      clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      run(input.value);
    }, 180);
  };
  input.onkeydown = (e) => {
    if (e.key !== "Enter")
      return;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    run(input.value);
  };
  render();
  return {
    focus() {
      input.focus?.();
      const end = query.length;
      input.setSelectionRange?.(end, end);
    }
  };
}

// apps/server/src/core/cert-name.ts
var LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
function isValidCertName(name) {
  if (!name || name.length > 253)
    return false;
  return name.split(".").every((label) => LABEL.test(label));
}

// apps/server/src/client/settings.ts
var LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
function isLoopback(h) {
  return !h.trim() || LOOPBACK.has(h.trim());
}
function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function resolveFormState(host, cn) {
  const remote = !isLoopback(host);
  const trimmed = cn.trim();
  let cnError = "";
  if (remote && !trimmed)
    cnError = "Required to enable remote access";
  else if (trimmed && !isValidCertName(trimmed)) {
    cnError = "A hostname or IPv4 address: letters, digits, hyphens and dots only";
  }
  return { remote, canSave: !cnError, cnError };
}
function buildSaveBody(port, host, open, cn, pendingToken, webhook, tray) {
  const body = port === null ? { host, open } : { port, host, open };
  if (cn.trim())
    body["tls"] = { commonName: cn.trim() };
  if (pendingToken)
    body["auth"] = { token: pendingToken };
  if (webhook) {
    const { headersText, ...rest } = webhook;
    body["notifications"] = { webhook: { ...rest, headers: parseHeaders(headersText) } };
  }
  if (tray) {
    const n = body["notifications"] ?? {};
    body["notifications"] = { ...n, tray };
  }
  return body;
}
function usablePort(value) {
  const n = Number(value.trim());
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}
function parseHeaders(text) {
  const out = {};
  for (const line of text.split(`
`)) {
    const at = line.indexOf(":");
    if (at <= 0)
      continue;
    const name = line.slice(0, at).trim();
    if (name)
      out[name] = line.slice(at + 1).trim();
  }
  return out;
}
function formatHeaders(headers) {
  return Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join(`
`);
}
var SLIDERS_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
  <line x1="2" y1="4" x2="14" y2="4"/>
  <circle cx="5.5" cy="4" r="1.8" fill="currentColor" stroke="none"/>
  <line x1="2" y1="8" x2="14" y2="8"/>
  <circle cx="10.5" cy="8" r="1.8" fill="currentColor" stroke="none"/>
  <line x1="2" y1="12" x2="14" y2="12"/>
  <circle cx="7" cy="12" r="1.8" fill="currentColor" stroke="none"/>
</svg>`;
var WARN_SVG = `<svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
  <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 3a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 018 4zm0 8a1 1 0 110-2 1 1 0 010 2z"/>
</svg>`;
var RESTART_SVG = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
  <path d="M8 3a5 5 0 104.546 2.914.5.5 0 01.908-.417A6 6 0 118 2v1z"/>
  <path d="M8 4.466V.534a.25.25 0 01.41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 018 4.466z"/>
</svg>`;
function createSettingsPanel(headerEl) {
  let pendingToken = "";
  let savedState = null;
  const btn = document.createElement("button");
  btn.className = "settings-btn";
  btn.title = "Settings";
  btn.setAttribute("aria-label", "Open settings");
  btn.innerHTML = SLIDERS_SVG;
  headerEl.append(btn);
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  document.body.append(scrim);
  const drawer = document.createElement("div");
  drawer.className = "drawer";
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-label", "Settings");
  drawer.innerHTML = `
<button class="close" aria-label="Close settings">×</button>
<div class="dhead">
  <div class="deyebrow"><span class="dchip">config</span></div>
  <h3>Settings</h3>
</div>
<div class="sbanner spending" id="s-pending" style="display:none">
  ${RESTART_SVG}
  <div>
    <strong>Running an older configuration</strong>
    This server is still using the port, host, certificate name and token it
    started with — <code>config.json</code> has changed since. Restart to serve it.
  </div>
</div>
<div class="sbanner spending" id="s-save-pending" style="display:none">
  ${WARN_SVG}
  <div>
    <strong>Changes waiting to be applied</strong>
    <code>config.json</code> carries notification settings this server has not
    taken up. These need no restart — saving applies them.
    <button id="s-apply-now" class="xbtn s-apply-btn">Apply now</button>
  </div>
</div>
<div class="sbanner" id="s-banner" style="display:none">
  ${WARN_SVG}
  <div>
    <strong>Remote access enabled</strong>
    HTTPS and token authentication are required. Your browser will show a
    certificate warning on first visit — add a one-time exception.
  </div>
</div>
<div class="block" style="margin-top:.85rem">
  <div class="blabel">Network</div>
  <div class="srow">
    <div class="slabel">Port<small>Requires restart</small></div>
    <div>
      <input id="s-port" class="sinput" type="number" min="1" max="65535">
      <div id="s-ov-port" class="sinput-note" style="display:none"></div>
    </div>
  </div>
  <div class="srow">
    <div class="slabel">Host<small>Requires restart</small></div>
    <div>
      <input id="s-host" class="sinput" type="text" placeholder="127.0.0.1">
      <div id="s-ov-host" class="sinput-note" style="display:none"></div>
    </div>
  </div>
  <div class="srow">
    <div class="slabel">Open browser on start</div>
    <div>
      <div class="stoggle-wrap">
        <div id="s-open-track" class="stoggle-track"><div class="stoggle-thumb"></div></div>
        <span id="s-open-label" class="stoggle-label">Yes</span>
      </div>
      <div id="s-ov-open" class="sinput-note" style="display:none"></div>
    </div>
  </div>
</div>
<div class="block">
  <div class="blabel">Security</div>
  <div class="srow">
    <div class="slabel">Auth token<small>Active in remote mode</small></div>
    <div>
      <div class="stoken-wrap">
        <input id="s-token" class="sinput" type="password" readonly autocomplete="off" value="***">
        <button id="s-regen" class="xbtn">Regen</button>
      </div>
      <div id="s-token-note" class="sinput-note" style="display:none">Saving this locks out every other
        browser and client still holding the old token.</div>
    </div>
  </div>
  <div class="srow">
    <div class="slabel">Access URL<small>Open in browser</small></div>
    <div class="stoken-wrap">
      <input id="s-url" class="sinput" type="text" readonly>
      <button id="s-copy-url" class="xbtn">Copy</button>
    </div>
  </div>
</div>
<div class="block" id="s-tls" style="display:none">
  <div class="blabel">TLS Certificate</div>
  <div class="srow">
    <div class="slabel">Common name<small>Required for remote access</small></div>
    <div>
      <input id="s-cn" class="sinput sinput-warn" type="text" placeholder="e.g. MacBook-Pro.local">
      <div id="s-cn-err" class="sinput-err" style="display:none">Required to enable remote access</div>
      <div id="s-cn-note" class="sinput-note" style="display:none">Saving this replaces the certificate
        on the next start: the fingerprint below changes and any pinned client must be re-pinned.</div>
      <div id="s-ov-tls.commonName" class="sinput-note" style="display:none"></div>
    </div>
  </div>
  <div class="srow">
    <div class="slabel">Fingerprint<small>SHA-256 — pin it on a client</small></div>
    <div class="stoken-wrap">
      <input id="s-fp" class="sinput" type="text" readonly
             placeholder="Available after restarting in remote mode">
      <button id="s-copy-fp" class="xbtn">Copy</button>
    </div>
  </div>
</div>
<div class="block">
  <div class="blabel">Notifications</div>
  <div class="srow">
    <div class="slabel">Tray notifies you when<small>The menu-bar app on this machine. Its icon is never silenced by these — it costs nothing to ignore.</small></div>
    <div class="shooks">
      <div class="shook-row"><div id="s-tray-needsYou" class="stoggle-track"><div class="stoggle-thumb"></div></div><span>A session needs you</span></div>
      <div class="shook-row"><div id="s-tray-fails" class="stoggle-track"><div class="stoggle-thumb"></div></div><span>A session fails</span></div>
      <div class="shook-row"><div id="s-tray-finishes" class="stoggle-track"><div class="stoggle-thumb"></div></div><span>A session finishes a turn</span></div>
      <div class="shook-row"><div id="s-tray-updates" class="stoggle-track"><div class="stoggle-thumb"></div></div><span>A new server version is out</span></div>
    </div>
  </div>
  <div class="srow">
    <div class="slabel">Where notifications go<small>The tray shows them on this machine. Nothing else is sent anywhere unless you add an endpoint below.</small></div>
    <button id="s-hook-custom" class="sdisclose" aria-expanded="false">Send to a webhook…</button>
  </div>
  <div class="srow scustom" hidden>
    <div class="slabel">Webhook URL<small>Where the POST goes. Any service that accepts one — leaving it empty keeps the webhook off.</small></div>
    <input id="s-hook-url" class="sinput" type="text" placeholder="https://example.com/hook">
  </div>
  <div class="srow scustom" hidden>
    <div class="slabel">Send when<small>Its own set: the same event can be worth a banner on the tray and not worth sending here.</small></div>
    <div class="shooks">
      <div class="shook-row"><div id="s-hook-needsYou" class="stoggle-track"><div class="stoggle-thumb"></div></div><span>A session needs you</span></div>
      <div class="shook-row"><div id="s-hook-fails" class="stoggle-track"><div class="stoggle-thumb"></div></div><span>A session fails</span></div>
      <div class="shook-row"><div id="s-hook-finishes" class="stoggle-track"><div class="stoggle-thumb"></div></div><span>A session finishes a turn</span></div>
    </div>
  </div>
  <div class="srow scustom" hidden>
    <div class="slabel">Headers<small>Sent with every POST, one <code>Name: value</code> per line. This is where a service's auth token goes.</small></div>
    <textarea id="s-hook-headers" class="sinput" rows="2" placeholder="Authorization: Bearer …"></textarea>
  </div>
  <div class="srow scustom" hidden>
    <div class="slabel">Body template<small>What gets posted. Use {{title}}, {{body}}, {{project}}, {{subject}}, {{kind}}. Empty posts the body alone.</small></div>
    <textarea id="s-hook-template" class="sinput" rows="2" placeholder="{{title}}"></textarea>
  </div>
</div>
<div class="block">
  <div class="blabel">About</div>
  <div class="srow">
    <div class="slabel">Version<small>The server answering</small></div>
    <div id="s-version" class="sversion">—</div>
  </div>
  <div class="srow" id="s-update-row" style="display:none">
    <div class="slabel">Update<small>npm, checked once an hour</small></div>
    <div id="s-update" class="sversion supdate"></div>
  </div>
</div>
<div class="settings-save">
  <span id="s-restart" class="srestart-hint" style="display:none">${RESTART_SVG}Restart required</span>
  <span id="s-msg" class="smsg" style="display:none"></span>
  <button id="s-restart-now" class="xbtn s-restart-btn" style="display:none">Restart now</button>
</div>`;
  document.body.append(drawer);
  const qd = (sel) => drawer.querySelector(sel);
  const dclose = qd(".close");
  const banner = qd("#s-banner");
  const pendingBanner = qd("#s-pending");
  const savePendingBanner = qd("#s-save-pending");
  const applyNowBtn = qd("#s-apply-now");
  const portEl = qd("#s-port");
  const hostEl = qd("#s-host");
  const openTrack = qd("#s-open-track");
  const openLabel = qd("#s-open-label");
  const tokenEl = qd("#s-token");
  const regenBtn = qd("#s-regen");
  const urlEl = qd("#s-url");
  const copyUrlBtn = qd("#s-copy-url");
  const tlsSection = qd("#s-tls");
  const tokenNote = qd("#s-token-note");
  const cnEl = qd("#s-cn");
  const cnErr = qd("#s-cn-err");
  const cnNote = qd("#s-cn-note");
  const fpEl = qd("#s-fp");
  const versionEl = qd("#s-version");
  const updateRow = qd("#s-update-row");
  const updateEl = qd("#s-update");
  const copyFpBtn = qd("#s-copy-fp");
  const restartEl = qd("#s-restart");
  const msgEl = qd("#s-msg");
  const restartNowBtn = qd("#s-restart-now");
  function setOpen(on) {
    openTrack.classList.toggle("on", on);
    openLabel.textContent = on ? "Yes" : "No";
  }
  async function showUpdate() {
    try {
      const s = await authFetch("/api/update").then((r) => r.json());
      const behind = s.standing === "behind" && !!s.latest;
      updateRow.style.display = behind ? "" : "none";
      if (behind) {
        updateEl.textContent = s.command ? `${s.latest} available — run \`${s.command}\`, then \`seedeep restart\`` : `${s.latest} available — replace this executable, then \`seedeep restart\``;
      }
    } catch {
      updateRow.style.display = "none";
    }
  }
  function setRestartPending(on) {
    pendingBanner.style.display = on ? "" : "none";
    restartNowBtn.style.display = on ? "" : "none";
    markPending();
  }
  function setSavePending(on) {
    savePendingBanner.style.display = on ? "" : "none";
    markPending();
  }
  function markPending() {
    const on = pendingBanner.style.display !== "none" || savePendingBanner.style.display !== "none";
    btn.classList.toggle("pending", on);
    btn.title = on ? "Settings — config.json is not fully applied" : "Settings";
  }
  function setOverrides(overrides) {
    const ENV_OF = {
      port: "SEEDEEP_PORT",
      host: "SEEDEEP_HOST",
      open: "SEEDEEP_OPEN",
      "tls.commonName": "SEEDEEP_TLS_CN"
    };
    for (const field of Object.keys(ENV_OF)) {
      const el5 = drawer.querySelector(`#s-ov-${CSS.escape(field)}`);
      if (!el5)
        continue;
      const source = overrides?.[field];
      el5.textContent = source ? source === "flag" ? "A command-line flag overrides this while this server runs — saving it takes effect on a start without that flag." : `${ENV_OF[field]} overrides this while this server runs — saving it takes effect on a start without that variable.` : "";
      el5.style.display = source ? "" : "none";
    }
  }
  function showMsg(text, isErr = false, durationMs = 3000) {
    msgEl.textContent = text;
    msgEl.className = isErr ? "smsg err" : "smsg";
    msgEl.style.display = "";
    restartEl.style.display = "none";
    setTimeout(() => {
      msgEl.style.display = "none";
      updateRemote();
    }, durationMs);
  }
  function computeAccessUrl() {
    const host = hostEl.value.trim() || "127.0.0.1";
    const port = portEl.value.trim() || "44842";
    const cn = cnEl.value.trim();
    const remote = !isLoopback(host);
    const proto = remote ? "https" : "http";
    const displayHost = remote ? cn || host : "localhost";
    const base = `${proto}://${displayHost}:${port}`;
    if (!remote)
      return base;
    const token = pendingToken || getToken();
    return token ? `${base}/?token=${encodeURIComponent(token)}` : base;
  }
  function updateRemote() {
    const { remote, cnError } = resolveFormState(hostEl.value, cnEl.value);
    banner.style.display = remote ? "" : "none";
    tlsSection.style.display = remote || cnError ? "" : "none";
    const portChanged = portEl.value !== (savedState?.port ?? "");
    const hostChanged = hostEl.value.trim() !== (savedState?.host ?? "");
    restartEl.style.display = portChanged || hostChanged ? "" : "none";
    if (cnError)
      cnErr.textContent = cnError;
    cnErr.style.display = cnError ? "" : "none";
    const replacing = remote && !!savedState?.cn && !cnError && cnEl.value.trim() !== savedState.cn;
    cnNote.style.display = replacing ? "" : "none";
    urlEl.value = computeAccessUrl();
  }
  const hookUrlEl = drawer.querySelector("#s-hook-url");
  const hookHeadersEl = drawer.querySelector("#s-hook-headers");
  const hookTemplateEl = drawer.querySelector("#s-hook-template");
  const traySwitches = {
    needsYou: drawer.querySelector("#s-tray-needsYou"),
    fails: drawer.querySelector("#s-tray-fails"),
    finishes: drawer.querySelector("#s-tray-finishes"),
    updates: drawer.querySelector("#s-tray-updates")
  };
  const hookSwitches = {
    needsYou: drawer.querySelector("#s-hook-needsYou"),
    fails: drawer.querySelector("#s-hook-fails"),
    finishes: drawer.querySelector("#s-hook-finishes")
  };
  for (const track of [...Object.values(traySwitches), ...Object.values(hookSwitches)]) {
    track.parentElement?.addEventListener("click", () => {
      track.classList.toggle("on");
      persist();
    });
  }
  const customBtn = drawer.querySelector("#s-hook-custom");
  const customRows = [...drawer.querySelectorAll(".scustom")];
  customBtn.addEventListener("click", () => {
    const open2 = customBtn.getAttribute("aria-expanded") === "true";
    customBtn.setAttribute("aria-expanded", String(!open2));
    customBtn.textContent = open2 ? "Send to a webhook…" : "Hide webhook settings";
    for (const row of customRows)
      row.hidden = open2;
  });
  const trayForm = () => ({
    needsYou: traySwitches.needsYou.classList.contains("on"),
    fails: traySwitches.fails.classList.contains("on"),
    finishes: traySwitches.finishes.classList.contains("on"),
    updates: traySwitches.updates.classList.contains("on")
  });
  const webhookForm = () => ({
    url: hookUrlEl.value.trim(),
    headersText: hookHeadersEl.value,
    template: hookTemplateEl.value,
    needsYou: hookSwitches.needsYou.classList.contains("on"),
    fails: hookSwitches.fails.classList.contains("on"),
    finishes: hookSwitches.finishes.classList.contains("on")
  });
  async function load() {
    try {
      const cfg = await authFetch("/api/config").then((r) => r.json());
      savedState = {
        port: String(cfg.port ?? 44842),
        host: cfg.host ?? "127.0.0.1",
        open: cfg.open ?? true,
        cn: cfg.tls?.commonName ?? ""
      };
      portEl.value = savedState.port;
      hostEl.value = savedState.host;
      setOpen(savedState.open);
      cnEl.value = savedState.cn;
      fpEl.value = cfg.tls?.fingerprint ?? "";
      const tray = cfg.notifications?.tray;
      traySwitches.needsYou.classList.toggle("on", tray?.needsYou ?? true);
      traySwitches.fails.classList.toggle("on", tray?.fails ?? true);
      traySwitches.finishes.classList.toggle("on", tray?.finishes ?? false);
      traySwitches.updates.classList.toggle("on", tray?.updates ?? true);
      const hook = cfg.notifications?.webhook;
      hookUrlEl.value = hook?.url ?? "";
      hookHeadersEl.value = formatHeaders(hook?.headers ?? {});
      hookTemplateEl.value = hook?.template ?? "";
      hookSwitches.needsYou.classList.toggle("on", hook?.needsYou ?? true);
      hookSwitches.fails.classList.toggle("on", hook?.fails ?? true);
      hookSwitches.finishes.classList.toggle("on", hook?.finishes ?? false);
      versionEl.textContent = cfg.version ?? "—";
      showUpdate();
      pendingToken = "";
      tokenEl.value = "***";
      tokenEl.type = "password";
      tokenNote.style.display = "none";
      setRestartPending(cfg.restart_pending ?? false);
      setSavePending(cfg.save_pending ?? false);
      setOverrides(cfg.overrides);
      updateRemote();
    } catch {
      showMsg("Could not load config", true);
    }
  }
  function open() {
    btn.classList.add("active");
    scrim.classList.add("on");
    drawer.classList.add("on");
    load();
  }
  function close() {
    btn.classList.remove("active");
    scrim.classList.remove("on");
    drawer.classList.remove("on");
  }
  async function refreshPending() {
    try {
      const cfg = await authFetch("/api/config").then((r) => r.json());
      setRestartPending(cfg.restart_pending ?? false);
      setSavePending(cfg.save_pending ?? false);
    } catch {}
  }
  refreshPending();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden)
      refreshPending();
  });
  btn.addEventListener("click", () => drawer.classList.contains("on") ? close() : open());
  scrim.addEventListener("click", close);
  dclose.addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && drawer.classList.contains("on"))
      close();
  });
  portEl.addEventListener("input", () => updateRemote());
  hostEl.addEventListener("input", () => updateRemote());
  cnEl.addEventListener("input", () => updateRemote());
  openTrack.addEventListener("click", () => {
    openTrack.classList.toggle("on");
    openLabel.textContent = openTrack.classList.contains("on") ? "Yes" : "No";
    persist();
  });
  regenBtn.addEventListener("click", () => {
    pendingToken = randomToken();
    tokenEl.value = pendingToken;
    tokenEl.type = "text";
    tokenNote.style.display = "";
    urlEl.value = computeAccessUrl();
    persist();
  });
  function wireCopy(btn2, input) {
    btn2.addEventListener("click", () => {
      if (!input.value)
        return;
      navigator.clipboard?.writeText(input.value).catch(() => {});
      btn2.textContent = "Copied!";
      setTimeout(() => {
        btn2.textContent = "Copy";
      }, 1800);
    });
  }
  wireCopy(copyUrlBtn, urlEl);
  wireCopy(copyFpBtn, fpEl);
  for (const field of [portEl, hostEl, cnEl, hookUrlEl, hookHeadersEl, hookTemplateEl]) {
    field.addEventListener("change", () => void persist());
  }
  async function persist() {
    const host = hostEl.value.trim();
    if (!resolveFormState(host, cnEl.value).canSave) {
      updateRemote();
      cnEl.focus();
      return;
    }
    const body = buildSaveBody(usablePort(portEl.value), host, openTrack.classList.contains("on"), cnEl.value, pendingToken, webhookForm(), trayForm());
    try {
      const res = await authFetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const r = await res.json();
      if (!res.ok) {
        showMsg(r.error ?? "Save failed", true, 6000);
        return;
      }
      savedState = {
        port: String(r.port ?? body["port"]),
        host: r.host ?? host,
        open: r.open ?? openTrack.classList.contains("on"),
        cn: r.tls?.commonName ?? cnEl.value.trim()
      };
      if (pendingToken)
        setToken(pendingToken);
      pendingToken = "";
      tokenEl.value = "***";
      tokenEl.type = "password";
      tokenNote.style.display = "none";
      updateRemote();
      const pending = r.restart_pending ?? false;
      setRestartPending(pending);
      setSavePending(r.save_pending ?? false);
      setOverrides(r.overrides);
      showMsg(pending ? "Saved — restart to apply" : "Saved");
    } catch {
      showMsg("Save failed", true);
    }
  }
  applyNowBtn.addEventListener("click", async () => {
    await load();
    await persist();
  });
  restartNowBtn.addEventListener("click", async () => {
    restartNowBtn.disabled = true;
    restartNowBtn.textContent = "Restarting…";
    try {
      await authFetch("/api/restart", { method: "POST" });
    } catch {}
    setRestartPending(false);
    restartEl.style.display = "none";
    msgEl.textContent = "Restarting…";
    msgEl.className = "smsg";
    msgEl.style.display = "";
    const deadline = Date.now() + 1e4;
    const poll = async () => {
      try {
        const r = await authFetch("/api/config");
        if (r.ok) {
          window.location.reload();
          return;
        }
      } catch {}
      if (Date.now() < deadline)
        setTimeout(poll, 400);
      else {
        msgEl.textContent = "Server did not come back — check the terminal";
        msgEl.className = "smsg err";
      }
    };
    setTimeout(poll, 600);
  });
}

// apps/server/src/core/wire.ts
var HEARTBEAT_EVENT = "heartbeat";

// apps/server/src/client/stream.ts
var CLOSED = 2;
var RETRY_MS2 = 3000;
var STALE_MS = 45000;
function createStream(opts) {
  const url = opts.url ?? "/api/stream";
  const retryMs = opts.retryMs ?? RETRY_MS2;
  const staleMs = opts.staleMs ?? STALE_MS;
  const checkMs = opts.checkMs ?? Math.max(1, Math.round(staleMs / 3));
  const now = opts.now ?? (() => Date.now());
  const handlers = new Map;
  const statusListeners = new Set;
  const lastSeq = new Map;
  let es = null;
  let status = "init";
  let retryTimer = null;
  let stopped = false;
  let lastFrameAt = now();
  function onFrame(ev) {
    let e;
    try {
      e = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (e.seq >= 0) {
      const streamKey = e.sessionId + "\x00" + (e.agentId ?? "");
      const prev = lastSeq.get(streamKey);
      if (prev !== undefined && e.seq < prev)
        return;
      lastSeq.set(streamKey, e.seq);
    }
    const set = handlers.get(e.sessionId);
    if (set)
      for (const h of set)
        h(e);
  }
  function setStatus(next) {
    if (next === status)
      return;
    status = next;
    for (const cb of statusListeners)
      cb(next);
  }
  function connect() {
    if (stopped)
      return;
    const src = new opts.EventSourceImpl(url);
    es = src;
    const arrived = (ev) => {
      if (es !== src)
        return;
      lastFrameAt = now();
      onFrame(ev);
    };
    for (const type of EVENT_TYPES)
      src.addEventListener(type, arrived);
    src.addEventListener(HEARTBEAT_EVENT, () => {
      if (es !== src)
        return;
      lastFrameAt = now();
    });
    src.addEventListener("open", () => {
      if (es !== src)
        return;
      lastFrameAt = now();
      lastSeq.clear();
      setStatus("open");
    });
    src.addEventListener("error", () => {
      if (es !== src)
        return;
      setStatus("lost");
      if (src.readyState === CLOSED)
        scheduleReconnect();
    });
  }
  function scheduleReconnect() {
    if (stopped || retryTimer !== null)
      return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, retryMs);
  }
  function watchSilence() {
    if (stopped)
      return;
    if (now() - lastFrameAt < staleMs)
      return;
    setStatus("lost");
    lastFrameAt = now();
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    es?.close();
    es = null;
    connect();
  }
  const onVisible = () => {
    if (document.visibilityState === "visible")
      watchSilence();
  };
  const hasDocument = typeof document !== "undefined";
  if (hasDocument)
    document.addEventListener("visibilitychange", onVisible);
  connect();
  const watchdog = setInterval(watchSilence, checkMs);
  watchdog.unref?.();
  function subscribe(sessionId, handler) {
    let set = handlers.get(sessionId);
    if (!set) {
      set = new Set;
      handlers.set(sessionId, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0)
        handlers.delete(sessionId);
    };
  }
  function onStatus(cb) {
    statusListeners.add(cb);
    return () => statusListeners.delete(cb);
  }
  return {
    subscribe,
    onStatus,
    close: () => {
      stopped = true;
      clearInterval(watchdog);
      if (hasDocument)
        document.removeEventListener("visibilitychange", onVisible);
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      es?.close();
    }
  };
}

// apps/server/src/client/tab-bar.ts
function createTabBar(container, { onSwitch, onClose }) {
  const tabs = new Map;
  let activeId = null;
  function render() {
    for (const [id, t] of tabs)
      t.el.classList.toggle("active", id === activeId);
  }
  const titleFor = (label, ended2, waiting = null, failed = false) => label + (ended2 ? " — ended" : failed ? " — its last API call failed" : waiting === "permission" ? " — waiting for your approval" : waiting === "input" ? " — waiting for your answer" : "");
  return {
    add(sessionId, { label, ended: ended2, busy: isBusy }) {
      if (tabs.has(sessionId))
        return;
      const el5 = document.createElement("div");
      el5.className = "tab" + (ended2 ? " ended" : "");
      el5.title = titleFor(label, ended2);
      const busy = document.createElement("span");
      busy.className = "tab-busy" + (isBusy && !ended2 ? " on" : "");
      const name = document.createElement("span");
      name.textContent = label;
      const closeEl = document.createElement("button");
      closeEl.className = "tab-close";
      closeEl.textContent = "×";
      closeEl.onclick = (e) => {
        e.stopPropagation();
        onClose(sessionId);
      };
      el5.onclick = () => onSwitch(sessionId);
      el5.append(busy, name, closeEl);
      container.append(el5);
      tabs.set(sessionId, { el: el5, busy, name, label, waiting: null, failed: false });
      render();
    },
    setEnded(sessionId) {
      const t = tabs.get(sessionId);
      if (!t)
        return;
      t.waiting = null;
      t.failed = false;
      t.busy.classList.remove("wait", "err");
      t.el.classList.add("ended");
      t.el.title = titleFor(t.label, true);
      t.busy.classList.remove("on");
    },
    clearEnded(sessionId) {
      const t = tabs.get(sessionId);
      if (!t)
        return;
      t.el.classList.remove("ended");
      t.el.title = titleFor(t.label, false, t.waiting, t.failed);
    },
    setBusy(sessionId, busy) {
      const t = tabs.get(sessionId);
      if (t)
        t.busy.classList.toggle("on", busy);
    },
    setWaiting(sessionId, waiting) {
      const t = tabs.get(sessionId);
      if (!t || t.el.classList.contains("ended"))
        return;
      t.waiting = waiting;
      t.busy.classList.toggle("wait", waiting !== null);
      t.el.title = titleFor(t.label, false, waiting, t.failed);
    },
    setFailed(sessionId, failed) {
      const t = tabs.get(sessionId);
      if (!t || t.el.classList.contains("ended"))
        return;
      if (t.failed === failed)
        return;
      t.failed = failed;
      t.busy.classList.toggle("err", failed);
      t.el.title = titleFor(t.label, false, t.waiting, failed);
    },
    setLabel(sessionId, label) {
      const t = tabs.get(sessionId);
      if (!t || t.label === label)
        return;
      t.label = label;
      t.name.textContent = label;
      t.el.title = titleFor(label, t.el.classList.contains("ended"), t.waiting, t.failed);
    },
    setActive(sessionId) {
      activeId = sessionId;
      render();
    },
    remove(sessionId) {
      const t = tabs.get(sessionId);
      if (t) {
        t.el.remove();
        tabs.delete(sessionId);
      }
    }
  };
}

// apps/server/src/client/tab-store.ts
var KEY = "seedeep.tabs.v1";
var MAX_KNOWN = 500;
function createTabStore(storage) {
  return {
    load() {
      try {
        const raw = storage?.getItem(KEY);
        if (raw == null)
          return null;
        const v = JSON.parse(raw);
        if (!v || typeof v !== "object")
          return null;
        const { ids, activeId, known } = v;
        if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string"))
          return null;
        const knownOk = Array.isArray(known) && known.every((x) => typeof x === "string");
        return {
          ids,
          activeId: typeof activeId === "string" ? activeId : null,
          known: knownOk ? known : ids
        };
      } catch {
        return null;
      }
    },
    save(state) {
      try {
        storage?.setItem(KEY, JSON.stringify({
          ids: [...state.ids],
          activeId: state.activeId ?? null,
          known: state.known.slice(-MAX_KNOWN)
        }));
      } catch {}
    }
  };
}

// apps/server/src/core/activity-line.ts
var RUNNING_AFTER_MS = 1000;
var MAX_FAMILIES = 3;
var WORDS = {
  Read: { past: "read", one: "file", many: "files" },
  Bash: { past: "ran", one: "shell command", many: "shell commands" },
  Edit: { past: "edited", one: "file", many: "files" },
  Write: { past: "wrote", one: "file", many: "files" },
  NotebookEdit: { past: "edited", one: "notebook", many: "notebooks" },
  Glob: { past: "searched", one: "pattern", many: "patterns" },
  Grep: { past: "searched", one: "pattern", many: "patterns" },
  LS: { past: "listed", one: "directory", many: "directories" },
  WebFetch: { past: "fetched", one: "page", many: "pages" },
  WebSearch: { past: "searched", one: "query", many: "queries" },
  Agent: { past: "ran", one: "subagent", many: "subagents" },
  Workflow: { past: "ran", one: "workflow", many: "workflows" },
  Skill: { past: "used", one: "skill", many: "skills" },
  ToolSearch: { past: "loaded", one: "tool", many: "tools" },
  Artifact: { past: "published", one: "artifact", many: "artifacts" }
};
function activityBucket(name) {
  if (!name.startsWith("mcp__"))
    return name;
  const server = name.split("__")[1];
  return server ? "mcp:" + server : "mcp";
}
function phrase(bucket, n) {
  const w = WORDS[bucket];
  if (w)
    return `${w.past} ${n} ${n === 1 ? w.one : w.many}`;
  const label = bucket.startsWith("mcp:") ? bucket.slice(4) : bucket;
  return `${n} ${label} call${n === 1 ? "" : "s"}`;
}
function activityLine(counts) {
  const merged = new Map;
  for (const [name, n] of Object.entries(counts)) {
    const b = activityBucket(name);
    merged.set(b, (merged.get(b) ?? 0) + n);
  }
  const ranked = [...merged.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!ranked.length)
    return "";
  const shown = ranked.slice(0, MAX_FAMILIES);
  let s = shown.map(([b, n]) => phrase(b, n)).join(", ");
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return ranked.length > shown.length ? s + "…" : s;
}
var WORD_ARRIVES_LIVE_MS = 60000;
function nowLine(input, nowMs) {
  if (input.waiting !== null) {
    const what = input.waiting === "permission" ? "Waiting for your approval" : "Waiting for your answer";
    const tool = input.pendingTool;
    return {
      kind: "waiting",
      label: "waiting for you",
      text: tool ? `${what} — ${tool.name}${tool.arg ? " · " + tool.arg : ""}` : `${what} in the terminal`,
      ageFrom: input.waitingSince
    };
  }
  const full = input.result ?? input.narration?.text ?? null;
  const stamped = input.wordTs === null ? NaN : Date.parse(input.wordTs);
  const arrivedLive = input.wordSeenAt !== null && !Number.isNaN(stamped) && input.wordSeenAt - stamped < WORD_ARRIVES_LIVE_MS;
  const wordIsFresh = arrivedLive && nowMs - input.wordSeenAt < narrationHoldMs(full ?? "");
  if (input.activity && !wordIsFresh) {
    return {
      kind: "activity",
      label: "now",
      text: activityLine(input.activity.counts),
      ageFrom: input.live ? runningSince(input.activity.open, nowMs) : null
    };
  }
  if (full === null)
    return working(input);
  const showingResult = input.result !== null;
  return {
    kind: showingResult ? "output" : "intent",
    label: showingResult ? "output" : input.live ? "now" : "intent",
    text: full,
    ageFrom: input.live && !showingResult && input.narration ? tsOrNull(input.narration.ts) : null
  };
}
function working(input) {
  if (!input.live)
    return null;
  const r = input.returned;
  if (r && !input.delegated) {
    return {
      kind: "working",
      label: "now",
      text: `${r.label} returned — working on the result`,
      ageFrom: r.at
    };
  }
  const d = input.delegated;
  if (d) {
    return {
      kind: "working",
      label: "now",
      text: d.count > 1 ? `${d.count} agents running in the background` : `${d.label} is running in the background`,
      ageFrom: d.since
    };
  }
  return {
    kind: "working",
    label: "now",
    text: input.apiCalls > 0 ? "Answering — no tools used, nothing said yet" : "Started — no output yet",
    ageFrom: input.startedAt
  };
}
function tsOrNull(ts) {
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : t;
}
var READING_CHARS_PER_S = 17;
var VISIBLE_CHARS = 240;
var HOLD_MIN_MS = 3000;
function narrationHoldMs(text) {
  if (!text)
    return 0;
  const readable = Math.min(text.length, VISIBLE_CHARS);
  return Math.max(HOLD_MIN_MS, readable / READING_CHARS_PER_S * 1000);
}
function runningSince(open, nowMs) {
  let oldest = null;
  for (const c of open) {
    const t = Date.parse(c.startedTs);
    if (Number.isNaN(t) || nowMs - t < RUNNING_AFTER_MS)
      continue;
    if (oldest === null || t < oldest)
      oldest = t;
  }
  return oldest;
}
var BACKGROUND_SUMMARY_RE = /^(Background command\s+"[\s\S]*")\s+(\S[^\n]*)$/;
var ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };
var unescapeEntities = (s) => s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (m, k) => ENTITIES[k] ?? m);
function outcomeLine(summary) {
  const m = BACKGROUND_SUMMARY_RE.exec(summary.trim());
  return m ? `${unescapeEntities(m[2])} · ${unescapeEntities(m[1])}` : unescapeEntities(summary);
}

// apps/server/src/core/activity-list.ts
var ACTIVITY_TYPES = new Set(["api", "tool", "subspan", "spawn"]);
function agentName(label) {
  if (!label)
    return null;
  return label.replace(/\s*\(.*\)\s*$/, "") || label;
}
function flattenActivity(snap) {
  const rows = [];
  const push = (s, turnIdx) => {
    if (!ACTIVITY_TYPES.has(s.type))
      return;
    rows.push({
      id: s.id,
      type: s.type,
      name: s.label,
      detail: s.detail,
      t0: s.t0,
      ms: s.status === "running" || s.t1 <= s.t0 ? null : s.t1 - s.t0,
      status: s.status,
      agent: agentName(s.agent),
      lane: s.lane,
      handle: s.handle,
      turnIndex: turnIdx,
      ...s.flagged ? { flagged: true } : {}
    });
  };
  for (const turn of snap.turns) {
    for (const span of turn.spans)
      push(span, turn.index);
    for (const spawn of turn.spawns) {
      for (const lane of spawn.lanes) {
        for (const span of lane.spans)
          push(span, turn.index);
      }
    }
  }
  rows.sort((a, b) => a.t0 - b.t0 || (a.lane === 0 ? -1 : 0) - (b.lane === 0 ? -1 : 0));
  return rows;
}
function activityMatches(row, query) {
  const q = query.toLowerCase();
  return row.name.toLowerCase().includes(q) || (row.detail ?? "").toLowerCase().includes(q);
}

// apps/server/src/core/feed.ts
function tsMs(t) {
  const n = Date.parse(t ?? "");
  return Number.isFinite(n) ? n : null;
}
var DEFAULT_CAP = 10;
function createFeed(cap = DEFAULT_CAP) {
  const ring = [];
  const byId = new Map;
  const turnOf = (it) => it.turnIndex ?? null;
  return {
    push(item) {
      const ts = item.ts ?? 0;
      let i = ring.length;
      while (i > 0 && (ring[i - 1].ts ?? 0) > ts)
        i--;
      ring.splice(i, 0, item);
      if (item.id)
        byId.set(item.id, item);
      const turn = turnOf(item);
      let n = 0;
      for (const it of ring)
        if (turnOf(it) === turn)
          n++;
      while (n > cap) {
        const idx = ring.findIndex((it) => turnOf(it) === turn);
        const dropped = ring.splice(idx, 1)[0];
        if (dropped.id && byId.get(dropped.id) === dropped)
          byId.delete(dropped.id);
        n--;
      }
    },
    end(toolUseId, endTs, error) {
      const it = byId.get(toolUseId);
      if (!it)
        return false;
      let changed = false;
      if (error && !it.error) {
        it.error = true;
        changed = true;
      }
      if (it.startMs != null) {
        const e = tsMs(endTs);
        if (e != null && it.ms !== e - it.startMs) {
          it.ms = e - it.startMs;
          changed = true;
        }
      }
      return changed;
    },
    mark(toolUseId) {
      const it = byId.get(toolUseId);
      if (!it || it.background)
        return false;
      it.background = true;
      return true;
    },
    outcome(toolUseId, failed, summary) {
      const it = byId.get(toolUseId);
      if (!it?.background)
        return false;
      const message = failed ? summary : null;
      if ((it.error ?? false) === failed && (it.errorMessage ?? null) === message)
        return false;
      it.error = failed;
      it.errorMessage = message;
      return true;
    },
    items(turnIndex) {
      if (turnIndex === undefined)
        return ring.slice(-cap);
      return ring.filter((it) => turnOf(it) === turnIndex);
    }
  };
}

// apps/server/src/core/text.ts
var SCRATCH_ROOT = "~scratch";
function isScratchPath(path) {
  return path.startsWith(SCRATCH_ROOT);
}

// apps/server/src/core/file-attribution.ts
function displayFiles(files, roots, scratch = false) {
  const prefixes = [...roots].map((r) => r.replace(/\/$/, "") + "/").sort((a, b) => b.length - a.length);
  return files.map((f) => {
    const prefix = prefixes.find((p) => f.path.startsWith(p));
    const shown = prefix ? f.path.slice(prefix.length) : f.path;
    const slash = shown.lastIndexOf("/");
    return {
      path: f.path,
      base: shown.slice(slash + 1),
      dir: slash >= 0 ? shown.slice(0, slash + 1) : "",
      at: f.at,
      commit: f.commit,
      scratch
    };
  });
}

// apps/server/src/core/graph-derive.ts
var WF_SILENT_MS = 300000;
function toolDuration(ms, ended2) {
  return ms == null && ended2 ? "cut off" : formatToolMs(ms);
}
function displayState(a, ended2, now = Date.now()) {
  if (a.state !== "running")
    return a.state;
  if (ended2)
    return "unknown";
  if (a.kind === "workflow" && a.workflow?.lastActivityAt) {
    if (now - a.workflow.lastActivityAt > WF_SILENT_MS)
      return "unknown";
  }
  if (a.kind === "subagent" && !hasStarted(a))
    return "unknown";
  return "running";
}
function delegatedWork(turnIndex, subs, ended2, now = Date.now()) {
  let out = null;
  for (const a of subs) {
    if (a.turnIndex !== turnIndex || displayState(a, ended2, now) !== "running")
      continue;
    const parsed = a.startedAt ? Date.parse(a.startedAt) : Number.NaN;
    const since = Number.isNaN(parsed) ? null : parsed;
    if (!out)
      out = { label: a.title, since, count: 1 };
    else {
      out.count++;
      if (since !== null && (out.since === null || since < out.since)) {
        out.since = since;
        out.label = a.title;
      }
    }
  }
  return out;
}
function turnIsWorking(turn, isLast, session) {
  if (session.ended)
    return false;
  if (turn.state === "interrupted")
    return false;
  return turn.state === "live" || isLast && session.busy;
}
function returnedWork(turnIndex, subs, ended2, now = Date.now()) {
  let best = null;
  for (const a of subs) {
    if (a.turnIndex !== turnIndex)
      continue;
    const state = displayState(a, ended2, now);
    if (state === "running" || state === "unknown")
      continue;
    const started = a.startedAt ? Date.parse(a.startedAt) : Number.NaN;
    const at = !Number.isNaN(started) && a.durationMs != null ? started + a.durationMs : null;
    if (!best || at !== null && (best.at === null || at > best.at))
      best = { label: a.title, at };
  }
  return best;
}
function turnCls(t, working2 = t.state === "live") {
  if (t.state === "interrupted")
    return "esc";
  if (t.kind === "context" || t.compaction)
    return "cmp";
  if (t.kind === "local")
    return "loc";
  if (working2)
    return "lv";
  return "";
}
function isMarker(t) {
  return t.deltaFill === 0;
}
function entryLabel(t, max = 200) {
  return entryText(t.prompt, t.command, max);
}
function workOrdinal(fullSnap, turn) {
  return fullSnap.turnList.filter((t) => t.kind === "work").findIndex((t) => t.index === turn.index) + 1;
}
function entryTitle(fullSnap, turn) {
  if (!turn || !fullSnap)
    return "";
  return turn.kind === "work" ? "Turn " + workOrdinal(fullSnap, turn) : "/" + (turn.command ?? "entry");
}
function finalResultTurn(fullSnap) {
  if (!fullSnap)
    return null;
  for (let i = fullSnap.turnList.length - 1;i >= 0; i--) {
    const t = fullSnap.turnList[i];
    if (t?.result)
      return t;
  }
  return null;
}
function shortModel2(m) {
  if (!m)
    return "";
  const fam = modelFamily(m);
  return fam === "fable" ? m : fam ?? m;
}
function modelLabel3(m) {
  return m ? m.replace(/^claude-/, "") : "";
}

// apps/server/src/core/selectors.ts
function runningBackground(tools) {
  return backgroundCommands(tools, { ended: false }).filter((c) => c.state === "running").map((c) => ({ toolUseId: c.toolUseId, command: c.command, since: c.since, turnIndex: c.turnIndex }));
}
function backgroundCommands(tools, opts) {
  return tools.filter((t) => t.background && t.startedTs).map((t) => {
    const ended2 = t.outcomeStatus != null;
    const clean = t.outcomeStatus === "completed" || t.outcomeStatus === "stopped";
    const state = !ended2 ? opts.ended || t.vanishedTs ? "unknown" : "running" : clean ? "done" : "failed";
    const since = t.startedTs;
    const endedAt = t.outcomeTs ?? null;
    const bound = ended2 ? null : t.lastSeenAliveTs ?? null;
    const a = Date.parse(since);
    const b = endedAt === null ? bound === null ? Number.NaN : Date.parse(bound) : Date.parse(endedAt);
    return {
      toolUseId: t.id,
      label: t.description || t.arg || t.name,
      command: t.arg ?? t.name,
      state,
      since,
      endedAt,
      ranMs: Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : null,
      ranAtLeast: endedAt === null && bound !== null,
      sentence: t.outcome ?? null,
      outputFile: t.outputFile ?? null,
      turnIndex: t.turnIndex,
      by: t.backgroundBy ?? "agent",
      events: t.events ?? 0,
      lastEvent: t.lastEvent ?? null
    };
  }).sort((a, b) => a.since.localeCompare(b.since));
}
function tokenUsage(m) {
  const input = m.inputTotal, cacheWrite = m.cacheTotals.created, cacheRead = m.cacheTotals.read, output = m.outputTotal;
  return {
    input,
    cacheWrite,
    cacheRead,
    output,
    thinking: m.thinkingTotal,
    total: input + cacheWrite + cacheRead + output
  };
}
function subagentsChronological(subagents) {
  return [...subagents].sort((a, b) => {
    if (!a.startedAt && !b.startedAt)
      return 0;
    if (!a.startedAt)
      return 1;
    if (!b.startedAt)
      return -1;
    return a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0;
  });
}
function maxReturnedLen(subagents) {
  return Math.max(1, ...subagents.map((a) => a.outLen ?? 0));
}
function contextHogs(mainTools) {
  return mainTools.filter((t) => t.ctx > 0).sort((a, b) => b.ctx - a.ctx);
}
function contextFraction(a) {
  return a.window > 0 ? a.fill / a.window : 0;
}
function skillShare(skill, skills) {
  const total = skills.reduce((n, x) => n + x.turns, 0);
  return total > 0 ? skill.turns / total * 100 : null;
}
function scopeToTurn(s, turnIndex) {
  const turn = s.turnList.find((t) => t.index === turnIndex);
  if (!turn)
    return s;
  const mainTools = s.mainTools.filter((t) => t.turnIndex === turnIndex);
  const filesChanged = s.filesChanged.filter((f) => f.turnIndex === turnIndex);
  const subagents = s.subagents.filter((a) => a.turnIndex === turnIndex);
  const skills = [...turn.skills];
  const commands = [...turn.commands];
  const w = s.main.window;
  return {
    ...s,
    main: {
      ...s.main,
      fill: turn.fillEnd,
      pct: w > 0 ? Math.round(turn.fillEnd / w * 100) : 0,
      breakdown: { ...turn.breakdown },
      cacheTotals: { ...turn.cacheTotals },
      inputTotal: turn.inputTotal,
      outputTotal: turn.out,
      thinkingTotal: turn.thinking,
      weighted: turn.weighted,
      weightedByModel: []
    },
    mainTools,
    filesChanged,
    subagents,
    subagentsTotal: subagents.reduce((n, a) => n + a.volume, 0),
    subagentsEstimated: subagents.some((a) => a.volumeEstimated),
    subagentTokensByModel: sumTokensByModel(subagents),
    weightedSubagents: subagents.reduce((n, a) => n + a.weighted, 0),
    weightedByModel: [],
    skills,
    commands,
    turns: 1,
    apiCalls: turn.apiCalls
  };
}
function turnCostStats(s) {
  return { escCount: s.turnList.filter((t) => t.state === "interrupted").length };
}
function workingMs(s) {
  let total = 0;
  for (const t of s.turnList)
    if (t.durationMs !== null)
      total += t.durationMs;
  return total;
}

// apps/server/src/core/session-artifacts.ts
var ARTIFACT_URL = /https:\/\/claude\.ai\/code\/artifact\/[\w-]+/;

// apps/server/src/core/span-store.ts
var _nextId = 0;
function nextId() {
  return `sp-${_nextId++}`;
}
function firstLine(s) {
  if (!s)
    return null;
  const line = s.split(`
`)[0]?.trim();
  return line?.length ? line : null;
}
function tsOrFallback(ts, fallback) {
  const n = Date.parse(ts ?? "");
  return Number.isFinite(n) ? n : fallback;
}
function createSpanStore() {
  const turns = new Map;
  const closedByResult = new Set;
  const openToolSpans = new Map;
  const backgroundSpans = new Map;
  const pendingBgOutcome = new Map;
  const pendingFlags = new Set;
  const spawnById = new Map;
  const openSpawnIds = new Set;
  const agentSpawnMap = new Map;
  const childBuffer = new Map;
  const metaBuffer = new Map;
  const openChildToolSpans = new Map;
  let latestTs = 0;
  let _seq = 0;
  const listeners = new Set;
  function applyChildEvent(e, ctx) {
    if (e.agentId == null)
      return false;
    const spawnId = agentSpawnMap.get(e.agentId);
    if (spawnId == null)
      return false;
    const entry = spawnById.get(spawnId);
    if (!entry)
      return false;
    const { spawn, turnIdx } = entry;
    const ts = tsOrFallback(e.timestamp, latestTs);
    const lane = spawn.lanes.find((l) => l.agentId === e.agentId);
    if (!lane)
      return false;
    const laneIdx = spawn.lanes.indexOf(lane) + 1;
    if (e.type === "tool-start" && !SPAWN_TOOL_NAMES.has(e.name) && e.name !== "Workflow") {
      const subspan = {
        id: nextId(),
        type: "subspan",
        label: e.name,
        detail: ctx.label ?? null,
        t0: ts,
        t1: ts,
        turnIndex: turnIdx,
        lane: laneIdx,
        parentId: spawnId,
        agent: lane.label,
        status: "running",
        handle: { kind: "tool", toolUseId: e.id }
      };
      lane.spans.push(subspan);
      openChildToolSpans.set(e.id, subspan);
      return true;
    }
    if (e.type === "tool-end") {
      const subspan = openChildToolSpans.get(e.toolUseId);
      if (subspan) {
        subspan.t1 = ts;
        subspan.status = e.error ? "error" : "ok";
        openChildToolSpans.delete(e.toolUseId);
        return true;
      }
      return false;
    }
    if (e.type === "usage" && ctx.newCall === true) {
      const t1 = ts + (ctx.callMs ?? 0);
      const subspan = {
        id: nextId(),
        type: "api",
        label: "API call",
        detail: ctx.label ?? null,
        t0: ts,
        t1,
        turnIndex: turnIdx,
        lane: laneIdx,
        parentId: spawnId,
        agent: lane.label,
        status: e.apiError ? "error" : "ok",
        handle: e.callId ? { kind: "call", callId: e.callId } : null
      };
      lane.spans.push(subspan);
      return true;
    }
    return false;
  }
  function flushChildBuffer(agentId) {
    const buf = childBuffer.get(agentId);
    if (!buf)
      return;
    childBuffer.delete(agentId);
    for (const { e: be, ctx: bc } of buf)
      applyChildEvent(be, bc);
  }
  function applyMeta(e) {
    if (e.agentId == null || e.agentType == null)
      return false;
    const key = e.toolUseId ?? e.agentId;
    const entry = spawnById.get(key);
    if (!entry)
      return false;
    const { spawn } = entry;
    let lane = spawn.lanes.find((l) => l.agentId === e.agentId);
    if (!lane) {
      lane = { agentId: e.agentId, label: e.agentId, spans: [], status: "" };
      spawn.lanes.push(lane);
    }
    agentSpawnMap.set(e.agentId, key);
    lane.label = e.model ? `${e.agentType} (${e.model})` : e.agentType;
    flushChildBuffer(e.agentId);
    return true;
  }
  function apply(e, ctx) {
    const ts = tsOrFallback(e.timestamp, latestTs);
    if (ts > latestTs)
      latestTs = ts;
    let mutated = false;
    const metaKey = e.type === "subagent-meta" ? e.toolUseId ?? e.agentId : null;
    if (e.type === "subagent-meta" && metaKey != null) {
      if (spawnById.has(metaKey)) {
        mutated = applyMeta(e);
      } else {
        metaBuffer.set(metaKey, e);
      }
      if (mutated) {
        _seq++;
        for (const cb of listeners)
          cb();
      }
      return;
    }
    if (e.agentId != null) {
      const spawnId = agentSpawnMap.get(e.agentId);
      if (spawnId == null) {
        let buf = childBuffer.get(e.agentId);
        if (!buf) {
          buf = [];
          childBuffer.set(e.agentId, buf);
        }
        buf.push({ e, ctx });
      } else {
        mutated = applyChildEvent(e, ctx);
      }
      if (mutated) {
        _seq++;
        for (const cb of listeners)
          cb();
      }
      return;
    }
    if (e.type === "user-turn" && e.agentId == null) {
      const idx = ctx.turnIndex ?? 1;
      const title = entryText(e.prompt, e.command ?? null) || "(prompt)";
      const kind = e.command != null ? "local" : "work";
      const promptSpan = {
        id: nextId(),
        type: "prompt",
        label: title,
        detail: null,
        t0: ts,
        t1: ts,
        turnIndex: idx,
        lane: 0,
        parentId: null,
        agent: null,
        status: "ok",
        handle: { kind: "turn-text", turnIndex: idx, which: "prompt" }
      };
      const turn = {
        index: idx,
        title,
        kind,
        t0: ts,
        t1: ts,
        state: "live",
        spans: [promptSpan],
        spawns: []
      };
      turns.set(idx, turn);
      mutated = true;
    } else if (e.type === "usage" && ctx.newCall === true && e.agentId == null) {
      const idx = ctx.turnIndex;
      if (idx != null) {
        const turn = turns.get(idx);
        if (turn) {
          const t1 = ts + (ctx.callMs ?? 0);
          const span = {
            id: nextId(),
            type: "api",
            label: "API call",
            detail: ctx.label ?? null,
            t0: ts,
            t1,
            turnIndex: idx,
            lane: 0,
            parentId: null,
            agent: null,
            status: e.apiError ? "error" : "ok",
            handle: e.callId ? { kind: "call", callId: e.callId } : null
          };
          turn.spans.push(span);
          if (t1 > turn.t1)
            turn.t1 = t1;
          if (closedByResult.has(idx) && turn.state === "done")
            turn.state = "live";
          mutated = true;
        }
      }
    } else if (e.type === "turn-narration" && e.agentId == null && e.callId) {
      const idx = ctx.turnIndex;
      const turn = idx != null ? turns.get(idx) : undefined;
      if (turn) {
        for (let i = turn.spans.length - 1;i >= 0; i--) {
          const s = turn.spans[i];
          if (s.type === "api" && s.handle?.kind === "call" && s.handle.callId === e.callId) {
            s.narration = e.text;
            mutated = true;
            break;
          }
        }
      }
    } else if (e.type === "agent-launch") {
      const idx = ctx.turnIndex;
      const turn = idx == null ? null : turns.get(idx);
      if (turn && !spawnById.has(e.launchedAgentId)) {
        const label = e.skillName ? "/" + e.skillName : "Agent";
        const span = {
          id: nextId(),
          type: "spawn",
          label,
          detail: e.description ?? null,
          t0: ts,
          t1: ts,
          turnIndex: idx,
          lane: 0,
          parentId: null,
          agent: null,
          status: "running",
          handle: { kind: "subagent", agentId: e.launchedAgentId, toolUseId: e.launchedAgentId }
        };
        const spawn = { spawnId: e.launchedAgentId, label, kind: label, lanes: [] };
        turn.spans.push(span);
        turn.spawns.push(spawn);
        if (turn.kind === "local")
          turn.kind = "work";
        spawnById.set(e.launchedAgentId, { turnIdx: idx, spawn, span });
        openSpawnIds.add(e.launchedAgentId);
        if (ts > turn.t1)
          turn.t1 = ts;
        const parked = metaBuffer.get(e.launchedAgentId);
        if (parked) {
          metaBuffer.delete(e.launchedAgentId);
          applyMeta(parked);
        }
        mutated = true;
      }
    } else if (e.type === "tool-start" && e.agentId == null && (SPAWN_TOOL_NAMES.has(e.name) || e.name === "Workflow")) {
      const idx = ctx.turnIndex;
      if (idx != null) {
        const turn = turns.get(idx);
        if (turn) {
          const span = {
            id: nextId(),
            type: "spawn",
            label: e.name,
            detail: e.description ?? (e.launchPrompt ? firstLine(e.launchPrompt) : null) ?? e.subagentType ?? null,
            t0: ts,
            t1: ts,
            turnIndex: idx,
            lane: 0,
            parentId: null,
            agent: null,
            status: "running",
            handle: { kind: "tool", toolUseId: e.id }
          };
          const spawn = { spawnId: e.id, label: e.name, kind: e.name, lanes: [] };
          turn.spans.push(span);
          turn.spawns.push(spawn);
          spawnById.set(e.id, { turnIdx: idx, spawn, span });
          openSpawnIds.add(e.id);
          const parked = metaBuffer.get(e.id);
          if (parked) {
            metaBuffer.delete(e.id);
            applyMeta(parked);
          }
          mutated = true;
        }
      }
    } else if (e.type === "tool-start" && e.agentId == null && !SPAWN_TOOL_NAMES.has(e.name) && e.name !== "Workflow") {
      const idx = ctx.turnIndex;
      if (idx != null) {
        const turn = turns.get(idx);
        if (turn) {
          const span = {
            id: nextId(),
            type: "tool",
            label: e.name,
            detail: ctx.label ?? null,
            t0: ts,
            t1: ts,
            turnIndex: idx,
            lane: 0,
            parentId: null,
            agent: null,
            status: "running",
            handle: { kind: "tool", toolUseId: e.id }
          };
          if (pendingFlags.delete(e.id))
            span.flagged = true;
          turn.spans.push(span);
          openToolSpans.set(e.id, span);
          mutated = true;
        }
      }
    } else if (e.type === "tool-end" && e.agentId == null) {
      const span = openToolSpans.get(e.toolUseId);
      if (span) {
        span.t1 = ts;
        span.status = e.error ? "error" : "ok";
        openToolSpans.delete(e.toolUseId);
        const parked = pendingBgOutcome.get(e.toolUseId);
        if (parked)
          pendingBgOutcome.delete(e.toolUseId);
        if (e.background) {
          backgroundSpans.set(e.toolUseId, span);
          span.background = true;
          if (parked) {
            span.status = parked.clean ? "ok" : "error";
            if (!parked.clean && parked.summary)
              span.detail = outcomeLine(parked.summary);
          }
        }
        const turn = turns.get(span.turnIndex);
        if (turn && ts > turn.t1)
          turn.t1 = ts;
        mutated = true;
      } else if (openSpawnIds.has(e.toolUseId)) {
        const entry = spawnById.get(e.toolUseId);
        if (entry) {
          entry.span.t1 = ts;
          entry.span.status = "ok";
          if (e.workflow?.runId)
            entry.spawn.kind = "Workflow";
          openSpawnIds.delete(e.toolUseId);
          const turn = turns.get(entry.turnIdx);
          if (turn && ts > turn.t1)
            turn.t1 = ts;
          mutated = true;
        }
      }
    } else if (e.type === "note") {
      if (e.toolUseId === null)
        return;
      let found;
      for (const turn of [...turns.values()].reverse()) {
        found = turn.spans.find((s) => s.handle?.kind === "tool" && s.handle.toolUseId === e.toolUseId);
        if (found)
          break;
      }
      if (found) {
        if (!found.flagged) {
          found.flagged = true;
          mutated = true;
        }
      } else {
        pendingFlags.add(e.toolUseId);
      }
    } else if (e.type === "agent-end") {
      const bgSpan = e.toolUseId ? backgroundSpans.get(e.toolUseId) : undefined;
      if (!bgSpan && e.toolUseId && !spawnById.has(e.toolUseId)) {
        pendingBgOutcome.set(e.toolUseId, {
          clean: e.status === null || e.status === "completed" || e.status === "stopped",
          summary: e.summary
        });
      }
      if (bgSpan) {
        const clean = e.status === null || e.status === "completed" || e.status === "stopped";
        bgSpan.status = clean ? "ok" : "error";
        if (!clean && e.summary)
          bgSpan.detail = outcomeLine(e.summary);
        mutated = true;
      }
      if (e.taskId != null) {
        const entry = (e.toolUseId ? spawnById.get(e.toolUseId) : undefined) ?? spawnById.get(agentSpawnMap.get(e.taskId) ?? "") ?? spawnById.get(e.taskId);
        if (entry) {
          const { spawn, span } = entry;
          if (openSpawnIds.has(spawn.spawnId) && spawn.spawnId === e.taskId) {
            openSpawnIds.delete(spawn.spawnId);
            span.status = e.status === null || e.status === "completed" || e.status === "stopped" ? "ok" : "error";
            if (ts > span.t1)
              span.t1 = ts;
            const t = turns.get(span.turnIndex);
            if (t && ts > t.t1)
              t.t1 = ts;
          }
          let lane = spawn.lanes.find((l) => l.agentId === e.taskId);
          if (!lane) {
            lane = { agentId: e.taskId, label: e.taskId, spans: [], status: e.status ?? "" };
            spawn.lanes.push(lane);
          } else {
            lane.status = e.status ?? "";
          }
          agentSpawnMap.set(e.taskId, spawn.spawnId);
          flushChildBuffer(e.taskId);
          mutated = true;
        }
      }
    } else if (e.type === "turn-result" && e.agentId == null) {
      const idx = ctx.turnIndex;
      if (idx != null) {
        const turn = turns.get(idx);
        if (turn) {
          const span = {
            id: nextId(),
            type: "result",
            label: "done",
            detail: firstLine(e.outputFull),
            t0: ts,
            t1: ts,
            turnIndex: idx,
            lane: 0,
            parentId: null,
            agent: null,
            status: "ok",
            handle: { kind: "turn-text", turnIndex: idx, which: "result" }
          };
          turn.spans.push(span);
          if (ts > turn.t1)
            turn.t1 = ts;
          if (turn.state === "live") {
            turn.state = "done";
            closedByResult.add(idx);
          }
          mutated = true;
        }
      }
    } else if (e.type === "turn-end" && e.agentId == null) {
      const idx = ctx.turnIndex;
      if (idx != null) {
        const turn = turns.get(idx);
        if (turn) {
          turn.t1 = ts;
          turn.state = "done";
          closedByResult.delete(idx);
          mutated = true;
        }
      }
    } else if (e.type === "turn-interrupted" && e.agentId == null) {
      const idx = ctx.turnIndex;
      if (idx != null) {
        const turn = turns.get(idx);
        const worked = turn?.spans.some((s) => s.type === "api") === true;
        if (turn && (!e.cutoff || worked)) {
          turn.state = "interrupted";
          mutated = true;
        }
      }
    }
    if (mutated) {
      _seq++;
      for (const cb of listeners)
        cb();
    }
  }
  function snapshot(scopeTurn) {
    let included;
    if (scopeTurn != null) {
      const t = turns.get(scopeTurn);
      included = t ? [t] : [];
    } else {
      included = [...turns.values()].sort((a, b) => a.index - b.index);
    }
    let t0 = Infinity, t1 = -Infinity;
    for (const turn of included) {
      for (const span of turn.spans) {
        if (span.t0 < t0)
          t0 = span.t0;
        if (span.t1 > t1)
          t1 = span.t1;
      }
      if (turn.t0 < t0)
        t0 = turn.t0;
      if (turn.t1 > t1)
        t1 = turn.t1;
    }
    if (!Number.isFinite(t0))
      t0 = 0;
    if (!Number.isFinite(t1))
      t1 = 0;
    return { turns: included, t0, t1, seq: _seq };
  }
  function onChange(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }
  return { apply, snapshot, onChange };
}

// apps/server/src/core/verdict.ts
var WASTED_OUTLEN = 5000;
var EXPLORE_READS = 8;
var RESUME_MIN_TOKENS = 50000;
var RESUME_MIN_SHARE = 0.8;
var CONTEXT_FILL_WARN = 0.7;
var VERIFY_RE = /\b(test|pytest|jest|vitest|bun test|npm test|go test|cargo test|tsc|typecheck|lint|eslint|ruff|mypy|make |gradle|mvn |build|playwright|curl -s?I?\s|screenshot)\b/i;
var COMMIT_RE = /\bgit\s+(commit|push)\b/;
var CODE_RE = /\.(ts|tsx|js|jsx|py|go|rs|java|rb|php|c|h|cpp|sh|sql|css|vue|svelte)$/i;
var REVIEW_RE = /review|verif|audit/i;
function turnBillable(t) {
  return t.inputTotal + t.out + t.cacheTotals.created;
}
function turnResumeCost(t) {
  const c = t.firstCall;
  if (!c || t.rebuildExpected || c.fill <= 0)
    return 0;
  if (c.cacheCreation < RESUME_MIN_TOKENS)
    return 0;
  return c.cacheCreation / c.fill >= RESUME_MIN_SHARE ? c.cacheCreation : 0;
}
function compactionTail(turn, next) {
  return turn.compaction ? next?.firstCall?.cacheCreation ?? 0 : 0;
}
function kTok(n) {
  const a = Math.abs(n);
  if (a >= 1e6)
    return (n / 1e6).toFixed(1) + "M";
  if (a >= 1000)
    return (n / 1000).toFixed(1) + "k";
  return String(Math.round(n));
}
var MIN_BASELINE = 20;
function bucketFor(baseline, effort) {
  if (!baseline?.byEffort)
    return null;
  const b = baseline.byEffort[effort];
  return b && b.count >= MIN_BASELINE ? b : null;
}
function turnFillShare(t) {
  const { window: window2, estimated } = windowFor(t.models.at(-1) ?? null);
  if (estimated || !window2)
    return null;
  return t.fillEnd / window2;
}
var EMPTY_EVIDENCE = {
  bigSub: null,
  reviewSub: null,
  subs: 0,
  reads: 0,
  edits: 0,
  committed: false,
  checked: false,
  shippedCode: false
};
function indexEvidence(snap) {
  const byTurn = new Map;
  const slot = (i) => {
    let e = byTurn.get(i);
    if (!e) {
      e = { ...EMPTY_EVIDENCE };
      byTurn.set(i, e);
    }
    return e;
  };
  for (const t of snap.mainTools) {
    if (t.turnIndex === null)
      continue;
    const e = slot(t.turnIndex);
    if (t.name === "Read")
      e.reads++;
    else if (t.name === "Bash" && t.arg) {
      if (COMMIT_RE.test(t.arg))
        e.committed = true;
      if (VERIFY_RE.test(t.arg))
        e.checked = true;
    } else if (t.name === "Edit" || t.name === "Write" || t.name === "NotebookEdit") {
      e.edits++;
      if ((t.name === "Edit" || t.name === "Write") && t.arg && CODE_RE.test(t.arg) && !isScratchPath(t.arg))
        e.shippedCode = true;
    }
  }
  for (const a of snap.subagents) {
    if (a.turnIndex === null)
      continue;
    const e = slot(a.turnIndex);
    e.subs++;
    if (!e.bigSub && a.outLen >= WASTED_OUTLEN)
      e.bigSub = a;
    if (!e.reviewSub && REVIEW_RE.test(`${a.agentType ?? ""} ${a.title ?? ""}`))
      e.reviewSub = a;
  }
  return byTurn;
}
var NO_CONTEXT = { prevInterrupted: false, next: null, checkedBefore: false };
function verdictFrom(turn, ev, ctx) {
  const findings = [];
  if (ev.bigSub) {
    const a = ev.bigSub;
    findings.push({
      kind: "wasted-subagent",
      severity: "crit",
      text: `subagent ${a.agentType ?? "agent"}: ${kTok(a.outLen)} chars returned to main${a.volume ? ` (${kTok(a.volume)} tokens in its own context)` : ""}`
    });
  }
  if (turn.compaction && turn.kind === "work") {
    const tail = compactionTail(turn, ctx.next);
    findings.push({
      kind: "compaction",
      severity: "crit",
      text: `compaction mid-turn — cache rebuilt${tail > 0 ? `, +${kTok(tail)} on the next turn` : ""}`,
      cost: kTok(turn.cacheTotals.created)
    });
  }
  if (turn.state === "interrupted" && !turn.cutoff && ctx.prevInterrupted) {
    findings.push({
      kind: "esc",
      severity: "warn",
      text: `interrupted again — second correction in a row, ${kTok(turnBillable(turn))} abandoned`
    });
  }
  const resume = turnResumeCost(turn);
  if (resume > 0) {
    const share = Math.round(100 * resume / Math.max(1, turnBillable(turn)));
    findings.push({
      kind: "resume",
      severity: "warn",
      text: `resumed cold — ${kTok(resume)} tokens re-created before any work`,
      cost: `${share}% of the turn`
    });
  }
  const fill = turnFillShare(turn);
  if (fill !== null && fill >= CONTEXT_FILL_WARN) {
    findings.push({
      kind: "context",
      severity: "warn",
      text: `context ${Math.round(100 * fill)}% full at the end of the turn (${kTok(turn.fillEnd)})`
    });
  }
  if (ev.reads >= EXPLORE_READS && ev.edits === 0 && ev.subs === 0) {
    findings.push({
      kind: "exploration",
      severity: "warn",
      text: `read ${ev.reads} files into the main context and changed nothing — no subagent`
    });
  }
  if (ev.committed && ev.shippedCode && !ctx.checkedBefore && !ev.checked) {
    findings.push({
      kind: "unverified-ship",
      severity: "crit",
      text: "committed code with no check run anywhere in this session"
    });
  }
  const severity = findings.some((f) => f.severity === "crit") ? "crit" : findings.length ? "warn" : "good";
  return { severity, findings, positives: positivesFrom(ev) };
}
function positivesFrom(ev) {
  const out = [];
  if (ev.committed && ev.shippedCode && ev.checked)
    out.push({ kind: "verified", text: "ran a check before committing" });
  if (ev.subs >= 1 && ev.reads <= 3)
    out.push({ kind: "delegated", text: "delegated the exploration to a subagent" });
  if (ev.reviewSub)
    out.push({ kind: "reviewed", text: `had its work reviewed by ${ev.reviewSub.agentType ?? "a subagent"}` });
  return out;
}
function contexts(snap, evidence) {
  const work = snap.turnList.filter((t) => t.kind === "work");
  const out = new Map;
  let checkedBefore = false;
  for (let i = 0;i < work.length; i++) {
    out.set(work[i].index, {
      prevInterrupted: work[i - 1]?.state === "interrupted" && !work[i - 1]?.cutoff,
      next: work[i + 1] ?? null,
      checkedBefore
    });
    if (evidence.get(work[i].index)?.checked)
      checkedBefore = true;
  }
  return out;
}
function computeVerdict(turn, snap) {
  const evidence = indexEvidence(snap);
  return verdictFrom(turn, evidence.get(turn.index) ?? EMPTY_EVIDENCE, contexts(snap, evidence).get(turn.index) ?? NO_CONTEXT);
}
function computeVerdicts(snap) {
  const evidence = indexEvidence(snap);
  const ctxs = contexts(snap, evidence);
  const out = new Map;
  for (const t of snap.turnList)
    out.set(t.index, verdictFrom(t, evidence.get(t.index) ?? EMPTY_EVIDENCE, ctxs.get(t.index) ?? NO_CONTEXT));
  return out;
}

// apps/server/src/client/cards-view.ts
function el5(tag, className, text) {
  const n = document.createElement(tag);
  if (className)
    n.className = className;
  if (text != null)
    n.textContent = text;
  return n;
}
function hhmm(at) {
  const d = new Date(at);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
function openCard(url) {
  window.open(url, "_blank", "noopener,noreferrer");
}
function cardRow(c, withTime) {
  const row = el5("div", "crdrow" + (c.url ? "" : " nolink") + (c.evidence === "read" ? " read" : ""));
  row.append(el5("span", "crdid", c.id));
  if (c.evidence === "read")
    row.append(el5("span", "crdlvl", "read"));
  row.append(el5("span", "crdt", c.title ?? "—"));
  if (withTime)
    row.append(el5("span", "crdtime", hhmm(c.at)));
  if (c.url) {
    const url = c.url;
    row.title = c.evidence === "read" ? "Only read — open it on the tracker" : "Open it on the tracker";
    row.onclick = () => openCard(url);
  } else {
    row.title = "No link came back from the tracker for this card";
  }
  return row;
}
function describe(cards) {
  const wrote = cards.filter((c) => c.evidence === "wrote").length;
  const what = wrote === cards.length ? "Cards this session changed." : `Cards this session worked on — ${wrote} changed.`;
  return cards.some((c) => c.url) ? `${what} Click one to open it on the tracker.` : what;
}
function cardsList(cards) {
  const box = el5("div", "crddlist");
  for (const c of cards) {
    const row = el5("div", "crddrow" + (c.url ? "" : " nolink"));
    row.append(el5("span", "crdid", c.id));
    if (c.evidence === "read")
      row.append(el5("span", "crdlvl", "read"));
    row.append(el5("span", "crdt wrap", c.title ?? "—"));
    if (c.touches > 1)
      row.append(el5("span", "crdn", `${c.touches} tool calls`));
    row.append(el5("span", "crdtime", hhmm(c.at)));
    if (c.url) {
      const url = c.url;
      row.onclick = () => openCard(url);
    }
    box.append(row);
  }
  return box;
}
var CARD_ROWS = 4;
function renderCardsCard(host, data, onExpand) {
  host.replaceChildren();
  if (!data) {
    host.append(el5("div", "wdesc", "Reading the tracker calls…"));
    return;
  }
  const { cards } = data;
  if (!cards.length) {
    host.append(el5("div", "wdesc", "No tracker card in scope yet."));
    return;
  }
  host.append(el5("div", "wdesc", describe(cards)));
  const num = el5("div", "num");
  num.append(document.createTextNode(String(cards.length)), el5("small", undefined, cards.length === 1 ? "card" : "cards"));
  host.append(num);
  const list = el5("div", "crdlist");
  for (const c of cards.slice(0, CARD_ROWS))
    list.append(cardRow(c, false));
  host.append(list);
  if (cards.length > CARD_ROWS) {
    const more = el5("div", "crdmore", `+ ${cards.length - CARD_ROWS} more →`);
    more.onclick = onExpand;
    host.append(more);
  }
}

// apps/server/src/client/commits-view.ts
function el6(tag, className, text) {
  const n = document.createElement(tag);
  if (className)
    n.className = className;
  if (text != null)
    n.textContent = text;
  return n;
}
function hhmm2(at) {
  const d = new Date(at);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
function openCommit(url) {
  window.open(url, "_blank", "noopener,noreferrer");
}
function chip(c) {
  if (!c.reachable) {
    return {
      word: "superseded",
      why: "No branch leads to it any more — squash-merged or rebased away. The work is in the history under another hash."
    };
  }
  if (!c.url)
    return { word: "local", why: "Not pushed yet — it has no page on the forge" };
  return null;
}
function commitRow(c, withTime) {
  const row = el6("div", "cmtrow" + (c.url ? "" : " nolink"));
  const mark = chip(c);
  row.append(el6("span", "cmth", c.short));
  if (mark)
    row.append(el6("span", c.reachable ? "cmtlocal" : "cmtlocal cmtgone", mark.word));
  row.append(el6("span", "cmts", c.subject));
  if (withTime)
    row.append(el6("span", "cmtt", hhmm2(c.at)));
  if (c.url) {
    const url = c.url;
    row.title = "Open on the forge";
    row.onclick = () => openCommit(url);
  } else {
    row.title = mark?.why ?? "";
  }
  return row;
}
function describe2(commits) {
  if (commits.some((c) => c.url))
    return "Commits this session produced. Click one to open it on the forge.";
  if (commits.every((c) => !c.reachable))
    return "Commits this session produced. The history has moved past them, so none has a page to open.";
  return "Commits this session produced. None is pushed yet, so none has a page to open.";
}
function commitsList(commits) {
  const box = el6("div", "cmtdlist");
  for (const c of [...commits].reverse()) {
    const row = el6("div", "cmtdrow" + (c.url ? "" : " nolink"));
    const mark = chip(c);
    row.append(el6("span", "cmth", c.short));
    if (mark) {
      const span = el6("span", c.reachable ? "cmtlocal" : "cmtlocal cmtgone", mark.word);
      span.title = mark.why;
      row.append(span);
    }
    row.append(el6("span", "cmts wrap", c.subject), el6("span", "cmtt", hhmm2(c.at)));
    if (c.url) {
      const url = c.url;
      row.onclick = () => openCommit(url);
    }
    box.append(row);
  }
  return box;
}
var CARD_ROWS2 = 4;
function renderCommitsCard(host, data, onExpand) {
  host.replaceChildren();
  if (!data) {
    host.append(el6("div", "wdesc", "Reading the repository…"));
    return;
  }
  const { commits } = data;
  if (!commits.length) {
    host.append(el6("div", "wdesc", data.denied ? "Cannot read this session’s folder, so its commits are unknown. On macOS, allow access when the system asks — or grant it under Privacy & Security → Files and Folders." : "No commits in scope yet."));
    return;
  }
  host.append(el6("div", "wdesc", describe2(commits)));
  const num = el6("div", "num");
  num.append(document.createTextNode(String(commits.length)), el6("small", undefined, commits.length === 1 ? "commit" : "commits"));
  host.append(num);
  const list = el6("div", "cmtlist");
  for (const c of commits.slice(0, CARD_ROWS2))
    list.append(commitRow(c, false));
  host.append(list);
  if (commits.length > CARD_ROWS2) {
    const more = el6("div", "cmtmore", `+ ${commits.length - CARD_ROWS2} more →`);
    more.onclick = onExpand;
    host.append(more);
  }
}

// apps/server/src/client/markdown.ts
var FENCE = /^\s*(`{3,}|~{3,})\s*(\S*)\s*$/;
var HEADING = /^(#{1,6})\s+(.*)$/;
var RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
var QUOTE = /^\s*>\s?(.*)$/;
var BULLET = /^\s*[-*+]\s+(.*)$/;
var ORDERED = /^\s*(\d+)[.)]\s+(.*)$/;
var TABLE_ROW = /^\s*\|(.+)\|\s*$/;
var TABLE_SEP = /^\s*\|[\s:|-]+\|\s*$/;
var INLINE = /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\n]+?)\*|_([^_\n]+?)_|\[([^\]\n]+)\]\(([^()\s]+)\)/;
var SAFE_HREF = /^(https?:\/\/|mailto:)/i;
function el7(tag, cls) {
  const n = document.createElement(tag);
  if (cls)
    n.className = cls;
  return n;
}
function inline(text) {
  const out = [];
  let rest = text;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push(document.createTextNode(rest));
      break;
    }
    if (m.index > 0)
      out.push(document.createTextNode(rest.slice(0, m.index)));
    const [, , code, bold1, bold2, it1, it2, linkText, href] = m;
    if (code !== undefined) {
      const c = el7("code");
      c.textContent = code.trim();
      out.push(c);
    } else if (bold1 !== undefined || bold2 !== undefined) {
      const b = el7("strong");
      for (const n of inline(bold1 ?? bold2 ?? ""))
        b.append(n);
      out.push(b);
    } else if (it1 !== undefined || it2 !== undefined) {
      const i = el7("em");
      for (const n of inline(it1 ?? it2 ?? ""))
        i.append(n);
      out.push(i);
    } else if (linkText !== undefined) {
      if (href !== undefined && SAFE_HREF.test(href)) {
        const a = el7("a");
        a.textContent = linkText;
        a.setAttribute("href", href);
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noreferrer noopener");
        out.push(a);
      } else {
        out.push(document.createTextNode(m[0]));
      }
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}
function para(tag, text, cls) {
  const p = el7(tag, cls);
  for (const n of inline(text))
    p.append(n);
  return p;
}
function renderMarkdown(src) {
  const out = [];
  const lines = String(src ?? "").split(`
`);
  const at = (n) => lines[n] ?? "";
  const isTableStart = (n) => TABLE_ROW.test(at(n)) && TABLE_SEP.test(at(n + 1));
  let i = 0;
  while (i < lines.length) {
    const line = at(i);
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = (fence[1] ?? "")[0];
      const closes = (l) => {
        const f = FENCE.exec(l);
        return !!f && (f[1] ?? "")[0] === marker;
      };
      const body2 = [];
      i++;
      while (i < lines.length && !closes(at(i)))
        body2.push(at(i++));
      i++;
      const pre = el7("pre");
      const code = el7("code");
      if (fence[2])
        code.className = "lang-" + fence[2];
      code.textContent = body2.join(`
`);
      pre.append(code);
      out.push(pre);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push(para("h" + (heading[1] ?? "").length, heading[2] ?? ""));
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push(el7("hr"));
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body2 = [];
      while (i < lines.length) {
        const quoted = QUOTE.exec(at(i));
        if (!quoted)
          break;
        body2.push(quoted[1] ?? "");
        i++;
      }
      const q = el7("blockquote");
      for (const n of renderMarkdown(body2.join(`
`)))
        q.append(n);
      out.push(q);
      continue;
    }
    if (isTableStart(i)) {
      const cells = (l) => (TABLE_ROW.exec(l)?.[1] ?? "").split("|").map((c) => c.trim());
      const table = el7("table");
      const thead = el7("thead"), htr = el7("tr");
      for (const c of cells(line)) {
        const th = el7("th");
        for (const n of inline(c))
          th.append(n);
        htr.append(th);
      }
      thead.append(htr);
      table.append(thead);
      i += 2;
      const tbody = el7("tbody");
      while (i < lines.length && TABLE_ROW.test(at(i)) && !TABLE_SEP.test(at(i))) {
        const tr = el7("tr");
        for (const c of cells(at(i))) {
          const td = el7("td");
          for (const n of inline(c))
            td.append(n);
          tr.append(td);
        }
        tbody.append(tr);
        i++;
      }
      table.append(tbody);
      out.push(table);
      continue;
    }
    const isItem = (l) => BULLET.exec(l) || ORDERED.exec(l);
    if (isItem(line)) {
      const ordered = !!ORDERED.exec(line);
      const list = el7(ordered ? "ol" : "ul");
      while (i < lines.length && at(i).trim() && !!ORDERED.exec(at(i)) === ordered && isItem(at(i))) {
        const m = ordered ? ORDERED.exec(at(i)) : BULLET.exec(at(i));
        list.append(para("li", (ordered ? m?.[2] : m?.[1]) ?? ""));
        i++;
      }
      out.push(list);
      continue;
    }
    const body = [];
    while (i < lines.length && at(i).trim() && !FENCE.test(at(i)) && !HEADING.test(at(i)) && !RULE.test(at(i)) && !QUOTE.test(at(i)) && !isItem(at(i)) && !isTableStart(i)) {
      body.push(at(i++));
    }
    out.push(para("p", body.join(`
`)));
  }
  return out;
}

// apps/server/src/core/share-card.ts
var CARD_W = 1200;
var CARD_H = 628;
var CARD_DPR = 2;
function kTok2(n) {
  const a = Math.abs(n);
  if (a >= 1e6)
    return (n / 1e6).toFixed(1) + "M";
  if (a >= 1000)
    return (n / 1000).toFixed(1) + "k";
  return String(Math.round(n));
}
function fmtDuration(ms) {
  if (ms === null)
    return "";
  const s = Math.round(ms / 1000);
  if (s < 60)
    return s + "s";
  return Math.floor(s / 60) + "m" + (s % 60 ? String(s % 60).padStart(2, "0") + "s" : "");
}
function attributedTokens(findings) {
  let sum = 0;
  for (const f of findings) {
    const m = /^~?([\d.]+)([kM]?)$/.exec((f.cost ?? "").trim());
    if (!m)
      continue;
    sum += parseFloat(m[1]) * (m[2] === "k" ? 1000 : m[2] === "M" ? 1e6 : 1);
  }
  return sum;
}
function shortModel3(model) {
  if (!model)
    return "";
  const m = /claude-(opus|sonnet|haiku|fable)-?(\d)-?(\d)?/.exec(model);
  if (!m)
    return model.replace(/^claude-/, "");
  return m[1] + " " + m[2] + (m[3] ? "." + m[3] : "");
}
function shareCardSvg(d) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" ` + `viewBox="0 0 ${CARD_W} ${CARD_H}">` + `<foreignObject width="100%" height="100%">${buildShareCardHtml(d)}</foreignObject></svg>`;
}
function buildShareCardHtml(d) {
  const sevColor = d.severity === "crit" ? "#fb7185" : d.severity === "warn" ? "#fbbf24" : "#6ee7b7";
  const sevLabel = d.severity === "crit" ? "CRITICAL" : d.severity === "warn" ? "WARNING" : "CLEAN";
  const sevBg = d.severity === "crit" ? "rgba(251,113,133,.12)" : d.severity === "warn" ? "rgba(251,191,36,.10)" : "rgba(110,231,183,.10)";
  const glowRgb = d.severity === "crit" ? "251,113,133" : d.severity === "warn" ? "251,191,36" : "110,231,183";
  const heroNum = kTok2(d.billable);
  const compare = d.mult && d.p50 ? `${d.mult}× your median turn (${kTok2(d.p50)})` : d.p50 ? `your median turn is ${kTok2(d.p50)}` : "no personal baseline yet";
  const scale = (() => {
    if (!d.p50 || !d.p90 || !d.p95)
      return "";
    const span = Math.max(d.p95 * 1.25, d.billable * 1.1);
    const at = (v) => Math.min(100, 100 * v / span);
    const tick = (v, label) => `
      <div style="position:absolute;left:${at(v).toFixed(1)}%;top:0;bottom:0;width:1px;background:#26364e"></div>
      <div style="position:absolute;left:${at(v).toFixed(1)}%;top:22px;transform:translateX(-50%);
        font:13px/1 ui-monospace,monospace;color:#93a6c2;white-space:nowrap">${label}</div>`;
    return `<div style="position:relative;height:46px;margin-top:22px">
      <div style="position:absolute;left:0;right:0;top:6px;height:9px;border-radius:5px;background:#101a29"></div>
      <div style="position:absolute;left:0;top:6px;height:9px;border-radius:5px;width:${at(d.billable).toFixed(1)}%;
        background:${sevColor};box-shadow:0 0 22px rgba(${glowRgb},.45)"></div>
      ${tick(d.p50, "p50")}${tick(d.p90, "p90")}${tick(d.p95, "p95")}
    </div>`;
  })();
  const findingsHtml = d.findings.length === 0 ? `<div style="font:17px/1.55 ui-sans-serif,system-ui,sans-serif;color:#a8bad4;padding:6px 0">
         No waste pattern detected — no cold resume, no oversized subagent output, no compaction, no repeated correction, and the context stayed clear of its limit.
       </div>` : d.findings.map((f) => {
    const dotCol = f.severity === "crit" ? "#fb7185" : "#fbbf24";
    return `<div style="display:grid;grid-template-columns:10px 1fr auto;gap:14px;align-items:start;
            padding:11px 0;border-bottom:1px solid #131f30">
          <span style="width:8px;height:8px;border-radius:50%;background:${dotCol};display:inline-block;margin-top:6px"></span>
          <span style="font:17px/1.45 ui-sans-serif,system-ui,sans-serif;color:#e8eef9">${esc(f.text)}</span>
          <span style="font:600 16px/1.45 ui-monospace,monospace;color:${dotCol};white-space:nowrap">${f.cost ? esc(f.cost) : ""}</span>
        </div>`;
  }).join("");
  const attributed = attributedTokens(d.findings);
  const attributedLine = attributed > 0 ? `<div style="display:flex;align-items:baseline;gap:10px;margin-top:14px">
         <span style="font:15px/1 ui-sans-serif,system-ui,sans-serif;color:#a8bad4">tokens attributed to findings</span>
         <span style="font:600 17px/1 ui-monospace,monospace;color:${sevColor}">~${kTok2(attributed)}</span>
         ${d.billable > 0 ? `<span style="font:15px/1 ui-monospace,monospace;color:#93a6c2">${Math.round(100 * attributed / d.billable)}% of the turn</span>` : ""}
       </div>` : "";
  const s = d.stats;
  const cells = [
    ["turn", `${d.turnOrdinal} of ${d.totalTurns}`],
    ["duration", fmtDuration(d.durationMs) || "—"],
    ...s ? [
      ["api calls", String(s.apiCalls)],
      ["tool calls", String(s.toolCalls)],
      ["subagents", String(s.subagents)],
      ["cache reads", kTok2(s.cacheRead)],
      [
        "model",
        [shortModel3(s.model), s.effort && s.effort !== "unknown" ? s.effort : ""].filter(Boolean).join(" · ") || "—"
      ]
    ] : []
  ];
  const statStrip = cells.map(([label, value]) => `
    <div style="flex:1;min-width:0">
      <div style="font:600 12px/1 ui-monospace,monospace;letter-spacing:.11em;text-transform:uppercase;color:#93a6c2;margin-bottom:8px">${esc(label)}</div>
      <div style="font:600 20px/1 ui-sans-serif,system-ui,sans-serif;color:#e8eef9;font-variant-numeric:tabular-nums;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(value)}</div>
    </div>`).join("");
  return `<div xmlns="http://www.w3.org/1999/xhtml" class="card">
<style>
*{box-sizing:border-box;margin:0;padding:0}
.card{
  width:1200px;height:628px;overflow:hidden;
  background:#05070c;
  background-image:
    radial-gradient(ellipse 700px 280px at 88% 10%,rgba(167,139,250,.06),transparent),
    radial-gradient(ellipse 560px 380px at 4% 92%,rgba(56,189,248,.05),transparent);
  font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;
  color:#dde3ef;position:relative;
}
.card::before{
  content:'';position:absolute;top:0;left:0;right:0;height:3px;
  background:linear-gradient(90deg,#38bdf8 0%,#818cf8 48%,#c084fc 100%);
}
.inner{padding:38px 56px 30px;display:flex;flex-direction:column;height:628px;position:relative;z-index:1}
.top{display:flex;align-items:center;gap:14px;margin-bottom:26px}
.wordmark{font:700 19px/1 ui-monospace,monospace;letter-spacing:.04em;
  background:linear-gradient(90deg,#38bdf8,#a78bfa);-webkit-background-clip:text;background-clip:text;color:transparent}
.kicker{font:600 13px/1 ui-monospace,monospace;letter-spacing:.15em;text-transform:uppercase;color:#93a6c2}
.badge{margin-left:auto;font:700 13px/1 ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;
  padding:7px 15px;border-radius:20px;border:1px solid ${sevColor};color:${sevColor};background:${sevBg}}
/* The card is a fixed 1200×628 frame holding 0-3 findings: the two columns are CENTRED in the
   space between the header and the stat strip, so a one-finding card does not leave a dead
   lower half (the original layout pinned everything to the top and did exactly that). */
.main{display:grid;grid-template-columns:400px 1fr;column-gap:56px;align-items:center;flex:1}
.hero{font:700 92px/.86 ui-sans-serif,system-ui,sans-serif;letter-spacing:-.045em;
  font-variant-numeric:tabular-nums;color:${sevColor};text-shadow:0 0 60px rgba(${glowRgb},.28)}
.hero-unit{font:600 24px/1 ui-sans-serif,system-ui,sans-serif;color:#a8bad4;letter-spacing:0;margin-left:10px}
.hero-label{font:16px/1.4 ui-sans-serif,system-ui,sans-serif;color:#a8bad4;margin-top:14px}
.hero-cmp{font:15px/1.4 ui-monospace,monospace;color:#93a6c2;margin-top:6px}
.fhdr{font:700 13px/1 ui-monospace,monospace;letter-spacing:.13em;text-transform:uppercase;
  color:#93a6c2;margin-bottom:14px;display:flex;align-items:center;gap:12px}
.fhdr::after{content:'';flex:1;height:1px;background:#131f30}
.strip{display:flex;gap:26px;margin-top:auto;padding:22px 0 18px;border-top:1px solid #131f30;border-bottom:1px solid #0d1725}
.footer{display:flex;align-items:center;justify-content:space-between;padding-top:14px}
.safe{font:13px/1 ui-monospace,monospace;color:#93a6c2;display:flex;align-items:center;gap:7px}
.date{font:13px/1 ui-monospace,monospace;color:#93a6c2}
</style>
<div class="inner">
  <div class="top">
    <span class="wordmark">seedeep</span>
    <span class="kicker">turn verdict</span>
    <span class="badge">${sevLabel}</span>
  </div>
  <div class="main">
    <div>
      <div class="hero">${esc(heroNum)}<span class="hero-unit">tokens</span></div>
      <div class="hero-label">spent on this turn — input, output and cache writes</div>
      <div class="hero-cmp">${esc(compare)}</div>
      ${scale}
    </div>
    <div>
      <div class="fhdr">findings${d.findings.length ? "&#160;·&#160;" + d.findings.length : ""}</div>
      ${findingsHtml}
      ${attributedLine}
    </div>
  </div>
  <div class="strip">${statStrip}</div>
  <div class="footer">
    <div class="safe">\uD83D\uDD12 Safe to share — no paths, project names or prompt text</div>
    <div class="date">${esc(d.date)}</div>
  </div>
</div>
</div>`;
}
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// apps/server/src/client/share-card-png.ts
async function renderShareCardPng(data) {
  const img = new Image;
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(shareCardSvg(data))}`;
  await new Promise((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("the card SVG did not load — malformed markup?"));
  });
  const canvas = document.createElement("canvas");
  canvas.width = CARD_W * CARD_DPR;
  canvas.height = CARD_H * CARD_DPR;
  const ctx = canvas.getContext("2d");
  if (!ctx)
    throw new Error("no 2d canvas context");
  ctx.scale(CARD_DPR, CARD_DPR);
  ctx.drawImage(img, 0, 0);
  return await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("canvas produced no PNG")), "image/png");
  });
}

// apps/server/src/core/trace-group.ts
var CHAPTER_CAP = 10;
var LANDMARK_TOOLS = new Set(["Skill", "AskUserQuestion", "ReportFindings"]);
function isLandmark(s) {
  if (s.type === "prompt" || s.type === "result" || s.type === "spawn")
    return true;
  return s.type === "tool" && LANDMARK_TOOLS.has(s.label);
}
function leafSpans(item) {
  if (item.kind === "step")
    return [item.span];
  if (item.kind === "parallel")
    return item.spans;
  return item.items.flatMap(leafSpans);
}
function mergeParallelSpawns(items) {
  const isSpawn = (it) => it != null && it.kind === "step" && it.span.type === "spawn";
  const out = [];
  for (let i = 0;i < items.length; i++) {
    const it = items[i];
    if (!isSpawn(it)) {
      out.push(it);
      continue;
    }
    const run = [it.span];
    while (isSpawn(items[i + 1]))
      run.push(items[++i].span);
    out.push(run.length === 1 ? it : { kind: "parallel", spans: run });
  }
  return out;
}
var spanMs = (s) => Math.max(0, s.t1 - s.t0);
var anyError = (item) => leafSpans(item).some((s) => s.status === "error");
function groupPathToSpan(items, spanId) {
  for (const it of items) {
    if (it.kind === "step") {
      if (it.span.id === spanId)
        return [];
      continue;
    }
    if (it.kind === "parallel") {
      if (it.spans.some((s) => s.id === spanId))
        return [];
      continue;
    }
    const inner = groupPathToSpan(it.items, spanId);
    if (inner)
      return [it.id, ...inner];
  }
  return null;
}
function itemMs(item) {
  if (item.kind === "group")
    return item.ms;
  if (item.kind === "parallel")
    return Math.max(0, ...item.spans.map(spanMs));
  return spanMs(item.span);
}
function groupTurnSpans(spans, opts) {
  const cap = opts?.cap ?? CHAPTER_CAP;
  const lastIdx = spans.length - 1;
  const flat = [];
  let cur = null;
  const closeRound = () => {
    if (cur && cur.spans.length)
      flat.push(cur);
    cur = null;
  };
  spans.forEach((s, i) => {
    if (isLandmark(s)) {
      closeRound();
      const item = { kind: "step", span: s };
      if (s.type === "result" && i < lastIdx)
        item.midResult = true;
      flat.push(item);
      return;
    }
    if (s.type === "api") {
      closeRound();
      cur = { spans: [s] };
      return;
    }
    (cur ??= { spans: [] }).spans.push(s);
  });
  closeRound();
  const out = [];
  let no = 0;
  let run = [];
  let runFrom = 0;
  const roundItem = (r) => {
    no++;
    return {
      kind: "group",
      id: "r" + no,
      label: "#" + no + " round",
      rounds: 1,
      steps: r.spans.length,
      ms: r.spans.reduce((n, s) => n + spanMs(s), 0),
      hasError: r.spans.some((s) => s.status === "error"),
      items: r.spans.map((span) => ({ kind: "step", span })),
      intents: r.spans.flatMap((s) => s.narration ? [s.narration] : [])
    };
  };
  const flushRun = () => {
    if (!run.length)
      return;
    if (run.length === 1) {
      out.push(run[0]);
      run = [];
      return;
    }
    const ss = run.flatMap(leafSpans);
    out.push({
      kind: "group",
      id: "ch" + runFrom,
      label: "R" + runFrom + "–" + no,
      rounds: run.length,
      steps: ss.length,
      ms: ss.reduce((n, s) => n + spanMs(s), 0),
      hasError: run.some(anyError),
      items: run,
      intents: ss.flatMap((s) => s.narration ? [s.narration] : [])
    });
    run = [];
  };
  flat.forEach((entry, i) => {
    if (!("spans" in entry)) {
      flushRun();
      out.push(entry);
      return;
    }
    const isLastEntry = i === flat.length - 1;
    if (isLastEntry && opts?.liveTail) {
      flushRun();
      for (const span of entry.spans)
        out.push({ kind: "step", span });
      return;
    }
    if (!run.length)
      runFrom = no + 1;
    run.push(roundItem(entry));
    if (run.length === cap)
      flushRun();
  });
  flushRun();
  return mergeParallelSpawns(out);
}

// apps/server/src/client/trace.ts
var CATV = {
  prompt: "--sp-prompt",
  api: "--sp-api",
  tool: "--sp-tool",
  skill: "--sp-skill",
  spawn: "--sp-spawn",
  subspan: "--sp-spawn",
  result: "--sp-result",
  note: "--warn"
};
var _cssCache = new Map;
function cssv(n) {
  if (_cssCache.has(n))
    return _cssCache.get(n);
  let v = "";
  if (typeof getComputedStyle !== "undefined" && typeof document !== "undefined") {
    try {
      v = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    } catch {
      v = "";
    }
  }
  _cssCache.set(n, v);
  return v;
}
function fmtDur(ms) {
  if (ms < 1000)
    return ms + "ms";
  const s = ms / 1000;
  if (s < 60)
    return (s < 10 ? s.toFixed(1) : Math.round(s)) + "s";
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return m + "m" + (r ? " " + r + "s" : "");
}
function short(s, n) {
  if (!s)
    return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function firstLine2(s) {
  for (const line of s.split(`
`)) {
    const t = line.trim();
    if (t)
      return t;
  }
  return "";
}
var plural2 = (n, w) => n + " " + w + (n === 1 ? "" : "s");
var SPARK_BINS = 30;
var SPARK_RANK = ["spawn", "skill", "tool", "result", "prompt", "api"];
function binComposition(slice) {
  const failed = slice.filter((s) => s.status === "error").length;
  const errW = failed ? Math.max(0.34, failed / slice.length) : 0;
  const out = failed ? [{ key: "err", weight: errW }] : [];
  const okTotal = slice.length - failed;
  if (okTotal > 0) {
    for (const t of SPARK_RANK) {
      const n = slice.filter((s) => s.type === t && s.status !== "error").length;
      if (n > 0)
        out.push({ key: t, weight: n / okTotal * (1 - errW) });
    }
  }
  return out;
}
function raf(fn) {
  if (typeof requestAnimationFrame !== "undefined")
    requestAnimationFrame(fn);
  else
    fn();
}
function adaptSnapshot(snap, scopeTurn) {
  const turns = scopeTurn != null ? snap.turns.filter((t) => t.index === scopeTurn) : snap.turns;
  return turns.map((turn) => {
    const mainSpans = turn.spans.filter((s) => s.lane === 0);
    const cnt = (type) => mainSpans.filter((s) => s.type === type).length;
    const spawnGroups = [];
    for (const spawnSpan of mainSpans.filter((s) => s.type === "spawn")) {
      const spawnToolUseId = spawnSpan.handle && "toolUseId" in spawnSpan.handle ? spawnSpan.handle.toolUseId : undefined;
      const traceSpawn = turn.spawns.find((sp) => sp.spawnId === spawnToolUseId);
      if (!traceSpawn) {
        spawnGroups.push({ spawnSpan, spawnGroup: null, lanes: [] });
        continue;
      }
      const lanes = traceSpawn.lanes.map((lane, laneIdx) => {
        const laneSpans = lane.spans;
        const t0 = laneSpans.length ? Math.min(...laneSpans.map((s) => s.t0)) : turn.t0;
        const t1 = laneSpans.length ? Math.max(...laneSpans.map((s) => s.t1)) : turn.t1;
        return {
          subspan: {
            id: lane.agentId ?? `lane-${laneIdx}`,
            type: "subspan",
            label: lane.label,
            agent: lane.label,
            agentId: lane.agentId,
            status: lane.status || "ok",
            t0,
            t1,
            lane: laneIdx
          },
          spans: laneSpans,
          toolCount: laneSpans.filter((s) => s.type === "subspan").length
        };
      });
      spawnGroups.push({ spawnSpan, spawnGroup: traceSpawn, lanes });
    }
    const api = cnt("api"), tool = cnt("tool");
    const failed = mainSpans.filter((s) => s.status === "error").length + turn.spawns.reduce((n, sp) => n + sp.lanes.reduce((k, ln) => k + ln.spans.filter((s) => s.status === "error").length, 0), 0);
    return {
      turn,
      api,
      tool,
      skill: cnt("skill"),
      hasError: failed > 0,
      failed,
      isIdle: turn.kind === "local" && !api && !tool && turn.spawns.length === 0,
      isLive: turn.state === "live" && (api > 0 || tool > 0 || turn.spawns.length > 0),
      ms: Math.max(0, turn.t1 - turn.t0),
      spawnGroups,
      path: mainSpans
    };
  });
}
function createTrace(container, opts = {}) {
  const onBlock = opts.onBlock ?? (() => {});
  const openTurns = new Set([0]);
  const openLanes = new Set;
  const pinnedGroups = new Set;
  let _following = false;
  let _ended = false;
  let _dense = false;
  const _failCursor = new Map;
  let _hitSpanId = null;
  let _expectedTop = null;
  let _snap = null;
  let _scopeTurn = null;
  let _model = [];
  let _segs = [];
  let scrimEl = null, modalEl = null;
  let stageEl = null, canvasEl = null;
  let spineEl = null, hsubjEl = null;
  let followBtn = null, denseBtn = null;
  let _isOpen = false;
  let onWinKeyDown = null;
  let onStageScroll = null;
  function ensureModal() {
    if (modalEl)
      return;
    const doc = document;
    scrimEl = doc.createElement("div");
    scrimEl.className = "trace-scrim";
    scrimEl.onclick = () => close();
    modalEl = doc.createElement("div");
    modalEl.className = "trace-modal";
    const hdr = doc.createElement("div");
    hdr.className = "trace-hdr";
    const htitle = doc.createElement("span");
    htitle.className = "trace-htitle";
    htitle.textContent = "Trace";
    hsubjEl = doc.createElement("span");
    hsubjEl.className = "trace-hsubj";
    const spacer = doc.createElement("span");
    spacer.className = "trace-hspacer";
    const zoom = doc.createElement("div");
    zoom.className = "trace-zoom";
    denseBtn = doc.createElement("button");
    denseBtn.className = "trace-zbtn";
    denseBtn.textContent = "Compact";
    denseBtn.title = "Smaller blocks, sub-lines hidden. Changes how the steps are drawn, " + "not which turns are open.";
    denseBtn.onclick = () => {
      _dense = !_dense;
      if (modalEl)
        modalEl.classList.toggle("dense", _dense);
      denseBtn.classList.toggle("on", _dense);
    };
    const collapseBtn = doc.createElement("button");
    collapseBtn.className = "trace-zbtn";
    collapseBtn.textContent = "Close turns";
    collapseBtn.title = "Shut every open turn. The groups inside a turn have their own " + "expand / collapse.";
    collapseBtn.onclick = () => collapseAllTurns();
    const lastBtn = doc.createElement("button");
    lastBtn.className = "trace-zbtn";
    lastBtn.textContent = "Last turn";
    lastBtn.title = "Open the newest turn and scroll to it.";
    lastBtn.onclick = () => {
      openLastTurn();
      raf(focusLastTurn);
    };
    zoom.append(denseBtn, collapseBtn, lastBtn);
    const closeBtn = doc.createElement("button");
    closeBtn.className = "trace-close";
    closeBtn.textContent = "✕";
    closeBtn.onclick = () => close();
    followBtn = doc.createElement("button");
    followBtn.className = "trace-follow hidden";
    followBtn.textContent = "follow";
    followBtn.onclick = () => {
      _following = true;
      syncFollowBtn();
      raf(focusLastTurn);
    };
    hdr.append(htitle, hsubjEl, spacer, followBtn, zoom, closeBtn);
    stageEl = doc.createElement("div");
    stageEl.className = "trace-stage";
    canvasEl = doc.createElement("div");
    canvasEl.className = "trace-canvas";
    spineEl = doc.createElement("div");
    spineEl.className = "trace-spine";
    canvasEl.append(spineEl);
    stageEl.append(canvasEl);
    modalEl.append(hdr, stageEl);
    container.append(scrimEl, modalEl);
    onStageScroll = () => {
      if (_expectedTop != null && stageEl && Math.abs(stageEl.scrollTop - _expectedTop) <= 2)
        return;
      _expectedTop = null;
      _following = false;
      syncFollowBtn();
    };
    if (stageEl.addEventListener)
      stageEl.addEventListener("scroll", onStageScroll, { passive: true });
    onWinKeyDown = (e) => {
      if (e.key === "Escape" && _isOpen)
        close();
    };
    if (typeof window !== "undefined")
      window.addEventListener("keydown", onWinKeyDown);
  }
  function setScrollTop(top) {
    if (!stageEl)
      return;
    stageEl.scrollTop = Math.max(0, top);
    _expectedTop = stageEl.scrollTop;
  }
  function focusLastTurn() {
    if (!_segs.length || !stageEl)
      return;
    const last = _segs[_segs.length - 1];
    const vh = stageEl.clientHeight || 0;
    const top = typeof last.seg.offsetTop === "number" ? last.seg.offsetTop : 0;
    setScrollTop(top - Math.round(vh * 0.2));
    if (last.m.turn.state === "live" && last.scroller) {
      const s = last.scroller;
      if (typeof s.scrollWidth === "number")
        s.scrollLeft = s.scrollWidth;
    }
  }
  function anchorLanes() {
    for (const rec of _segs) {
      if (!openTurns.has(rec.i) || !rec._laneWraps)
        continue;
      for (const { spawnEl, wrap } of rec._laneWraps) {
        const left = spawnEl && typeof spawnEl.offsetLeft === "number" ? spawnEl.offsetLeft : 0;
        wrap.style.marginLeft = Math.max(0, left - 8) + "px";
      }
    }
  }
  let _anchorQueued = false;
  function scheduleAnchor() {
    if (_anchorQueued)
      return;
    _anchorQueued = true;
    raf(() => {
      _anchorQueued = false;
      anchorLanes();
    });
  }
  function walkClass(root, cls) {
    const wanted = typeof cls === "string" ? null : cls;
    const acc = [];
    function walk(n) {
      if (!n || !n.children)
        return;
      for (const child of n.children) {
        const c = child;
        if (typeof c.className === "string") {
          const list = c.className.split(" ");
          if (wanted !== null ? list.some((x) => wanted.has(x)) : typeof cls === "string" && list.includes(cls))
            acc.push(c);
        }
        walk(child);
      }
    }
    walk(root);
    return acc;
  }
  function build() {
    spineEl.replaceChildren();
    _segs = [];
    const startCap = document.createElement("div");
    startCap.className = "cap start";
    startCap.textContent = "▼ INITIAL PROMPT";
    spineEl.append(startCap);
    const maxTurnMs = Math.max(1, ..._model.map((m) => m.ms));
    _model.forEach((m, i) => {
      const isOpen = openTurns.has(i);
      const seg = document.createElement("div");
      const isLive2 = m.isLive;
      seg.className = "tseg" + (isOpen ? " open" : "") + (m.hasError ? " has-err" : "") + (isLive2 ? " is-live" : "") + (m.isIdle ? " is-idle" : "");
      const th = document.createElement("div");
      th.className = "thead";
      const hdDiv = document.createElement("div");
      hdDiv.className = "hd";
      const idEl = document.createElement("span");
      idEl.className = "id";
      const chev = document.createElement("span");
      chev.className = "chev";
      chev.textContent = "▸";
      idEl.append(chev, document.createTextNode(" T" + m.turn.index + " · " + m.turn.kind));
      const ttl = document.createElement("div");
      ttl.className = "ttl";
      ttl.textContent = short(m.turn.title, 200);
      hdDiv.append(idEl, ttl);
      if (!m.isIdle) {
        hdDiv.append(sparkline(m.path));
        const fk = document.createElement("div");
        fk.className = "fk";
        const subagentTotal = m.spawnGroups.reduce((n, sg) => n + sg.lanes.length, 0);
        if (subagentTotal > 0)
          fk.textContent = "⑃ ×" + subagentTotal;
        hdDiv.append(fk);
        const errSlot = document.createElement("span");
        errSlot.className = "errslot";
        if (m.failed > 0) {
          const badge = document.createElement("button");
          badge.className = "terr";
          badge.textContent = plural2(m.failed, "failed step");
          badge.title = m.failed + " of this turn's steps failed (a tool error, or an API " + "call Claude Code flagged). The turn itself did not fail." + `
Click to jump to ` + (m.failed === 1 ? "it" : "each of them in turn") + ".";
          badge.onclick = (e) => {
            if (e && e.stopPropagation)
              e.stopPropagation();
            const cur = _segs[i];
            if (cur)
              jumpToFailure(cur);
          };
          errSlot.append(badge);
        }
        hdDiv.append(errSlot);
        const dur2 = document.createElement("div");
        dur2.className = "tdur";
        const bar = document.createElement("div");
        bar.className = "tbar";
        const fill = document.createElement("i");
        const share = Math.round(100 * m.ms / maxTurnMs);
        fill.style.width = Math.max(2, share) + "%";
        bar.append(fill);
        const durTxt = document.createElement("b");
        durTxt.textContent = fmtDur(m.ms);
        dur2.title = fmtDur(m.ms) + " — " + share + "% of the longest turn in this session (" + fmtDur(maxTurnMs) + ")";
        dur2.append(bar, durTxt);
        hdDiv.append(dur2);
      }
      th.append(hdDiv);
      th.onclick = () => toggleTurn(i);
      const tb = document.createElement("div");
      tb.className = "tbody";
      const ctl = document.createElement("div");
      ctl.className = "tctl";
      for (const [label, want] of [
        ["expand", true],
        ["collapse", false]
      ]) {
        const a = document.createElement("a");
        a.textContent = label;
        a.onclick = (e) => {
          if (e && e.stopPropagation)
            e.stopPropagation();
          if (want) {
            let prev = -1, holders = walkClass(tb, "gholder");
            while (holders.length !== prev) {
              holders.forEach((h) => h._traceSetOpen && h._traceSetOpen(true));
              prev = holders.length;
              holders = walkClass(tb, "gholder");
            }
          } else {
            walkClass(tb, "gholder").forEach((h) => h._traceSetOpen && h._traceSetOpen(false));
          }
        };
        ctl.append(a);
      }
      tb.append(ctl);
      seg.append(th, tb);
      spineEl.append(seg);
      const rec = { seg, thead: th, tbody: tb, built: false, m, i };
      _segs.push(rec);
      if (isOpen)
        buildBody(rec);
    });
    if (_ended || !_model.some((m) => m.isLive)) {
      const endCap = document.createElement("div");
      endCap.className = "cap end";
      endCap.textContent = "▲ FINAL RESULT";
      spineEl.append(endCap, finalResultNode());
    }
    scheduleAnchor();
  }
  function finalResultNode() {
    let span = null;
    let turn = null;
    for (let i = _model.length - 1;i >= 0 && !span; i--) {
      const m = _model[i];
      for (let j = m.path.length - 1;j >= 0; j--) {
        const s = m.path[j];
        if (s.type === "result") {
          span = s;
          turn = m.turn;
          break;
        }
      }
    }
    const fin = document.createElement("div");
    if (!span || !turn) {
      fin.className = "finres empty";
      fin.textContent = "No final answer yet";
      return fin;
    }
    fin.className = "finres";
    const id = document.createElement("span");
    id.className = "fnid";
    id.textContent = "T" + turn.index;
    const txt = document.createElement("div");
    txt.className = "fntext";
    txt.textContent = (span.detail ? stripMarkdown(span.detail) : "") || "(no text)";
    fin.append(id, txt);
    const h = span.handle;
    if (h != null)
      fin.onclick = () => onBlock(h);
    return fin;
  }
  function applyHit() {
    if (!_hitSpanId)
      return;
    for (const rec of _segs) {
      const el8 = rec._stepEls ? rec._stepEls.get(_hitSpanId) : null;
      if (el8 && el8.classList)
        el8.classList.add("hit");
    }
  }
  function makeConnSVG(col) {
    if (typeof document.createElementNS !== "function") {
      const d = document.createElement("div");
      return d;
    }
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", "38");
    svg.setAttribute("height", "44");
    const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", "2");
    line.setAttribute("y1", "22");
    line.setAttribute("x2", "28");
    line.setAttribute("y2", "22");
    line.setAttribute("stroke", col);
    line.setAttribute("stroke-width", "2");
    const arrow = document.createElementNS(ns, "path");
    arrow.setAttribute("d", "M26,16 L34,22 L26,28");
    arrow.setAttribute("fill", "none");
    arrow.setAttribute("stroke", col);
    arrow.setAttribute("stroke-width", "2");
    svg.append(line, arrow);
    return svg;
  }
  function sparkline(spans) {
    const box = document.createElement("div");
    box.className = "tspark";
    const bins = document.createElement("div");
    bins.className = "bins";
    const n = Math.min(SPARK_BINS, Math.max(1, spans.length));
    for (let b = 0;b < n; b++) {
      const from = Math.floor(b * spans.length / n);
      const to = Math.max(from + 1, Math.floor((b + 1) * spans.length / n));
      const slice = spans.slice(from, to);
      const i = document.createElement("i");
      const present = SPARK_RANK.filter((t) => slice.some((s) => s.type === t));
      const failed = slice.filter((s) => s.status === "error").length;
      i.className = [...failed ? ["err"] : [], ...present.map((t) => "t-" + t)].join(" ");
      const parts = binComposition(slice).map((p) => ({
        colour: p.key === "err" ? cssv("--sp-error") || "#fb7185" : cssv(CATV[p.key]) || "",
        weight: p.weight
      }));
      const usable = parts.filter((p) => p.colour);
      if (usable.length === 1)
        i.style.background = usable[0].colour;
      else if (usable.length > 1) {
        let at = 0;
        const stops = usable.map((p) => {
          const from2 = at;
          at = Math.min(100, at + p.weight * 100);
          return `${p.colour} ${from2.toFixed(1)}% ${at.toFixed(1)}%`;
        });
        i.style.background = `linear-gradient(to bottom, ${stops.join(", ")})`;
      }
      bins.append(i);
    }
    const num = document.createElement("span");
    num.className = "n";
    num.textContent = plural2(spans.length, "step");
    box.append(bins, num);
    return box;
  }
  function typeDots(spans, max = 14) {
    const box = document.createElement("span");
    box.className = "gdots";
    spans.slice(0, max).forEach((s) => {
      const i = document.createElement("i");
      if (s.status === "error") {
        i.className = "err";
      } else {
        const cv = cssv(CATV[s.type]);
        if (cv)
          i.style.background = cv;
      }
      box.append(i);
    });
    if (spans.length > max) {
      const m = document.createElement("span");
      m.className = "more";
      m.textContent = "+" + (spans.length - max);
      box.append(m);
    }
    return box;
  }
  function durBar(ms, max) {
    const b = document.createElement("div");
    b.className = "dbar";
    const i = document.createElement("i");
    i.style.width = Math.max(2, Math.round(100 * ms / Math.max(1, max))) + "%";
    b.append(i);
    return b;
  }
  function makeStepNode(item, rec, max) {
    const m = rec.m;
    const s = item.span;
    const isSpawn = s.type === "spawn";
    const isMid = item.midResult === true;
    const sn = document.createElement("div");
    const cls = [
      "snode",
      s.type === "prompt" ? "start" : "",
      s.type === "result" ? "end" + (isMid ? " mid" : "") : "",
      isSpawn ? "spawn" + (openLanes.has(s.id) ? " on" : "") : "",
      s.status === "error" ? "err" : ""
    ].filter(Boolean).join(" ");
    sn.className = cls;
    if (!isSpawn && s.type !== "prompt" && s.type !== "result") {
      const cv = cssv(CATV[s.type]);
      if (cv)
        sn.style.setProperty("--c", cv);
    }
    const slDiv = document.createElement("div");
    slDiv.className = "sl";
    const dot = document.createElement("i");
    const stepLabel = s.type === "result" ? isMid ? "reply" : "done" : isSpawn ? s.detail || s.label : s.label;
    const st = document.createElement("span");
    st.className = "st";
    st.textContent = (isSpawn ? "⑃ " : "") + short(stepLabel.replace(/ · (fan-out|background)/, ""), 20);
    slDiv.append(dot, st);
    if (s.background) {
      const bg = document.createElement("span");
      bg.className = "sbg";
      bg.textContent = "bg";
      bg.title = "Launched in the background. The duration is the LAUNCH; the command itself may still be " + "running — Claude Code reports it only when it ends.";
      slDiv.append(bg);
    }
    if (s.flagged) {
      const fl = document.createElement("span");
      fl.className = "sflag";
      fl.textContent = "⚑";
      fl.title = "A hook attached a note to this call — open it to read what it said.";
      slDiv.append(fl);
    }
    const ssDiv = document.createElement("div");
    ssDiv.className = "ss";
    if (isSpawn) {
      const sg = m.spawnGroups.find((g) => g.spawnSpan.id === s.id);
      const lanes = sg ? sg.lanes : [];
      const lane = lanes.length ? lanes[0] : null;
      const isWf = Boolean(sg && sg.spawnGroup && sg.spawnGroup.kind === "Workflow");
      const toolWord = (n) => n + (n === 1 ? " tool" : " tools");
      let base;
      if (isWf) {
        base = plural2(sg.spawnGroup.lanes.length, "agent");
      } else if (lanes.length > 1) {
        const total = lanes.reduce((n, ln) => n + ln.toolCount, 0);
        const ms = Math.max(...lanes.map((ln) => ln.subspan.t1 - ln.subspan.t0));
        base = lanes.length + " subagents · " + toolWord(total) + " · " + fmtDur(ms);
      } else if (lane) {
        base = short(lane.subspan.agent || "", 24) + " · " + toolWord(lane.toolCount) + " · " + fmtDur(lane.subspan.t1 - lane.subspan.t0);
      } else {
        base = null;
      }
      const openHint = " · ▾ fold", closedHint = isWf ? " · ▸ expand" : " · ▸ expand flow";
      ssDiv.textContent = base == null ? "no child data yet" : base + (openLanes.has(s.id) ? openHint : closedHint);
      const snSpawn = sn;
      snSpawn._traceSsBase = base;
      snSpawn._traceHints = { openHint, closedHint };
      const gi = document.createElement("span");
      gi.className = "gi";
      gi.textContent = "ⓘ";
      gi.onclick = (e) => {
        if (e && e.stopPropagation)
          e.stopPropagation();
        const toolUseId = s.handle && "toolUseId" in s.handle ? s.handle.toolUseId : undefined;
        onBlock({ kind: "subagent", agentId: lane ? lane.subspan.agentId ?? null : null, toolUseId });
      };
      slDiv.append(gi);
      sn.append(slDiv, ssDiv);
      sn.onclick = (e) => {
        if (e && e.stopPropagation)
          e.stopPropagation();
        toggleLane(rec, s.id, sn);
      };
      if (rec._spawnEls)
        rec._spawnEls.set(s.id, sn);
    } else {
      const ms = s.t1 - s.t0;
      const detail = s.type === "api" ? "" : s.detail || "";
      const parts = [detail, ms > 0 ? fmtDur(ms) : ""].filter(Boolean);
      ssDiv.textContent = parts.join(" · ");
      sn.append(slDiv, ssDiv);
      if (ms > 0)
        sn.append(durBar(ms, max));
      const suppress = isMid && s.type === "result";
      if (s.handle != null && !suppress) {
        const h = s.handle;
        sn.onclick = () => onBlock(h);
      }
    }
    if (rec._stepEls)
      rec._stepEls.set(s.id, sn);
    return sn;
  }
  function makeParallelNode(item, rec) {
    const groups = item.spans.map((s) => rec.m.spawnGroups.find((g) => g.spawnSpan.id === s.id)).filter(Boolean);
    const lanes = groups.flatMap((g) => g.lanes);
    const tools = lanes.reduce((n, ln) => n + ln.toolCount, 0);
    const ms = lanes.length ? Math.max(...lanes.map((ln) => ln.subspan.t1 - ln.subspan.t0)) : 0;
    const sn = document.createElement("div");
    const open2 = item.spans.every((s) => openLanes.has(s.id));
    sn.className = "snode spawn par" + (open2 ? " on" : "");
    const slDiv = document.createElement("div");
    slDiv.className = "sl";
    const st = document.createElement("span");
    st.className = "st";
    st.textContent = "⑃ " + item.spans.length + " in parallel";
    slDiv.append(document.createElement("i"), st);
    const ssDiv = document.createElement("div");
    ssDiv.className = "ss";
    const base = lanes.length ? plural2(lanes.length, "subagent") + " · " + plural2(tools, "tool") + " · " + fmtDur(ms) : plural2(item.spans.length, "subagent") + " · no child data yet";
    const openHint = " · ▾ fold", closedHint = " · ▸ expand flow";
    ssDiv.textContent = base + (open2 ? openHint : closedHint);
    sn._traceSsBase = base;
    sn._traceHints = { openHint, closedHint };
    const pk = document.createElement("div");
    pk.className = "pk";
    for (const ln of lanes) {
      const i = document.createElement("i");
      if (ln.spans.some((s) => s.status === "error") || ln.subspan.status === "error")
        i.className = "err";
      pk.append(i);
    }
    sn.append(slDiv, ssDiv, pk);
    sn.onclick = (e) => {
      if (e && e.stopPropagation)
        e.stopPropagation();
      const wantOpen = !item.spans.every((s) => openLanes.has(s.id));
      for (const s of item.spans) {
        if (wantOpen)
          openLanes.add(s.id);
        else
          openLanes.delete(s.id);
      }
      if (sn.classList)
        sn.classList.toggle("on", wantOpen);
      const ss = walkClass(sn, "ss")[0];
      if (ss)
        ss.textContent = base + (wantOpen ? openHint : closedHint);
      renderLanes(rec);
      scheduleAnchor();
    };
    if (rec._spawnEls)
      for (const s of item.spans)
        rec._spawnEls.set(s.id, sn);
    return sn;
  }
  function renderItem(parent, item, rec, ns, max) {
    if (item.kind === "step") {
      parent.append(makeStepNode(item, rec, max));
      return;
    }
    if (item.kind === "parallel") {
      parent.append(makeParallelNode(item, rec));
      return;
    }
    const key = rec.m.turn.index + ":" + (ns || "") + item.id;
    const tint = cssv(item.rounds > 1 ? "--sp-chapter" : "--sp-round");
    const err = item.hasError;
    const isRound = item.rounds === 1;
    const intent = isRound ? item.intents[0] ?? null : null;
    const g = document.createElement("div");
    g.className = "gnode" + (err ? " err" : "") + (intent ? " gnamed" : "");
    if (tint)
      g.style.setProperty("--g", tint);
    const gl = document.createElement("div");
    gl.className = "gl";
    gl.textContent = intent ? firstLine2(intent) : item.label;
    const gs = document.createElement("div");
    gs.className = "gs";
    gs.textContent = intent ? item.label.replace(" round", "") + " · " + plural2(item.steps, "step") + " · " + fmtDur(item.ms) : !isRound && item.intents.length > 0 ? plural2(item.rounds, "round") + " · " + plural2(item.intents.length, "intent") + " · " + fmtDur(item.ms) : (item.rounds > 1 ? plural2(item.rounds, "round") + " · " : "") + plural2(item.steps, "step") + " · " + fmtDur(item.ms);
    if (intent)
      g.title = intent;
    else if (item.intents.length > 0)
      g.title = item.intents.map(firstLine2).join(`
`);
    const gx = document.createElement("div");
    gx.className = "gx";
    gx.textContent = "▸ expand";
    g.append(gl, gs, typeDots(leafSpans(item)), gx, durBar(item.ms, max));
    const frame = document.createElement("div");
    frame.className = "gframe";
    if (tint)
      frame.style.setProperty("--g", tint);
    const cap = document.createElement("button");
    cap.className = "gcap" + (err ? " err" : "");
    cap.textContent = "▾ " + item.label;
    const inner = document.createElement("div");
    inner.className = "ginner";
    frame.append(cap, inner);
    let built = false;
    const holder = document.createElement("span");
    holder.className = "gholder";
    holder.append(g);
    const setOpen = (want) => {
      if (want && !built) {
        const inMax = stripMax(item.items);
        renderItems(inner, item.items, rec, ns, inMax);
        built = true;
      }
      if (want)
        pinnedGroups.add(key);
      else
        pinnedGroups.delete(key);
      holder.replaceChildren(want ? frame : g);
      scheduleAnchor();
    };
    g.onclick = (e) => {
      if (e && e.stopPropagation)
        e.stopPropagation();
      setOpen(true);
    };
    cap.onclick = (e) => {
      if (e && e.stopPropagation)
        e.stopPropagation();
      setOpen(false);
    };
    holder._traceSetOpen = setOpen;
    parent.append(holder);
    if (pinnedGroups.has(key))
      setOpen(true);
  }
  function renderItems(parent, items, rec, ns, max) {
    const col = cssv("--border2") || "#2b3242";
    items.forEach((item, i) => {
      if (i > 0) {
        const conn = document.createElement("div");
        conn.className = "conn";
        conn.append(makeConnSVG(col));
        parent.append(conn);
      }
      renderItem(parent, item, rec, ns, max);
    });
  }
  const stripMax = (items) => Math.max(1, ...items.map(itemMs));
  const BLOCK_CLASSES = new Set(["snode", "gnode"]);
  const walkBlocks = (root) => walkClass(root, BLOCK_CLASSES);
  function markLiveTail(container2) {
    const blocks = walkBlocks(container2);
    const tail = blocks[blocks.length - 1];
    if (tail && tail.classList && tail.className.includes("snode"))
      tail.classList.add("tail");
  }
  function buildBody(rec) {
    if (rec.built)
      return;
    const m = rec.m;
    const dflow = document.createElement("div");
    dflow.className = "dflow";
    rec.dflow = dflow;
    rec._spawnEls = new Map;
    rec._stepEls = new Map;
    const live = m.turn.state === "live";
    const items = groupTurnSpans(m.path, { liveTail: live });
    renderItems(dflow, items, rec, "", stripMax(items));
    if (live)
      markLiveTail(dflow);
    const lanesBox = document.createElement("div");
    lanesBox.className = "lanes";
    rec.lanesBox = lanesBox;
    const scroller = document.createElement("div");
    scroller.className = "striproll";
    scroller.append(dflow, lanesBox);
    rec.scroller = scroller;
    rec.tbody.append(scroller);
    renderLanes(rec);
    rec.built = true;
  }
  function toggleLane(rec, spawnId, spawnEl) {
    if (openLanes.has(spawnId))
      openLanes.delete(spawnId);
    else
      openLanes.add(spawnId);
    const open2 = openLanes.has(spawnId);
    if (spawnEl && spawnEl.classList)
      spawnEl.classList.toggle("on", open2);
    const spawnNode = spawnEl;
    if (spawnNode._traceSsBase != null) {
      const ss = walkClass(spawnEl, "ss")[0];
      if (ss)
        ss.textContent = spawnNode._traceSsBase + (open2 ? spawnNode._traceHints.openHint : spawnNode._traceHints.closedHint);
    }
    renderLanes(rec);
    scheduleAnchor();
  }
  function renderLanes(rec) {
    const lanesBox = rec.lanesBox;
    if (!lanesBox)
      return;
    lanesBox.replaceChildren();
    rec._laneWraps = [];
    rec.m.spawnGroups.forEach((sg) => {
      if (!openLanes.has(sg.spawnSpan.id))
        return;
      const spawnEl = rec._spawnEls ? rec._spawnEls.get(sg.spawnSpan.id) : null;
      if (!spawnEl)
        return;
      const wrap = document.createElement("div");
      const rawLanes = sg.spawnGroup ? sg.spawnGroup.lanes : [];
      if (sg.spawnGroup && sg.spawnGroup.kind === "Workflow") {
        const grid = document.createElement("div");
        grid.className = "wf-grid";
        rawLanes.forEach((ln, k) => {
          const mini = document.createElement("div");
          mini.className = "amini" + (ln.status === "error" ? " err" : "");
          mini.textContent = String(k);
          const spawnToolUseId = sg.spawnSpan.handle && "toolUseId" in sg.spawnSpan.handle ? sg.spawnSpan.handle.toolUseId : undefined;
          mini.onclick = () => onBlock({ kind: "subagent", agentId: ln.agentId ?? null, toolUseId: spawnToolUseId });
          if (rec._stepEls)
            for (const s of ln.spans)
              rec._stepEls.set(s.id, mini);
          grid.append(mini);
        });
        wrap.append(grid);
      } else if (rawLanes.length === 0 || rawLanes.every((ln) => !ln.spans.length)) {
        const strip = document.createElement("div");
        strip.className = "lane-strip";
        const note = document.createElement("div");
        note.className = "lane-empty";
        note.textContent = "no child events (background agent)";
        strip.append(note);
        wrap.append(strip);
      } else {
        const merged = spawnEl.className.includes("par");
        rawLanes.forEach((ln) => {
          if (rawLanes.length > 1 || merged) {
            const name = document.createElement("div");
            name.className = "lane-name";
            const intent = merged ? short(sg.spawnSpan.detail || sg.spawnSpan.label, 40) : "";
            name.textContent = "⑃ " + (merged && intent ? intent + " — " : "") + (ln.label || "subagent");
            const spToolUseId = sg.spawnSpan.handle && "toolUseId" in sg.spawnSpan.handle ? sg.spawnSpan.handle.toolUseId : undefined;
            name.onclick = () => onBlock({ kind: "subagent", agentId: ln.agentId ?? null, toolUseId: spToolUseId });
            wrap.append(name);
          }
          const strip = document.createElement("div");
          strip.className = "lane-strip";
          if (ln.spans.length) {
            const running = rec.m.turn.state === "live" && !ln.status;
            const laneSpans = ln.spans.map((x) => x.type === "subspan" ? { ...x, type: "tool" } : x);
            const laneItems = groupTurnSpans(laneSpans, { liveTail: running });
            renderItems(strip, laneItems, rec, "lane:" + sg.spawnSpan.id + ":" + (ln.agentId ?? "") + ":", stripMax(laneItems));
            if (running)
              markLiveTail(strip);
          } else {
            const note = document.createElement("div");
            note.className = "lane-empty";
            note.textContent = "no child events (background agent)";
            strip.append(note);
          }
          wrap.append(strip);
        });
      }
      const left = typeof spawnEl.offsetLeft === "number" ? spawnEl.offsetLeft : 0;
      wrap.style.marginLeft = Math.max(0, left - 8) + "px";
      lanesBox.append(wrap);
      rec._laneWraps.push({ spawnEl, wrap });
    });
    applyHit();
  }
  function toggleTurn(i) {
    const rec = _segs[i];
    if (!rec)
      return;
    if (openTurns.has(i)) {
      openTurns.delete(i);
      rec.seg.classList.remove("open");
    } else {
      openTurns.add(i);
      if (!rec.built)
        buildBody(rec);
      rec.seg.classList.add("open");
    }
    scheduleAnchor();
  }
  function failTargets(m) {
    const out = m.path.filter((s) => s.status === "error").map((s) => ({ spanId: s.id, ns: "", spawnSpanId: null }));
    for (const sg of m.spawnGroups) {
      for (const lane of sg.lanes) {
        for (const s of lane.spans) {
          if (s.status !== "error")
            continue;
          out.push({
            spanId: s.id,
            ns: "lane:" + sg.spawnSpan.id + ":" + (lane.subspan.agentId ?? "") + ":",
            spawnSpanId: sg.spawnSpan.id
          });
        }
      }
    }
    return out;
  }
  function jumpToFailure(rec) {
    const targets = failTargets(rec.m);
    if (!targets.length)
      return;
    const cursor = (_failCursor.get(rec.i) ?? -1) + 1;
    _failCursor.set(rec.i, cursor % targets.length);
    const t = targets[cursor % targets.length];
    const mainItems = groupTurnSpans(rec.m.path, { liveTail: rec.m.turn.state === "live" });
    if (t.spawnSpanId) {
      const run = mainItems.find((it) => it.kind === "parallel" && it.spans.some((s) => s.id === t.spawnSpanId));
      if (run && run.kind === "parallel")
        for (const s of run.spans)
          openLanes.add(s.id);
      else
        openLanes.add(t.spawnSpanId);
    }
    const strip = t.ns ? (() => {
      const sg = rec.m.spawnGroups.find((g) => g.spawnSpan.id === t.spawnSpanId);
      const lane = sg?.lanes.find((l) => l.spans.some((s) => s.id === t.spanId));
      const spans = (lane?.spans ?? []).map((x) => x.type === "subspan" ? { ...x, type: "tool" } : x);
      return groupTurnSpans(spans, { liveTail: rec.m.turn.state === "live" && !lane?.subspan.status });
    })() : mainItems;
    for (const id of groupPathToSpan(strip, t.spanId) ?? []) {
      pinnedGroups.add(rec.m.turn.index + ":" + t.ns + id);
    }
    if (!openTurns.has(rec.i))
      openTurns.add(rec.i);
    _following = false;
    syncFollowBtn();
    _hitSpanId = t.spanId;
    build();
    const fresh = _segs[rec.i];
    const el8 = fresh && fresh._stepEls ? fresh._stepEls.get(t.spanId) : null;
    if (!el8)
      return;
    if (typeof el8.scrollIntoView === "function")
      el8.scrollIntoView({ block: "center", inline: "center" });
    if (stageEl)
      _expectedTop = stageEl.scrollTop;
  }
  function collapseAllTurns() {
    for (const rec of [..._segs])
      if (openTurns.has(rec.i))
        toggleTurn(rec.i);
  }
  function openLastTurn() {
    if (!_segs.length)
      return;
    const last = _segs[_segs.length - 1];
    if (!openTurns.has(last.i))
      toggleTurn(last.i);
  }
  function syncFollowBtn() {
    if (!followBtn)
      return;
    const live = _model.some((m) => m.isLive);
    followBtn.classList.toggle("hidden", _following || _scopeTurn != null || !live);
  }
  function setSubject(snap) {
    if (!hsubjEl)
      return;
    const named = snap.turns.find((t) => t.spans.some((s) => s.lane === 0 && (s.type === "api" || s.type === "tool")));
    hsubjEl.textContent = short((named ?? snap.turns[0])?.title ?? "session", 90);
  }
  function open(snap, scopeTurn, ended2 = false) {
    _snap = snap;
    _ended = ended2;
    _scopeTurn = scopeTurn ?? null;
    _model = adaptSnapshot(snap, _scopeTurn);
    openTurns.clear();
    openLanes.clear();
    pinnedGroups.clear();
    _failCursor.clear();
    _hitSpanId = null;
    if (_scopeTurn == null) {
      const lastIdx = _model.length > 0 ? _model.length - 1 : 0;
      openTurns.add(lastIdx);
      _following = true;
    } else {
      openTurns.add(0);
      _following = false;
    }
    ensureModal();
    scrimEl.classList.add("on");
    modalEl.classList.add("on");
    _isOpen = true;
    setSubject(snap);
    syncFollowBtn();
    if (modalEl)
      modalEl.classList.toggle("dense", _dense);
    build();
    setScrollTop(0);
    if (_following)
      raf(focusLastTurn);
  }
  function update(snap, ended2 = false) {
    if (!_isOpen)
      return;
    _snap = snap;
    _ended = ended2;
    _model = adaptSnapshot(snap, _scopeTurn);
    if (_following && _scopeTurn == null && _model.length > 0) {
      openTurns.add(_model.length - 1);
    }
    const keepTop = stageEl ? stageEl.scrollTop : 0;
    const keepLeft = new Map;
    for (const rec of _segs) {
      const left = rec.scroller ? rec.scroller.scrollLeft : 0;
      if (typeof left === "number" && left > 0)
        keepLeft.set(rec.i, left);
    }
    syncFollowBtn();
    build();
    for (const rec of _segs) {
      const left = keepLeft.get(rec.i);
      if (left != null && rec.scroller)
        rec.scroller.scrollLeft = left;
    }
    if (_following && _scopeTurn == null)
      raf(focusLastTurn);
    else if (keepTop)
      setScrollTop(keepTop);
  }
  function close() {
    if (!modalEl)
      return;
    scrimEl.classList.remove("on");
    modalEl.classList.remove("on");
    _isOpen = false;
  }
  function destroy() {
    if (typeof window !== "undefined" && onWinKeyDown)
      window.removeEventListener("keydown", onWinKeyDown);
    if (stageEl && onStageScroll && stageEl.removeEventListener)
      stageEl.removeEventListener("scroll", onStageScroll);
    _isOpen = false;
  }
  return {
    open,
    update,
    close,
    isOpen: () => _isOpen,
    destroy,
    _releaseFollow: () => {
      _following = false;
      syncFollowBtn();
    }
  };
}

// apps/server/src/client/graph.ts
var sharedBaseline = null;
var baselineFetch = null;
var BASELINE_TIMEOUT_MS = 1e4;
var SHARE_CARD_TIMEOUT_MS = 30000;
function ensureBaseline(onReady) {
  if (sharedBaseline)
    return;
  if (!baselineFetch) {
    baselineFetch = withDeadline((signal) => authFetch("/api/baseline", { signal }).then((r) => r.ok ? r.json() : null), BASELINE_TIMEOUT_MS).then((b) => {
      sharedBaseline = b;
    }).catch(() => {
      baselineFetch = null;
    });
  }
  baselineFetch.then(() => {
    if (sharedBaseline)
      onReady();
  });
}
function k(n) {
  const a = Math.abs(n);
  if (a >= 1e9)
    return (n / 1e9).toFixed(1) + "B";
  if (a >= 1e6)
    return (n / 1e6).toFixed(1) + "M";
  if (a >= 1000)
    return (n / 1000).toFixed(1) + "k";
  return String(n);
}
function kc(n) {
  const a = Math.abs(n);
  if (a >= 1e9)
    return Math.round(n / 1e9) + "B";
  if (a >= 1e6)
    return Math.round(n / 1e6) + "M";
  if (a >= 1000)
    return Math.round(n / 1000) + "k";
  return String(n);
}
function kd(n) {
  const s = n < 0 ? "-" : "+";
  const a = Math.abs(n);
  if (a >= 1e9)
    return s + (a / 1e9).toFixed(1) + "B";
  if (a >= 1e6)
    return s + (a / 1e6).toFixed(1) + "M";
  if (a >= 1000)
    return s + (a / 1000).toFixed(1) + "k";
  return s + a;
}
function E(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls)
    e.className = cls;
  if (text != null)
    e.textContent = text;
  return e;
}
function turnsWord(n) {
  return n === 1 ? "turn" : "turns";
}
function nTurns(n) {
  return n + " " + turnsWord(n);
}
function legendItem(color, txt) {
  const g = E("span", "lg");
  const sw = E("span", "sw");
  sw.style.background = color;
  g.append(sw, document.createTextNode(txt));
  return g;
}
function thinkingSplit(thinking, output) {
  const box = E("div", "tsplit");
  const bar = E("div", "tsbar");
  const share = Math.max(0, Math.min(1, output > 0 ? thinking / output : 0));
  const a = E("i");
  a.style.width = share * 100 + "%";
  const b = E("i", "answer");
  b.style.width = (1 - share) * 100 + "%";
  bar.append(a, b);
  const key = E("div", "tskey");
  const one = (cls, label, n) => {
    const sp = E("span", cls);
    sp.append(E("i"), document.createTextNode(label + " "), E("b", null, k(n)));
    return sp;
  };
  key.append(one("think", "thinking", thinking), one("answer", "answer", output - thinking));
  box.append(bar, key);
  return box;
}
var scrollLocks = 0;
function lockPageScroll() {
  if (scrollLocks++ === 0) {
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
  }
}
function unlockPageScroll() {
  if (scrollLocks > 0 && --scrollLocks === 0) {
    document.documentElement.style.overflow = "";
    document.body.style.overflow = "";
  }
}
function turnGroup(label, meta, rows, open, onToggle) {
  const g = E("div", "tgroup" + (open ? " open" : ""));
  const head = E("button", "tghead");
  head.type = "button";
  head.setAttribute("aria-expanded", String(open));
  head.append(E("span", "tgarrow", "▸"), E("span", "tglabel", label), E("span", "tgmeta", meta));
  const body = E("div", "tgbody");
  const fill = () => {
    for (const r of rows())
      body.append(r);
  };
  if (open)
    fill();
  head.onclick = () => {
    const nowOpen = !g.classList.contains("open");
    g.classList.toggle("open", nowOpen);
    head.setAttribute("aria-expanded", String(nowOpen));
    if (nowOpen)
      fill();
    else
      body.replaceChildren();
    onToggle(nowOpen);
  };
  g.append(head, body);
  return g;
}
function createGraph(container, state, opts = {}) {
  const root = E("div", "graph-root");
  let ended2 = opts.ended ?? false;
  let busy = false;
  const working2 = (t, s = lastSnap) => !!t && turnIsWorking(t, s?.turnList.at(-1)?.index === t.index, { ended: ended2, busy });
  if (ended2)
    root.classList.add("ended");
  let waiting = null;
  let waitingSince = null;
  const toprow = E("div", "toprow");
  const stack = E("div", "stack");
  const ctxCard = E("div", "card");
  let liveScrollTop = 0;
  const subLiveCard = E("div", "card sublivecard");
  stack.append(ctxCard, subLiveCard);
  const liveCard = E("div", "card livecard");
  const liveHead = E("div");
  liveHead.style.display = "flex";
  liveHead.style.flexDirection = "column";
  liveHead.style.gap = "5px";
  const liveTitle = E("div", "wtitle", "Live activity");
  const liveBadge = E("span", "live");
  liveBadge.append(E("span", "pulse"), document.createTextNode("live"));
  const endBadge = E("span", "endbadge hidden");
  endBadge.append(E("span", "edot"), document.createTextNode("ended"));
  const traceBtn = E("button", "tracebtn", "Trace");
  const liveExpand = E("button", "xbtn", "Expand all");
  const liveTitleRow = E("div");
  liveTitleRow.style.display = "flex";
  liveTitleRow.style.alignItems = "center";
  liveTitleRow.style.justifyContent = "space-between";
  const liveTitleLeft = E("div");
  liveTitleLeft.style.display = "flex";
  liveTitleLeft.style.alignItems = "center";
  liveTitleLeft.style.gap = "10px";
  liveTitleLeft.append(liveTitle, liveExpand);
  const liveBadgeWrap = E("div");
  liveBadgeWrap.style.display = "flex";
  liveBadgeWrap.style.alignItems = "center";
  liveBadgeWrap.style.gap = "6px";
  liveBadgeWrap.append(traceBtn, liveBadge, endBadge);
  liveTitleRow.append(liveTitleLeft, liveBadgeWrap);
  liveHead.append(liveTitleRow);
  const nowPanel = E("div", "nowpanel");
  const nowHead = E("div", "nowhead");
  const nowLbl = E("span", "nowlbl", "now");
  const nowAge = E("span", "nowage", "");
  nowHead.append(nowLbl, nowAge);
  const nowTick = E("span");
  let nowTickArmed = false;
  const nowTextWrap = E("div", "nowtextwrap");
  const nowText = E("div", "nowtext");
  const nowMore = E("button", "nowmore", "more");
  nowTextWrap.append(nowText, nowMore);
  nowPanel.append(nowHead, nowTextWrap);
  const feedHost = E("div", "feed");
  feedHost.style.marginTop = ".4rem";
  liveCard.append(liveHead, nowPanel, feedHost);
  toprow.append(stack, liveCard);
  const statsRow = E("div", "statsrow");
  const usageCard = E("div", "card statw burnw");
  const skillsCard = E("div", "cpart");
  const commandsCard = E("div", "cpart");
  const skCombo = E("div", "card");
  const combo = E("div", "combo");
  combo.append(skillsCard, commandsCard);
  skCombo.append(combo);
  const toolsCard = E("div", "card");
  const toolsHead = E("div", "whead");
  const toolsExpand = E("button", "xbtn", "Expand all");
  toolsHead.append(E("div", "wtitle", "Main tools"), toolsExpand);
  const toolsHost = E("div");
  toolsCard.append(toolsHead, E("div", "wdesc", "Top context consumers first, then all tool types as counts. Click a type to browse its calls, or Expand all for the full list."), toolsHost);
  const filesCard = E("div", "card statw burnw");
  const filesHead = E("div", "whead");
  const filesExpand = E("button", "xbtn", "Expand all");
  filesHead.append(E("div", "wtitle", "Changed files"), filesExpand);
  const filesHost = E("div");
  const filesDesc = E("div", "wdesc", "How many project files changed in scope.");
  filesCard.append(filesHead, filesDesc, filesHost);
  statsRow.append(usageCard, skCombo, filesCard);
  const outRow = E("div", "outrow triple");
  const commitsCard = E("div", "card statw burnw");
  const commitsHead = E("div", "whead");
  const commitsExpand = E("button", "xbtn", "Expand all");
  commitsExpand.hidden = true;
  commitsHead.append(E("div", "wtitle", "Commits"), commitsExpand);
  const commitsHost = E("div");
  commitsCard.append(commitsHead, commitsHost);
  const cardsCard = E("div", "card statw burnw");
  const cardsHead = E("div", "whead");
  const cardsExpand = E("button", "xbtn", "Expand all");
  cardsExpand.hidden = true;
  cardsHead.append(E("div", "wtitle", "Cards"), cardsExpand);
  const cardsHost = E("div");
  cardsCard.append(cardsHead, cardsHost);
  outRow.append(toolsCard, commitsCard, cardsCard);
  const subsCard = E("div", "card");
  const subsHead = E("div", "whead");
  const subsTitleWrap = E("div");
  const subsTabs = E("div", "cardtabs");
  subsHead.append(subsTitleWrap, subsTabs);
  const subsHost = E("div", "subgrid");
  subsHost.style.marginTop = ".3rem";
  const bgHost = E("div", "sublist bgcatalogue");
  subsCard.append(subsHead, subsHost, bgHost);
  const turnExplorerDiv = E("div");
  const scopeBanner = E("div", "scope-banner");
  scopeBanner.onclick = () => {
    stripOpen = !stripOpen;
    render();
  };
  root.append(scopeBanner, turnExplorerDiv, toprow, statsRow, outRow, subsCard);
  const scrim = E("div", "scrim");
  const drawer = E("div", "drawer");
  const dclose = E("button", "close", "✕");
  const dbody = E("div");
  drawer.append(dclose, dbody);
  const omodal = E("div", "omodal");
  const oscrim = E("div", "oscrim");
  const obox = E("div", "obox");
  const ohead = E("div", "ohead");
  const otitleWrap = E("div");
  const otitle = E("h3", null, "Output");
  const osub = E("div", "osub");
  otitleWrap.append(otitle, osub);
  const oclose = E("button", "oclose", "✕");
  ohead.append(otitleWrap, oclose);
  const obody = E("div", "obody");
  obox.append(ohead, obody);
  omodal.append(oscrim, obox);
  const spmodal = E("div", "spmodal");
  const spbox = E("div", "spbox");
  const spimg = document.createElement("img");
  spimg.alt = "Share card preview";
  const spfoot = E("div", "spfoot");
  const sptitle = E("span", "sptitle");
  const spactions = E("div", "spactions");
  const spdlBtn = E("button", "sbout sbout-share", "⬇ Download");
  const spcloseBtn = E("button", "sbout", "Close");
  spactions.append(spcloseBtn, spdlBtn);
  spfoot.append(sptitle, spactions);
  spbox.append(spimg, spfoot);
  spmodal.append(spbox);
  let sharePngUrl = null;
  let sharePngFile = "seedeep-share.png";
  function openSharePreview(url, filename) {
    if (sharePngUrl)
      URL.revokeObjectURL(sharePngUrl);
    sharePngUrl = url;
    sharePngFile = filename;
    spimg.src = url;
    sptitle.textContent = filename;
    spmodal.classList.add("on");
    lockPageScroll();
  }
  function closeSharePreview() {
    spmodal.classList.remove("on");
    unlockPageScroll();
    if (sharePngUrl) {
      URL.revokeObjectURL(sharePngUrl);
      sharePngUrl = null;
    }
    spimg.src = "";
  }
  spmodal.onclick = closeSharePreview;
  spbox.onclick = (e) => e.stopPropagation();
  spcloseBtn.onclick = closeSharePreview;
  spdlBtn.onclick = () => {
    if (!sharePngUrl)
      return;
    const a = document.createElement("a");
    a.href = sharePngUrl;
    a.download = sharePngFile;
    a.click();
  };
  const toasts = E("div", "toasts");
  const subToasts = E("div", "toasts bottom");
  container.append(root, scrim, drawer, omodal, spmodal, toasts, subToasts);
  const spanStore = createSpanStore();
  let trace = null;
  let traceRafPending = false;
  let selectedTurn = null, stripOpen = false, activeFilter = "all";
  let bottomTab = "subs";
  let openActivityTurns = null;
  let openToolTurns = null;
  let lastSnap = null;
  let verdicts = new Map;
  const announced = new Set;
  const loadToolOutput = opts.loadToolOutput ?? null;
  const loadCallIO = opts.loadCallIO ?? null;
  const loadAgentPrompt = opts.loadAgentPrompt ?? null;
  const loadCommits = opts.loadCommits ?? null;
  const loadFiles = opts.loadFiles ?? null;
  const loadCards = opts.loadCards ?? null;
  function openDrawer() {
    const spacer = E("div", "drawer-spacer");
    dbody.append(spacer);
    if (!drawer.classList.contains("on"))
      lockPageScroll();
    scrim.classList.add("on");
    drawer.classList.add("on");
    toasts.classList.add("shifted");
    subToasts.classList.add("shifted");
  }
  function closeDrawer() {
    if (drawer.classList.contains("on"))
      unlockPageScroll();
    scrim.classList.remove("on");
    drawer.classList.remove("on");
    toasts.classList.remove("shifted");
    subToasts.classList.remove("shifted");
  }
  scrim.onclick = closeDrawer;
  dclose.onclick = closeDrawer;
  const crumbs = [];
  function renderCrumbs() {
    if (!crumbs.length)
      return;
    const nav = E("nav", "breadcrumb");
    crumbs.forEach((c, i) => {
      const lnk = E("span", "crumb-link clk", c.label);
      lnk.onclick = () => {
        crumbs.splice(i);
        c.open();
      };
      nav.append(lnk, E("span", "crumb-sep", " ›"));
    });
    dbody.append(nav);
  }
  function openOutput(title, sub, full, plain = false) {
    otitle.textContent = title;
    osub.textContent = sub;
    obody.replaceChildren(...plain ? [E("pre", "opre", full)] : renderMarkdown(full));
    omodal.classList.add("on");
  }
  function closeOutput() {
    omodal.classList.remove("on");
  }
  oscrim.onclick = closeOutput;
  oclose.onclick = closeOutput;
  const onKey = (e) => {
    if (e.key !== "Escape")
      return;
    if (spmodal.classList.contains("on")) {
      closeSharePreview();
      e.stopPropagation();
      return;
    }
    if (omodal.classList.contains("on")) {
      closeOutput();
      e.stopPropagation();
      return;
    }
    if (drawer.classList.contains("on")) {
      closeDrawer();
      e.stopPropagation();
    }
  };
  document.addEventListener("keydown", onKey);
  function drow(kk, v) {
    const r = E("div", "drow");
    r.append(E("span", "dk", kk), E("span", "dv", v));
    return r;
  }
  function block(label, node) {
    const bl = E("div", "block");
    bl.append(E("div", "blabel", label), node);
    return bl;
  }
  function blockD(label, desc, node) {
    const bl = E("div", "block");
    bl.append(E("div", "blabel", label));
    if (desc)
      bl.append(E("div", "wdesc", desc));
    bl.append(node);
    return bl;
  }
  function dhead(kind, title, sub) {
    const h = E("div", "dhead");
    const eye = E("div", "deyebrow");
    eye.append(E("span", "dchip", kind));
    h.append(eye, E("h3", null, title));
    const parts = (sub || []).filter((s) => Boolean(s));
    if (parts.length) {
      const d = E("div", "dsub");
      parts.forEach((p, i) => {
        if (i)
          d.append(E("span", "sep", "·"));
        d.append(document.createTextNode(p));
      });
      h.append(d);
    }
    return h;
  }
  function setDSub(head, parts) {
    const kept = parts.filter((s) => Boolean(s));
    let d = head.querySelector(".dsub");
    if (!d) {
      d = E("div", "dsub");
      head.append(d);
    }
    d.replaceChildren();
    kept.forEach((p, i) => {
      if (i)
        d.append(E("span", "sep", "·"));
      d.append(document.createTextNode(p));
    });
  }
  function kpi2(label, value, unit) {
    const t = E("div", "kpi");
    const v = E("div", "kv");
    v.append(document.createTextNode(value));
    if (unit)
      v.append(E("small", null, " " + unit));
    t.append(E("div", "kl", label), v);
    return t;
  }
  function kpis(...tiles) {
    const row = E("div", "kpis");
    row.style.setProperty("--n", String(tiles.length));
    row.append(...tiles);
    return row;
  }
  function setKV(tile, value, unit) {
    const v = tile.children[1];
    if (!v)
      return;
    v.classList.remove("wait");
    v.replaceChildren(document.createTextNode(value), ...unit ? [E("small", null, " " + unit)] : []);
  }
  function kpiWait(label) {
    const t = kpi2(label, "···");
    t.children[1]?.classList.add("wait");
    return t;
  }
  function stackBlock(label, total, segs) {
    const bl = E("div");
    const head = E("div", "chead");
    head.append(E("span", "clbl", label), E("span", "cval", total));
    const bar = E("div", "dstack");
    const sum = segs.reduce((n, s) => n + s.value, 0);
    for (const s of segs) {
      if (sum <= 0 || s.value <= 0)
        continue;
      const i = E("i");
      i.style.width = s.value / sum * 100 + "%";
      i.style.background = s.color;
      bar.append(i);
    }
    const leg = E("div", "legend");
    for (const s of segs) {
      const it = E("span");
      const sw = E("i");
      sw.style.background = s.color;
      it.append(sw, document.createTextNode(s.label + " "), E("b", null, s.detail || ""));
      leg.append(it);
    }
    bl.append(head, bar, leg);
    return bl;
  }
  function fillBar(label, caption, pct3, grad) {
    const c = E("div", "crow");
    const head = E("div", "chead");
    head.append(E("span", "clbl", label), E("span", "cval", caption));
    const track = E("div", "ctrack");
    const bar = E("div", "cbar");
    const fill = E("i");
    fill.style.width = Math.max(0, Math.min(100, pct3)) + "%";
    fill.style.background = grad;
    bar.append(fill);
    track.append(bar, E("span", "cpct", Math.round(pct3) + "%"));
    c.append(head, track);
    return c;
  }
  function metaBlock(pairs) {
    const kept = pairs.filter(([, v]) => v && v !== "—");
    if (!kept.length)
      return null;
    const dl = E("dl", "meta");
    for (const [kk, v] of kept)
      dl.append(E("dt", null, kk), E("dd", null, v));
    return block("Details", dl);
  }
  let toolChipsExpanded = false;
  let wfStaleTimer = null;
  function renderCtx(m) {
    ctxCard.replaceChildren();
    ctxCard.append(E("div", "wtitle", "Context"), E("div", "wdesc", "How full the window is right now, and what fills it."));
    const w = E("div", "ctxw");
    const d = E("div", "dial");
    d.style.setProperty("--p", String(m.pct));
    d.append(E("span", "pv", `${m.pct}${m.estimated ? "~" : ""}%`));
    const col = E("div", "col");
    const big = E("div", "big");
    big.append(document.createTextNode(k(m.fill)));
    big.append(E("small", null, " / " + k(m.window)));
    col.append(big);
    const seg = E("div", "segbar");
    const parts = [
      ["#38bdf8", m.breakdown.cacheRead, "Cache read"],
      ["#a78bfa", m.breakdown.cacheCreation, "Cache write"],
      ["#f472b6", m.breakdown.input, "Input"]
    ];
    for (const [color, val] of parts) {
      if (m.window > 0 && val > 0) {
        const s = E("span");
        s.style.background = color;
        s.style.width = val / m.window * 100 + "%";
        seg.append(s);
      }
    }
    col.append(seg);
    const legend2 = E("div", "seglegend");
    for (const [color, , label] of parts)
      legend2.append(legendItem(color, label));
    col.append(legend2);
    w.append(d, col);
    ctxCard.append(w);
  }
  const MODEL_TINT = {
    opus: "#a78bfa",
    sonnet: "#2dd4bf",
    haiku: "#f472b6",
    fable: "#818cf8"
  };
  const modelTint = (model) => MODEL_TINT[modelFamily(model) ?? ""] ?? "#8593ad";
  function appendSubagentModels(host, s) {
    const byFamily = new Map;
    for (const { model, tokens } of s.subagentTokensByModel) {
      const key = shortModel2(model) || "unknown";
      byFamily.set(key, (byFamily.get(key) ?? 0) + tokens);
    }
    const rows = [...byFamily.entries()].sort((a, b) => b[1] - a[1]);
    const total = rows.reduce((n, [, t]) => n + t, 0);
    if (total <= 0)
      return;
    const wrap = E("div", "submdl");
    wrap.append(E("div", "submdlh", "by model"));
    const bar = E("div", "segbar");
    for (const [family, tokens] of rows) {
      const seg = E("span");
      seg.style.background = modelTint(family);
      seg.style.width = tokens / total * 100 + "%";
      bar.append(seg);
    }
    wrap.append(bar);
    const legend2 = E("div", "seglegend");
    for (const [family, tokens] of rows) {
      legend2.append(legendItem(modelTint(family), `${family} ${Math.round(tokens / total * 100)}%`));
    }
    wrap.append(legend2);
    host.append(wrap);
  }
  function renderTokenUsage(s, full) {
    const m = s.main;
    usageCard.replaceChildren();
    const where = selectedTurn !== null ? "this turn" : "this session";
    const title = E("div", "wtitle", "Session");
    const scopedTurn = selectedTurn !== null ? full.turnList.find((t) => t.index === selectedTurn) : null;
    appendModelChips(title, scopedTurn ? scopedTurn.models : full.main.models, scopedTurn ? scopedTurn.efforts : sessionEfforts(full));
    usageCard.append(title, E("div", "wdesc", "Tokens billed " + where + ", by category."));
    const u = tokenUsage(m);
    const agents = s.subagentsTotal ?? 0;
    if (u.total + agents === 0) {
      usageCard.append(E("div", "num", "—"), E("div", "led"));
      usageCard.append(E("div", "cap", "no API call in this scope"));
    } else {
      const num = E("div", "num");
      num.append(document.createTextNode(k(u.total + agents)));
      num.append(E("small", null, "tokens"));
      usageCard.append(num);
      const rows = [
        ["Cache read", u.cacheRead, false],
        ["New input", u.cacheWrite + u.input, false],
        ["Output", u.output, false]
      ];
      if (agents > 0)
        rows.push(["Subagents", agents, true, s.subagentsEstimated]);
      usageCard.append(E("div", "ledlbl", "main session"));
      const led = E("div", "led");
      for (const [label, val, sep, est] of rows) {
        led.append(E("div", "lk" + (sep ? " sep" : ""), label), E("div", "ld" + (sep ? " sep" : "")), E("div", "lv" + (sep ? " sep" : ""), (est ? "~" : "") + k(val)));
        if (label === "Output" && u.thinking !== null && val > 0)
          led.append(thinkingSplit(u.thinking, val));
      }
      usageCard.append(led);
      appendSubagentModels(usageCard, s);
    }
    usageCard.append(sessionFoot(full));
  }
  function sessionFoot(full) {
    const foot = E("div", "sessfoot");
    const tk = E("span", "sfk");
    tk.append(E("b", null, String(full.turns)), document.createTextNode(" " + turnsWord(full.turns)));
    foot.append(tk);
    const stats = turnCostStats(full);
    if (stats.escCount > 0)
      foot.append(E("span", "sfk esc", stats.escCount + " interrupted"));
    if (full.apiCalls > 0)
      foot.append(E("span", "sfk", kc(full.apiCalls) + " API calls"));
    if (full.turnList.length > 0) {
      const ob = E("button", "obtn", stripOpen ? "Close" : "Explore →");
      ob.onclick = (ev) => {
        ev.stopPropagation();
        stripOpen = !stripOpen;
        render();
      };
      foot.append(ob);
    }
    return foot;
  }
  const MARKER_H = "20%";
  function selectTurn(idx) {
    selectedTurn = selectedTurn === idx ? null : idx;
    render();
  }
  function clearScope() {
    selectedTurn = null;
    stripOpen = false;
    render();
  }
  function sevOf(t) {
    return verdicts.get(t.index)?.severity ?? "good";
  }
  const isFlagged = (t) => sevOf(t) !== "good";
  function filteredTurns(s) {
    const all = s.turnList;
    if (activeFilter === "interrupted")
      return all.filter((t) => t.state === "interrupted");
    if (activeFilter === "top10")
      return [...all].sort((a, b) => Math.abs(b.deltaFill) - Math.abs(a.deltaFill)).slice(0, 10);
    if (activeFilter === "subagents")
      return all.filter((t) => t.agentIds.length > 0);
    if (activeFilter === "waste")
      return all.filter(isFlagged);
    return all;
  }
  function renderTurnExplorer(s) {
    turnExplorerDiv.replaceChildren();
    if (!stripOpen || s.turnList.length === 0)
      return;
    const box = E("div", "tstrip");
    const intCount = s.turnList.filter((t) => t.state === "interrupted").length;
    const subCount = s.turnList.filter((t) => t.agentIds.length > 0).length;
    const wasteCount = s.turnList.filter(isFlagged).length;
    const filterDefs = [
      { key: "all", label: "All " + s.turnList.length },
      { key: "interrupted", label: "Interrupted " + intCount, esc: true },
      { key: "top10", label: "Top cost 10" },
      { key: "subagents", label: "With subagents " + subCount },
      { key: "waste", label: "Verdict " + wasteCount, waste: true }
    ];
    const chips = E("div", "fchips");
    for (const f of filterDefs) {
      const on = activeFilter === f.key;
      const c = E("span", "fchip" + (f.esc ? " esc" : "") + (f.waste ? " waste" : "") + (on ? " on" : ""), f.label);
      c.onclick = () => {
        activeFilter = f.key;
        renderTurnExplorer(s);
      };
      chips.append(c);
    }
    const h = E("div", "whead");
    h.append(E("div", "wtitle", "Timeline · " + s.turnList.length + " sent · " + nTurns(s.turns)), chips);
    box.append(h);
    box.append(E("div", "wdesc", "One column per thing you sent — height = context added, below the line = context freed. Grey = a local command (no tokens), violet = /clear or /compact. Click to scope every widget."));
    const wasteLens = activeFilter === "waste";
    const shown = new Set(filteredTurns(s).map((t) => t.index));
    const maxUp = Math.max(1, ...s.turnList.filter((t) => t.deltaFill > 0).map((t) => t.deltaFill));
    const maxDn = Math.max(1, ...s.turnList.filter((t) => t.deltaFill < 0).map((t) => -t.deltaFill));
    const bars = E("div", "sbars");
    for (const t of s.turnList) {
      const dim = shown.has(t.index) ? "" : " dim";
      const sel = t.index === selectedTurn ? " sel" : "";
      const b = E("div", "sb" + sel + dim);
      const up = E("div", "up"), dn = E("div", "dn");
      if (t.deltaFill > 0 || isMarker(t)) {
        const i = E("i");
        i.style.height = isMarker(t) ? MARKER_H : Math.max(4, t.deltaFill / maxUp * 100) + "%";
        const c = turnCls(t, working2(t, s));
        if (c)
          i.className = c;
        up.append(i);
      }
      if (t.deltaFill < 0) {
        const i = E("i");
        i.style.height = Math.max(4, -t.deltaFill / maxDn * 100) + "%";
        const c = turnCls(t, working2(t, s));
        if (c)
          i.className = c;
        dn.append(i);
      }
      b.append(up, E("div", "base"), dn);
      if (wasteLens && isFlagged(t))
        b.append(E("span", "wunder " + sevOf(t)));
      b.title = "#" + t.index + " · " + entryLabel(t, 120) + " · " + kd(t.deltaFill);
      b.onclick = () => selectTurn(t.index);
      bars.append(b);
    }
    box.append(bars);
    const mk = (color, txt) => {
      const g = E("div", "lg");
      const sw = E("span", "sw");
      sw.style.background = color;
      g.append(sw, document.createTextNode(txt));
      return g;
    };
    const lg = E("div", "slegend");
    lg.append(mk("var(--cache)", "context added"), mk("var(--good)", "live (burning tokens)"), mk("var(--crit)", "interrupted (Esc)"), mk("var(--create)", "context event (/clear, /compact)"), mk("var(--lo)", "local command (no tokens)"));
    const clr = E("button", "xbtn", "Whole session");
    clr.style.marginLeft = "auto";
    clr.onclick = () => clearScope();
    lg.append(clr);
    box.append(lg);
    if (wasteLens) {
      const workCount = s.turnList.filter((t) => t.kind === "work").length;
      const cnt = E("div", "wdesc wcount", "Every work turn, judged: " + wasteCount + " flagged · " + (workCount - wasteCount) + " clean.");
      box.append(cnt);
      const wl = E("div", "wlist");
      for (const t of s.turnList) {
        if (t.kind !== "work")
          continue;
        const v = verdicts.get(t.index);
        const row = E("div", "wrow " + v.severity + (t.index === selectedTurn ? " open sel" : ""));
        const head = E("div", "wrh");
        const lead = v.findings.find((f) => f.severity === "crit") ?? v.findings[0] ?? null;
        const headText = verdictHeadline(v) || v.positives[0]?.text || "nothing flagged";
        const body = E("div", "wrb");
        for (const f of v.findings) {
          if (f === lead && !f.cost)
            continue;
          const fr = E("div", "wfind");
          fr.append(E("span", "wdot " + f.severity), E("span", "wwhat", f.text));
          if (f.cost)
            fr.append(E("span", "wcost", f.cost));
          body.append(fr);
        }
        for (const p of lead ? v.positives : v.positives.slice(1)) {
          const pr = E("div", "wfind good");
          pr.append(E("span", "wtick", "✓"), E("span", "wwhat", p.text));
          body.append(pr);
        }
        const hasBody = body.children.length > 0;
        head.append(E("span", "wt", "#" + t.index), E("span", "ws", headText), E("span", "wc " + v.severity, v.severity), shareButton(t, s, "⇪ Share"), E("span", "wchev", hasBody ? "▸" : ""));
        row.onclick = () => selectTurn(t.index);
        row.append(head);
        if (hasBody)
          row.append(body);
        wl.append(row);
      }
      if (!wl.children.length)
        wl.append(E("div", "wdesc", "No work turn in this session yet."));
      box.append(wl);
    } else if (activeFilter !== "all") {
      const fl = E("div", "flist");
      for (const t of filteredTurns(s)) {
        const c = turnCls(t, working2(t, s));
        const row = E("div", "frow" + (t.index === selectedTurn ? " sel" : ""));
        row.append(E("span", "st" + (c ? " " + c : "")), E("span", "id", "#" + t.index), E("span", "pr", entryLabel(t, 160) || "(no text)"), E("span", "dv", kd(t.deltaFill)));
        row.onclick = () => selectTurn(t.index);
        fl.append(row);
      }
      box.append(fl);
    }
    turnExplorerDiv.append(box);
  }
  let promptRO = null;
  function watchPromptOverflow(promptEl, btn) {
    stopWatchingPrompt();
    const sync = () => btn.classList.toggle("hidden", !(promptEl.scrollWidth > promptEl.clientWidth));
    sync();
    if (typeof ResizeObserver === "function") {
      promptRO = new ResizeObserver(sync);
      promptRO.observe(promptEl);
    }
  }
  function stopWatchingPrompt() {
    if (promptRO) {
      promptRO.disconnect();
      promptRO = null;
    }
  }
  function sessionEfforts(s) {
    const out = [];
    for (const t of s.turnList)
      for (const e of t.efforts)
        if (!out.includes(e))
          out.push(e);
    return out;
  }
  function appendModelChips(host, models, efforts) {
    if (models.length) {
      const current = models[models.length - 1];
      const chip2 = E("span", "sbmodel", modelLabel3(current));
      if (models.length > 1) {
        chip2.classList.add("mixed");
        chip2.textContent = modelLabel3(current) + " · was " + models.slice(0, -1).map(modelLabel3).join(", ");
      }
      host.append(chip2);
    }
    if (efforts.length)
      host.append(E("span", "sbeffort", efforts.join(" · ")));
  }
  let liveCounters = [];
  function dropNowCounters() {
    if (liveCounters.some((c) => c.owner === "now")) {
      for (const c of liveCounters)
        if (c.owner === "now")
          c.dead = true;
      liveCounters = liveCounters.filter((c) => c.owner !== "now");
    }
    nowTickArmed = false;
  }
  function liveElapsed(turn) {
    const el8 = E("span", "sblive");
    const since = turn.startedAt ? Date.parse(turn.startedAt) : NaN;
    if (Number.isNaN(since)) {
      el8.textContent = "● running turn";
      return el8;
    }
    const render2 = () => "● " + formatDuration(Math.max(0, Date.now() - since)) + " turn";
    el8.textContent = render2();
    liveCounters.push({ el: el8, render: render2 });
    return el8;
  }
  function sessionWorked(s) {
    const el8 = E("span", "sbstats");
    const base = workingMs(s);
    const open = ended2 ? undefined : s.turnList.find((t) => t.state === "live");
    const since = open?.startedAt ? Date.parse(open.startedAt) : NaN;
    const render2 = () => formatDuration(base + (Number.isNaN(since) ? 0 : Math.max(0, Date.now() - since))) + " total";
    el8.textContent = render2();
    if (!Number.isNaN(since))
      liveCounters.push({ el: el8, render: render2 });
    return el8;
  }
  let tickTimer = null;
  function syncTicker() {
    if (!liveCounters.length) {
      stopTicker();
      return;
    }
    if (tickTimer !== null)
      return;
    tickTimer = setInterval(() => {
      if (!liveCounters.length) {
        stopTicker();
        return;
      }
      for (const c of liveCounters) {
        if (c.dead)
          continue;
        c.el.textContent = c.render();
      }
    }, 1000);
  }
  function stopTicker() {
    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }
  function backgroundChip(fullSnap) {
    const running = runningBackground(fullSnap.mainTools);
    if (!running.length || ended2)
      return null;
    const chip2 = E("span", "sbbg");
    const oldest = Date.parse(running[0].since);
    const label = running.length === 1 ? "1 background command" : running.length + " background commands";
    const renderAge = () => label + (Number.isNaN(oldest) ? "" : " · " + formatDuration(Math.max(0, Date.now() - oldest)));
    chip2.textContent = renderAge();
    liveCounters.push({ el: chip2, render: renderAge });
    chip2.title = running.map((c) => c.command).join(`
`);
    return chip2;
  }
  function renderScopeBanner(fullSnap) {
    scopeBanner.replaceChildren();
    stopWatchingPrompt();
    const bg = backgroundChip(fullSnap);
    if (selectedTurn === null) {
      scopeBanner.classList.add("on");
      scopeBanner.classList.remove("int");
      scopeBanner.append(E("span", "sbprompt", "Whole session"));
      if (bg)
        scopeBanner.append(bg);
      appendModelChips(scopeBanner, fullSnap.main.models, sessionEfforts(fullSnap));
      const cs = turnCostStats(fullSnap);
      if (cs.escCount > 0)
        scopeBanner.append(E("span", "sbstats", cs.escCount + " interrupted"));
      const work = [];
      const gloss = [];
      if (fullSnap.turns > 0) {
        work.push(nTurns(fullSnap.turns));
        gloss.push("rounds of work");
      }
      if (fullSnap.apiCalls > 0) {
        work.push(kc(fullSnap.apiCalls) + " API calls");
        gloss.push("model calls on the main thread, subagents excluded");
      }
      const toolCount = summarizeTools(fullSnap.mainTools).count;
      if (toolCount > 0) {
        work.push(kc(toolCount) + " tools");
        gloss.push("tool uses");
      }
      if (work.length) {
        const span = E("span", "sbnum", work.join(" · "));
        span.title = gloss.join(" · ");
        scopeBanner.append(span);
      }
      const open = fullSnap.turnList.find((t) => working2(t, fullSnap));
      const worked = fullSnap.turnList.some((t) => t.durationMs !== null);
      if (work.length && (open || worked))
        scopeBanner.append(E("span", "sbsep group", "|"));
      if (open)
        scopeBanner.append(liveElapsed(open));
      if (open && worked)
        scopeBanner.append(E("span", "sbsep", "·"));
      if (worked)
        scopeBanner.append(sessionWorked(fullSnap));
      const finalTurn = open && !ended2 ? null : finalResultTurn(fullSnap);
      if (finalTurn) {
        const finBtn = E("button", "sbout", "Result");
        finBtn.onclick = (ev) => {
          ev.stopPropagation();
          openOutput(entryTitle(fullSnap, finalTurn) + " result", promptLine(finalTurn.prompt, 80), finalTurn.result);
        };
        scopeBanner.append(finBtn);
      }
      if (fullSnap.turnList.length > 0)
        scopeBanner.append(E("span", "sbhint", stripOpen ? "Timeline ▴" : "Timeline ▾"));
      return;
    }
    const turn = fullSnap.turnList.find((t) => t.index === selectedTurn);
    if (!turn) {
      scopeBanner.classList.remove("on", "int");
      return;
    }
    scopeBanner.classList.add("on");
    scopeBanner.classList.toggle("int", turn.state === "interrupted");
    if (turn.kind === "work") {
      scopeBanner.append(E("span", "sbnum", "Turn " + workOrdinal(fullSnap, turn) + " / " + fullSnap.turns));
    } else {
      scopeBanner.append(E("span", "sbnum", turn.kind === "context" ? "Context event" : "Local command"));
    }
    if (bg)
      scopeBanner.append(bg);
    const line = promptLine(turn.prompt);
    const promptEl = E("span", "sbprompt", entryLabel(turn) || "(no text)");
    scopeBanner.append(promptEl);
    const wsBtn = E("button", "xbtn", "Whole session");
    wsBtn.onclick = (ev) => {
      ev.stopPropagation();
      clearScope();
    };
    scopeBanner.append(wsBtn);
    appendModelChips(scopeBanner, turn.models, turn.efforts);
    const statParts = [];
    if (turn.deltaFill !== 0)
      statParts.push((turn.deltaFill >= 0 ? "+" : "") + kc(turn.deltaFill) + " ctx");
    if (turn.durationMs !== null)
      statParts.push(formatDuration(turn.durationMs));
    if (turn.apiCalls > 0)
      statParts.push(turn.apiCalls + " API");
    const turnTools = fullSnap.mainTools.filter((t) => t.turnIndex === turn.index).length;
    if (turnTools > 0)
      statParts.push(turnTools + " tools");
    if (statParts.length)
      scopeBanner.append(E("span", "sbstats", statParts.join(" · ")));
    const v = verdicts.get(turn.index);
    if (v && v.severity !== "good") {
      const chip2 = E("button", "sbverdict " + v.severity);
      chip2.append(E("span", "wdot " + v.severity), document.createTextNode(verdictHeadline(v)));
      chip2.title = v.findings.map((f) => f.text + (f.cost ? " · " + f.cost : "")).join(`
`);
      chip2.onclick = (ev) => {
        ev.stopPropagation();
        stripOpen = true;
        activeFilter = "waste";
        render();
      };
      scopeBanner.append(chip2);
    }
    if (turn.state === "live" && !ended2)
      scopeBanner.append(liveElapsed(turn));
    if (turn.prompt) {
      const shortened = line !== turn.prompt.trim();
      const inBtn = E("button", "sbout" + (shortened ? "" : " hidden"), "Prompt");
      inBtn.onclick = (ev) => {
        ev.stopPropagation();
        openOutput(entryTitle(fullSnap, turn) + " prompt", turn.apiCalls + " API calls", turn.prompt);
      };
      scopeBanner.append(inBtn);
      if (!shortened)
        watchPromptOverflow(promptEl, inBtn);
    }
    if (turn.result) {
      const outBtn = E("button", "sbout", "Result");
      outBtn.onclick = (ev) => {
        ev.stopPropagation();
        openOutput(entryTitle(fullSnap, turn) + " result", promptLine(turn.prompt, 80), turn.result);
      };
      scopeBanner.append(outBtn);
    }
    if (turn.kind === "work")
      scopeBanner.append(shareButton(turn, fullSnap, "⇪ Share"));
  }
  function shareButton(turn, fullSnap, label) {
    const shareBtn = E("button", "sbout sbout-share", label);
    shareBtn.onclick = async (ev) => {
      ev.stopPropagation();
      shareBtn.textContent = "…";
      shareBtn.disabled = true;
      try {
        const v = verdicts.get(turn.index) ?? computeVerdict(turn, fullSnap);
        const b = bucketFor(sharedBaseline, turn.efforts.at(-1) ?? "unknown");
        const billable = turnBillable(turn);
        const effort = turn.efforts.at(-1) ?? null;
        const payload = {
          turnIndex: turn.index,
          turnOrdinal: workOrdinal(fullSnap, turn),
          totalTurns: fullSnap.turns,
          durationMs: turn.durationMs,
          date: new Date().toISOString().slice(0, 10),
          severity: v.severity,
          mult: b && b.p50 > 0 ? (billable / b.p50).toFixed(1) : null,
          billable,
          p50: b?.p50 ?? null,
          p90: b?.p90 ?? null,
          p95: b?.p95 ?? null,
          findings: v.findings,
          stats: {
            apiCalls: turn.apiCalls,
            toolCalls: fullSnap.mainTools.filter((t) => t.turnIndex === turn.index).length,
            subagents: turn.agentIds.length,
            cacheRead: turn.cacheTotals.read,
            model: turn.models.at(-1) ?? null,
            effort
          }
        };
        const blob = await withDeadline(() => renderShareCardPng(payload), SHARE_CARD_TIMEOUT_MS);
        const url = URL.createObjectURL(blob);
        openSharePreview(url, `seedeep-turn-${turn.index}.png`);
        shareBtn.textContent = label;
        shareBtn.disabled = false;
      } catch {
        shareBtn.textContent = "✗ error";
        setTimeout(() => {
          shareBtn.textContent = label;
          shareBtn.disabled = false;
        }, 2000);
      }
    };
    return shareBtn;
  }
  function renderCommands(s) {
    commandsCard.replaceChildren();
    commandsCard.append(E("div", "wtitle", "Commands"), E("div", "wdesc", "Slash commands you typed."));
    const chips = E("div", "toolchips");
    chips.style.marginTop = ".2rem";
    const cmds = s.commands || [];
    if (cmds.length) {
      for (const c of cmds) {
        const chip2 = E("span", "tchip clk");
        chip2.append(document.createTextNode("/" + c.name + " "), E("b", null, "×" + c.count));
        chip2.onclick = () => openCommand(c);
        chips.append(chip2);
      }
    } else {
      chips.append(E("span", "wdesc", "none yet"));
    }
    commandsCard.append(chips);
  }
  function renderSkills(s) {
    skillsCard.replaceChildren();
    skillsCard.append(E("div", "wtitle", "Skills used"), E("div", "wdesc", "Skills that drove the session."));
    const skills = s.skills;
    const chips = E("div", "toolchips");
    chips.style.marginTop = ".2rem";
    if (Array.isArray(skills) && skills.length) {
      for (const sk of skills) {
        const c = E("span", "tchip clk", sk.name.split(":").pop());
        c.onclick = () => openSkill(sk, skills);
        chips.append(c);
      }
    } else {
      chips.append(E("span", "wdesc", "no skills yet"));
    }
    skillsCard.append(chips);
  }
  function measureRowHeight(host) {
    const rows = host.children;
    if (!rows || !rows.length || typeof host.getBoundingClientRect !== "function")
      return;
    let tallest = 0;
    for (const r of rows) {
      const h = typeof r.getBoundingClientRect === "function" ? r.getBoundingClientRect().height : 0;
      if (h > tallest)
        tallest = h;
    }
    if (tallest > 0)
      host.style.setProperty("--subrow-h", Math.ceil(tallest) + "px");
  }
  function subActiveRow(a) {
    const r = E("div", "subrow act");
    r.onclick = () => openSub(a);
    const l1 = E("div", "sl1");
    l1.append(E("span", "sdot"), E("b", null, a.title));
    if (a.model)
      l1.append(E("span", "schip", shortModel2(a.model)));
    l1.append(E("span", "sel", formatDuration(a.durationMs)));
    r.append(l1);
    const type = E("div", "stype");
    type.textContent = a.agentType && a.agentType !== a.title ? a.agentType : " ";
    r.append(type);
    const l2 = E("div", "sl2");
    const frac = contextFraction(a);
    const bar = E("div", "scbar");
    const i = E("i");
    i.style.width = Math.max(2, Math.min(100, frac * 100)) + "%";
    bar.append(i);
    l2.append(E("span", "sclbl", "context"), bar, E("span", "scnum", k(a.fill) + " / " + kc(a.window) + " · " + Math.round(frac * 100) + "%"));
    const last = a.tools[a.tools.length - 1];
    const act = E("span", "sact");
    act.textContent = last ? "→ " + last.name + (last.arg ? " " + String(last.arg).slice(0, 36) : "") : "→ starting…";
    l2.append(act);
    r.append(l2);
    return r;
  }
  function wfActiveRow(a) {
    const w = a.workflow;
    const r = E("div", "subrow act wfrow");
    r.onclick = () => subsCard.scrollIntoView({ behavior: "smooth" });
    const l1 = E("div", "sl1");
    l1.append(E("span", "sdot"), E("b", null, w?.name || "workflow"), E("span", "schip", "workflow run"));
    l1.append(E("span", "sel", formatDuration(a.durationMs)));
    const l2 = E("div", "sl2");
    if (w) {
      const frac = w.agents > 0 ? w.running / w.agents : 0;
      const bar = E("div", "scbar");
      const i = E("i");
      i.style.width = Math.max(2, Math.min(100, frac * 100)) + "%";
      bar.append(i);
      l2.append(E("span", "sclbl", "subagents"), bar, E("span", "scnum", `${w.running} of ${w.agents} running`));
      l2.append(E("span", "sact", "→ " + k(w.volume) + " tokens"));
    }
    r.append(l1, l2);
    return r;
  }
  function subFinishedRow(a) {
    const r = E("div", "subrow done");
    r.onclick = () => openSub(a);
    r.append(E("span", "sdot"));
    const mid = E("div", "smid");
    mid.append(E("b", null, a.title));
    if (a.model)
      mid.append(E("span", "schip", shortModel2(a.model)));
    r.append(mid);
    r.append(E("span", "sdur", a.durationMs != null ? formatDuration(a.durationMs) : "—"));
    return r;
  }
  function subFinishedWfRow(a) {
    const r = E("div", "subrow done");
    r.onclick = () => subsCard.scrollIntoView({ behavior: "smooth" });
    r.append(E("span", "sdot"));
    const mid = E("div", "smid");
    mid.append(E("b", null, a.workflow?.name || "workflow"), E("span", "schip", "workflow"));
    r.append(mid);
    r.append(E("span", "sdur", a.durationMs != null ? formatDuration(a.durationMs) : "—"));
    return r;
  }
  function renderSubLive(s, full) {
    subLiveCard.replaceChildren();
    subLiveCard.className = "card sublivecard";
    subLiveCard.onclick = null;
    const subs = s.subagents || [];
    if (ended2) {
      const all = full.subagents || [];
      subLiveCard.classList.add("fulllist");
      const slHead2 = E("div", "slhead");
      const slTitleWrap2 = E("div");
      slTitleWrap2.append(E("div", "wtitle", "Subagents"), E("div", "wdesc slcount", (all.length ? all.length + " ran" : "none ran") + " this session"));
      slHead2.append(slTitleWrap2);
      subLiveCard.append(slHead2);
      if (!all.length) {
        const empty2 = E("div", "slempty");
        empty2.append(E("div", "slempty-t", "No subagents ran"), E("div", "slempty-s", "This session spawned none"));
        subLiveCard.append(empty2);
        return;
      }
      const host = E("div", "sublist");
      for (const a of subagentsChronological(all)) {
        host.append(a.kind === "workflow" ? subFinishedWfRow(a) : subFinishedRow(a));
      }
      subLiveCard.append(host);
      return;
    }
    const active = subs.filter((a) => displayState(a, ended2) === "running");
    const finished = subs.length - active.length;
    if (wfStaleTimer !== null) {
      clearTimeout(wfStaleTimer);
      timers.delete(wfStaleTimer);
      wfStaleTimer = null;
    }
    if (!ended2) {
      const deadlines = subs.filter((a) => a.kind === "workflow" && a.state === "running" && a.workflow?.lastActivityAt).map((a) => a.workflow.lastActivityAt + WF_SILENT_MS - Date.now()).filter((ms) => ms > 0);
      if (deadlines.length) {
        wfStaleTimer = later(() => {
          wfStaleTimer = null;
          scheduleRender();
        }, Math.min(...deadlines) + 1000);
      }
    }
    const bgAll = ended2 ? [] : backgroundCommands(full.mainTools, { ended: false });
    const commands = bgAll.filter((c) => c.state === "running");
    const failedCount = bgAll.filter((c) => c.state === "failed").length;
    const failedBelow = failedCount ? `${failedCount} command${failedCount === 1 ? "" : "s"} failed below` : "";
    const goneCount = bgAll.filter((c) => c.state === "unknown").length;
    const goneBelow = goneCount ? `${goneCount} never reported below` : "";
    const slHead = E("div", "slhead");
    const slTitleWrap = E("div");
    const counted = [
      active.length + (active.length === 1 ? " subagent" : " subagents"),
      commands.length ? commands.length + (commands.length === 1 ? " command running" : " commands running") : "",
      failedBelow,
      goneBelow,
      finished ? finished + " finished below" : ""
    ].filter(Boolean);
    slTitleWrap.append(E("div", "wtitle", commands.length ? "Running · live" : "Subagents · live"), E("div", "wdesc slcount", commands.length ? counted.join(" · ") : [active.length + " running", failedBelow, goneBelow, finished ? finished + " finished below" : ""].filter(Boolean).join(" · ")));
    slHead.append(slTitleWrap);
    const subLiveHost = E("div", "sublist");
    if (typeof subLiveHost.addEventListener === "function") {
      subLiveHost.addEventListener("scroll", () => {
        liveScrollTop = subLiveHost.scrollTop;
      });
    }
    subLiveCard.append(slHead, subLiveHost);
    for (const c of commands)
      subLiveHost.append(bgActiveRow(c));
    const wakeupRow = wakeupActiveRow(full);
    if (wakeupRow)
      subLiveHost.append(wakeupRow);
    if (commands.length || wakeupRow) {
      measureRowHeight(subLiveHost);
      if (liveScrollTop > 0)
        subLiveHost.scrollTop = liveScrollTop;
    }
    if (active.length) {
      for (const a of active)
        subLiveHost.append(a.kind === "workflow" ? wfActiveRow(a) : subActiveRow(a));
      measureRowHeight(subLiveHost);
      if (liveScrollTop > 0)
        subLiveHost.scrollTop = liveScrollTop;
      return;
    }
    if (commands.length || wakeupRow)
      return;
    const empty = E("div", "slempty");
    empty.append(E("div", "slempty-t", "No subagents running"), E("div", "slempty-s", finished ? finished + " finished this session — see the full list below" : "Spawned subagents will appear here live"));
    subLiveHost.append(empty);
  }
  const BG_AUTHOR_LABEL = {
    agent: "background",
    timeout: "auto-backgrounded",
    user: "backgrounded by you"
  };
  function wakeupActiveRow(full) {
    const w = full.wakeup;
    if (!w)
      return null;
    const at = Date.parse(w.at);
    if (!Number.isFinite(at) || at <= Date.now())
      return null;
    const r = E("div", "subrow act wake");
    r.onclick = () => openBlock({ kind: "tool", toolUseId: w.toolUseId });
    const l1 = E("div", "sl1");
    l1.append(E("span", "sdot"), E("b", null, "Scheduled wakeup"));
    l1.append(E("span", "schip", "timer"));
    const left = E("span", "sel");
    const renderLeft = () => {
      const ms = at - Date.now();
      if (ms <= 0) {
        r.hidden = true;
        scheduleRender();
        return "due";
      }
      return "in " + formatDuration(ms);
    };
    left.textContent = renderLeft();
    liveCounters.push({ el: left, render: renderLeft });
    l1.append(left);
    r.append(l1);
    const at12 = new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    r.append(E("div", "stype", (w.turnIndex !== null ? "armed in turn " + w.turnIndex + " · " : "") + "waking at " + at12));
    return r;
  }
  function bgActiveRow(c) {
    const r = E("div", "subrow act");
    r.onclick = () => openBlock({ kind: "tool", toolUseId: c.toolUseId });
    const l1 = E("div", "sl1");
    l1.append(E("span", "sdot"), E("b", null, c.label));
    l1.append(E("span", "schip", BG_AUTHOR_LABEL[c.by]));
    const since = Date.parse(c.since);
    const age = E("span", "sel");
    if (!Number.isNaN(since)) {
      const renderAge = () => formatDuration(Math.max(0, Date.now() - since));
      age.textContent = renderAge();
      liveCounters.push({ el: age, render: renderAge });
    }
    l1.append(age);
    r.append(l1);
    const events = c.events > 0 ? " · " + c.events + (c.events === 1 ? " event" : " events") : "";
    r.append(E("div", "stype", (c.turnIndex !== null ? "launched in turn " + c.turnIndex + " · " : "") + "still running" + events));
    if (c.lastEvent) {
      const last = E("div", "sevt", c.lastEvent);
      last.title = c.lastEvent;
      r.append(last);
    }
    return r;
  }
  function bgEndedRow(c) {
    const r = E("div", "subrow done");
    r.onclick = () => openBlock({ kind: "tool", toolUseId: c.toolUseId });
    r.append(E("span", "sdot"));
    const mid = E("div", "smid");
    mid.append(E("b", null, c.label));
    mid.append(E("span", `badge b-${c.state === "done" ? "done" : c.state}`, c.state));
    if (c.turnIndex !== null)
      mid.append(E("span", "schip", "turn " + c.turnIndex));
    if (c.by !== "agent")
      mid.append(E("span", "schip", BG_AUTHOR_LABEL[c.by]));
    const exit = c.sentence ? /exit code (\d+)/.exec(c.sentence) : null;
    if (exit)
      mid.append(E("span", "schip", "exit " + exit[1]));
    if (c.events > 0)
      mid.append(E("span", "schip", c.events + (c.events === 1 ? " event" : " events")));
    r.append(mid);
    const since = c.state === "running" ? Date.parse(c.since) : Number.NaN;
    if (Number.isFinite(since)) {
      const age = E("span", "sdur run");
      const renderAge = () => formatDuration(Math.max(0, Date.now() - since));
      age.textContent = renderAge();
      liveCounters.push({ el: age, render: renderAge });
      r.append(age);
    } else {
      r.append(E("span", "sdur", c.ranMs === null ? "—" : (c.ranAtLeast ? "≥ " : "") + formatDuration(c.ranMs)));
    }
    r.title = c.lastEvent ? (c.sentence ?? c.command) + `
last event: ` + c.lastEvent : c.sentence ?? c.command;
    return r;
  }
  function renderTools(s) {
    toolsHost.replaceChildren();
    const ranked = contextHogs(s.mainTools);
    const hogCap = s.subagentsTotal > 0 ? 4 : 3;
    for (const hg of ranked.slice(0, hogCap)) {
      const r = E("div", "hogrow");
      r.onclick = () => openTool(hg, "main session");
      const hl = E("div", "hl");
      hl.append(E("span", "hn", hg.name), E("span", "harg", hg.arg || "—"));
      r.append(hl, E("span", "hv", kc(hg.ctx) + " ch"));
      toolsHost.append(r);
    }
    const { count, breakdown } = summarizeTools(s.mainTools);
    const chips = E("div", "toolchips");
    chips.append(E("span", "tcount", count + " tools"));
    const shown = toolChipsExpanded ? breakdown : breakdown.slice(0, 12);
    for (const b of shown) {
      const c = E("span", "tchip clk");
      c.append(document.createTextNode(b.name + " "), E("b", null, String(b.n)));
      c.onclick = () => openToolType(b.name, s);
      chips.append(c);
    }
    if (!toolChipsExpanded && breakdown.length > 12) {
      const more = E("span", "tchip clk", "+" + (breakdown.length - 12));
      more.onclick = () => {
        toolChipsExpanded = true;
        renderTools(s);
      };
      chips.append(more);
    }
    toolsHost.append(chips);
  }
  const FILE_TINT = {
    ts: "ft-code",
    tsx: "ft-code",
    js: "ft-code",
    jsx: "ft-code",
    mjs: "ft-code",
    cjs: "ft-code",
    md: "ft-doc",
    mdx: "ft-doc",
    txt: "ft-doc",
    html: "ft-markup",
    htm: "ft-markup",
    xml: "ft-markup",
    svg: "ft-markup",
    json: "ft-data",
    yaml: "ft-data",
    yml: "ft-data",
    toml: "ft-data",
    css: "ft-style",
    scss: "ft-style",
    sass: "ft-style",
    sh: "ft-shell",
    bash: "ft-shell",
    zsh: "ft-shell"
  };
  const extOf = (base) => {
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  };
  const tintOf = (ext) => FILE_TINT[ext] ?? "";
  const extCounts = (files) => {
    const by = new Map;
    for (const f of files) {
      const e = extOf(f.base);
      by.set(e, (by.get(e) ?? 0) + 1);
    }
    return [...by].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  function renderFiles(s) {
    filesHost.replaceChildren();
    maybeRefreshFiles();
    const all = filesInScope();
    const scratch = scratchInScope();
    filesDesc.textContent = filesDescText(all);
    if (!all.length) {
      appendScratchRow(scratch.length);
      appendArtifactRow(artifactsInScope().length);
      return;
    }
    const num = E("div", "num");
    num.append(document.createTextNode(String(all.length)), E("small", null, all.length === 1 ? "file" : "files"));
    filesHost.append(num);
    const TYPES_CAP = s.subagentsTotal > 0 ? 5 : 4;
    const ranked = extCounts(all);
    const max = ranked[0]?.[1] ?? 1;
    const bars = E("div", "fchgbars");
    for (const [ext, n] of ranked.slice(0, TYPES_CAP)) {
      const t = tintOf(ext);
      const row = E("div", "fchgbar");
      const track = E("div", "fchgbt");
      const fill = E("i", t);
      fill.style.width = Math.max(6, n / max * 100) + "%";
      track.append(fill);
      row.append(E("div", t ? "fchgbn " + t : "fchgbn", ext || "—"), track, E("div", "fchgbv", String(n)));
      bars.append(row);
    }
    filesHost.append(bars);
    if (ranked.length > TYPES_CAP) {
      const rest = ranked.length - TYPES_CAP;
      const more = E("div", "fchgmore", `+${rest} more type${rest === 1 ? "" : "s"} — Expand all`);
      more.onclick = () => openAllFiles();
      filesHost.append(more);
    }
    appendScratchRow(scratch.length);
    appendArtifactRow(artifactsInScope().length);
  }
  function filesInScope() {
    if (!filesData)
      return [];
    return inScope(displayFiles(filesData.files, filesData.roots));
  }
  function scratchInScope() {
    if (!filesData)
      return [];
    return inScope(displayFiles(filesData.scratch, filesData.roots, true));
  }
  function artifactsInScope() {
    if (!filesData)
      return [];
    return inScope(filesData.artifacts);
  }
  function inScope(rows) {
    if (selectedTurn === null)
      return [...rows];
    const range = turnRangeMs(selectedTurn);
    if (!range)
      return [];
    return rows.filter((f) => f.at >= range[0] && f.at < range[1]);
  }
  function turnRangeMs(index) {
    const list = lastSnap?.turnList ?? [];
    const i = list.findIndex((t) => t.index === index);
    if (i < 0)
      return null;
    const from = Date.parse(list[i]?.startedAt ?? "");
    if (!Number.isFinite(from))
      return null;
    const next = Date.parse(list[i + 1]?.startedAt ?? "");
    return [from, Number.isFinite(next) ? next : Number.POSITIVE_INFINITY];
  }
  function appendScratchRow(n) {
    if (!n)
      return;
    const row = E("div", "fchgscr", `+${n} scratchpad file${n === 1 ? "" : "s"} — Expand all`);
    row.onclick = () => openAllFiles();
    filesHost.append(row);
  }
  function appendArtifactRow(n) {
    if (!n)
      return;
    const row = E("div", "fchgart", `+${n} published artifact${n === 1 ? "" : "s"} — Expand all`);
    row.onclick = () => openAllFiles();
    filesHost.append(row);
  }
  function filesDescText(rows) {
    if (!filesData)
      return "Reading the repository…";
    const o = filesData.origin;
    if (o.kind === "no-repo")
      return "This session is not inside a git repository.";
    if (o.kind === "unknown")
      return "The repository could not be read.";
    const commits = o.kind === "commits" && selectedTurn === null ? o.commits : new Set(rows.map((f) => f.commit)).size;
    if (!commits)
      return `Nothing committed in ${selectedTurn === null ? "this session" : "this turn"}.`;
    return `Files in ${commits} commit${commits === 1 ? "" : "s"}.`;
  }
  function fmtAge(ms) {
    return ms < 60000 ? Math.round(ms / 1000) + "s ago" : Math.round(ms / 60000) + "m ago";
  }
  function feedCapForPanel() {
    if (nowPanel.classList.contains("hidden"))
      return FEED_CAP;
    if (typeof getComputedStyle !== "function")
      return feedVisibleCap;
    const lh = parseFloat(getComputedStyle(nowText).lineHeight);
    return nowText.clientHeight <= lh + 4 ? 11 : 10;
  }
  let clampScheduled = false;
  function scheduleNowMeasure() {
    if (clampScheduled)
      return;
    clampScheduled = true;
    setTimeout(() => {
      clampScheduled = false;
      const overflowing = !nowPanel.classList.contains("hidden") && nowText.scrollHeight > nowText.clientHeight + 1;
      nowTextWrap.classList.toggle("clamped", overflowing);
      const cap = feedCapForPanel();
      if (cap !== feedVisibleCap) {
        feedVisibleCap = cap;
        renderFeed();
      }
    }, 0);
  }
  function pendingTool() {
    const items = feed.items();
    for (let i = items.length - 1;i >= 0; i--) {
      const it = items[i];
      if (it.apiCall || it.sub || it.ms != null || !it.id)
        continue;
      return { name: it.name, arg: it.arg ?? null };
    }
    return null;
  }
  function renderPlainPanel(state2) {
    dropNowCounters();
    nowPanel.classList.remove("hidden");
    nowPanel.classList.toggle("waiting", state2.kind === "waiting");
    nowLbl.textContent = state2.label;
    nowText.classList.add("plain");
    nowText.textContent = state2.text;
    nowMore.onclick = () => {};
    nowTextWrap.classList.remove("clamped");
    nowAge.textContent = "";
    if (state2.ageFrom !== null) {
      const renderAge = () => fmtAge(Math.max(0, Date.now() - state2.ageFrom));
      nowAge.textContent = renderAge();
      liveCounters.push({ el: nowAge, render: renderAge, owner: "now" });
    }
    scheduleNowMeasure();
  }
  let wordSeen = null;
  function renderActivityPanel(state2, g, isLive2, turn) {
    nowPanel.classList.remove("hidden");
    nowLbl.textContent = state2.label;
    nowText.classList.add("plain");
    const line = state2.text;
    nowText.textContent = line;
    nowMore.onclick = () => openOutput("Now", entryTitle(lastSnap, turn) || "", line);
    nowTextWrap.classList.remove("clamped");
    const renderAge = () => {
      const since = runningSince(g.open, Date.now());
      return since === null ? "" : formatToolMs(Math.max(0, Date.now() - since));
    };
    nowAge.textContent = isLive2 ? renderAge() : "";
    if (isLive2 && g.open.length)
      liveCounters.push({ el: nowAge, render: renderAge, owner: "now" });
    scheduleNowMeasure();
  }
  function renderNowPanel() {
    dropNowCounters();
    const blocked = waiting && !ended2 && selectedTurn === null ? waiting : null;
    nowText.classList.remove("plain", "empty");
    const list = lastSnap?.turnList ?? [];
    const panelTurn = selectedTurn !== null ? list.find((t) => t.index === selectedTurn) ?? null : list.find((t) => t.state === "live") ?? list[list.length - 1] ?? null;
    const isLive2 = working2(panelTurn);
    const group = panelTurn?.activity ?? null;
    const wordTs = panelTurn?.lastWordTs ?? null;
    const narr = panelTurn?.lastNarration ?? null;
    const result = panelTurn?.result ?? null;
    if (wordTs !== null && wordSeen?.ts !== wordTs)
      wordSeen = { ts: wordTs, at: Date.now() };
    const state2 = nowLine({
      waiting: blocked,
      pendingTool: blocked ? pendingTool() : null,
      waitingSince,
      live: isLive2,
      result,
      narration: narr,
      wordTs,
      wordSeenAt: wordSeen?.at ?? null,
      activity: group,
      delegated: panelTurn && lastSnap ? delegatedWork(panelTurn.index, lastSnap.subagents, ended2) : null,
      returned: panelTurn && lastSnap ? returnedWork(panelTurn.index, lastSnap.subagents, ended2) : null,
      apiCalls: panelTurn?.apiCalls ?? 0,
      startedAt: panelTurn?.startedAt ? tsMs(panelTurn.startedAt) : null
    }, Date.now());
    if (state2?.kind === "waiting") {
      renderPlainPanel(state2);
      return;
    }
    nowPanel.classList.remove("waiting");
    if (state2?.kind === "activity") {
      renderActivityPanel(state2, group, isLive2, panelTurn);
      return;
    }
    if (state2?.kind === "working") {
      renderPlainPanel(state2);
      return;
    }
    if (group && isLive2 && !nowTickArmed) {
      nowTickArmed = true;
      liveCounters.push({
        el: nowTick,
        render: () => {
          renderNowPanel();
          return "";
        },
        owner: "now"
      });
    }
    if (state2 === null) {
      nowPanel.classList.add("hidden");
      scheduleNowMeasure();
      return;
    }
    nowPanel.classList.remove("hidden");
    const showingResult = state2.kind === "output";
    nowLbl.textContent = state2.label;
    const glance = stripMarkdown(state2.text);
    const empty = glance === "";
    nowText.textContent = empty ? "(no text)" : glance;
    nowText.classList.toggle("empty", empty);
    scheduleNowMeasure();
    nowMore.onclick = () => openOutput(showingResult ? "Output" : "Intent", entryTitle(lastSnap, panelTurn) || "", state2.text);
    nowAge.textContent = "";
    const since = state2.ageFrom;
    if (since !== null) {
      const renderAge = () => fmtAge(Math.max(0, Date.now() - since));
      nowAge.textContent = renderAge();
      liveCounters.push({ el: nowAge, render: renderAge, owner: "now" });
    }
  }
  const FEED_CAP = 13;
  let feedVisibleCap = FEED_CAP;
  const feed = createFeed(FEED_CAP);
  function renderFeed() {
    const turn = selectedTurn !== null && lastSnap ? lastSnap.turnList.find((t) => t.index === selectedTurn) : null;
    const scoped = selectedTurn !== null;
    liveTitle.textContent = scoped ? (entryTitle(lastSnap, turn) || "Entry") + " activity" : "Live activity";
    liveBadge.classList.toggle("hidden", ended2 || scoped && turn?.state !== "live");
    endBadge.classList.toggle("hidden", !ended2 || scoped);
    feedHost.replaceChildren();
    const ring = (scoped ? feed.items(selectedTurn) : feed.items()).slice(-feedVisibleCap);
    if (!ring.length) {
      const why = !scoped ? "no activity yet" : turn && turn.kind !== "work" ? "nothing ran — " + entryTitle(lastSnap, turn) + " never called the model" : "no tool activity in this turn";
      feedHost.append(E("div", "wdesc", why));
      return;
    }
    for (let i = ring.length - 1;i >= 0; i--) {
      const it = ring[i];
      if (it.apiCall) {
        const r2 = E("div", "fev api" + (it.error ? " err" : ""));
        r2.onclick = () => openFeedItem(it);
        r2.append(E("span", "fn", "API call"), E("span", "fa", it.error && it.errorMessage || it.arg || "—"));
        const t2 = E("span", "ft");
        if (it.sub)
          t2.append(E("span", "fagent", "subagent"));
        if (it.error)
          t2.append(E("span", "ferr", "error"));
        else
          t2.append(document.createTextNode(it.ms != null ? formatToolMs(it.ms) : "—"));
        r2.append(t2);
        feedHost.append(r2);
        continue;
      }
      const r = E("div", "fev" + (it.error ? " err" : ""));
      r.onclick = () => openFeedItem(it);
      const label = it.spawn ? "spawn" : it.name;
      const spawnLabel = it.spawn ? it.subagentType || "subagent" : it.background && it.error && it.errorMessage || it.arg || "—";
      const spawnHint = it.spawn && it.launchPrompt ? " · " + it.launchPrompt.slice(0, 60) + (it.launchPrompt.length > 60 ? "…" : "") : "";
      const fnEl = E("span", "fn", label);
      fnEl.title = label;
      r.append(fnEl, E("span", "fa", spawnLabel + spawnHint));
      const t = E("span", "ft");
      if (it.sub)
        t.append(E("span", "fagent", "subagent"));
      if (it.error)
        t.append(E("span", "ferr", "error"));
      if (!it.note)
        t.append(document.createTextNode(toolDuration(it.ms, ended2)));
      r.append(t);
      feedHost.append(r);
    }
  }
  function workflowCard(a) {
    const w = a.workflow;
    const c = E("div", "subcard wfcard");
    c.onclick = () => openWorkflow(a);
    const top = E("div", "top");
    const topRow = E("div", "top-row");
    const st = displayState(a, ended2);
    topRow.append(E("span", "atype", w.name || "workflow"), E("span", `badge b-${st}`, st));
    top.append(topRow, E("span", "wfkind", "workflow run"));
    c.append(top);
    const bars = E("div", "bars");
    const line = (lbl, val) => {
      const row = E("div", "crow");
      const head = E("div", "chead");
      head.append(E("span", "clbl", lbl), E("span", "cval", val));
      row.append(head);
      return row;
    };
    const unreturned = st !== "running" ? "never returned" : "running";
    bars.append(line("subagents", w.running ? `${w.agents} · ${w.running} ${unreturned}` : `${w.agents}`));
    bars.append(line("volume", k(w.volume) + " tokens"));
    c.append(bars);
    if (w.models.length) {
      const chips = E("div", "wfmodels");
      for (const m of w.models) {
        const chip2 = E("span", "amodel-chip");
        chip2.append(E("span", null, m.model), E("span", "wfcalls", ` ${m.agents}`));
        chips.append(chip2);
      }
      c.append(chips);
    }
    return c;
  }
  function renderBottomHead(subs, cmds, showTabs) {
    subsTitleWrap.replaceChildren();
    subsTabs.replaceChildren();
    const failed = cmds.filter((c) => c.state === "failed").length;
    const onBg = bottomTab === "bg";
    subsTitleWrap.append(E("div", "wtitle", onBg ? "Background commands · in launch order" : "Subagents · in launch order"), E("div", "wdesc", onBg ? [
      cmds.length + " launched",
      cmds.filter((c) => c.state === "running").length + " still running",
      failed + " failed",
      cmds.filter((c) => c.state === "unknown").length + " never reported"
    ].join(" · ") + ". Click one for its command, its output file and what Claude Code said." : "Each subagent that ran, in the order it was launched. Click for its full launch prompt."));
    if (!showTabs)
      return;
    const tab = (id, label, badge) => {
      const b = E("button", bottomTab === id ? "xbtn on" : "xbtn");
      b.append(document.createTextNode(label));
      if (badge)
        b.append(E("span", "badge b-failed tabbadge", badge));
      b.onclick = () => {
        bottomTab = id;
        render();
      };
      return b;
    };
    subsTabs.append(tab("subs", "Subagents " + subs, null), tab("bg", "Background commands " + cmds.length, failed ? failed + " failed" : null));
  }
  function renderSubs(s) {
    subsHost.replaceChildren();
    bgHost.replaceChildren();
    const cmds = backgroundCommands(s.mainTools, { ended: ended2 });
    const showTabs = s.subagents.length > 0 && cmds.length > 0;
    if (!s.subagents.length && cmds.length)
      bottomTab = "bg";
    else if (!showTabs)
      bottomTab = "subs";
    renderBottomHead(s.subagents.length, cmds, showTabs);
    if (bottomTab === "bg") {
      for (const c of cmds)
        bgHost.append(bgEndedRow(c));
      return;
    }
    if (!s.subagents.length) {
      subsHost.append(E("div", "wdesc", selectedTurn !== null ? "no subagents in this entry" : ended2 ? "no subagents ran in this session" : "no subagents yet"));
      return;
    }
    const sorted = subagentsChronological(s.subagents);
    const maxReturned = maxReturnedLen(s.subagents);
    for (const a of sorted) {
      if (a.kind === "workflow") {
        subsHost.append(workflowCard(a));
        continue;
      }
      const c = E("div", "subcard");
      c.onclick = () => openSub(a);
      const top = E("div", "top");
      const topRow = E("div", "top-row");
      const st = displayState(a, ended2);
      topRow.append(E("span", "atype", a.title), E("span", `badge b-${st}`, st));
      top.append(topRow);
      const chips = E("div", "chips");
      if (a.agentType)
        chips.append(E("span", "atype-chip", a.agentType));
      if (a.model)
        chips.append(E("span", "amodel-chip", a.model));
      if (chips.children.length)
        top.append(chips);
      c.append(top);
      const barLine = (lbl, valStr, frac, color, pctStr) => {
        const row = E("div", "crow");
        const head = E("div", "chead");
        head.append(E("span", "clbl", lbl), E("span", "cval", valStr));
        const bar = E("div", "cbar");
        const i = E("i");
        i.style.width = Math.max(2, Math.min(100, frac * 100)) + "%";
        i.style.background = color;
        bar.append(i);
        const track = E("div", "ctrack");
        track.append(bar);
        if (pctStr)
          track.append(E("span", "cpct", pctStr));
        row.append(head, track);
        return row;
      };
      const valLine = (lbl, valStr, estimated) => {
        const row = E("div", "crow");
        const head = E("div", "chead");
        head.append(E("span", "clbl", lbl), E("span", "cval", valStr));
        if (estimated)
          row.title = "Estimated: this background subagent wrote no per-call usage, so this is the reported total (≈ its final context), not a true sum.";
        row.append(head);
        return row;
      };
      const bars = E("div", "bars");
      bars.append(valLine("volume", (a.volumeEstimated ? "~" : "") + k(a.volume) + " tokens", a.volumeEstimated));
      const ctxFrac = contextFraction(a);
      bars.append(barLine("context", k(a.fill) + " / " + kc(a.window), ctxFrac, "var(--create)", Math.round(ctxFrac * 100) + "%"));
      const hasOut = typeof a.outLen === "number" && a.outLen > 0;
      bars.append(barLine("returned", hasOut ? kc(a.outLen) + "ch" : "—", hasOut ? a.outLen / maxReturned : 0, "var(--crit)", null));
      c.append(bars);
      const foot = E("div", "foot");
      const launchStr = formatLaunchTime(a.startedAt) || "—";
      const footRight = E("span", "footright");
      footRight.append(E("span", null, a.tools.length + " tools"), E("span", null, formatDuration(a.durationMs)));
      foot.append(E("span", null, launchStr), footRight);
      c.append(foot);
      subsHost.append(c);
    }
  }
  function toolListBlock(label, list, owner, back) {
    const box = E("div");
    const sorted = [...list].sort((x, y) => (y.ctx ?? 0) - (x.ctx ?? 0));
    const trow = (t) => {
      const r = E("div", "ttrow");
      r.onclick = () => openTool(t, owner, back);
      const nm = E("div", "tn");
      nm.append(document.createTextNode(t.name + "  "));
      const arg = E("span", "targ");
      arg.textContent = t.arg || "";
      nm.append(arg);
      r.append(nm, E("div", "tv", t.ms != null ? formatToolMs(t.ms) : "—"), E("div", "tv", typeof t.ctx === "number" ? kc(t.ctx) + "ch" : "—"));
      return r;
    };
    for (const t of sorted.slice(0, 5))
      box.append(trow(t));
    const rest = sorted.slice(5);
    if (rest.length) {
      const restBox = E("div");
      restBox.style.display = "none";
      for (const t of rest)
        restBox.append(trow(t));
      const more = E("div", "morerow", "show " + rest.length + " more ▾");
      let open = false;
      more.onclick = () => {
        open = !open;
        restBox.style.display = open ? "block" : "none";
        more.textContent = open ? "show less ▴" : "show " + rest.length + " more ▾";
      };
      box.append(restBox, more);
    }
    return block(label, box);
  }
  function openSub(a, back) {
    if (back)
      crumbs.push(back);
    else
      crumbs.length = 0;
    dbody.replaceChildren();
    renderCrumbs();
    dbody.append(dhead("subagent", a.title, [
      a.agentType,
      shortModel2(a.model),
      a.efforts && a.efforts.length ? "effort " + a.efforts.join("/") : null
    ]));
    dbody.append(kpis(kpi2("Duration", formatDuration(a.durationMs)), kpi2("Tool calls", String(a.tools.length)), kpi2("Returned", typeof a.outLen === "number" ? kc(a.outLen) : "—", typeof a.outLen === "number" ? "chars" : null)));
    const bars = E("div", "block");
    bars.append(fillBar("Context", k(a.fill) + " / " + k(a.window), a.window > 0 ? a.fill / a.window * 100 : 0, "linear-gradient(90deg,var(--cache),var(--agent))"));
    const b = a.volumeBreakdown;
    if (b) {
      const detail = (v) => {
        const pct3 = a.volume > 0 ? Math.round(v / a.volume * 100) : 0;
        return k(v) + (pct3 >= 1 ? " · " + pct3 + "%" : "");
      };
      const vol = stackBlock("Volume", (a.volumeEstimated ? "~" : "") + k(a.volume) + " tokens", [
        { label: "cache read", value: b.cacheRead, color: "var(--cache)", detail: detail(b.cacheRead) },
        { label: "cache write", value: b.cacheCreation, color: "var(--create)", detail: detail(b.cacheCreation) },
        { label: "output", value: b.output, color: "var(--good)", detail: detail(b.output) },
        { label: "input", value: b.input, color: "var(--input)", detail: detail(b.input) }
      ]);
      vol.style.marginTop = "1rem";
      bars.append(vol);
    } else {
      const row = drow("Volume", (a.volumeEstimated ? "~" : "") + k(a.volume) + " tokens");
      row.style.marginTop = "1rem";
      bars.append(row);
    }
    dbody.append(bars);
    if (a.prompt) {
      const prompt = a.prompt;
      const pre = E("pre");
      pre.textContent = prompt.slice(0, 500) + (prompt.length > 500 ? " …" : "");
      const bl = block("Launch prompt (what spawned it)", pre);
      if (prompt.length > 500) {
        const more = E("button", "morebtn", "show full ▾");
        more.onclick = () => openOutput("Launch prompt", (a.agentType || a.agentId) + " · " + kc(prompt.length) + " chars", prompt);
        bl.append(more);
      }
      dbody.append(bl);
    }
    if (a.tools.length)
      dbody.append(toolListBlock("Tools it called (" + a.tools.length + ")", a.tools, a.agentType || a.agentId, {
        label: a.title,
        open: () => openSub(a)
      }));
    if (typeof a.outLen === "number" && a.outLen > 0 && a.outputFull) {
      const outputFull = a.outputFull;
      const pre = E("pre");
      pre.textContent = outputFull.slice(0, 500) + (a.outLen > 500 ? " …" : "");
      const bl = block("Returned to main (" + kc(a.outLen) + " chars)", pre);
      const more = E("button", "morebtn", "show full ▾");
      more.onclick = () => openOutput("Output returned to main", (a.agentType || a.agentId) + " · " + kc(a.outLen) + " chars", outputFull);
      bl.append(more);
      dbody.append(bl);
    }
    const meta = metaBlock([
      ["Model", a.model],
      ["Launched at", formatLaunchTime(a.startedAt)],
      ["Spawned in turn", a.turnIndex != null ? String(a.turnIndex + 1) : null]
    ]);
    if (meta)
      dbody.append(meta);
    openDrawer();
  }
  function openWorkflow(a) {
    crumbs.length = 0;
    dbody.replaceChildren();
    renderCrumbs();
    const w = a.workflow;
    const st = displayState(a, ended2);
    dbody.append(dhead("workflow run", w.name || "workflow", [st, w.runId.slice(0, 16)]));
    dbody.append(kpis(kpi2("Subagents", String(w.agents)), kpi2("Volume", k(w.volume), "tokens")));
    if (a.prompt) {
      const prompt = a.prompt;
      const pre = E("pre");
      pre.textContent = prompt.slice(0, 500) + (prompt.length > 500 ? " …" : "");
      const bl = block("Workflow script", pre);
      if (prompt.length > 500) {
        const more = E("button", "morebtn", "show full ▾");
        more.onclick = () => openOutput("Workflow script", w.name || w.runId, prompt);
        bl.append(more);
      }
      dbody.append(bl);
    }
    if (w.members.length) {
      const grid = E("div", "wf-members");
      const unreturned = st !== "running";
      for (const m of w.members) {
        const card2 = E("div", "wf-mcard");
        card2.append(E("div", "wfmc-id", m.agentId));
        const typeLine = E("div", "wfmc-type");
        typeLine.append(document.createTextNode(m.agentType || "subagent"), E("span", null, " · "), E("b", null, m.model ? shortModel2(m.model) : "—"));
        card2.append(typeLine);
        const krow = E("div", "wfmc-kpis");
        const mkpi = (lbl, val) => {
          const t = E("div", "wfmc-kpi");
          t.append(E("span", null, lbl), E("span", null, val));
          return t;
        };
        if (m.volume > 0)
          krow.append(mkpi("Volume", k(m.volume) + " tok"));
        if (m.window > 0)
          krow.append(mkpi("Fill", (m.window > 0 ? Math.round(m.fill / m.window * 100) : 0) + "%"));
        if (m.durationMs != null)
          krow.append(mkpi("Time", formatDuration(m.durationMs)));
        if (m.toolCount > 0)
          krow.append(mkpi("Tools", String(m.toolCount)));
        if (krow.children.length)
          card2.append(krow);
        const meta = [];
        if (m.outLen > 0)
          meta.push("→ " + kc(m.outLen) + " chars");
        if (m.efforts.length)
          meta.push("effort " + m.efforts.join("/"));
        if (meta.length) {
          const md = E("div", "wfmc-meta");
          meta.forEach((s) => md.append(E("span", null, s)));
          card2.append(md);
        }
        const badgeCls = m.returned ? "ret" : unreturned ? "miss" : "live";
        card2.append(E("span", "wfmc-badge " + badgeCls, m.returned ? "returned" : unreturned ? "never returned" : "running"));
        if (loadAgentPrompt) {
          const agentId = m.agentId;
          const btn = E("button", "morebtn wfmc-prompt-btn", "prompt ▾");
          btn.onclick = (e) => {
            e.stopPropagation();
            btn.textContent = "loading…";
            btn.disabled = true;
            loadAgentPrompt(agentId).then((res) => {
              if (!res) {
                btn.textContent = "prompt unavailable";
                return;
              }
              btn.remove();
              const pre = E("pre", "wfmc-prompt");
              pre.textContent = res.text + (res.truncated ? " …" : "");
              card2.append(pre);
            }).catch(() => {
              btn.textContent = "error loading";
            });
          };
          card2.append(btn);
        }
        grid.append(card2);
      }
      dbody.append(block("Agents (" + w.members.length + ")", grid));
    }
    openDrawer();
  }
  function openTool(t, owner, back) {
    if (back)
      crumbs.push(back);
    else
      crumbs.length = 0;
    dbody.replaceChildren();
    renderCrumbs();
    const th = dhead("tool call", t.name, [
      owner || "main session",
      t.turnIndex != null ? "turn " + (t.turnIndex + 1) : null
    ]);
    if (t.error)
      th.querySelector(".deyebrow")?.append(E("span", "dchip err", "failed"));
    if (t.background)
      th.querySelector(".deyebrow")?.append(E("span", "dchip bg", BG_AUTHOR_LABEL[t.backgroundBy ?? "agent"]));
    if (t.notes?.length)
      th.querySelector(".deyebrow")?.append(E("span", "dchip note", t.notes.length === 1 ? "flagged" : t.notes.length + " flags"));
    dbody.append(th);
    for (const n of t.notes ?? []) {
      dbody.append(blockD("Hook note", [n.source, n.hook].filter(Boolean).join(" · ") || null, E("pre", null, n.text)));
    }
    const bgRan = t.background && t.startedTs && t.outcomeTs ? Date.parse(t.outcomeTs) - Date.parse(t.startedTs) : null;
    dbody.append(kpis(kpi2(t.background ? "Launch" : "Duration", toolDuration(t.ms, ended2)), t.background ? kpi2("Ran for", bgRan !== null && Number.isFinite(bgRan) ? formatDuration(Math.max(0, bgRan)) : "—") : kpi2("Output size", t.ctx ? kc(t.ctx) : "—", t.ctx ? "chars" : null)));
    if (t.background) {
      dbody.append(blockD("Outcome", t.outcome ? null : "Claude Code reports a background command only when it ends.", E("pre", null, t.outcome ? outcomeLine(t.outcome) : "still running")));
      dbody.append(blockD("Output file", t.outputFile ? null : "named only by the notification that ends the command.", E("pre", null, t.outputFile || "not reported yet")));
    }
    dbody.append(block("Operated on", E("pre", null, t.arg || "—")));
    if (t.ctx !== null && t.ctx > 0 && loadToolOutput)
      dbody.append(toolOutputBlock(t, loadToolOutput));
    openDrawer();
  }
  function toolOutputBlock(t, fetcher) {
    const pre = E("pre", null, "loading…");
    const bl = block("Output returned (" + kc(t.ctx ?? 0) + " chars)", pre);
    fetcher(t.id).then((res) => {
      if (!res) {
        pre.textContent = "output not available";
        return;
      }
      pre.textContent = res.text.slice(0, 500) + (res.text.length > 500 || res.truncated ? " …" : "");
      const url = publishedUrl(t.name, res.text);
      if (url)
        bl.parentElement?.insertBefore(publishedBlock(url), bl);
      if (res.text.length > 500 || res.truncated) {
        const more = E("button", "morebtn", "show full ▾");
        const sub = t.name + " · " + kc(res.len) + " chars" + (res.truncated ? " (first " + kc(res.text.length) + " shown)" : "");
        more.onclick = () => openOutput("Tool output", sub, res.text, true);
        bl.append(more);
      }
    });
    return bl;
  }
  function publishedUrl(name, text) {
    if (name !== "Artifact")
      return null;
    return ARTIFACT_URL.exec(text)?.[0] ?? null;
  }
  function publishedBlock(url) {
    const a = E("a", "dlink", url);
    a.href = url;
    a.target = "_blank";
    a.rel = "noreferrer";
    return block("Published at", a);
  }
  function openNote(text) {
    crumbs.length = 0;
    dbody.replaceChildren();
    renderCrumbs();
    dbody.append(dhead("note", "Reported to the session", []));
    dbody.append(blockD("What it says", "attached by a hook or a background review, verbatim", E("pre", null, text)));
    openDrawer();
  }
  function openCall(it, back) {
    if (back)
      crumbs.push(back);
    else
      crumbs.length = 0;
    dbody.replaceChildren();
    renderCrumbs();
    const wired = Boolean(it.callId && loadCallIO);
    const turnPart = it.turnIndex != null ? "turn " + (it.turnIndex + 1) : null;
    const head = dhead("API call" + (it.sub ? " · subagent" : ""), it.callId || "API call", [
      wired ? "loading…" : null,
      turnPart
    ]);
    if (it.error) {
      head.querySelector(".deyebrow")?.append(E("span", "dchip err", "error"));
      dbody.append(head, block("Error", E("pre", null, it.errorMessage || "API call failed")));
    } else {
      dbody.append(head);
    }
    const inTile = wired ? kpiWait("Input") : kpi2("Input", "—");
    const newTile = wired ? kpiWait("New this call") : kpi2("New this call", "—");
    const outTile = wired ? kpiWait("Output") : kpi2("Output", "—");
    dbody.append(kpis(inTile, newTile, outTile));
    const compBlock = E("div", "block");
    dbody.append(compBlock);
    const inPre = E("pre", null, it.arg || "—");
    const inBl = E("div", "block");
    inBl.append(E("div", "blabel", "Input"), E("div", "wdesc", "What this call ADDED to the context — a prompt, or the tool results just returned. The bulk of the input (above) was the prior context, re-read from cache."), inPre);
    const intentPre = E("pre", null, "—");
    const intentBl = blockD("Intent", "What the model said it was about to do, before running this call’s tools.", intentPre);
    intentBl.className = "block hidden";
    const outPre = E("pre", null, wired ? "loading…" : "—");
    const outBl = blockD("Output", "What the model produced: its reply text, and any tools it decided to call.", outPre);
    dbody.append(intentBl, inBl, outBl);
    if (wired) {
      const fetchIO = loadCallIO;
      const callId = it.callId;
      fetchIO(callId).then((res) => {
        if (!res) {
          setDSub(head, ["not found — restart seedeep if this persists", turnPart]);
          setKV(inTile, "—");
          setKV(newTile, "—");
          setKV(outTile, "—");
          outPre.textContent = "—";
          return;
        }
        setDSub(head, [res.model || null, res.effort ? "effort " + res.effort : null, turnPart]);
        const u = res.usage || {};
        const totalIn = (u.input || 0) + (u.cacheRead || 0) + (u.cacheCreation || 0);
        const newThis = (u.input || 0) + (u.cacheCreation || 0);
        setKV(inTile, kc(totalIn));
        setKV(newTile, kc(newThis));
        setKV(outTile, kc(u.output || 0));
        const th = res.thinking;
        if (typeof th === "number" && (u.output || 0) > 0) {
          const bl = E("div", "block");
          bl.append(E("div", "blabel", "Output composition"), thinkingSplit(th, u.output || 0));
          compBlock.after(bl);
        }
        compBlock.replaceChildren(stackBlock("Input composition", kc(totalIn) + " total", [
          { label: "cached", value: u.cacheRead || 0, color: "var(--cache)", detail: kc(u.cacheRead || 0) },
          {
            label: "cache write",
            value: u.cacheCreation || 0,
            color: "var(--create)",
            detail: kc(u.cacheCreation || 0)
          },
          { label: "uncached", value: u.input || 0, color: "var(--input)", detail: kc(u.input || 0) }
        ]));
        if (res.narration) {
          intentBl.className = "block";
          fillIO(intentPre, intentBl, { text: res.narration, len: res.narration.length, truncated: false }, "Intent", callId, null, false);
        }
        fillIO(inPre, inBl, res.input, "Call input", callId, it.arg, true);
        fillIO(outPre, outBl, res.output, "Call output", callId, "—", Boolean(res.outputHasTools));
      });
    }
    openDrawer();
  }
  function fillIO(pre, bl, io, title, callId, fallback, plain) {
    if (!io || !io.text) {
      pre.textContent = fallback || "—";
      return;
    }
    pre.textContent = io.text.slice(0, 500) + (io.text.length > 500 || io.truncated ? " …" : "");
    if (io.text.length > 500 || io.truncated) {
      const more = E("button", "morebtn", "show full ▾");
      const sub = (callId || "call") + " · " + kc(io.len) + " chars" + (io.truncated ? " (first " + kc(io.text.length) + " shown)" : "");
      more.onclick = () => openOutput(title, sub, io.text, plain);
      bl.append(more);
    }
  }
  function openBlock(handle, back) {
    if (handle.kind === "call") {
      openCall({ callId: handle.callId }, back);
      return;
    }
    if (handle.kind === "turn-text") {
      const t = state.snapshot().turnList.find((x) => x.index === handle.turnIndex);
      if (!t)
        return;
      const isPrompt = handle.which === "prompt";
      const full = isPrompt ? t.prompt : t.result;
      const title = isPrompt ? "Prompt · T" + t.index : "Final answer · T" + t.index;
      const sub = isPrompt ? t.command ? "slash command " + t.command : "typed prompt" : t.state === "interrupted" ? "the turn was interrupted" : "model output, verbatim";
      openOutput(title, sub, full || (isPrompt ? "(no prompt text)" : "(no final answer — the turn did not close)"));
      return;
    }
    if (handle.kind === "tool") {
      const s = state.snapshot();
      const own = s.mainTools.find((t) => t.id === handle.toolUseId);
      if (own) {
        openTool(own, "main session", back);
        return;
      }
      for (const a of s.subagents) {
        const t = a.tools.find((t2) => t2.id === handle.toolUseId);
        if (t) {
          openTool(t, a.agentType || a.agentId, back);
          return;
        }
      }
      openTool({ id: handle.toolUseId, name: "", ms: null, ctx: null, arg: null }, null, back);
      return;
    }
    if (handle.kind === "subagent") {
      const s = state.snapshot();
      const a = s.subagents.find((ag) => ag.agentId === handle.agentId);
      if (a) {
        openSub(a, back);
        return;
      }
      if (handle.toolUseId) {
        const own = s.mainTools.find((t) => t.id === handle.toolUseId);
        openTool(own ?? { id: handle.toolUseId, name: "Agent", ms: null, ctx: null, arg: null }, null, back);
      }
    }
  }
  traceBtn.onclick = () => {
    if (!trace)
      trace = createTrace(container, { onBlock: openBlock });
    trace.open(spanStore.snapshot(selectedTurn), selectedTurn, ended2);
  };
  function openFeedItem(it) {
    if (it.apiCall) {
      openCall(it);
      return;
    }
    if (it.note) {
      openNote(it.arg ?? "");
      return;
    }
    if (!it.id)
      return;
    const s = state.snapshot();
    const agent = s.subagents.find((a) => a.toolUseId === it.id);
    if (agent) {
      openSub(agent);
      return;
    }
    const own = s.mainTools.find((t) => t.id === it.id);
    if (own) {
      openTool(own, "main session");
      return;
    }
    for (const a of s.subagents) {
      const t = a.tools.find((t2) => t2.id === it.id);
      if (t) {
        openTool(t, a.agentType || a.agentId);
        return;
      }
    }
  }
  function openToolType(name, s, back) {
    if (back)
      crumbs.push(back);
    else
      crumbs.length = 0;
    const list = [...s.mainTools.filter((t) => t.name === name)].sort((a, b) => (b.ctx ?? 0) - (a.ctx ?? 0));
    dbody.replaceChildren();
    renderCrumbs();
    dbody.append(dhead("tool type", name, ["main session"]));
    const totalCtx = list.reduce((n, t) => n + (t.ctx ?? 0), 0);
    const totalMs = list.reduce((n, t) => n + (t.ms ?? 0), 0);
    const hasTiming = list.some((t) => t.ms !== null);
    const tiles = [kpi2("Calls", String(list.length)), kpi2("Total output", kc(totalCtx), "chars")];
    if (hasTiming)
      tiles.push(kpi2("Total time", formatToolMs(totalMs)));
    dbody.append(kpis(...tiles));
    const backToType = { label: name, open: () => openToolType(name, s) };
    const filterInput = E("input", "tfilter");
    filterInput.placeholder = "filter by path or argument";
    const filterBar = E("div", "tfilterbar");
    filterBar.append(filterInput);
    const countEl = E("div", "tcount2", "");
    const box = E("div");
    const renderRows = () => {
      const q = filterInput.value.toLowerCase();
      const filtered = q ? list.filter((t) => (t.arg || "").toLowerCase().includes(q)) : list;
      countEl.textContent = q ? `${filtered.length} of ${list.length} calls` : `${list.length} calls`;
      box.replaceChildren();
      for (const t of filtered) {
        const r = E("div", "ttrow" + (t.error ? " err" : ""));
        r.onclick = () => openTool(t, "main session", backToType);
        const nm = E("div", "tn");
        nm.append(document.createTextNode(t.name + "  "));
        if (t.error)
          nm.append(E("span", "terr", "error"));
        const arg = E("span", "targ");
        arg.textContent = t.arg || "";
        nm.append(arg);
        r.append(nm, E("div", "tv", t.ms != null ? formatToolMs(t.ms) : "—"), E("div", "tv", typeof t.ctx === "number" ? kc(t.ctx) + "ch" : "—"));
        box.append(r);
      }
      if (!filtered.length)
        box.append(E("div", "wdesc", "No calls match the filter."));
    };
    filterInput.oninput = renderRows;
    renderRows();
    dbody.append(filterBar, countEl, block("All " + name + " calls", box));
    openDrawer();
  }
  function openSkill(sk, skills, back) {
    if (back)
      crumbs.push(back);
    else
      crumbs.length = 0;
    dbody.replaceChildren();
    renderCrumbs();
    dbody.append(dhead("skill", sk.name, ["invoked by the model"]));
    const share = skillShare(sk, skills);
    dbody.append(kpis(kpi2("Model invocations", String(sk.invokes)), kpi2("Active for", String(sk.turns), "API turns")));
    if (share != null) {
      const bl = E("div", "block");
      bl.append(fillBar("Share of turns", sk.turns + " turns", share, "linear-gradient(90deg,var(--good),var(--cache))"));
      dbody.append(bl);
    }
    dbody.append(block("What these mean", Object.assign(E("div", "wdesc"), {
      textContent: 'Model invocations = times the model called the Skill tool for this skill (not user-typed /commands — those appear in the Commands widget). API turns = assistant lines where this skill was the last one active — a long-lived skill stays "active" for many turns after a single invocation, so that count is much larger.'
    })));
    openDrawer();
  }
  function openCommand(cmd, back) {
    if (back)
      crumbs.push(back);
    else
      crumbs.length = 0;
    dbody.replaceChildren();
    renderCrumbs();
    dbody.append(dhead("command", "/" + cmd.name, ["used " + cmd.count + (cmd.count === 1 ? " time" : " times")]));
    const full = state.snapshot();
    const turnsWithCmd = full.turnList.filter((t) => t.commands.some((c) => c.name === cmd.name));
    if (turnsWithCmd.length) {
      const box = E("div");
      for (const turn of turnsWithCmd) {
        const turnCount = turn.commands.find((c) => c.name === cmd.name).count;
        const label = entryTitle(full, turn) || entryLabel(turn);
        const r = E("div", "ttrow");
        r.onclick = () => {
          closeDrawer();
          selectTurn(turn.index);
        };
        const nm = E("div", "tn");
        nm.textContent = label;
        r.append(nm, E("div", "tv", turnCount > 1 ? "×" + turnCount : ""));
        box.append(r);
      }
      dbody.append(block("Used in", box));
    }
    openDrawer();
  }
  function openAllTools(s) {
    crumbs.length = 0;
    dbody.replaceChildren();
    renderCrumbs();
    dbody.append(dhead("tools", "main session", [s.mainTools.length + " calls"]));
    const totalCtx = s.mainTools.reduce((n, t) => n + (t.ctx ?? 0), 0);
    const hasTiming = s.mainTools.some((t) => t.ms !== null);
    const totalMs = s.mainTools.reduce((n, t) => n + (t.ms ?? 0), 0);
    const tiles = [kpi2("Calls", String(s.mainTools.length)), kpi2("Total output", kc(totalCtx), "chars")];
    if (hasTiming)
      tiles.push(kpi2("Total time", formatToolMs(totalMs)));
    dbody.append(kpis(...tiles));
    let sortByTime = false;
    const sortBtn = E("button", "tsort", "size ↓");
    const filterInput = E("input", "tfilter");
    filterInput.placeholder = "filter by name or path";
    const filterBar = E("div", "tfilterbar");
    filterBar.append(filterInput, sortBtn);
    const countEl = E("div", "tcount2", "");
    const box = E("div");
    const backToAll = { label: "all tools", open: () => openAllTools(s) };
    const callNumber = new Map(s.mainTools.map((t, i) => [t.id, i + 1]));
    const NO_TURN = -1;
    const turnKey = (t) => t.turnIndex ?? NO_TURN;
    const turnsPresent = [...new Set(s.mainTools.map(turnKey))].sort((a, b) => a - b);
    const turnLabel = (idx) => {
      if (idx === NO_TURN)
        return "Before the first entry";
      const turn = s.turnList.find((t) => t.index === idx);
      return turn && (entryTitle(s, turn) || entryLabel(turn)) || "Entry " + idx;
    };
    const latestTurn = turnsPresent.length ? turnsPresent[turnsPresent.length - 1] : null;
    const expanded = openToolTurns ?? new Set(latestTurn === null ? [] : [latestTurn]);
    const remember = (idx, open) => {
      openToolTurns = expanded;
      if (open)
        expanded.add(idx);
      else
        expanded.delete(idx);
    };
    const toolRow = (t) => {
      const r = E("div", "ttrow" + (t.error ? " err" : ""));
      r.onclick = () => openTool(t, "main session", backToAll);
      const nm = E("div", "tn");
      nm.append(E("span", "tnum", "#" + (callNumber.get(t.id) ?? 0)));
      nm.append(document.createTextNode(t.name + "  "));
      if (t.error)
        nm.append(E("span", "terr", "error"));
      const arg = E("span", "targ");
      arg.textContent = t.arg || "";
      nm.append(arg);
      r.append(nm, E("div", "tv", t.ms != null ? formatToolMs(t.ms) : "—"), E("div", "tv", typeof t.ctx === "number" ? kc(t.ctx) + "ch" : "—"));
      return r;
    };
    const renderRows = () => {
      const q = filterInput.value.toLowerCase();
      const sorted = (list) => sortByTime ? [...list].sort((a, b) => (b.ms ?? -1) - (a.ms ?? -1)) : [...list].sort((a, b) => (b.ctx ?? 0) - (a.ctx ?? 0));
      const filtered = q ? s.mainTools.filter((t) => t.name.toLowerCase().includes(q) || (t.arg || "").toLowerCase().includes(q)) : s.mainTools;
      countEl.textContent = q ? `${filtered.length} of ${s.mainTools.length} calls` : `${s.mainTools.length} calls`;
      box.replaceChildren();
      if (!filtered.length) {
        box.append(E("div", "wdesc", q ? "No tools match the filter." : "No tool output available yet."));
        return;
      }
      if (selectedTurn !== null) {
        for (const t of sorted(filtered))
          box.append(toolRow(t));
        return;
      }
      for (const idx of turnsPresent) {
        const group = filtered.filter((t) => turnKey(t) === idx);
        if (!group.length)
          continue;
        const ctx = group.reduce((n, t) => n + (t.ctx ?? 0), 0);
        const meta = `${group.length} call${group.length === 1 ? "" : "s"} · ${kc(ctx)}ch`;
        box.append(turnGroup(turnLabel(idx), meta, () => sorted(group).map(toolRow), q ? true : expanded.has(idx), q ? () => {} : (open) => remember(idx, open)));
      }
    };
    filterInput.oninput = renderRows;
    sortBtn.onclick = () => {
      sortByTime = !sortByTime;
      sortBtn.textContent = sortByTime ? "time ↓" : "size ↓";
      renderRows();
    };
    renderRows();
    dbody.append(filterBar, countEl, block("All calls", box));
    openDrawer();
  }
  function openAllFiles() {
    crumbs.length = 0;
    dbody.replaceChildren();
    renderCrumbs();
    if (!filesData) {
      dbody.append(dhead("files changed", "main session", ["reading the repository…"]));
      dbody.append(E("div", "wdesc", "Waiting for the repository to answer."));
      openDrawer();
      return;
    }
    const repoFiles = filesInScope();
    const scratchList = scratchInScope();
    const files = [...repoFiles, ...scratchList];
    const artifacts = artifactsInScope();
    const scratchTotal = scratchList.length;
    const projectTotal = repoFiles.length;
    dbody.append(dhead("files changed", "main session", [
      projectTotal + (projectTotal === 1 ? " project file" : " project files"),
      scratchTotal ? scratchTotal + " scratchpad" : null,
      artifacts.length ? artifacts.length + " published" : null
    ]));
    dbody.append(artifacts.length ? kpis(kpi2("Project", String(projectTotal)), kpi2("Scratchpad", String(scratchTotal)), kpi2("Published", String(artifacts.length))) : kpis(kpi2("Project", String(projectTotal)), kpi2("Scratchpad", String(scratchTotal))));
    const filterInput = E("input", "tfilter");
    filterInput.placeholder = "filter by path";
    const filterBar = E("div", "tfilterbar");
    filterBar.append(filterInput);
    const countEl = E("div", "tcount2", "");
    const box = E("div");
    let typeFilter = null;
    const typeBar = E("div", "toolchips fchgtypes");
    const chipEls = new Map;
    const mkChip = (ext, label, n) => {
      const t = ext === null ? "" : tintOf(ext);
      const c = E("span", "tchip clk" + (t ? " " + t : ""));
      c.append(document.createTextNode(label + " "), E("b", null, String(n)));
      c.onclick = () => {
        typeFilter = typeFilter === ext ? null : ext;
        paintChips();
        renderRows();
      };
      chipEls.set(ext, c);
      typeBar.append(c);
    };
    const paintChips = () => {
      for (const [ext, el8] of chipEls)
        el8.classList.toggle("on", typeFilter === ext || typeFilter === null && ext === null);
    };
    const renderRows = () => {
      const q = filterInput.value.toLowerCase();
      const filtered = files.filter((f) => (typeFilter === null || extOf(f.base) === typeFilter) && (!q || f.path.toLowerCase().includes(q)));
      const narrowed = q !== "" || typeFilter !== null;
      countEl.textContent = narrowed ? `${filtered.length} of ${files.length} files` : `${files.length} files`;
      box.replaceChildren();
      if (!filtered.length) {
        box.append(E("div", "wdesc", narrowed ? "No files match the filters." : filesDescText(repoFiles)));
        return;
      }
      const groups = [
        ["Project", filtered.filter((f) => !f.scratch)],
        ["Scratchpad", filtered.filter((f) => f.scratch)]
      ];
      const separated = groups.filter(([, list]) => list.length).length > 1;
      for (const [label, list] of groups) {
        if (!list.length)
          continue;
        if (separated)
          box.append(E("div", "fchggrp", `${label} · ${list.length}`));
        for (const f of list) {
          const r = E("div", "ttrow");
          const nm = E("div", "tn");
          nm.append(E("span", tintOf(extOf(f.base)), f.base), document.createTextNode("  "));
          const dir = E("span", "targ");
          dir.textContent = f.dir || "·";
          nm.append(dir);
          r.append(nm);
          box.append(r);
        }
      }
    };
    filterInput.oninput = renderRows;
    mkChip(null, "all", files.length);
    for (const [ext, n] of extCounts(files))
      mkChip(ext, ext || "—", n);
    paintChips();
    renderRows();
    dbody.append(filterBar, typeBar, countEl, blockD("All changed files", "Project files come from git — the commits this session made, plus what is still uncommitted while it runs — so they include shell writes and build output. Scratchpad files are this session's temporaries, outside the repo, and only Claude Code's own ledger sees them.", box));
    if (artifacts.length) {
      const abox = E("div");
      for (const a of artifacts) {
        const row = E("div", "fchgarow");
        row.append(E("div", "fchgalbl", a.label));
        const link = E("a", "dlink fchgaurl", a.url);
        link.href = a.url;
        link.target = "_blank";
        link.rel = "noreferrer";
        row.append(link);
        abox.append(row);
      }
      dbody.append(blockD(artifacts.length === 1 ? "Published artifact" : "Published artifacts", "Pages this session put online with the Artifact tool. They live on claude.ai, not on this machine — the HTML they were built from is a scratchpad temporary, the link is what outlasts the session. One row per page: a redeploy overwrites the page it names.", abox));
    }
    openDrawer();
  }
  function withSessionNotes(rows) {
    const notes = (lastSnap?.notes ?? []).filter((n) => selectedTurn === null || n.turnIndex === selectedTurn);
    if (!notes.length)
      return rows;
    const out = [...rows];
    for (const [i, n] of notes.entries()) {
      const t0 = Date.parse(n.at);
      if (!Number.isFinite(t0))
        continue;
      const row = {
        id: "note-" + i,
        type: "note",
        name: "Note",
        detail: n.text,
        t0,
        ms: null,
        status: "ok",
        agent: null,
        lane: 0,
        handle: null,
        turnIndex: n.turnIndex ?? rows[0]?.turnIndex ?? 1
      };
      const at = out.findIndex((r) => r.t0 > t0);
      out.splice(at === -1 ? out.length : at, 0, row);
    }
    return out;
  }
  function openAllActivity() {
    crumbs.length = 0;
    dbody.replaceChildren();
    renderCrumbs();
    const rows = withSessionNotes(flattenActivity(spanStore.snapshot(selectedTurn)));
    const scopedTurn = selectedTurn !== null && lastSnap ? lastSnap.turnList.find((t) => t.index === selectedTurn) : null;
    const title = selectedTurn !== null ? entryTitle(lastSnap, scopedTurn) || "Entry" : "Session";
    dbody.append(dhead("activity", title, [rows.length + " activities", selectedTurn === null ? "all turns" : null]));
    const activityIndex = new Map(rows.map((r, i) => [r.id, i + 1]));
    const turnLabelMap = new Map;
    if (lastSnap) {
      for (const t of lastSnap.turnList) {
        turnLabelMap.set(t.index, entryTitle(lastSnap, t) || entryLabel(t));
      }
    }
    const tools = rows.filter((r) => r.type === "tool" || r.type === "subspan").length;
    const calls = rows.filter((r) => r.type === "api").length;
    const elapsed = rows.length ? rows[rows.length - 1].t0 - rows[0].t0 : 0;
    dbody.append(kpis(kpi2("Activities", String(rows.length)), kpi2("Tool calls", String(tools)), kpi2("API calls", String(calls)), kpi2("Elapsed", formatToolMs(elapsed))));
    let oldestFirst = true;
    const sortBtn = E("button", "tsort", "oldest ↓");
    const filterInput = E("input", "tfilter");
    filterInput.placeholder = "filter by name or argument";
    const filterBar = E("div", "tfilterbar");
    filterBar.append(filterInput, sortBtn);
    const countEl = E("div", "tcount2", "");
    const box = E("div");
    const backToList = { label: "all activity", open: () => openAllActivity() };
    const latestTurn = rows.length ? rows.reduce((max, r) => r.turnIndex > max ? r.turnIndex : max, rows[0].turnIndex) : null;
    const expandedTurns = openActivityTurns ?? new Set(latestTurn === null ? [] : [latestTurn]);
    const remember = (idx, open) => {
      openActivityTurns = expandedTurns;
      if (open)
        expandedTurns.add(idx);
      else
        expandedTurns.delete(idx);
    };
    const activityRow = (r, t0) => {
      const row = E("div", `ttrow t-${r.type}` + (r.lane > 0 ? " lane" : "") + (r.status === "error" ? " err" : ""));
      const nm = E("div", "tn");
      nm.append(E("span", "tnum", "#" + (activityIndex.get(r.id) ?? 0)));
      nm.append(document.createTextNode(r.name));
      if (r.status === "error")
        nm.append(E("span", "terr", "error"));
      if (r.flagged)
        nm.append(E("span", "tflag", "⚑"));
      if (r.agent)
        nm.append(E("span", "aagent", r.agent));
      if (r.detail)
        nm.append(E("span", "targ", r.detail));
      const dur2 = E("div", "tv");
      const durText = r.status === "running" ? toolDuration(null, ended2) : r.ms != null ? formatToolMs(r.ms) : "—";
      dur2.append(E("span", r.status === "running" ? "run" : null, durText));
      row.append(nm, dur2, E("div", "tv", formatOffset(r.t0 - t0)));
      if (r.handle) {
        const h = r.handle;
        row.onclick = () => openBlock(h, backToList);
      } else if (r.type === "note") {
        const text = r.detail ?? "";
        row.onclick = () => openNote(text);
      }
      return row;
    };
    const renderRows = () => {
      const q = filterInput.value.toLowerCase();
      const ordered = oldestFirst ? rows : [...rows].reverse();
      const filtered = q ? ordered.filter((r) => activityMatches(r, q)) : ordered;
      countEl.textContent = q ? `${filtered.length} of ${rows.length} activities` : `${rows.length} activities`;
      box.replaceChildren();
      if (!filtered.length) {
        box.append(E("div", "wdesc", q ? "No activity matches the filter." : "No activity in this scope yet."));
        return;
      }
      const t0 = rows.length ? rows[0].t0 : 0;
      if (selectedTurn !== null) {
        for (const r of filtered)
          box.append(activityRow(r, t0));
        return;
      }
      const order = [];
      const byTurn = new Map;
      for (const r of filtered) {
        let bucket = byTurn.get(r.turnIndex);
        if (!bucket) {
          bucket = [];
          byTurn.set(r.turnIndex, bucket);
          order.push(r.turnIndex);
        }
        bucket.push(r);
      }
      for (const idx of order) {
        const group = byTurn.get(idx);
        const meta = `${group.length} activit${group.length === 1 ? "y" : "ies"}`;
        box.append(turnGroup(turnLabelMap.get(idx) ?? "Entry " + idx, meta, () => group.map((r) => activityRow(r, t0)), q ? true : expandedTurns.has(idx), q ? () => {} : (open) => remember(idx, open)));
      }
    };
    filterInput.oninput = renderRows;
    sortBtn.onclick = () => {
      oldestFirst = !oldestFirst;
      sortBtn.textContent = oldestFirst ? "oldest ↓" : "newest ↓";
      renderRows();
    };
    renderRows();
    dbody.append(filterBar, countEl, block("All activity", box));
    openDrawer();
  }
  liveExpand.onclick = openAllActivity;
  toolsExpand.onclick = () => {
    const full = state.snapshot();
    openAllTools(selectedTurn !== null ? scopeToTurn(full, selectedTurn) : full);
  };
  filesExpand.onclick = () => openAllFiles();
  let commitsData = null;
  function openAllCommits() {
    if (!commitsData?.commits.length)
      return;
    crumbs.length = 0;
    dbody.replaceChildren();
    renderCrumbs();
    dbody.append(dhead("commits", "main session", [
      commitsData.commits.length + (commitsData.commits.length === 1 ? " commit" : " commits"),
      commitsData.remote ? commitsData.remote.replace(/^https:\/\//, "") : "no remote"
    ]));
    dbody.append(commitsList(commitsData.commits));
    openDrawer();
  }
  commitsExpand.onclick = openAllCommits;
  function refreshCommits() {
    if (!loadCommits)
      return;
    loadCommits().then((data) => {
      if (destroyed || !data || !Array.isArray(data.commits))
        return;
      commitsData = data;
      commitsExpand.hidden = data.commits.length === 0;
      renderCommitsCard(commitsHost, data, openAllCommits);
    });
  }
  let cardsData = null;
  function openAllCards() {
    if (!cardsData?.cards.length)
      return;
    crumbs.length = 0;
    dbody.replaceChildren();
    renderCrumbs();
    const wrote = cardsData.cards.filter((c) => c.evidence === "wrote").length;
    dbody.append(dhead("cards", "main session", [
      cardsData.cards.length + (cardsData.cards.length === 1 ? " card" : " cards"),
      `${wrote} changed`
    ]));
    dbody.append(cardsList(cardsData.cards));
    openDrawer();
  }
  cardsExpand.onclick = openAllCards;
  function refreshCards() {
    if (!loadCards)
      return;
    loadCards().then((data) => {
      if (destroyed || !data || !Array.isArray(data.cards))
        return;
      cardsData = data;
      cardsExpand.hidden = data.cards.length === 0;
      renderCardsCard(cardsHost, data, openAllCards);
    });
  }
  let filesData = null;
  let filesFetchedAt = -1;
  function refreshFiles() {
    if (!loadFiles)
      return;
    filesFetchedAt = lastSnap?.filesChanged.length ?? 0;
    loadFiles().then((data) => {
      if (destroyed || !data || !Array.isArray(data.files))
        return;
      filesData = data;
      scheduleRender();
    });
  }
  let filesDebounce = null;
  function maybeRefreshFiles() {
    if (!loadFiles || !live || filesDebounce)
      return;
    if ((lastSnap?.filesChanged.length ?? 0) === filesFetchedAt)
      return;
    filesDebounce = later(() => {
      filesDebounce = null;
      refreshFiles();
    }, 1500);
  }
  let destroyed = false;
  function refreshOutput() {
    refreshCommits();
    refreshCards();
    refreshFiles();
  }
  const COMMITS_REFRESH_MS = 60000;
  let commitsTimer = null;
  const MAX_SUB_TOASTS = 5, MAX_TOOL_TOASTS = 5, TOAST_SUB_MS = 5000, TOAST_TOOL_MS = 1500;
  const TOAST_ANNOUNCE_MS = 8000;
  const TOAST_NOISE = new Set(["Agent"]);
  const subToastModels = new Map;
  const timers = new Set;
  function later(fn, ms) {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  }
  function pushToast(ev) {
    const t = E("div", "toast" + (ev.sub ? " sub" : "") + (ev.sev ? " v-" + ev.sev : ""));
    const icon = E("div", "ticon", ev.sub ? "⑃" : ev.sev ? "⚠" : "›");
    const main = E("div", "tmain");
    main.append(E("div", "tname", ev.name));
    if (!ev.sub && ev.arg) {
      main.append(E("div", "targ2", ev.arg));
    }
    if (ev.sub) {
      const mdl = E("div", "tmodel", shortModel2(ev.model) || " ");
      main.append(mdl);
      if (ev.agentId && !ev.model)
        subToastModels.set(ev.agentId, { node: t, line: mdl });
    }
    t.append(icon, main, E("div", "tkind", ev.kind ?? (ev.sub ? "agent" : ev.sev ? "verdict" : "tool")));
    const rail = ev.sub ? subToasts : toasts;
    rail.append(t);
    const max = ev.sub ? MAX_SUB_TOASTS : MAX_TOOL_TOASTS;
    while (rail.children.length > max)
      dismiss(rail.firstChild, true);
    later(() => dismiss(t, false), ev.sev ? TOAST_ANNOUNCE_MS : ev.sub ? TOAST_SUB_MS : TOAST_TOOL_MS);
  }
  function verdictHeadline(v) {
    const lead = v.findings.find((f) => f.severity === "crit") ?? v.findings[0];
    if (!lead)
      return "";
    return v.findings.length > 1 ? `${lead.text}  (+${v.findings.length - 1} more)` : lead.text;
  }
  function syncSubToastModels(full) {
    if (!subToastModels.size)
      return;
    for (const a of full.subagents || []) {
      const slot = a.agentId ? subToastModels.get(a.agentId) : undefined;
      if (!slot || !a.model)
        continue;
      slot.line.textContent = shortModel2(a.model);
      subToastModels.delete(a.agentId);
    }
  }
  function dropToastSlot(node) {
    for (const [agentId, slot] of subToastModels)
      if (slot.node === node)
        subToastModels.delete(agentId);
  }
  function dismiss(node, now) {
    if (!node)
      return;
    dropToastSlot(node);
    if (now) {
      node.remove();
      return;
    }
    if (node._dismissed)
      return;
    node._dismissed = true;
    node.classList.add("out");
    later(() => node.remove(), 320);
  }
  let toastsArmed = false;
  let live = !opts.loading;
  const seenSubagents = new Set;
  const offEvent = state.onEvent((e, ctx) => {
    const isFirstSpawn = e.type === "subagent-meta" && e.agentId != null && !seenSubagents.has(e.agentId);
    if (isFirstSpawn && e.agentId != null)
      seenSubagents.add(e.agentId);
    spanStore.apply(e, ctx);
    if (trace && trace.isOpen()) {
      if (!traceRafPending) {
        traceRafPending = true;
        const _trace = trace;
        requestAnimationFrame(() => {
          traceRafPending = false;
          _trace.update(spanStore.snapshot(selectedTurn), ended2);
        });
      }
    }
    if (e.type === "usage" && ctx?.newCall) {
      const evTs = tsMs(e.timestamp);
      feed.push({
        apiCall: true,
        callId: e.callId ?? null,
        name: "API call",
        arg: ctx?.label ?? null,
        sub: e.agentId != null,
        turnIndex: ctx?.turnIndex ?? null,
        ts: evTs ?? 0,
        startMs: evTs,
        ms: ctx?.callMs ?? null,
        error: Boolean(e.apiError),
        errorMessage: e.apiError?.message ?? null
      });
      if (live)
        renderFeed();
    } else if (e.type === "tool-start") {
      const evTs = tsMs(e.timestamp);
      feed.push({
        id: e.id,
        name: e.name,
        arg: ctx?.label ?? null,
        sub: e.agentId != null,
        spawn: SPAWN_TOOL_NAMES.has(e.name),
        subagentType: e.subagentType,
        launchPrompt: e.launchPrompt ?? null,
        turnIndex: ctx?.turnIndex ?? null,
        ts: evTs ?? 0,
        startMs: evTs,
        ms: null
      });
      if (live)
        renderFeed();
    } else if (e.type === "tool-end") {
      const changed = feed.end(e.toolUseId, e.timestamp, e.error);
      if (e.background)
        feed.mark(e.toolUseId);
      if (changed && live)
        renderFeed();
    } else if (e.type === "note" && e.toolUseId === null) {
      const evTs = tsMs(e.timestamp);
      feed.push({
        name: "Note",
        arg: e.text,
        note: true,
        turnIndex: ctx?.turnIndex ?? null,
        ts: evTs ?? 0,
        startMs: null,
        ms: null
      });
      if (live)
        renderFeed();
    } else if (e.type === "agent-end" && e.toolUseId) {
      const clean = e.status === null || e.status === "completed" || e.status === "stopped";
      const line = e.summary === null ? null : outcomeLine(e.summary);
      if (feed.outcome(e.toolUseId, !clean, line) && live)
        renderFeed();
    }
    if (!toastsArmed)
      return;
    if (e.type === "tool-start" && e.agentId == null && !TOAST_NOISE.has(e.name))
      pushToast({ name: e.name, arg: ctx?.label ?? null });
    else if (isFirstSpawn && e.type === "subagent-meta") {
      const known = e.model ?? (lastSnap?.subagents || []).find((a) => a.agentId === e.agentId)?.model ?? (state.snapshot().subagents || []).find((a) => a.agentId === e.agentId)?.model ?? null;
      pushToast({ sub: true, name: e.agentType ?? "agent", agentId: e.agentId ?? undefined, model: known });
    } else if (e.type === "turn-end" && e.agentId == null) {
      const snap = state.snapshot();
      const ended3 = snap.turnList.filter((t) => t.state !== "live").at(-1);
      if (ended3 && ended3.kind === "work" && !announced.has(ended3.index)) {
        const v = computeVerdict(ended3, snap);
        announced.add(ended3.index);
        if (v.severity === "crit")
          pushToast({ name: "Verdict · turn #" + ended3.index, arg: verdictHeadline(v), sev: "crit" });
      }
    }
  });
  ensureBaseline(() => render());
  function render(full = state.snapshot()) {
    lastSnap = full;
    verdicts = computeVerdicts(full);
    liveCounters = [];
    nowTickArmed = false;
    const s = selectedTurn !== null ? scopeToTurn(full, selectedTurn) : full;
    renderCtx(s.main);
    renderTokenUsage(s, full);
    renderSkills(s);
    renderCommands(s);
    renderSubLive(s, full);
    renderTools(s);
    renderFiles(s);
    renderSubs(s);
    syncSubToastModels(full);
    renderTurnExplorer(full);
    renderScopeBanner(full);
    renderFeed();
    renderNowPanel();
    syncTicker();
  }
  let renderScheduled = false;
  function scheduleRender() {
    if (!live || renderScheduled)
      return;
    renderScheduled = true;
    later(() => {
      renderScheduled = false;
      render();
    }, 0);
  }
  const off = state.onChange(scheduleRender);
  if (live)
    render();
  return {
    goLive() {
      toastsArmed = true;
      if (live)
        return;
      live = true;
      render();
      refreshOutput();
      if (!ended2 && !commitsTimer)
        commitsTimer = setInterval(refreshOutput, COMMITS_REFRESH_MS);
    },
    setWaiting(kind, since) {
      if (kind === waiting)
        return;
      const entering = kind !== null && waiting === null;
      waiting = kind;
      waitingSince = kind === null ? null : since;
      if (entering && toastsArmed && !ended2) {
        const tool = pendingTool();
        pushToast({
          name: kind === "permission" ? "Waiting for your approval" : "Waiting for your answer",
          arg: tool ? `${tool.name}${tool.arg ? " · " + tool.arg : ""}` : null,
          sev: "warn",
          kind: "pending"
        });
      }
      scheduleRender();
    },
    setBusy(working3) {
      if (working3 === busy)
        return;
      busy = working3;
      scheduleRender();
    },
    setEnded() {
      if (ended2)
        return;
      ended2 = true;
      root.classList.add("ended");
      scheduleRender();
      if (commitsTimer) {
        clearInterval(commitsTimer);
        commitsTimer = null;
      }
      refreshOutput();
    },
    setLive() {
      if (!ended2)
        return;
      ended2 = false;
      root.classList.remove("ended");
      scheduleRender();
      if (live && !commitsTimer)
        commitsTimer = setInterval(refreshOutput, COMMITS_REFRESH_MS);
      refreshOutput();
    },
    destroy() {
      destroyed = true;
      off();
      offEvent();
      if (commitsTimer)
        clearInterval(commitsTimer);
      for (const t of timers)
        clearTimeout(t);
      stopTicker();
      stopWatchingPrompt();
      document.removeEventListener("keydown", onKey);
      if (drawer.classList.contains("on"))
        unlockPageScroll();
      if (trace)
        trace.destroy();
      container.replaceChildren();
    },
    _openBlock: openBlock
  };
}

// apps/server/src/client/view.ts
function createView(container, treeState, opts = {}) {
  let ended2 = opts.ended ?? false;
  const body = document.createElement("div");
  const graphHost = document.createElement("div");
  body.append(graphHost);
  const loader = buildLoader();
  container.append(loader, body);
  const graph = createGraph(graphHost, treeState, {
    loading: true,
    loadToolOutput: opts.loadToolOutput,
    loadCallIO: opts.loadCallIO,
    loadAgentPrompt: opts.loadAgentPrompt,
    loadCommits: opts.loadCommits,
    loadFiles: opts.loadFiles,
    loadCards: opts.loadCards,
    ended: ended2,
    sessionId: opts.sessionId
  });
  let replayEnded = false;
  function mount() {
    loader.style.display = replayEnded ? "none" : "";
    body.style.display = replayEnded ? "" : "none";
  }
  mount();
  return {
    setEnded() {
      ended2 = true;
      graph.setEnded();
    },
    setLive() {
      ended2 = false;
      graph.setLive();
    },
    setWaiting(kind, since) {
      if (ended2)
        return;
      graph.setWaiting(kind, since);
    },
    setBusy(working2) {
      if (ended2)
        return;
      graph.setBusy(working2);
    },
    onReplayEnd() {
      if (replayEnded)
        return;
      replayEnded = true;
      graph.goLive();
      mount();
    },
    destroy() {
      graph.destroy();
      container.replaceChildren();
    }
  };
}
function buildLoader() {
  const el8 = (tag, cls) => {
    const n = document.createElement(tag);
    n.className = cls;
    return n;
  };
  const card2 = (...bars) => {
    const c = el8("div", "card sk-card");
    for (const w of bars) {
      const b = el8("div", "sk-bar");
      b.style.setProperty("width", w);
      c.append(b);
    }
    return c;
  };
  const root = el8("div", "skeleton");
  const note = el8("div", "sk-note");
  note.textContent = "Reading the session…";
  const toprow = el8("div", "toprow");
  const stack = el8("div", "stack");
  const monitor = card2("40%", "70%", "55%");
  monitor.classList.add("sublivecard");
  stack.append(card2("30%", "90%", "60%"), monitor);
  toprow.append(stack, card2("35%", "80%", "65%", "80%", "50%"));
  const statsrow = el8("div", "statsrow");
  for (let i = 0;i < 3; i++)
    statsrow.append(card2("30%", "85%", "60%"));
  root.append(note, toprow, statsrow);
  return root;
}

// apps/server/src/client/app.ts
initAuth();
authFetch("/api/config").then((r) => r.json()).then((cfg) => {
  const brand = document.querySelector("header > strong");
  markVersion(cfg.version, brand);
  markDevBuild(cfg.dev === true, brand);
}).catch(() => {});
var stream = createStream({ EventSourceImpl: AuthEventSource });
function rootEl(id) {
  const el8 = document.getElementById(id);
  if (!el8)
    throw new Error(`seedeep: #${id} is missing from index.html`);
  return el8;
}
var navEl = rootEl("nav");
var tabsEl = rootEl("tabs");
var panelsEl = rootEl("panels");
var dropdownEl = rootEl("dropdown");
var connEl = rootEl("conn");
if (typeof document.body["append"] === "function") {
  createSettingsPanel(document.querySelector("header"));
}
var openTabs = new Map;
var activeId = null;
var known = new Set;
var booted = false;
var lastRosterLen = -1;
var lastPaintedLen = -1;
var tabBar = createTabBar(tabsEl, { onSwitch: switchTo, onClose: closeTab });
var navMenu = createNavMenu(navEl, {
  items: [
    { id: HOME_ID, label: "Home", hint: "retrospective" },
    { id: COMPARE_ID, label: "Compare", hint: "sessions" },
    { id: SEARCH_ID, label: "Search", hint: "dialogue" }
  ],
  onSwitch: switchTo
});
var dropdown = createDropdown(dropdownEl, { onOpen: openFromDropdown });
function readRoster(r) {
  if (!r.ok)
    throw new Error(`roster reading failed: ${r.status}`);
  return r.json();
}
var ROSTER_POLL_MS = 3000;
var roster = createRoster({
  fetchCatalogue: (signal) => authFetch("/api/sessions", { signal }).then((r) => readRoster(r)),
  fetchLive: (signal) => authFetch("/api/live", { signal }).then((r) => readRoster(r)),
  pollMs: ROSTER_POLL_MS
});
var endGuard = createEndGuard({
  delayMs: ROSTER_POLL_MS + 1000,
  reading: () => roster.readings(),
  stillGone: (sessionId) => {
    const row = roster.current().find((s) => s.sessionId === sessionId);
    return !row || !isLive(row);
  },
  end: (sessionId) => {
    const t = openTabs.get(sessionId);
    if (!t || t.ended)
      return;
    t.ended = true;
    tabBar.setEnded(sessionId);
    t.view.setEnded();
  }
});
function revive(sessionId) {
  const t = openTabs.get(sessionId);
  if (!t || !t.ended)
    return;
  t.ended = false;
  tabBar.clearEnded(sessionId);
  t.view.setLive();
  t.stopReplay.resync();
}
var tabStore = createTabStore((() => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
})());
var homePanel = document.createElement("div");
homePanel.className = "home-panel";
homePanel.style.display = "none";
panelsEl.append(homePanel);
var homeView = createHomeView(homePanel, {
  loadRetro: () => authFetch("/api/retro").then((r) => r.ok ? r.json() : null).catch(() => null),
  onPickSession: () => dropdown.open(),
  sessionsOnDisk: () => roster.current().length
});
var comparePanel = document.createElement("div");
comparePanel.className = "home-panel compare-panel";
comparePanel.style.display = "none";
panelsEl.append(comparePanel);
var compareView = createCompareView(comparePanel, {
  loadComparison: () => authFetch("/api/compare").then((r) => r.ok ? r.json() : null).catch(() => null),
  onOpenSession: openFromDropdown
});
var searchPanel = document.createElement("div");
searchPanel.className = "home-panel search-panel";
searchPanel.style.display = "none";
panelsEl.append(searchPanel);
var searchView = createSearchView(searchPanel, {
  search: (q) => authFetch("/api/search?q=" + encodeURIComponent(q)).then((r) => r.ok ? r.json() : null).catch(() => null),
  onOpenSession: openFromDropdown
});
function persist() {
  if (roster.readings() === 0)
    return;
  tabStore.save({ ids: [...openTabs.keys()], activeId, known: [...known] });
}
function autoOpenNew(rows) {
  for (const row of sessionsToAutoOpen(rows, known, new Set(openTabs.keys()))) {
    openTab(row, { activate: activeId === null });
  }
}
function switchTo(sessionId) {
  activeId = sessionId;
  for (const [id, t] of openTabs)
    t.panel.style.display = id === sessionId ? "block" : "none";
  homePanel.style.display = sessionId === HOME_ID ? "block" : "none";
  comparePanel.style.display = sessionId === COMPARE_ID ? "block" : "none";
  searchPanel.style.display = sessionId === SEARCH_ID ? "block" : "none";
  if (sessionId === COMPARE_ID)
    compareView.refresh();
  if (sessionId === SEARCH_ID)
    searchView.focus();
  tabBar.setActive(sessionId);
  navMenu.setActive(sessionId);
  persist();
}
function syncPins() {
  dropdown.setOpenTabs(openTabs.keys());
}
function closeTab(sessionId) {
  const t = openTabs.get(sessionId);
  if (!t)
    return;
  endGuard.cancel(sessionId);
  t.stopReplay.stop();
  t.view.destroy();
  t.panel.remove();
  tabBar.remove(sessionId);
  openTabs.delete(sessionId);
  syncPins();
  if (activeId === sessionId) {
    const next = openTabs.keys().next();
    if (!next.done)
      switchTo(next.value);
    else
      switchTo(HOME_ID);
  }
  persist();
}
function openTab(record, { activate = true } = {}) {
  const { sessionId } = record;
  if (openTabs.has(sessionId)) {
    if (activate)
      switchTo(sessionId);
    return;
  }
  const treeState = createSessionTree({ windowFor, mainModel: record.model });
  panelsEl.querySelector(".empty-hint")?.remove();
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.style.display = "none";
  panelsEl.append(panel);
  const loadToolOutput = (toolUseId) => authFetch(`/api/tool-output?sessionId=${encodeURIComponent(sessionId)}&toolUseId=${encodeURIComponent(toolUseId)}`).then((r) => r.ok ? r.json() : null).catch(() => null);
  const loadCallIO = (callId) => authFetch(`/api/call-io?sessionId=${encodeURIComponent(sessionId)}&callId=${encodeURIComponent(callId)}`).then((r) => r.ok ? r.json() : null).catch(() => null);
  const loadAgentPrompt = (agentId) => authFetch(`/api/agent-prompt?sessionId=${encodeURIComponent(sessionId)}&agentId=${encodeURIComponent(agentId)}`).then((r) => r.ok ? r.json() : null).catch(() => null);
  const loadCommits = () => authFetch(`/api/commits?sessionId=${encodeURIComponent(sessionId)}`).then((r) => r.ok ? r.json() : null).catch(() => null);
  const loadFiles = () => authFetch(`/api/files?sessionId=${encodeURIComponent(sessionId)}`).then((r) => r.ok ? r.json() : null).catch(() => null);
  const loadCards = () => authFetch(`/api/cards?sessionId=${encodeURIComponent(sessionId)}`).then((r) => r.ok ? r.json() : null).catch(() => null);
  const open = isLive(record);
  const view = createView(panel, treeState, {
    loadToolOutput,
    loadCallIO,
    loadAgentPrompt,
    loadCommits,
    loadFiles,
    loadCards,
    ended: !open,
    sessionId
  });
  tabBar.add(sessionId, { label: tabLabel(record), ended: !open, busy: isWorking(record) });
  const waitingAtOpen = open ? pendingInput(record) : null;
  tabBar.setWaiting(sessionId, waitingAtOpen);
  view.setWaiting(waitingAtOpen, waitingAtOpen ? record.waitingSince : null);
  view.setBusy(open ? isModelBusy(record) : false);
  treeState.onChange(() => tabBar.setFailed(sessionId, treeState.currentError() !== null));
  const onLive = () => view.onReplayEnd();
  const stopReplay = startReplay(sessionId, (e) => treeState.apply(e), {
    stream,
    EventSourceImpl: AuthEventSource,
    onLive,
    stillExists: () => roster.readings() === 0 || roster.current().some((r) => r.sessionId === sessionId)
  });
  openTabs.set(sessionId, { view, panel, stopReplay, ended: !open, label: tabLabel(record) });
  known.add(sessionId);
  syncPins();
  if (activate)
    switchTo(sessionId);
  else
    persist();
}
function openFromDropdown(id) {
  const r = roster.current().find((s) => s.sessionId === id);
  if (r)
    openTab(r);
}
var connHideTimer = null;
var AUTH_PILL = {
  missing: {
    text: "No token for this address",
    title: "This server asks for a token and this browser has none for this address. A token is stored per address, and the PORT is part of it — the one you use on another port is not visible here. Open the URL seedeep printed at startup (it carries the token), or paste it in Settings."
  },
  refused: {
    text: "Token refused",
    title: "The token stored for this address is not the one the server accepts — it was regenerated, or it belongs to another seedeep. Open the URL seedeep printed at startup, or paste the current token in Settings."
  }
};
function showConnection(state) {
  if (connHideTimer !== null) {
    clearTimeout(connHideTimer);
    connHideTimer = null;
  }
  const auth = currentAuthState();
  if (auth !== "ok") {
    connEl.className = "feed-auth";
    connEl.textContent = AUTH_PILL[auth].text;
    connEl.title = AUTH_PILL[auth].title;
    return;
  }
  connEl.title = "";
  connEl.className = state === "ok" ? "" : "feed-" + state;
  connEl.textContent = state === "lost" ? "Live feed lost — reconnecting…" : state === "resync" ? "Reconnected — re-reading" : "";
  if (state === "resync")
    connHideTimer = setTimeout(() => showConnection("ok"), 4000);
}
var feedWasLost = false;
onAuthState(() => showConnection(feedWasLost ? "lost" : "ok"));
stream.onStatus((s) => {
  if (s === "lost") {
    feedWasLost = true;
    showConnection("lost");
    return;
  }
  if (!feedWasLost)
    return;
  feedWasLost = false;
  showConnection("resync");
  for (const t of openTabs.values())
    if (!t.ended)
      t.stopReplay.resync();
});
roster.onChange((rows) => {
  dropdown.update(rows);
  for (const row of rows) {
    const t = openTabs.get(row.sessionId);
    if (!t)
      continue;
    const open = isLive(row);
    if (!t.ended && !open)
      endGuard.gone(row.sessionId);
    if (open)
      endGuard.cancel(row.sessionId);
    if (t.ended && open)
      revive(row.sessionId);
    if (!t.ended) {
      tabBar.setBusy(row.sessionId, isWorking(row));
      t.view.setBusy(isModelBusy(row));
      const waiting = pendingInput(row);
      tabBar.setWaiting(row.sessionId, waiting);
      t.view.setWaiting(waiting, waiting ? row.waitingSince : null);
      const newLabel = tabLabel(row);
      if (newLabel !== t.label) {
        t.label = newLabel;
        tabBar.setLabel(row.sessionId, newLabel);
      }
    }
  }
  if (roster.complete()) {
    const listed = new Set(rows.map((r) => r.sessionId));
    for (const [sessionId, t] of openTabs)
      if (!t.ended && !listed.has(sessionId))
        endGuard.gone(sessionId);
  }
  if (rows.length !== lastPaintedLen) {
    lastPaintedLen = rows.length;
    homeView.repaint();
  }
  if (booted) {
    autoOpenNew(rows);
    if (rows.length !== lastRosterLen) {
      lastRosterLen = rows.length;
      homeView.refresh();
    }
  }
});
roster.start().then(() => {
  const rows = roster.current();
  dropdown.update(rows);
  const saved = tabStore.load();
  if (saved) {
    known = new Set(saved.known);
    const byId = new Map(rows.map((r) => [r.sessionId, r]));
    for (const id of saved.ids) {
      const r = byId.get(id);
      if (r)
        openTab(r);
    }
    if (saved.activeId === HOME_ID)
      switchTo(HOME_ID);
    else if (saved.activeId === COMPARE_ID)
      switchTo(COMPARE_ID);
    else if (saved.activeId === SEARCH_ID)
      switchTo(SEARCH_ID);
    else if (saved.activeId && openTabs.has(saved.activeId))
      switchTo(saved.activeId);
  }
  booted = true;
  lastRosterLen = rows.length;
  autoOpenNew(rows);
  const asked = takeDeepLink();
  if (asked) {
    const row = rows.find((r) => r.sessionId === asked);
    if (row)
      openTab(row);
  }
  if (activeId === null)
    switchTo(HOME_ID);
});
function takeDeepLink() {
  try {
    const params = new URLSearchParams(location.search);
    const asked = requestedSession(location.search);
    if (!asked)
      return null;
    params.delete("session");
    const search = params.toString();
    history.replaceState(null, "", location.pathname + (search ? "?" + search : "") + location.hash);
    return asked;
  } catch {
    return null;
  }
}
