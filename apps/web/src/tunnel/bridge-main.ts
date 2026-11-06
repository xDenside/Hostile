import { startBridge, type BridgeConfig } from './bridge';

const config = JSON.parse(atob(location.hash.slice(1))) as BridgeConfig;
history.replaceState(null, '', location.pathname);
const status = document.getElementById('status')!;
const host = (
  window as { hostileBridgeHost?: { report(s: { room: string; guests: number }): void } }
).hostileBridgeHost;
startBridge(config, (s) => {
  status.dataset.room = s.room;
  status.dataset.guests = String(s.guests);
  status.textContent = `${s.room}, ${s.guests} guests`;
  host?.report(s);
}).catch(() => host?.report({ room: 'failed', guests: 0 }));
