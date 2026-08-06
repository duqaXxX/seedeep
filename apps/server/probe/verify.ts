import type { Claim, ClaimContext } from '../src/server/schema-contract.ts';

/**
 * Evaluating the contract, and saying so in a way that names the next action.
 *
 * Three outcomes, never two. A two-state check would have to call an unprovoked
 * claim either "pass" (a lie that makes the whole guard worthless) or "fail" (an
 * alarm about Claude's routing, not about the schema).
 */
export type Outcome = 'HOLDS' | 'BROKEN' | 'UNPROVEN';

export interface ClaimResult {
  claim: Claim;
  outcome: Outcome;
  /** Why, in the probe's own words — becomes the report line. */
  reason: string;
}

/**
 * Decide each claim against what the driven session actually produced.
 * Absence is only ever a FINDING for a `gesture` claim: there the probe caused
 * the event itself, so the field must be there. For a `model` claim the model had
 * to choose, and a miss cannot be told apart from a schema change — that is
 * UNPROVEN by construction, not by timidity.
 */
export function evaluate(claims: Claim[], ctx: ClaimContext): ClaimResult[] {
  return claims.map((claim) => {
    let provoked: boolean;
    let holds: boolean;
    try {
      provoked = claim.provoked(ctx);
      holds = provoked ? claim.holds(ctx) : false;
    } catch (err) {
      return { claim, outcome: 'UNPROVEN' as const, reason: `the check itself threw: ${(err as Error).message}` };
    }
    if (!provoked) {
      return { claim, outcome: 'UNPROVEN', reason: `scene ${claim.scene} never happened, so nothing was learned` };
    }
    if (holds) return { claim, outcome: 'HOLDS', reason: 'provoked and present' };
    if (claim.kind === 'gesture') {
      return { claim, outcome: 'BROKEN', reason: 'the probe caused this event and the field did NOT appear' };
    }
    return {
      claim,
      outcome: 'UNPROVEN',
      reason: 'the model may simply have routed differently — this cannot be told apart from a schema change',
    };
  });
}

/**
 * Close claims the probe could not provoke, using REAL sessions written by the
 * same version — the work you did anyway.
 *
 * Only `holds` is consulted, never `provoked`: presence is conclusive, so a field
 * FOUND in a log of that version proves it exists, no matter what caused it.
 * Absence changes nothing (it never proves a removal), so a claim with no
 * evidence keeps whatever outcome the probe gave it and goes on the checklist.
 *
 * Never touches BROKEN: the probe caused that event and watched the field fail to
 * appear. Evidence from another session must not paper over it — one session
 * writing a field does not mean the case the probe exercised still works.
 */
export function closeWithEvidence(results: ClaimResult[], contexts: ClaimContext[], version: string): ClaimResult[] {
  if (contexts.length === 0) return results;
  return results.map((r) => {
    if (r.outcome !== 'UNPROVEN') return r;
    let proven = false;
    for (const ctx of contexts) {
      try {
        if (r.claim.holds(ctx)) {
          proven = true;
          break;
        }
      } catch {
        // A claim that throws on real data proves nothing; leave it open.
      }
    }
    return proven
      ? {
          ...r,
          outcome: 'HOLDS' as const,
          reason: `found in a real session written by ${version} (the probe could not provoke it)`,
        }
      : r;
  });
}

const ICON: Record<Outcome, string> = { HOLDS: '  ok  ', BROKEN: 'BROKEN', UNPROVEN: ' ??   ' };

/**
 * A verdict plus an instruction — never a field dump. A report that only says
 * "field missing" hands the diagnosis back to the reader, which is the work the
 * guard exists to do.
 */
export function report(results: ClaimResult[], version: string): string {
  const broken = results.filter((r) => r.outcome === 'BROKEN');
  const unproven = results.filter((r) => r.outcome === 'UNPROVEN');
  const held = results.filter((r) => r.outcome === 'HOLDS');
  const out: string[] = [];

  out.push('');
  out.push(`seedeep schema probe — Claude Code ${version}`);
  out.push('─'.repeat(72));

  if (broken.length === 0 && unproven.length === 0) {
    out.push(`seedeep is OK on ${version}: all ${held.length} claims provoked and present.`);
    out.push('─'.repeat(72));
    return out.join('\n');
  }

  out.push(
    broken.length > 0
      ? `seedeep IS BROKEN on ${version}: ${broken.length} claim(s) failed.`
      : `seedeep looks ok on ${version} (${held.length} claims hold), but ${unproven.length} could not be checked.`,
  );
  out.push('');

  for (const r of [...broken, ...unproven]) {
    out.push(`${ICON[r.outcome]}  ${r.claim.id}  ${r.claim.describe}`);
    out.push(`        → ${r.claim.reader}`);
    out.push(`        ${r.reason}`);
    out.push(`        Verify: ${r.claim.investigate}`);
    out.push('');
  }

  if (unproven.length > 0) {
    out.push('"??" means the probe learned NOTHING about that claim — there may be a');
    out.push('problem and it is worth investigating, but it is not evidence of one.');
  }
  out.push('─'.repeat(72));
  out.push(`${held.length} hold · ${broken.length} broken · ${unproven.length} unproven`);
  return out.join('\n');
}

/** True when a run must not certify the version. */
export function isBroken(results: ClaimResult[]): boolean {
  return results.some((r) => r.outcome === 'BROKEN');
}

/**
 * May this run certify the version?
 *
 * ONLY if every `gesture` claim HOLDS. "Nothing broke" is NOT the same as "I
 * checked": a run that provokes nothing finds nothing, and under the old rule it
 * signed the version off anyway — run 2 certified 2.1.212 having verified 13
 * claims of 25. A gesture claim is one the probe causes itself, so if it did not
 * end in HOLDS the probe failed at its own job and has no standing to sign.
 *
 * `model` claims cannot block certification — the model may always route
 * differently — so they leave the run instead as a MANUAL checklist. Nothing the
 * probe could not prove is ever silently counted as fine.
 */
export function canCertify(results: ClaimResult[]): boolean {
  return results.filter((r) => r.claim.kind === 'gesture').every((r) => r.outcome === 'HOLDS');
}

/**
 * What a human must check by hand: everything the probe could not prove.
 * The probe is honest about its reach instead of pretending the gap is fine.
 */
export function manualChecklist(results: ClaimResult[]): string {
  const open = results.filter((r) => r.outcome !== 'HOLDS');
  if (open.length === 0) return '';
  const out: string[] = [];
  out.push('');
  out.push('TEST THESE BY HAND — the probe could not prove them:');
  out.push('');
  for (const r of open) {
    out.push(`  [ ] ${r.claim.describe}`);
    out.push(`      how: ${r.claim.manual ?? r.claim.investigate}`);
    out.push(`      if it is wrong, the break is at ${r.claim.reader}`);
    out.push('');
  }
  return out.join('\n');
}
