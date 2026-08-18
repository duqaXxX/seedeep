import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createTabBar } from '../src/client/tab-bar.ts';
import { fakeDoc, findByClass } from './fake-dom.ts';

// mountBar swaps the global document per test; put the original back once the file is done.
const prevDoc = (globalThis as any).document;
after(() => {
  (globalThis as any).document = prevDoc;
});

// Build the REAL tab bar against a fake DOM and hand back the pieces a test drives.
function mountBar() {
  const doc: any = fakeDoc();
  (globalThis as any).document = doc;
  const container = doc.createElement('div');
  const switched: string[] = [];
  const closed: string[] = [];
  const bar = createTabBar(container, {
    onSwitch: (id: string) => switched.push(id),
    onClose: (id: string) => closed.push(id),
  });
  return { container, bar, switched, closed };
}
const labelOf = (tab: any) => tab.children[1].textContent; // [busy dot, name, close]

test('add renders one tab with label and busy dot; duplicates are ignored', () => {
  const { container, bar } = mountBar();
  bar.add('s1', { label: 'proj', ended: false, busy: true });
  bar.add('s1', { label: 'proj', ended: false, busy: true });
  const tabs = findByClass(container, 'tab');
  assert.equal(tabs.length, 1);
  assert.equal(labelOf(tabs[0]), 'proj', 'the label is the label — state never rides in the text');
  assert.ok(tabs[0].children[0].classList.contains('on'), 'busy dot lit');
});

test('state is spelled out in the title, so a class is never the only channel', () => {
  const { container, bar } = mountBar();
  bar.add('s1', { label: 'proj', ended: false, busy: false });
  bar.add('s2', { label: 'other', ended: true, busy: false });
  const [t1, t2] = findByClass(container, 'tab');
  assert.equal(t1.title, 'proj');
  assert.equal(t2.title, 'other — ended');
});

test('clicking a tab switches; clicking × closes without also switching', () => {
  const { container, bar, switched, closed } = mountBar();
  bar.add('s1', { label: 'a', ended: false, busy: false });
  const tab = findByClass(container, 'tab')[0];
  tab.onclick();
  assert.deepEqual(switched, ['s1']);
  tab.children[2].onclick({ stopPropagation: () => {} });
  assert.deepEqual(closed, ['s1']);
  assert.deepEqual(switched, ['s1'], 'close must not bubble into a switch');
});

test('setActive marks exactly the active tab', () => {
  const { container, bar } = mountBar();
  bar.add('s1', { label: 'a', ended: false, busy: false });
  bar.add('s2', { label: 'b', ended: false, busy: false });
  bar.setActive('s2');
  const [t1, t2] = findByClass(container, 'tab');
  assert.equal(t1.classList.contains('active'), false);
  assert.equal(t2.classList.contains('active'), true);
});

test('setEnded marks the tab and kills the busy dot, twice over', () => {
  const { container, bar } = mountBar();
  bar.add('s1', { label: 'a', ended: false, busy: true });
  bar.setEnded('s1');
  bar.setEnded('s1');
  const tab = findByClass(container, 'tab')[0];
  assert.ok(tab.classList.contains('ended'));
  assert.equal(tab.children[0].classList.contains('on'), false, 'a closed session is never busy');
});

test('setEnded never touches the label — no marker may creep back into the text', () => {
  // The words are what this strip cannot afford: a project NAMED 'extended-api' also used
  // to lose its marker forever, because the old guard parsed the label instead of the state.
  const { container, bar } = mountBar();
  bar.add('s1', { label: 'extended-api', ended: false, busy: false });
  bar.setEnded('s1');
  const tab = findByClass(container, 'tab')[0];
  assert.equal(labelOf(tab), 'extended-api');
  assert.ok(tab.classList.contains('ended'));
  assert.equal(tab.title, 'extended-api — ended', 'the state still reaches a reader who cannot see the dim');
});

test('clearEnded brings a resumed session back, dot and title included', () => {
  // `claude --resume` reopens the SAME session id, so the strip has to be able to un-dim a tab:
  // the alternative was a tab frozen for the life of the page while the session worked on.
  const { container, bar } = mountBar();
  bar.add('s1', { label: 'a', ended: false, busy: true });
  bar.setEnded('s1');
  bar.clearEnded('s1');
  const tab = findByClass(container, 'tab')[0];
  assert.equal(tab.classList.contains('ended'), false, 'the dim is what says ended — it has to go');
  assert.equal(tab.title, 'a', 'and so does the word a reader who cannot see the dim relies on');
  // The setters the ended class had locked out answer again — the busy dot and the amber one
  // are driven by the roster poll, which is exactly what has just said the session is back.
  bar.setBusy('s1', true);
  assert.equal(tab.children[0].classList.contains('on'), true);
  bar.setWaiting('s1', 'permission');
  assert.equal(tab.children[0].classList.contains('wait'), true);
  assert.equal(tab.title, 'a — waiting for your approval');
  bar.clearEnded('s1'); // idempotent: a second live poll must not undo what the first restored
  assert.equal(tab.title, 'a — waiting for your approval');
});

// The strip holds SESSIONS only — the fixed surfaces moved to the header menu — so it is
// handed ids it has no tab for (Home, Compare, Search) on every switch to one of them.
test('setActive with a foreign id lights nothing, and leaves the strip untouched', () => {
  const { container, bar } = mountBar();
  bar.add('s1', { label: 'a', ended: false, busy: false });
  bar.setActive('s1');
  bar.setActive('__home__');
  assert.equal(findByClass(container, 'tab').length, 1, 'no tab is created for a fixed surface');
  assert.equal(container.children[0].classList.contains('active'), false, 'the session tab goes dark');
});

test('setBusy toggles the dot; remove drops the tab element', () => {
  const { container, bar } = mountBar();
  bar.add('s1', { label: 'a', ended: false, busy: false });
  bar.setBusy('s1', true);
  assert.equal(findByClass(container, 'tab')[0].children[0].classList.contains('on'), true);
  bar.remove('s1');
  assert.equal(findByClass(container, 'tab').length, 0);
});

test('setWaiting lights the dot amber and says so in the title, until it is answered', () => {
  const { container, bar } = mountBar();
  bar.add('s1', { label: 'a', ended: false, busy: true });
  bar.setWaiting('s1', 'permission');
  const dot = () => findByClass(container, 'tab')[0].children[0];
  assert.equal(dot().classList.contains('wait'), true);
  assert.equal(findByClass(container, 'tab')[0].title, 'a — waiting for your approval');
  bar.setWaiting('s1', 'input');
  assert.equal(findByClass(container, 'tab')[0].title, 'a — waiting for your answer');
  bar.setWaiting('s1', null); // the user answered
  assert.equal(dot().classList.contains('wait'), false);
  assert.equal(findByClass(container, 'tab')[0].title, 'a');
});

test('an ended session is never shown as waiting', () => {
  // The PID file is gone, so nothing can clear the flag: an amber dot on a dead tab would
  // sit there forever, claiming a prompt that no longer exists.
  const { container, bar } = mountBar();
  bar.add('s1', { label: 'a', ended: false, busy: false });
  bar.setWaiting('s1', 'permission');
  bar.setEnded('s1');
  const tab = findByClass(container, 'tab')[0];
  assert.equal(tab.children[0].classList.contains('wait'), false);
  assert.equal(tab.title, 'a — ended');
  bar.setWaiting('s1', 'permission'); // a late poll must not resurrect it
  assert.equal(tab.children[0].classList.contains('wait'), false);
});

test('setLabel updates the visible text and the title, is idempotent, ignores unknowns', () => {
  // A session that opens with no subject (label = uuid fallback) must update in place when
  // subject arrives via a roster poll — without a refresh.
  const { container, bar } = mountBar();
  bar.add('s1', { label: 'proj · abc12345', ended: false, busy: false });
  bar.setLabel('s1', 'proj · fix the login redirect');
  const tab = findByClass(container, 'tab')[0];
  assert.equal(labelOf(tab), 'proj · fix the login redirect');
  assert.equal(tab.title, 'proj · fix the login redirect');
  // Idempotent: calling with the same label must not cause any visible change.
  bar.setLabel('s1', 'proj · fix the login redirect');
  assert.equal(labelOf(tab), 'proj · fix the login redirect');
  // Unknown session: silently no-op.
  bar.setLabel('unknown', 'boom');
  assert.equal(findByClass(container, 'tab').length, 1);
});

test('setLabel preserves the title suffix when the session is waiting', () => {
  const { container, bar } = mountBar();
  bar.add('s1', { label: 'proj · abc12345', ended: false, busy: false });
  bar.setWaiting('s1', 'input');
  bar.setLabel('s1', 'proj · fix the login redirect');
  const tab = findByClass(container, 'tab')[0];
  assert.equal(labelOf(tab), 'proj · fix the login redirect');
  assert.equal(tab.title, 'proj · fix the login redirect — waiting for your answer');
});

test('setFailed lights the dot red, outranks the amber wait, and clears on recovery', () => {
  // Red must WIN over amber while both are set: a session whose calls are failing is not
  // "waiting for you" in any useful sense, and the dot has one job — say the worst true thing.
  const { container, bar } = mountBar();
  bar.add('s1', { label: 'a', ended: false, busy: true });
  bar.setWaiting('s1', 'permission');
  bar.setFailed('s1', true);
  const tab = () => findByClass(container, 'tab')[0];
  assert.equal(tab().children[0].classList.contains('err'), true);
  assert.equal(tab().title, 'a — its last API call failed', 'the failure is what the title says, not the wait');
  bar.setFailed('s1', false); // a later call succeeded
  assert.equal(tab().children[0].classList.contains('err'), false);
  assert.equal(tab().title, 'a — waiting for your approval', 'the wait it was hiding is still true, and comes back');
});

test('setLabel and setWaiting both preserve a failed tab', () => {
  // Every path that rewrites the title must carry the state, or a roster poll silently heals a
  // broken session — the exact class of bug the ended-marker guard was written for.
  const { container, bar } = mountBar();
  bar.add('s1', { label: 'proj · abc12345', ended: false, busy: false });
  bar.setFailed('s1', true);
  bar.setLabel('s1', 'proj · fix the login redirect');
  assert.equal(findByClass(container, 'tab')[0].title, 'proj · fix the login redirect — its last API call failed');
  bar.setWaiting('s1', 'input');
  assert.equal(findByClass(container, 'tab')[0].title, 'proj · fix the login redirect — its last API call failed');
  assert.equal(findByClass(container, 'tab')[0].children[0].classList.contains('err'), true);
});

test('an ended session is never shown as failed', () => {
  // Same reason as the waiting guard: nothing would ever clear it, and a dead tab claiming a
  // live failure is a lie that outlives the session.
  const { container, bar } = mountBar();
  bar.add('s1', { label: 'a', ended: false, busy: false });
  bar.setFailed('s1', true);
  bar.setEnded('s1');
  const tab = findByClass(container, 'tab')[0];
  assert.equal(tab.children[0].classList.contains('err'), false);
  assert.equal(tab.title, 'a — ended');
  bar.setFailed('s1', true); // a late event must not resurrect it
  assert.equal(tab.children[0].classList.contains('err'), false);
});

test('setFailed with the value it already has touches nothing', () => {
  // It is called on every applied event, not once a roster poll like the setters beside it: a
  // replay of a long session would rewrite the class and the title thousands of times over.
  const { container, bar } = mountBar();
  bar.add('s1', { label: 'a', ended: false, busy: false });
  bar.setFailed('s1', true);
  const tab = findByClass(container, 'tab')[0];
  let writes = 0;
  const before = tab.title;
  Object.defineProperty(tab, 'title', {
    get: () => before,
    set: () => {
      writes += 1;
    },
  });

  for (let i = 0; i < 50; i++) bar.setFailed('s1', true);

  assert.equal(writes, 0, 'an unchanged state must not reach the DOM');
  bar.setFailed('s1', false);
  assert.equal(writes, 1, 'a real change still does');
});

test('a session whose state was derived says so in the title, and its dot behaves the same', () => {
  // The dot is deliberately identical: the claim ("this session is working") is the same claim.
  // What differs is that nobody published it — said in the one place the strip uses WORDS.
  const { container, bar } = mountBar();
  bar.add('s1', { label: 'desktop', ended: false, busy: true, derived: true });
  bar.add('s2', { label: 'terminal', ended: false, busy: true });
  const [t1, t2] = container.children;
  assert.equal(t1.title, 'desktop — state derived from the transcript: this session publishes none');
  assert.equal(t2.title, 'terminal', 'a published state is not qualified');
  assert.ok(t1.children[0].classList.contains('on'), 'the derived row still pulses');

  // It follows the roster, both ways, and an approval outranks it: the session is stopped on the
  // user, which is the more urgent thing to say — and it is never a derived claim anyway.
  bar.setBusy('s2', true, true);
  assert.equal(t2.title, 'terminal — state derived from the transcript: this session publishes none');
  bar.setWaiting('s2', 'permission');
  assert.equal(t2.title, 'terminal — waiting for your approval');
  bar.setBusy('s1', false, false);
  assert.equal(t1.title, 'desktop');
});
