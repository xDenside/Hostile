import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { JoinRequestDTO } from '@hostile/shared';
import { endpoints, errorMessage } from '../../api/client';
import { Avatar, Button } from '../../components/ui';
import { toast, useUi } from '../../stores/ui';
import { useSession } from '../../stores/session';
import styles from './join-requests.module.scss';

export const useJoinRequests = create<{ requests: JoinRequestDTO[] }>(() => ({ requests: [] }));

export const setJoinRequests = (requests: JoinRequestDTO[]) =>
  useJoinRequests.setState({ requests });

export async function refreshJoinRequests() {
  if (useSession.getState().user?.role !== 'owner') return;
  try {
    const { requests } = await endpoints.admin.joinRequests();
    setJoinRequests(requests);
  } catch {}
}

function useAnswers(id: string) {
  const [busy, setBusy] = useState(false);
  const answer = (call: (id: string) => Promise<void>) => async () => {
    setBusy(true);
    try {
      await call(id);
    } catch (err) {
      toast(errorMessage(err), 'error');
      setBusy(false);
    }
  };
  return {
    busy,
    letIn: answer(endpoints.admin.letIn),
    turnAway: answer(endpoints.admin.turnAway),
  };
}

const SETTLE_MS = 700;

function useSettled(place: string) {
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(place), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [place]);
  return settled === place;
}

export function JoinRequestRow({ request }: { request: JoinRequestDTO }) {
  const { busy, letIn, turnAway } = useAnswers(request.id);
  const index = useJoinRequests((s) => s.requests.findIndex((r) => r.id === request.id));
  const settled = useSettled(`${request.id}:${index}`);
  return (
    <div className={styles.row} data-testid="join-request" data-request={request.id}>
      <Avatar name={request.nickname} color="#2e2e2e" src={request.pictureUrl} size={36} />
      <span className={styles.name} title={request.nickname}>
        {request.nickname}
      </span>
      <div className={styles.actions}>
        <Button variant="primary" disabled={busy || !settled} onClick={() => void letIn()}>
          Let in
        </Button>
        <Button disabled={busy || !settled} onClick={() => void turnAway()}>
          Turn away
        </Button>
      </div>
    </div>
  );
}

export function JoinRequestCard() {
  const requests = useJoinRequests((s) => s.requests);
  const isOwner = useSession((s) => s.user?.role === 'owner');
  const onHosting = useUi((s) => s.settingsTab === 'hosting');
  useEffect(() => {
    if (isOwner) void refreshJoinRequests();
  }, [isOwner]);
  const first = requests[0];
  if (!isOwner || !first || onHosting) return null;
  return (
    <aside className={styles.card} aria-label="Someone is asking to join" data-testid="join-card">
      <div className={styles.title}>
        Asking to join
        {requests.length > 1 && (
          <span className={styles.more} data-testid="join-card-more">
            {requests.length - 1} more waiting
          </span>
        )}
      </div>
      <JoinRequestRow key={first.id} request={first} />
    </aside>
  );
}
