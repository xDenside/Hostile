import { createSocket } from 'node:dgram';
import { createServer } from 'node:net';

export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export function freeUdpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    socket.once('error', reject);
    socket.bind(0, () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });
}

export function udpPortIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    socket.once('error', () => resolve(false));
    socket.bind(port, () => socket.close(() => resolve(true)));
  });
}
