import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * The test banner is posted AFTER the popover is hidden, and nothing else can catch it if it is not.
 *
 * macOS does not present a notification posted by the frontmost app (Apple's `NSUserNotification.h`,
 * on `shouldPresentNotification:`), and clicking the button in the settings view is the one moment
 * the tray is frontmost — the panel took focus when it opened. Posting first was the shipped bug: the
 * command returned `Ok`, the panel said "Sent.", and the user saw nothing, while every real banner
 * kept arriving because those are posted while the user is somewhere else.
 *
 * No runtime test reaches this. The command needs an `AppHandle`, the platform's refusal is silent by
 * construction, and a view test can only see that a handler ran. So the invariant is asserted where
 * it is written — as source text, the way the name contract already is (`invoke-contract.test.ts`) —
 * and what it guards against is a later simplification that posts the banner in the same breath as
 * the click.
 */
const main = new URL('../src-tauri/src/main.rs', import.meta.url).pathname;

/** The body of `fn test_notification`, from its signature to the closing brace in column 0. */
function command(): string {
  const src = readFileSync(main, 'utf8');
  const start = src.indexOf('fn test_notification');
  assert.notEqual(start, -1, 'main.rs still defines the test notification command');
  const end = src.indexOf('\n}\n', start);
  assert.notEqual(end, -1, 'and the definition is closed');
  return src.slice(start, end);
}

test('the popover is put away before the test banner is posted', () => {
  const body = command();
  const hidden = body.indexOf('.hide()');
  const posted = body.indexOf('.notification()');

  assert.notEqual(hidden, -1, 'the command hides the popover itself');
  assert.notEqual(posted, -1, 'and posts the banner');
  assert.ok(hidden < posted, 'a banner posted while the panel is up is one macOS never draws');
});

// The hide only starts the handover; the window server performs it on a later turn of the run loop,
// so a post that does not wait is still a post from the frontmost app. The wait is what makes the
// order above mean anything.
test('and it waits for the handover before posting', () => {
  const body = command();

  assert.match(body, /sleep\(NOTIFY_SETTLE\)/, 'the settle is awaited between the two');
});
