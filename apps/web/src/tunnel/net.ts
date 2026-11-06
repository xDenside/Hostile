import { WebSocket as EngineWebSocket } from 'engine.io-client';
import { checkTunnelRoute, type TunnelTarget } from '@hostile/shared';
import type { TunnelFetchInit } from './mux';
import { TunnelWebSocket } from './mux';

export const isGuestBuild = () => import.meta.env.HOSTILE_GUEST === '1' || guestInApp;

let guestInApp = false;
export function becomeGuestInApp() {
  guestInApp = true;
}

export const siteBase = () => (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');

export const LIVEKIT_TUNNEL_URL = 'ws://livekit.hostile-tunnel.invalid';
const LIVEKIT_HOST = 'livekit.hostile-tunnel.invalid';

export interface TunnelNet {
  fetch(target: TunnelTarget, path: string, init?: TunnelFetchInit): Promise<Response>;
  openSocket(
    socket: TunnelWebSocket,
    target: TunnelTarget,
    path: string,
    protocols: string[],
  ): void;
}

let active: TunnelNet | null = null;

export function setTunnelNet(net: TunnelNet | null) {
  active = net;
}

const noHost = () => new TypeError('The host cannot be reached.');

function routeOf(url: string): { target: TunnelTarget; path: string } | null {
  const parsed = new URL(url, location.href);
  if (parsed.hostname === LIVEKIT_HOST)
    return { target: 'livekit', path: parsed.pathname + parsed.search };
  const base = siteBase();
  const pathname = parsed.pathname.startsWith(`${base}/`)
    ? parsed.pathname.slice(base.length)
    : parsed.pathname;
  return parsed.origin === location.origin && pathname.startsWith('/api/')
    ? { target: 'room', path: pathname + parsed.search }
    : null;
}

export function netFetch(url: string, init: RequestInit & TunnelFetchInit = {}): Promise<Response> {
  if (!isGuestBuild()) return fetch(url, init);
  const route = routeOf(url);
  if (!route) return fetch(url, init);
  if (!active) return Promise.reject(noHost());
  return active.fetch(route.target, route.path, {
    ...init,
    bulk: init.bulk ?? init.body instanceof Blob,
  });
}

class TunnelTransport extends EngineWebSocket {
  override createSocket(uri: string, protocols: string | string[] | undefined) {
    if (!active) throw noHost();
    const route = checkTunnelRoute('ws', 'room', new URL(uri).pathname + new URL(uri).search);
    if (!route.ok) throw new Error(route.reason);
    const socket = new TunnelWebSocket(uri);
    active.openSocket(socket, 'room', route.path, protocolList(protocols));
    return socket as unknown as WebSocket;
  }
}

const protocolList = (protocols: string | string[] | undefined) =>
  Array.isArray(protocols) ? protocols : protocols ? [protocols] : [];

export const socketTransportOptions = () =>
  isGuestBuild() ? { transports: [TunnelTransport] } : {};

export const tunnelSocketUrl = () =>
  isGuestBuild() && !location.protocol.startsWith('http')
    ? 'http://room.hostile-tunnel.invalid'
    : undefined;

export const voiceServerUrl = (url: string) => (isGuestBuild() ? LIVEKIT_TUNNEL_URL : url);

let shimmed = false;
export function installLivekitShims() {
  if (shimmed || !isGuestBuild()) return;
  shimmed = true;
  const NativeSocket = window.WebSocket;
  const nativeFetch = window.fetch.bind(window);
  const Routed = function (url: string | URL, protocols?: string | string[]) {
    const parsed = new URL(String(url));
    if (parsed.hostname !== LIVEKIT_HOST) return new NativeSocket(url, protocols);
    const socket = new TunnelWebSocket(String(url));
    if (active)
      active.openSocket(
        socket,
        'livekit',
        parsed.pathname + parsed.search,
        protocolList(protocols),
      );
    else queueMicrotask(() => socket.handleFailure());
    return socket;
  } as unknown as typeof WebSocket;
  Object.assign(Routed, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = Routed;
  window.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    return url.includes(LIVEKIT_HOST) ? netFetch(url, init) : nativeFetch(input, init);
  };
}
