import { create } from 'zustand';
import { displayNameSchema, type JoinStatus } from '@hostile/shared';
import { ApiError, endpoints, errorMessage } from '../api/client';
import { platform } from '../platform';
import { useSession } from '../stores/session';
import { toast } from '../stores/ui';
import { useTunnel } from '../tunnel/state';
import { enterApp } from './session';
import { currentDeviceKey } from '../tunnel/device-key';

const LOOK_EVERY_MS = 2_000;
const WAIT_LIMIT_MS = 30 * 60_000;

export type AskPhase = 'form' | 'waiting' | 'turned-away' | 'no-answer';

interface AskState {
  phase: AskPhase;
  nickname: string;
  avatar: File | null;
  banner: File | null;
  error: string | null;
}

export const useAsk = create<AskState>(() => ({
  phase: 'form',
  nickname: '',
  avatar: null,
  banner: null,
  error: null,
}));

interface Kept {
  ticket: string;
  nickname: string;
  startedAt: number;
}

const keptKey = () => `hostile:join:${useTunnel.getState().hostFingerprint ?? 'here'}`;

function readKept(): Kept | null {
  try {
    return JSON.parse(localStorage.getItem(keptKey()) ?? 'null') as Kept | null;
  } catch {
    return null;
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
let current: Kept | null = null;
let draftInMemory = false;

function stopLooking() {
  if (timer) clearTimeout(timer);
  timer = null;
}

function settle(phase: AskPhase, error: string | null = null) {
  stopLooking();
  current = null;
  localStorage.removeItem(keptKey());
  useAsk.setState({ phase, error });
}

async function enter(answer: Extract<JoinStatus, { status: 'admitted' }>, avatarSent: boolean) {
  stopLooking();
  current = null;
  localStorage.removeItem(keptKey());
  const { avatar, banner } = useAsk.getState();
  platform().adoptSession(answer.csrfToken);
  enterApp(answer.user);
  useAsk.setState({ phase: 'form', avatar: null, banner: null, error: null, nickname: '' });
  try {
    if (avatar && !avatarSent) {
      const { user } = await endpoints.uploadProfileMedia('avatar', avatar);
      useSession.setState({ user });
    }
    if (banner) {
      const { user } = await endpoints.uploadProfileMedia('banner', banner);
      useSession.setState({ user });
    }
  } catch (err) {
    toast(`You are in, but a picture did not upload: ${errorMessage(err)}`, 'error', 8000);
  }
}

function lookSoon() {
  stopLooking();
  timer = setTimeout(() => void look(), LOOK_EVERY_MS);
}

async function look() {
  const kept = current;
  if (!kept) return;
  let answer: JoinStatus;
  try {
    answer = await endpoints.join.status(kept.ticket);
  } catch {
    if (current === kept) lookSoon();
    return;
  }
  if (current !== kept) return;
  if (answer.status === 'waiting') return lookSoon();
  if (answer.status === 'admitted') return void enter(answer, true);
  if (answer.status === 'turned-away') return settle('turned-away');
  if (Date.now() - kept.startedAt > WAIT_LIMIT_MS) return settle('no-answer');
  if (!draftInMemory) {
    useAsk.setState({ nickname: kept.nickname });
    return settle('form');
  }
  current = null;
  await send(kept.startedAt);
}

async function send(startedAt: number) {
  const { nickname, avatar } = useAsk.getState();
  try {
    const answer = await endpoints.join.ask(nickname, !!avatar, currentDeviceKey());
    if ('status' in answer) return await enter(answer, false);
    const kept: Kept = { ticket: answer.ticket, nickname, startedAt };
    current = kept;
    localStorage.setItem(keptKey(), JSON.stringify(kept));
    if (avatar) await endpoints.join.picture(answer.ticket, avatar);
    lookSoon();
  } catch (err) {
    if (err instanceof ApiError && !err.isNetwork && err.status >= 400 && err.status < 500) {
      if (err.status !== 429) {
        settle('form', errorMessage(err));
        return;
      }
    }
    if (Date.now() - startedAt > WAIT_LIMIT_MS) return settle('no-answer');
    stopLooking();
    timer = setTimeout(() => void send(startedAt), LOOK_EVERY_MS * 5);
  }
}

export function askToJoin() {
  const parsed = displayNameSchema.safeParse(useAsk.getState().nickname);
  if (!parsed.success) {
    useAsk.setState({ error: parsed.error.issues[0]!.message });
    return;
  }
  draftInMemory = true;
  useAsk.setState({ phase: 'waiting', error: null, nickname: parsed.data });
  void send(Date.now());
}

export function cancelAsking() {
  const kept = current;
  settle('form');
  if (kept) void endpoints.join.cancel(kept.ticket).catch(() => undefined);
}

export function askAgain() {
  useAsk.setState({ phase: 'form', error: null });
}

export function resumeAsking() {
  if (current || timer) return;
  const kept = readKept();
  if (!kept) return;
  current = kept;
  useAsk.setState({ phase: 'waiting', nickname: kept.nickname, error: null });
  void look();
}
