// Read-only smoke check against the real Claude Code session store.
// Run: npx tsx scripts/live-check.ts  (prints discovered active sessions + a few live events)

import { homedir } from 'node:os';
import { isLive } from '../src/core/types.ts';
import { scanMtimeSessions } from '../src/server/discover-extra.ts';
import { discoverSessions } from '../src/server/discovery.ts';
import { Watcher } from '../src/server/watcher.ts';

const recs = await discoverSessions();
const active = recs.filter((r) => r.isActive);
console.log(`discovered ${recs.length} sessions, ${active.length} active`);
for (const r of active) console.log(`  [${r.root}] ${r.sessionId} model=${r.model} proj=${r.project}`);

const w = new Watcher({
  discoverMtime: async () => (await scanMtimeSessions(homedir(), Date.now())).filter(isLive),
});
let n = 0;
w.on('event', (e) => {
  if (n++ < 20) console.log('event', e.type, e.sessionId, e.type === 'usage' ? `fill=${e.fill}` : '');
});
await w.tick();
console.log(`emitted ${n} events on first tick`);
