import { useEffect, useState } from 'react';
import type { HostingPart, HostingStatus } from '@hostile/shared';
import { desktopRoom, platform } from '../../platform';
import { useTunnel } from '../../tunnel/state';
import { leaveRoom } from '../../app/session';
import { JoinRequestRow, useJoinRequests } from '../join/JoinRequests';
import { toast } from '../../stores/ui';
import { CodeReveal, ConfirmButton, Group } from './Group';
import styles from './settings.module.scss';

async function copy(code: string) {
  try {
    await navigator.clipboard.writeText(code);
  } catch {
    toast('Could not reach the clipboard. Select the code and copy it by hand.');
  }
}

function useHostingStatus(): HostingStatus | null {
  const [status, setStatus] = useState<HostingStatus | null>(null);
  useEffect(() => {
    const bridge = platform().desktop;
    if (!bridge || desktopRoom()?.role !== 'host') return;
    let alive = true;
    void bridge.hosting.status().then((s) => alive && setStatus(s));
    const off = bridge.hosting.onStatus(setStatus);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return status;
}

export function useRoomCode(): string | null {
  const hosting = useHostingStatus();
  const joined = useTunnel((s) => s.code);
  return hosting?.code ?? joined;
}

const WORDS: Record<HostingPart['state'], string> = {
  stopped: 'Stopped',
  starting: 'Starting',
  running: 'Running',
  restarting: 'Stopped by itself, restarting',
  failed: 'Stopped, and not restarting again. Stop hosting, then host again to retry',
};

function partWords(part: HostingPart) {
  if (part.detail === 'slow') return 'Still starting. Calls work once it is ready';
  if (part.detail === 'not-ready') return 'It never became ready, so it is starting again';
  if (part.detail === 'missing')
    return 'Not available: its program is missing, so calls will not work';
  const restarted = part.restarts
    ? `, restarted ${part.restarts === 1 ? 'once' : `${part.restarts} times`}`
    : '';
  return `${WORDS[part.state]}${restarted}`;
}

function Hosting() {
  const bridge = platform().desktop!;
  const status = useHostingStatus();
  const waiting = useJoinRequests((s) => s.requests);
  if (!status) return null;
  const { parts } = status;
  return (
    <>
      <Group
        title="Your room"
        hint="This PC is the room. It stays awake while hosting, but closing a laptop's lid still ends the room until you open it again."
      >
        {status.code && (
          <div data-testid="hosting-code">
            <CodeReveal
              title="Room code"
              code={status.code}
              note="Anyone with this code can ask to join, and you choose who comes in. Share it only with your friends."
              onCopy={copy}
            />
          </div>
        )}
      </Group>
      <Group title="Waiting to join">
        {waiting.length ? (
          waiting.map((request) => <JoinRequestRow key={request.id} request={request} />)
        ) : (
          <p className={styles.waitingNone} data-testid="waiting-none">
            Nobody is waiting.
          </p>
        )}
      </Group>
      <div className={styles.panelColumns}>
        <Group title="Status">
          <dl className={styles.definitions}>
            <dt>Guests connected</dt>
            <dd data-testid="hosting-guests">{status.guests}</dd>
            <dt>Room server</dt>
            <dd data-testid="hosting-server">{partWords(parts.server)}</dd>
            <dt>Calls</dt>
            <dd data-testid="hosting-media">{partWords(parts.media)}</dd>
            <dt>Connections from guests</dt>
            <dd data-testid="hosting-gateway">{partWords(parts.gateway)}</dd>
            <dt>Meeting point</dt>
            <dd data-testid="hosting-bridge">{partWords(parts.bridge)}</dd>
          </dl>
        </Group>
        <Group title="Code and hosting">
          <div className={styles.actionRowStacked}>
            <span>Replace the code if it has reached someone it should not.</span>
            <ConfirmButton
              label="Make a new code"
              question="Cut everyone off?"
              onConfirm={async () => {
                await bridge.hosting.newCode();
              }}
            />
          </div>
          <div className={styles.actionRowStacked}>
            <span>Guests see that the host is away, until you host again.</span>
            <ConfirmButton
              label="Stop hosting"
              question="Close the room for everyone?"
              onConfirm={() => bridge.room.leave()}
            />
          </div>
        </Group>
      </div>
    </>
  );
}

function GuestRoom() {
  const code = useTunnel((s) => s.code);
  return (
    <Group
      title="Your room"
      hint="You are a guest in this room. The person hosting it holds its data."
    >
      {code && <CodeReveal title="Room code" code={code} onCopy={copy} />}
      <div className={styles.actionRow}>
        <span>
          Leaving ends who you are here. Your messages stay. Coming back means asking to join again,
          as someone new.
        </span>
        <ConfirmButton
          label="Leave"
          question="Leave and become someone new next time?"
          onConfirm={async () => {
            await leaveRoom();
          }}
        />
      </div>
    </Group>
  );
}

export function HostingTab() {
  return desktopRoom()?.role === 'host' ? <Hosting /> : <GuestRoom />;
}
