import net from 'node:net';
import dgram from 'node:dgram';

export function isTcpPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen({ port: Number(port), host, exclusive: true });
  });
}

export function isUdpPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', () => resolve(false));
    socket.bind({ port: Number(port), address: host, exclusive: true }, () =>
      socket.close(() => resolve(true)),
    );
  });
}

export async function waitForTcp(port, host = '127.0.0.1', timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const s = net.connect({ port: Number(port), host });
      s.once('connect', () => {
        s.destroy();
        resolve(true);
      });
      s.once('error', () => resolve(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

export async function waitForHttp(url, timeoutMs = 30_000, accept = (res) => res.ok) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (accept(res)) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

export async function lanAddresses() {
  const os = await import('node:os');
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}
