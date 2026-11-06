import { startTunnelGateway, type GatewayOptions, type TunnelGateway } from '../tunnel/gateway.js';
import { parentPort } from './parent-port.js';

const port = parentPort();
let gateway: TunnelGateway | null = null;

type Incoming = { type: 'start'; options: GatewayOptions } | { type: 'stop' };

port.on('message', ({ data }) => {
  const message = data as Incoming;
  if (message.type === 'start') {
    startTunnelGateway(message.options).then(
      (started) => {
        gateway = started;
        port.postMessage({ type: 'ready', port: started.port });
        setInterval(() => port.postMessage({ type: 'guests', guests: started.guests() }), 1000);
      },
      (err: Error) => {
        port.postMessage({ type: 'failed', message: err.message });
        process.exit(1);
      },
    );
  } else if (message.type === 'stop') {
    const timer = setTimeout(() => process.exit(1), 5_000);
    timer.unref();
    void (gateway?.close() ?? Promise.resolve()).finally(() => process.exit(0));
  }
});
