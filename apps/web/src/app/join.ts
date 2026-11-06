import { connectWithCode, initialCode, onHostBack } from '../tunnel/guest';
import { useTunnel } from '../tunnel/state';
import { useSession } from '../stores/session';
import { kickRealtime } from '../realtime/socket';

let listening = false;
let pending: Promise<boolean> | null = null;

export function resumeOrAsk(): Promise<boolean> {
  pending ??= start().finally(() => {
    pending = null;
  });
  return pending;
}

async function start(): Promise<boolean> {
  if (!listening) {
    listening = true;
    onHostBack(() => {
      if (useSession.getState().status === 'signed-in') kickRealtime();
    });
    useTunnel.subscribe((state, previous) => {
      if (state.phase === 'ended' && previous.phase !== 'ended')
        useSession.setState({ status: 'join', user: null });
    });
  }
  const code = initialCode();
  useSession.setState({ status: 'join' });
  if (!code) return false;
  return connectWithCode(code);
}
