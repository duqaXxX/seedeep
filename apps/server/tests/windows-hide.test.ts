import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const SERVER_SRC = join(import.meta.dirname, '..', 'src', 'server');

/**
 * Every subprocess this server starts must pass `windowsHide`.
 *
 * Not a style rule. On Windows a process with no console is given one for each console child it
 * spawns, and the user sees it flash — and a seedeep started by `seedeep start` or by a restart IS
 * console-less, because it is spawned detached. `git.ts` runs one git per commit, so a portal
 * refresh flashed a burst of them (observed on Windows 11, 2026-08-15). Six spawn sites existed and
 * none passed the flag.
 *
 * A source scan rather than a behavioural test, for the same reason the tray keeps `CREATE_NO_WINDOW`
 * in one shared constant: what has to be true is that a SEVENTH site cannot be added without meeting
 * the rule, and no runtime assertion on this machine can say that. The layer-boundary test in this
 * suite reads the source the same way.
 */
test('every module that spawns a subprocess passes windowsHide', () => {
  const offenders: string[] = [];
  for (const name of readdirSync(SERVER_SRC).filter((f) => f.endsWith('.ts'))) {
    // Comments stripped for BOTH questions, and that is not tidiness: the first version asked
    // whether the file mentioned `windowsHide` anywhere, so deleting the option from the call left
    // the test green on the strength of the comment explaining it. A guard that survives the
    // removal it guards against is decoration.
    const code = readFileSync(join(SERVER_SRC, name), 'utf8').replace(/^\s*(?:\/\/|\*|\/\*).*$/gm, '');
    // `Bun.spawn(` counts and `spawnSelfFn(` does not: the lookbehind excludes a longer identifier,
    // never a namespace.
    const spawns = /(?<!\w)(?:spawn|execFile|execFileSync|spawnSync)\s*\(/.test(code);
    if (spawns && !code.includes('windowsHide')) offenders.push(name);
  }
  assert.deepEqual(offenders, [], 'these start a subprocess and would open a console window on Windows');
});
