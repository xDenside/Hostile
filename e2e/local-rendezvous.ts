import { WebSocketServer, type WebSocket } from 'ws';

interface Filter {
  kinds?: number[];
  '#x'?: string[];
}
interface NostrEvent {
  kind: number;
  tags: string[][];
}

const matches = (filter: Filter, event: NostrEvent) =>
  (!filter.kinds || filter.kinds.includes(event.kind)) &&
  (!filter['#x'] || event.tags.some((t) => t[0] === 'x' && filter['#x']!.includes(t[1]!)));

export async function startLocalRendezvous(port: number) {
  const server = new WebSocketServer({ host: '127.0.0.1', port });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const subscriptions = new Map<WebSocket, Map<string, Filter>>();
  let seen = 0;
  server.on('connection', (socket) => {
    subscriptions.set(socket, new Map());
    socket.on('close', () => subscriptions.delete(socket));
    socket.on('error', () => undefined);
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as unknown[];
      seen++;
      switch (message[0]) {
        case 'REQ':
          subscriptions.get(socket)!.set(message[1] as string, message[2] as Filter);
          socket.send(JSON.stringify(['EOSE', message[1]]));
          return;
        case 'CLOSE':
          subscriptions.get(socket)!.delete(message[1] as string);
          return;
        case 'EVENT': {
          const event = message[1] as NostrEvent;
          socket.send(JSON.stringify(['OK', (event as unknown as { id: string }).id, true, '']));
          for (const [peer, subs] of subscriptions) {
            for (const [id, filter] of subs) {
              if (matches(filter, event)) peer.send(JSON.stringify(['EVENT', id, event]));
            }
          }
        }
      }
    });
  });
  return {
    messagesSeen: () => seen,
    async stop() {
      for (const socket of subscriptions.keys()) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
