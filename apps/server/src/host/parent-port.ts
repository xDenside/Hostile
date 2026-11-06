export interface ParentPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: { data: unknown }) => void): void;
}

export function parentPort(): ParentPort {
  const port = (process as unknown as { parentPort?: ParentPort }).parentPort;
  if (!port) throw new Error('This file runs only as a utility process of the Hostile app.');
  return port;
}
