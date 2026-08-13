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
  const hidden = body.indexOf('win.hide()');
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

// Measured on the first fix (2026-08-13): with the popover hidden and nothing else changed, the
// banner still went straight to Notification Center undrawn, while real banners from the same build
// appeared. An `Accessory` app has no second window to fall back to, so hiding one leaves it the
// ACTIVE app with nothing on screen — and active is the state macOS refuses to draw a banner for.
// `deactivate` was the second attempt and does not work either: `isActive` stayed true at +0.3s,
// +1s and +3s. Hiding the APP flips it by +0.3s, which is why that is the call here — and why
// deleting it restores a bug no runtime test can see.
test('and it hides the APP, not just the window, which is what ends the activation', () => {
  const body = command();
  const window = body.indexOf('win.hide()');
  const application = body.indexOf('app.hide()');

  assert.notEqual(application, -1, 'the command hides the application itself');
  assert.ok(window < application, 'after the window is down, so nothing is left holding focus');
});

/** The body of `fn toggle_panel`, from its signature to the closing brace in column 0. */
function toggle(): string {
  const src = readFileSync(main, 'utf8');
  const start = src.indexOf('fn toggle_panel');
  assert.notEqual(start, -1, 'main.rs still defines the panel toggle');
  return src.slice(start, src.indexOf('\n}\n', start));
}

// The cost of hiding the APP: every window of a hidden app stays down until something unhides it.
// The menu-bar click is what has to undo it, and if it does not, the test notification is a button
// that breaks the panel until the tray is restarted.
test('and the click that reopens the panel unhides the app first', () => {
  const body = toggle();

  assert.match(body, /app\.show\(\)/, 'toggle_panel brings the application back');
  assert.ok(body.indexOf('app.show()') < body.indexOf('win.show()'), 'before it shows the window');
});

// The same rule on the other gesture, and the reason it is here rather than in a test about the
// popover: dismissing from the icon used to hide the window and stop, which left the tray ACTIVE
// with nothing on screen — the exact state in which macOS drops a banner. The REAL ones were being
// dropped there too, silently, and no test could see it. Losing focus needs no such call: clicking
// elsewhere is itself the activation ending.
test('dismissing from the icon hides the app too, or the real banners are dropped as well', () => {
  const body = toggle();
  const dismiss = body.slice(0, body.indexOf('set_panel_open(app, true)'));

  assert.match(dismiss, /win\.hide\(\)/, 'the dismissal puts the window away');
  assert.match(dismiss, /app\.hide\(\)/, 'and ends the activation with it');
});
