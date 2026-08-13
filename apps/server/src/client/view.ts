import { createGraph, type GraphOpts, type SessionTree } from './graph.ts';
import type { PendingKind } from './sessions.ts';

// What the view forwards to the Graph. `loading` is absent on purpose: the view derives
// it from its own replay state, so a caller must not be able to set it.
export type ViewOpts = Pick<
  GraphOpts,
  | 'ended'
  | 'loadToolOutput'
  | 'loadCallIO'
  | 'loadAgentPrompt'
  | 'loadCommits'
  | 'loadFiles'
  | 'loadCards'
  | 'sessionId'
>;

/**
 * A tab's view: the loading skeleton until the session's history is in, then the Graph.
 * Owns the replay→live handoff for its panel (`onReplayEnd`) and forwards the tab's
 * lifecycle signals (`setEnded`, `setLive`, `setWaiting`, `setBusy`) to the Graph.
 *
 * Built with DOM nodes + textContent (never innerHTML) so session-derived values
 * (model name, etc.) can never inject markup.
 * `opts.loadToolOutput(toolUseId)` and `opts.loadCallIO(callId)` are handed straight to the
 * Graph: what a tool returned / an API call's input+output are fetched from the server on click,
 * never carried in the client (see graph.ts `openTool` / `openCall`).
 */
export function createView(container: HTMLElement, treeState: SessionTree, opts: ViewOpts = {}) {
  let ended = opts.ended ?? false;

  const body = document.createElement('div');
  const graphHost = document.createElement('div');
  body.append(graphHost);

  // A tab opens on a session whose history has not been read yet: the replay streams the whole
  // file through the reducer first, which for a large session takes long enough to see. Until
  // it ends, the view shows NOTHING — the loader stands in for it, so the first thing after a
  // refresh is an honest "loading", never a dashboard assembling itself card by card.
  const loader = buildLoader();
  container.append(loader, body);

  // Built at once, hidden behind the loader: the graph must absorb every replayed event to
  // build its feed, but it paints nothing until goLive().
  const graph = createGraph(graphHost, treeState, {
    loading: true,
    loadToolOutput: opts.loadToolOutput,
    loadCallIO: opts.loadCallIO,
    loadAgentPrompt: opts.loadAgentPrompt,
    loadCommits: opts.loadCommits,
    loadFiles: opts.loadFiles,
    loadCards: opts.loadCards,
    ended,
    sessionId: opts.sessionId,
  });
  let replayEnded = false; // the initial replay has handed off to live: the view may paint

  function mount() {
    loader.style.display = replayEnded ? 'none' : '';
    body.style.display = replayEnded ? '' : 'none';
  }
  mount();

  return {
    // The tab's session closed (roster watch in app.ts): forward to the graph so it can
    // freeze into the ended presentation.
    setEnded() {
      ended = true;
      graph.setEnded();
    },
    // The session is running again — `claude --resume` on the same id (roster watch in app.ts).
    // Lifting the flag is what re-opens the two setters below: their guard exists because a DEAD
    // session can never clear a flag it set, and a resumed one can.
    setLive() {
      ended = false;
      graph.setLive();
    },
    // The session is blocked on the user (roster watch in app.ts). Ignored once the session
    // has ended: its PID file is gone, so nothing would ever clear the flag again.
    setWaiting(kind: PendingKind | null, since: number | null) {
      if (ended) return;
      graph.setWaiting(kind, since);
    },
    // Claude Code's process says it is working (roster watch in app.ts). Same guard as
    // setWaiting: once the session has ended nothing would ever clear it again.
    setBusy(working: boolean) {
      if (ended) return;
      graph.setBusy(working);
    },
    // The initial replay has ended (replay-end, or a dead connection — `startReplay` guarantees
    // this fires exactly once, so the loader can never hang). Drop the loader and paint.
    onReplayEnd() {
      if (replayEnded) return;
      replayEnded = true;
      graph.goLive();
      mount();
    },
    destroy() {
      graph.destroy();
      container.replaceChildren();
    },
  };
}

// The loader mirrors the bento's own grid (a card per widget) so the layout does not jump
// when the real thing lands — the skeleton IS the shape of what is coming.
function buildLoader() {
  const el = (tag: string, cls: string) => {
    const n = document.createElement(tag);
    n.className = cls;
    return n;
  };
  const card = (...bars: string[]) => {
    const c = el('div', 'card sk-card');
    for (const w of bars) {
      const b = el('div', 'sk-bar');
      b.style.setProperty('width', w);
      c.append(b);
    }
    return c;
  };
  const root = el('div', 'skeleton');
  const note = el('div', 'sk-note');
  note.textContent = 'Reading the session…';
  // Cockpit: [Context + subagent monitor] on the left, the live feed on the right.
  const toprow = el('div', 'toprow');
  const stack = el('div', 'stack');
  const monitor = card('40%', '70%', '55%');
  monitor.classList.add('sublivecard');
  stack.append(card('30%', '90%', '60%'), monitor);
  toprow.append(stack, card('35%', '80%', '65%', '80%', '50%'));
  // Stats strip: three equal-height cards, mirroring the real .statsrow.
  const statsrow = el('div', 'statsrow');
  for (let i = 0; i < 3; i++) statsrow.append(card('30%', '85%', '60%'));
  root.append(note, toprow, statsrow);
  return root;
}
