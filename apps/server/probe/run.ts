import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { listOpenSessions } from '../src/server/open-sessions.ts';
import { cliRoot } from '../src/server/roots.ts';
import type { ClaimContext } from '../src/server/schema-contract.ts';
import { CLAIMS } from '../src/server/schema-contract.ts';
import { evidenceForVersion } from '../src/server/schema-evidence.ts';
import { openProbeSession, scrubbedEnv, slugFor } from './driver.ts';
import { FIXTURES, runScenes } from './scenes.ts';
import type { ClaimResult } from './verify.ts';
import { canCertify, closeWithEvidence, evaluate, isBroken, manualChecklist, report } from './verify.ts';

/**
 * The GUARD: does seedeep still work on the installed Claude Code?
 *
 *   bun run probe/run.ts           — run if this version is not yet certified
 *   bun run probe/run.ts --force   — run regardless
 *
 * Costs real tokens and needs a live login, which is why it is NOT in `bun test`.
 * It answers the one question observation cannot: is a field seedeep READS gone?
 * Absence is only proof because the probe causes each event itself.
 */

const CERTIFIED = new URL('../data/certified-versions.json', import.meta.url).pathname;
const PROBE_MODEL = 'claude-haiku-4-5-20251001';

/** The installed Claude Code version, or null if the binary is unusable. */
export async function installedVersion(): Promise<string | null> {
  try {
    const proc = Bun.spawn(['claude', '--version'], { stdout: 'pipe', stderr: 'pipe', env: scrubbedEnv() });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

interface CertRecord {
  certifiedAt: string;
  proven: number;
  /** Claims certification does NOT cover — they need the manual checklist. */
  open: string[];
}

async function certified(): Promise<Record<string, CertRecord>> {
  try {
    const v = JSON.parse(await readFile(CERTIFIED, 'utf8')).versions;
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

async function certify(version: string, results: ClaimResult[], when: string): Promise<void> {
  const list = await certified();
  const open = results.filter((r) => r.outcome !== 'HOLDS').map((r) => r.claim.id);
  // Record WHAT was covered, not just that it passed: certification only ever
  // covers the claims the probe can prove itself, so a bare "passed" would
  // overstate it. `open` is exactly what a human still has to check.
  list[version] = { certifiedAt: when, proven: results.filter((r) => r.outcome === 'HOLDS').length, open };
  const sorted = Object.fromEntries(
    Object.entries(list).sort(([a], [b]) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      return pa[0]! - pb[0]! || pa[1]! - pb[1]! || pa[2]! - pb[2]!;
    }),
  );
  await writeFile(
    CERTIFIED,
    JSON.stringify(
      {
        _note:
          'Claude Code versions the schema probe has passed, with what each run actually covered. ' +
          "A version is listed ONLY when every claim the probe can prove by itself holds — 'nothing broke' is not " +
          "'I checked'. `open` lists claims certification does NOT cover: they need the manual checklist the run prints. " +
          'The probe runs only on a version absent from here, so the guard cannot be forgotten.',
        versions: sorted,
      },
      null,
      2,
    ) + '\n',
  );
}

/** Scene 11: a headless session — the only place `promptSource: 'sdk'` exists. */
async function headlessContext(): Promise<ClaimContext | null> {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'seedeep-probe-sdk-')));
  const projectDir = join(cliRoot(homedir()), slugFor(cwd));
  try {
    const proc = Bun.spawn(['claude', '-p', 'say only the word ok', '--model', PROBE_MODEL], {
      cwd,
      env: scrubbedEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await new Response(proc.stdout).text();
    await proc.exited;
    let names: string[] = [];
    try {
      names = (await readdir(projectDir)).filter((n) => n.endsWith('.jsonl'));
    } catch {
      return null;
    }
    if (!names.length) return null;
    const raw = await readFile(join(projectDir, names[0]!), 'utf8');
    const lines = raw
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return { lines, raw, children: [], openSessions: [] };
  } finally {
    await rm(projectDir, { recursive: true, force: true }).catch(() => {});
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

async function main(): Promise<number> {
  const force = process.argv.includes('--force');
  const version = await installedVersion();
  if (!version) {
    console.error('probe: could not read `claude --version` — is the CLI installed?');
    return 2;
  }
  if (!force && version in (await certified())) {
    console.log(`probe: ${version} is already certified — nothing to do (use --force to re-run).`);
    return 0;
  }

  console.log(`probe: driving a real session on ${version} with ${PROBE_MODEL}…`);
  const s = await openProbeSession({ files: FIXTURES, model: PROBE_MODEL });
  let ctx: ClaimContext;
  const seenOpen: ClaimContext['openSessions'] = [];
  try {
    // C9/C23 can only be checked while the session is ALIVE — the file is gone once
    // it exits, so this is captured mid-run, not from the transcript. Every DISTINCT
    // state is kept, not just the first sighting: 'waiting' is a state the session
    // passes THROUGH, and de-duping by session id alone would only ever record the
    // busy/idle it started in.
    const seenKeys = new Set<string>();
    const openTimer = setInterval(async () => {
      for (const o of await listOpenSessions()) {
        const key = `${o.sessionId}:${o.status ?? ''}:${o.waitingFor ?? ''}`;
        if (o.cwd === s.cwd && !seenKeys.has(key)) {
          seenKeys.add(key);
          seenOpen.push(o);
        }
      }
    }, 2_000);

    await runScenes(s, (m) => console.log(m));
    clearInterval(openTimer);

    const raw = (await s.transcript()) ?? '';
    const lines = raw
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    ctx = { lines, raw, children: await s.childTranscripts(), openSessions: seenOpen };
  } finally {
    await s.close();
  }

  let results = evaluate(
    CLAIMS.filter((c) => c.scene !== 11),
    ctx,
  );

  console.log('probe: running the headless scene (promptSource: sdk)…');
  const sdkCtx = await headlessContext();
  if (sdkCtx) {
    results.push(
      ...evaluate(
        CLAIMS.filter((c) => c.scene === 11),
        sdkCtx,
      ),
    );
  } else {
    for (const c of CLAIMS.filter((c) => c.scene === 11)) {
      results.push({ claim: c, outcome: 'UNPROVEN', reason: 'the headless session produced no transcript' });
    }
  }

  // Close what the probe could not provoke, using real sessions written by THIS
  // version — the work you did anyway. Presence is conclusive; absence still
  // proves nothing, so anything left open goes to the manual checklist.
  console.log(`probe: looking for evidence in real ${version} sessions…`);
  const ev = await evidenceForVersion(version);
  console.log(
    `probe: ${ev.sessionsAttributed} session(s) written wholly by ${version}` +
      (ev.sessionsAmbiguous > 0
        ? ` (${ev.sessionsAmbiguous} skipped: they span an upgrade, so their subagents cannot be attributed)`
        : ''),
  );
  results = closeWithEvidence(results, ev.contexts, version);

  console.log(report(results, version));
  console.log(manualChecklist(results));

  if (isBroken(results)) return 1;
  if (!canCertify(results)) {
    // "Nothing broke" is not "I checked". Run 2 signed off 2.1.212 having proven
    // 13 claims of 25 — the exact lie this guard exists to prevent.
    const gaps = results.filter((r) => r.claim.kind === 'gesture' && r.outcome !== 'HOLDS');
    console.log(
      `\nprobe: ${version} NOT certified — the probe could not prove ${gaps.length} claim(s) it is supposed to prove itself` +
        ` (${gaps.map((g) => g.claim.id).join(', ')}). Nothing is known to be broken; the probe simply did not do its job.` +
        `\nWork the checklist above by hand, or re-run.`,
    );
    return 3;
  }
  await certify(version, results, new Date().toISOString().slice(0, 10));
  console.log(`\nprobe: ${version} certified — every claim the probe can prove itself HOLDS.`);
  const manual = results.filter((r) => r.outcome !== 'HOLDS').length;
  if (manual > 0)
    console.log(`probe: ${manual} claim(s) still need the manual checklist above — certification does NOT cover them.`);
  return 0;
}

if (import.meta.main) process.exit(await main());
