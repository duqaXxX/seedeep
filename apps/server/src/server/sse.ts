// Serialize an event into a single Server-Sent Events frame.
// Format: https://html.spec.whatwg.org/multipage/server-sent-events.html
//
// `data` is safe because JSON.stringify escapes newlines inside string values.
// `event` is stripped of CR/LF so an event name derived from session content can
// never split the frame and inject spurious SSE fields.
export function sseFrame(id: number, event: string, data: unknown): string {
  const safeEvent = event.replace(/[\r\n]/g, '');
  return `id: ${id}\nevent: ${safeEvent}\ndata: ${JSON.stringify(data)}\n\n`;
}
