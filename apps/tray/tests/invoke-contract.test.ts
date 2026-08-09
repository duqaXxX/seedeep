import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * The webview calls Rust by NAME, and nothing else checks the two ends agree.
 *
 * A view test can click a button and see its handler run; the handler's `invoke('open_portal')` is a
 * string, and a wrong one fails only in the built app, silently — the promise rejects with "command
 * not found" and the panel shows a message about a portal nobody asked to open. Every other seam in
 * the tray has a test that would go red; this one had none, which is exactly why the button added
 * for the empty state deserved it.
 *
 * Read as TEXT rather than by importing either side: the UI imports `@tauri-apps/api`, which has no
 * host to talk to here, and the Rust list is a macro no JS test can evaluate.
 */
const root = new URL('../', import.meta.url).pathname;

/** Every `invoke('name')` the panel and the settings view make. */
function invoked(): Set<string> {
  const names = new Set<string>();
  for (const file of ['ui/panel.ts', 'ui/settings.ts', 'ui/connection.ts', 'ui/bands.ts']) {
    const src = readFileSync(root + file, 'utf8');
    for (const m of src.matchAll(/\binvoke(?:<[^>]*>)?\(\s*'([a-z_]+)'/g)) names.add(m[1]!);
  }
  return names;
}

/** Every command `main.rs` registers with `generate_handler!`. */
function registered(): Set<string> {
  const src = readFileSync(root + 'src-tauri/src/main.rs', 'utf8');
  const list = /generate_handler!\[([^\]]*)\]/s.exec(src);
  assert.ok(list, 'main.rs registers its commands with generate_handler!');
  return new Set(
    list[1]!
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

test('every command the webview invokes is one Rust registered', () => {
  const commands = registered();
  const calls = invoked();

  assert.ok(calls.has('open_portal'), 'the sanity check: the parser found the calls at all');
  for (const name of calls) {
    assert.ok(commands.has(name), `the webview invokes \`${name}\`, which main.rs does not register`);
  }
});
