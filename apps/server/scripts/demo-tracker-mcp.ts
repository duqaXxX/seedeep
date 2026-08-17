/**
 * A tracker that does not exist, for the demo capture.
 *
 * The Cards surface is the one part of a session seedeep cannot see from the transcript alone: it
 * recognises a card from an MCP tool call whose name carries `issue`, or from a `gh issue` command.
 * Both of those mean a REAL tracker, and every public artefact of this product comes from a
 * synthetic session — so a demo either shows an empty Cards card forever, or it brings its own
 * tracker. This is that tracker: three invented issues on an invented project, served over stdio,
 * reachable by nothing and nobody.
 *
 * It implements the four MCP methods a session actually exercises (`initialize`, `tools/list`,
 * `tools/call`, `ping`) and nothing else. Newline-delimited JSON-RPC on stdin/stdout, which is what
 * the stdio transport is; anything written to stdout that is not a message corrupts the stream, so
 * every diagnostic here goes to stderr.
 *
 * Registered in the demo profile's own `~/.claude.json` (user scope) rather than a project
 * `.mcp.json`: Claude Code asks for approval before using a project-scoped server, and an
 * unattended recording has nobody to answer it.
 */

interface Issue {
  id: string;
  title: string;
  state: string;
  priority: string;
  description: string;
}

/** Invented, on an invented project. `ORB-` avoids every real tracker prefix this repo bans. */
const ISSUES: Record<string, Issue> = {
  'ORB-142': {
    id: 'ORB-142',
    title: 'Passes endpoint fails under burst load',
    state: 'In Progress',
    priority: 'High',
    description:
      'The /v1/passes handler returns 503 far more often than any other route, and the failures cluster rather than spreading out. Suspected: the rate limiter refills per key but the bucket is shared, so one noisy client starves the rest.',
  },
  'ORB-143': {
    id: 'ORB-143',
    title: 'Rate limiter has no upper bound on stored keys',
    state: 'Todo',
    priority: 'Medium',
    description: 'Every key ever seen stays in the map. Nothing evicts, so memory grows with traffic.',
  },
  'ORB-118': {
    id: 'ORB-118',
    title: 'Access log has no request id',
    state: 'Done',
    priority: 'Low',
    description: 'Two requests at the same millisecond cannot be told apart when reading the log.',
  },
};

const TOOLS = [
  {
    name: 'get_issue',
    description: 'Read one issue from the orbit tracker by its id, for example ORB-142.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Issue id, e.g. ORB-142' } },
      required: ['id'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the open issues on the orbit tracker.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function text(body: string) {
  return { content: [{ type: 'text', text: body }] };
}

function render(i: Issue): string {
  return `${i.id} — ${i.title}\nState: ${i.state}\nPriority: ${i.priority}\n\n${i.description}`;
}

function call(name: string, args: Record<string, unknown>) {
  if (name === 'get_issue') {
    const id = String(args['id'] ?? '')
      .trim()
      .toUpperCase();
    const issue = ISSUES[id];
    return issue ? text(render(issue)) : { ...text(`No issue ${id} on this tracker.`), isError: true };
  }
  if (name === 'list_issues') {
    const open = Object.values(ISSUES).filter((i) => i.state !== 'Done');
    return text(open.map((i) => `${i.id} [${i.state}] ${i.title}`).join('\n'));
  }
  return { ...text(`Unknown tool ${name}`), isError: true };
}

function handle(msg: { id?: unknown; method?: string; params?: Record<string, unknown> }): unknown | null {
  const { id, method, params } = msg;
  // A notification carries no id and must never be answered — a response to one is a protocol error.
  if (id === undefined || id === null) return null;
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize':
      return reply({
        // Echoed, never asserted: the client names the version it speaks, and a server that insists
        // on its own is a server the next release stops talking to.
        protocolVersion: (params?.['protocolVersion'] as string) ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'tracker', version: '0.0.0' },
      });
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call':
      return reply(call(String(params?.['name'] ?? ''), (params?.['arguments'] as Record<string, unknown>) ?? {}));
    case 'ping':
      return reply({});
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
  }
}

let buffer = '';
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  // Newline-delimited, and the LAST fragment is kept: a message can arrive split across reads.
  const parts = buffer.split('\n');
  buffer = parts.pop() ?? '';
  for (const line of parts) {
    if (!line.trim()) continue;
    try {
      const out = handle(JSON.parse(line));
      if (out) Bun.write(Bun.stdout, `${JSON.stringify(out)}\n`);
    } catch (e) {
      console.error('[tracker] bad message:', e);
    }
  }
}
