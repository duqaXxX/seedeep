// Names on the SSE wire that BOTH ends have to agree on, and that no type can enforce: the
// server writes the frame, the browser attaches a listener to a string. A rename on one side
// alone leaves the other deaf while every test that asserts its own hand-written literal still
// passes — so the name lives here once, not twice.
//
// The data event types are not here: those come from `NormalizedEvent['type']`, which the
// compiler already keeps exhaustive (see client/event-types.ts). This file is for the CONTROL
// frames, which are strings by nature.

/**
 * The keepalive frame. It is a named event and not an SSE comment because the browser exposes no
 * hook for a comment, and this is the only thing that arrives on a quiet stream — the input the
 * client's silence watchdog measures.
 */
export const HEARTBEAT_EVENT = 'heartbeat';
