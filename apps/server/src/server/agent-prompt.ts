import { readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { anon } from '../core/text.ts';
import { initTailState, readNewLines } from './tailer.ts';

const CAP = 1000;

// agentIds are hex-prefixed identifiers written by Claude Code (e.g. "aaaa4f049f84ad241").
// runDir names are wf_<hex>-<hex> (e.g. "wf_db4f0d0b-6c5"). Strict allowlists prevent
// path traversal via either parameter.
const AGENT_ID_RE = /^[a-z0-9]{1,64}$/;
const RUN_DIR_RE = /^[a-zA-Z0-9_-]{1,80}$/;

/**
 * Returns the launch prompt of a workflow member agent (the first user message
 * in its child jsonl), anonymized and capped. The child file lives at
 * `<sessionDir>/subagents/workflows/<runId>/agent-<agentId>.jsonl` — we search
 * all run subdirectories so the caller needs only the agentId, not the runId.
 * Returns null when the file is absent, the id fails validation, or no text prompt exists.
 */
export async function readAgentPrompt(
  sessionPath: string,
  agentId: string,
): Promise<{ text: string; truncated: boolean } | null> {
  if (!AGENT_ID_RE.test(agentId)) return null;
  const sessionDir = join(dirname(sessionPath), basename(sessionPath, '.jsonl'));
  const workflowsDir = join(sessionDir, 'subagents', 'workflows');
  let runDirs: string[];
  try {
    runDirs = await readdir(workflowsDir);
  } catch {
    return null;
  }
  for (const runDir of runDirs) {
    if (!RUN_DIR_RE.test(runDir)) continue;
    const candidate = join(workflowsDir, runDir, `agent-${agentId}.jsonl`);
    // Confirm the resolved path stays inside the intended run directory.
    const base = resolve(workflowsDir, runDir) + sep;
    if (!resolve(candidate).startsWith(base)) continue;
    const { lines } = await readNewLines(candidate, initTailState()).catch(() => ({ lines: [] as string[] }));
    for (const line of lines) {
      let d: any;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      if (d?.type !== 'user') continue;
      const raw: string | null =
        typeof d.message?.content === 'string'
          ? d.message.content
          : Array.isArray(d.message?.content)
            ? (d.message.content.find((b: any) => b?.type === 'text')?.text ?? null)
            : null;
      if (!raw) continue;
      return { text: anon(raw, CAP), truncated: raw.length > CAP };
    }
  }
  return null;
}
