import type { IncomingMessage, Server, ServerResponse } from 'node:http';

export const REQUEST_DEADLINE_MS = 5 * 60 * 1000;

interface Deadline {
  timer: NodeJS.Timeout;
  res: ServerResponse;
}

const deadlines = new WeakMap<IncomingMessage, Deadline>();

function expire(req: IncomingMessage, res: ServerResponse): void {
  if (req.complete) return;
  const socket = req.socket;
  if (!res.headersSent && socket.writable) {
    socket.write('HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n');
  }
  socket.destroySoon();
}

export function setRequestDeadline(req: IncomingMessage, ms: number): void {
  const deadline = deadlines.get(req);
  if (!deadline) return;
  clearTimeout(deadline.timer);
  deadline.timer = setTimeout(() => expire(req, deadline.res), ms);
  deadline.timer.unref();
}

export function touchRequestDeadline(req: IncomingMessage): void {
  deadlines.get(req)?.timer.refresh();
}

const REFUSED_BODY_DEADLINE_MS = 10_000;

export function discardRequestBody(req: IncomingMessage): void {
  setRequestDeadline(req, REFUSED_BODY_DEADLINE_MS);
  req.resume();
}

export function enforceRequestDeadlines(server: Server, ms: number = REQUEST_DEADLINE_MS): void {
  server.requestTimeout = 0;
  server.prependListener('request', (req, res) => {
    const timer = setTimeout(() => expire(req, res), ms);
    timer.unref();
    deadlines.set(req, { timer, res });
    req.once('end', () => clearTimeout(deadlines.get(req)?.timer));
  });
}
