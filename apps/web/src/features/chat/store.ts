import { create } from 'zustand';
import {
  ErrorCode,
  LIMITS,
  type AttachmentDTO,
  type AttachmentKind,
  type MessageDTO,
  type MessagePageDTO,
  type MessageQuoteDTO,
} from '@hostile/shared';
import {
  ApiError,
  endpoints,
  errorMessage,
  uploadAttachment,
  UploadCanceled,
} from '../../api/client';
import { loadJson, saveJson } from '../../lib/storage';
import { useCommunity } from '../../stores/community';
import { useSession } from '../../stores/session';
import { toast, useUi } from '../../stores/ui';
import { chooseFiles, describeRefusals } from './attachment-rules';
import { measureLocalMedia } from './local-media';
import {
  applyChanges,
  applyEvent,
  applyJumpPage,
  applyLatestPage,
  applyOlderPage,
  emptyWindow,
  forgetOrigin,
  newestSeq,
  patchQuote,
  quoteOf,
  type ChannelWindow,
} from './sync';

export type PendingStatus = 'waiting' | 'uploading' | 'sending' | 'retrying' | 'failed';

export interface OutgoingFile {
  id: string;
  name: string;
  size: number;
  kind: AttachmentKind;
  width: number | null;
  height: number | null;
}

export interface PendingFile extends OutgoingFile {
  attachment: AttachmentDTO | null;
  failed?: boolean;
}

export interface PendingMessage {
  nonce: string;
  channelId: string;
  content: string;
  status: PendingStatus;
  attempts: number;
  createdAt: number;
  error: string | null;
  files?: PendingFile[];
  replyToId?: string;
  replyQuote?: MessageQuoteDTO;
}

export interface JumpTarget {
  messageId: string;
  seq: number;
}

interface ChatState {
  windows: Record<string, ChannelWindow>;
  loading: Record<string, 'latest' | 'older' | 'resync' | 'jump' | undefined>;
  errors: Record<string, string | undefined>;
  syncStale: Record<string, boolean>;
  following: Record<string, boolean>;
  pending: Record<string, PendingMessage>;
  uploadPercent: Record<string, number>;
  drafts: Record<string, string>;
  trays: Record<string, OutgoingFile[]>;
  trayNotices: Record<string, string | undefined>;
  typing: Record<string, Record<string, number>>;
  replies: Record<string, MessageQuoteDTO | undefined>;
  composerFocus: string | null;
  editing: Record<string, string | undefined>;
  editDrafts: Record<string, string | undefined>;
  jumps: Record<string, JumpTarget | undefined>;
  forwarding: MessageDTO | null;
  deleting: MessageDTO | null;
}

export const useChat = create<ChatState>(() => ({
  windows: {},
  loading: {},
  errors: {},
  syncStale: {},
  following: {},
  pending: {},
  uploadPercent: {},
  drafts: {},
  trays: {},
  trayNotices: {},
  typing: {},
  replies: {},
  composerFocus: null,
  editing: {},
  editDrafts: {},
  jumps: {},
  forwarding: null,
  deleting: null,
}));

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

function win(channelId: string): ChannelWindow {
  return useChat.getState().windows[channelId] ?? emptyWindow();
}

function putWin(channelId: string, w: ChannelWindow) {
  useChat.setState((s) => ({ windows: { ...s.windows, [channelId]: w } }));
}

function setWin(channelId: string, w: ChannelWindow) {
  putWin(channelId, w);
  if (w.needsResync && !useChat.getState().loading[channelId]) void resyncChannel(channelId);
}

function setLoading(channelId: string, value: ChatState['loading'][string]) {
  useChat.setState((s) => ({ loading: { ...s.loading, [channelId]: value } }));
}

function setError(channelId: string, value: string | undefined) {
  useChat.setState((s) => ({ errors: { ...s.errors, [channelId]: value } }));
}

function setSyncStale(channelId: string, value: boolean) {
  if ((useChat.getState().syncStale[channelId] ?? false) === value) return;
  useChat.setState((s) => ({ syncStale: { ...s.syncStale, [channelId]: value } }));
}

export function resetChat() {
  flushDrafts();
  for (const t of retryTimers.values()) clearTimeout(t);
  retryTimers.clear();
  for (const t of resyncTimers.values()) clearTimeout(t);
  resyncTimers.clear();
  resyncAttempts.clear();
  readSettled.clear();
  windowLoads.clear();
  pendingKey = null;
  for (const upload of uploads.values()) upload.abort();
  uploads.clear();
  releaseAllLocalFiles();
  useChat.setState({
    windows: {},
    loading: {},
    errors: {},
    syncStale: {},
    following: {},
    pending: {},
    uploadPercent: {},
    drafts: {},
    trays: {},
    trayNotices: {},
    typing: {},
    replies: {},
    composerFocus: null,
    editing: {},
    editDrafts: {},
    jumps: {},
    forwarding: null,
    deleting: null,
  });
}

export const JUMP_CONTEXT_SEQS = 30;

const windowLoads = new Map<string, number>();

function startWindowLoad(channelId: string): number {
  const next = (windowLoads.get(channelId) ?? 0) + 1;
  windowLoads.set(channelId, next);
  return next;
}

const windowLoadIs = (channelId: string, load: number) =>
  (windowLoads.get(channelId) ?? 0) === load;

export async function loadLatest(channelId: string): Promise<void> {
  if (useChat.getState().loading[channelId] === 'latest') return;
  const load = startWindowLoad(channelId);
  setLoading(channelId, 'latest');
  setError(channelId, undefined);
  let page: MessagePageDTO;
  try {
    page = await endpoints.history(channelId, undefined, LIMITS.historyPageDefault);
  } catch (err) {
    if (windowLoadIs(channelId, load)) {
      setError(channelId, errorMessage(err));
      setLoading(channelId, undefined);
    }
    return;
  }
  if (!windowLoadIs(channelId, load)) return;
  setLoading(channelId, undefined);
  setSyncStale(channelId, false);
  setWin(channelId, applyLatestPage(win(channelId), page));
}

export async function loadOlder(channelId: string): Promise<void> {
  const w = win(channelId);
  if (!w.loaded || !w.hasOlder || useChat.getState().loading[channelId]) return;
  const oldest = w.messages[0]?.seq;
  const load = windowLoads.get(channelId) ?? 0;
  setLoading(channelId, 'older');
  let page: MessagePageDTO;
  try {
    page = await endpoints.history(channelId, oldest, LIMITS.historyPageDefault);
  } catch (err) {
    if (!windowLoadIs(channelId, load)) return;
    toast(`Could not load older messages: ${errorMessage(err)}`, 'error');
    setLoading(channelId, undefined);
    return;
  }
  if (!windowLoadIs(channelId, load)) return;
  setLoading(channelId, undefined);
  if (win(channelId).messages[0]?.seq !== oldest) return;
  setWin(channelId, applyOlderPage(win(channelId), page));
}

export async function loadAround(channelId: string, target: JumpTarget): Promise<boolean> {
  const load = startWindowLoad(channelId);
  const wanted = () =>
    windowLoadIs(channelId, load) && useChat.getState().jumps[channelId] === target;
  setLoading(channelId, 'jump');
  let page: MessagePageDTO;
  try {
    page = await endpoints.history(
      channelId,
      target.seq + JUMP_CONTEXT_SEQS,
      LIMITS.historyPageDefault,
    );
  } catch (err) {
    if (!wanted()) return false;
    setLoading(channelId, undefined);
    toast(`Could not load that message: ${errorMessage(err)}`, 'error');
    return false;
  }
  if (!wanted()) return false;
  setLoading(channelId, undefined);
  if (!page.messages.some((m) => m.id === target.messageId)) {
    toast('That message is no longer there.', 'error');
    return false;
  }
  setWin(channelId, applyJumpPage(win(channelId), page));
  return true;
}

export function requestJump(channelId: string, target: JumpTarget) {
  useChat.setState((s) => ({ jumps: { ...s.jumps, [channelId]: target } }));
}

export function clearJump(channelId: string) {
  if (!useChat.getState().jumps[channelId]) return;
  useChat.setState((s) => ({
    jumps: { ...s.jumps, [channelId]: undefined },
    ...(s.loading[channelId] === 'jump'
      ? { loading: { ...s.loading, [channelId]: undefined } }
      : {}),
  }));
}

useUi.subscribe((s, prev) => {
  if (prev.selectedChannelId && s.selectedChannelId !== prev.selectedChannelId) {
    clearJump(prev.selectedChannelId);
  }
});

const RESYNC_DELAYS_MS = [1000, 2000, 5000, 15000, 30000];
const resyncTimers = new Map<string, ReturnType<typeof setTimeout>>();
const resyncAttempts = new Map<string, number>();

function scheduleResync(channelId: string) {
  if (resyncTimers.has(channelId)) return;
  const attempt = resyncAttempts.get(channelId) ?? 0;
  resyncAttempts.set(channelId, attempt + 1);
  const base = RESYNC_DELAYS_MS[Math.min(attempt, RESYNC_DELAYS_MS.length - 1)]!;
  const delay = Math.round(base * (0.75 + Math.random() * 0.5));
  resyncTimers.set(
    channelId,
    setTimeout(() => {
      resyncTimers.delete(channelId);
      void resyncChannel(channelId);
    }, delay),
  );
}

function cancelScheduledResync(channelId: string) {
  const t = resyncTimers.get(channelId);
  if (t) clearTimeout(t);
  resyncTimers.delete(channelId);
}

export async function resyncChannel(channelId: string): Promise<void> {
  const w = win(channelId);
  if (!w.loaded || useChat.getState().loading[channelId] === 'latest') return;
  cancelScheduledResync(channelId);
  setLoading(channelId, 'resync');
  try {
    const changes = await endpoints.changes(channelId, w.syncSeq);
    const next = applyChanges(win(channelId), changes);
    setLoading(channelId, undefined);
    refreshHeldQuotes(changes.changes);
    forgetDeletedOrigins(changes.changes);
    if (next === 'reset') {
      resyncAttempts.delete(channelId);
      setSyncStale(channelId, false);
      putWin(channelId, emptyWindow());
      await loadLatest(channelId);
      return;
    }
    if (next.needsResync && next.syncSeq <= w.syncSeq) {
      putWin(channelId, next);
      setSyncStale(channelId, true);
      scheduleResync(channelId);
      return;
    }
    resyncAttempts.delete(channelId);
    setSyncStale(channelId, false);
    setWin(channelId, next);
  } catch (err) {
    setLoading(channelId, undefined);
    if (err instanceof ApiError && err.status === 404) {
      cancelScheduledResync(channelId);
      resyncAttempts.delete(channelId);
      setSyncStale(channelId, false);
      useChat.setState((s) => {
        const windows = { ...s.windows };
        delete windows[channelId];
        return { windows };
      });
      return;
    }
    setSyncStale(channelId, true);
    scheduleResync(channelId);
  }
}

export async function resyncAllLoaded(): Promise<void> {
  const ids = Object.entries(useChat.getState().windows)
    .filter(([, w]) => w.loaded)
    .map(([id]) => id);
  await Promise.all(ids.map((id) => resyncChannel(id)));
}

export function onMessageEvent(msg: MessageDTO) {
  refreshHeldQuotes([msg]);
  forgetDeletedOrigins([msg]);
  const { windows, following, pending } = useChat.getState();
  if (windows[msg.channelId]) {
    setWin(
      msg.channelId,
      applyEvent(windows[msg.channelId]!, msg, following[msg.channelId] ?? true),
    );
  }
  if (pending[msg.clientNonce] && msg.authorId === useSession.getState().user?.id) {
    removePending(msg.clientNonce);
    catchUpIfTrimmed(msg.channelId);
  }
  if (!msg.deleted && msg.seq === msg.changeSeq) {
    useCommunity.setState((s) => {
      const index = s.channels.findIndex((c) => c.id === msg.channelId);
      const channel = s.channels[index];
      if (!channel || msg.seq <= channel.lastMessageSeq) return {};
      const channels = s.channels.slice();
      channels[index] = { ...channel, lastMessageSeq: msg.seq };
      return { channels };
    });
    clearTyping(msg.channelId, msg.authorId);
  }
}

function forgetDeletedOrigins(changed: MessageDTO[]) {
  const deleted = changed.filter((msg) => msg.deleted);
  if (!deleted.length) return;
  useChat.setState((s) => {
    let windows = s.windows;
    for (const [channelId, w] of Object.entries(s.windows)) {
      const messages = deleted.reduce((rows, msg) => forgetOrigin(rows, msg.id), w.messages);
      if (messages !== w.messages) windows = { ...windows, [channelId]: { ...w, messages } };
    }
    return windows === s.windows ? {} : { windows };
  });
}

function refreshHeldQuotes(changed: MessageDTO[]) {
  const edits = changed.filter((msg) => msg.changeSeq !== msg.seq);
  if (!edits.length) return;
  const { replies, pending } = useChat.getState();
  const nextReplies = { ...replies };
  const nextPending = { ...pending };
  let repliesChanged = false;
  let pendingChanged = false;
  for (const msg of edits) {
    const reply = nextReplies[msg.channelId];
    if (reply && patchQuote(reply, msg) !== reply) {
      nextReplies[msg.channelId] = patchQuote(reply, msg);
      repliesChanged = true;
    }
    for (const row of Object.values(nextPending)) {
      if (!row.replyQuote || patchQuote(row.replyQuote, msg) === row.replyQuote) continue;
      nextPending[row.nonce] = { ...row, replyQuote: patchQuote(row.replyQuote, msg) };
      pendingChanged = true;
    }
  }
  if (repliesChanged) useChat.setState({ replies: nextReplies });
  if (pendingChanged) {
    useChat.setState({ pending: nextPending });
    savePending();
  }
}

function catchUpIfTrimmed(channelId: string) {
  const w = useChat.getState().windows[channelId];
  if (w?.loaded && w.hasNewer) void loadLatest(channelId);
}

export function onTyping(channelId: string, userId: string) {
  if (userId === useSession.getState().user?.id) return;
  useChat.setState((s) => ({
    typing: {
      ...s.typing,
      [channelId]: { ...s.typing[channelId], [userId]: Date.now() + LIMITS.typingDisplayMs },
    },
  }));
}

function clearTyping(channelId: string, userId: string) {
  const current = useChat.getState().typing[channelId];
  if (!current?.[userId]) return;
  const next = { ...current };
  delete next[userId];
  useChat.setState((s) => ({ typing: { ...s.typing, [channelId]: next } }));
}

setInterval(() => {
  const now = Date.now();
  const { typing } = useChat.getState();
  let changed = false;
  const next: ChatState['typing'] = {};
  for (const [channelId, users] of Object.entries(typing)) {
    const kept = Object.fromEntries(Object.entries(users).filter(([, exp]) => exp > now));
    if (Object.keys(kept).length !== Object.keys(users).length) changed = true;
    next[channelId] = kept;
  }
  if (changed) useChat.setState({ typing: next });
}, 1000);

const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function updatePending(nonce: string, patch: Partial<PendingMessage>) {
  useChat.setState((s) => {
    const p = s.pending[nonce];
    return p ? { pending: { ...s.pending, [nonce]: { ...p, ...patch } } } : {};
  });
  savePending();
}

function removePending(nonce: string) {
  const t = retryTimers.get(nonce);
  if (t) clearTimeout(t);
  retryTimers.delete(nonce);
  const files = useChat.getState().pending[nonce]?.files ?? [];
  useChat.setState((s) => {
    if (!s.pending[nonce]) return {};
    const pending = { ...s.pending };
    delete pending[nonce];
    if (!files.length) return { pending };
    const uploadPercent = { ...s.uploadPercent };
    for (const file of files) delete uploadPercent[file.id];
    return { pending, uploadPercent };
  });
  savePending();
  for (const file of files) settleLocalFile(file);
}

export function refusalMessage(err: unknown): string {
  if (err instanceof ApiError && err.issues?.[0]?.message) return err.issues[0].message;
  return errorMessage(err);
}

const UPLOADS_AT_ONCE = 2;

type UploadSlot = object;

const heldSlots = new Set<UploadSlot>();
const uploadLine: { nonce: string; admit: (slot: UploadSlot) => void }[] = [];

const uploadSlotFree = () => heldSlots.size < UPLOADS_AT_ONCE && uploadLine.length === 0;

function takeUploadSlot(nonce: string): Promise<UploadSlot> {
  if (uploadSlotFree()) {
    const slot: UploadSlot = {};
    heldSlots.add(slot);
    return Promise.resolve(slot);
  }
  return new Promise((admit) => uploadLine.push({ nonce, admit }));
}

function releaseUploadSlot(slot: UploadSlot) {
  heldSlots.delete(slot);
  while (heldSlots.size < UPLOADS_AT_ONCE) {
    const next = uploadLine.shift();
    if (!next) return;
    const nextSlot: UploadSlot = {};
    heldSlots.add(nextSlot);
    next.admit(nextSlot);
  }
}

async function uploadFiles(nonce: string): Promise<boolean> {
  const slot = await takeUploadSlot(nonce);
  try {
    if (useChat.getState().pending[nonce]?.status === 'waiting') {
      updatePending(nonce, { status: 'uploading' });
    }
    return await uploadEachFile(nonce);
  } finally {
    releaseUploadSlot(slot);
  }
}

async function uploadEachFile(nonce: string): Promise<boolean> {
  for (;;) {
    const before = useChat.getState().pending[nonce];
    if (!before) return false;
    const next = before.files?.find((f) => !f.attachment);
    if (!next) return true;
    const local = localFiles.get(next.id);
    if (!local) {
      updatePending(nonce, { status: 'failed', error: filesLost(before.files ?? []) });
      return false;
    }
    if (next.kind === 'video') await local.measured;
    const p = useChat.getState().pending[nonce];
    const file = p?.files?.find((f) => f.id === next.id);
    if (!p || !file) return false;

    setUploadPercent(file.id, 0);
    const upload = uploadAttachment(
      p.channelId,
      local.file,
      { name: file.name, width: file.width, height: file.height },
      (percent) => setUploadPercent(file.id, percent),
    );
    uploads.set(nonce, upload);
    let attachment: AttachmentDTO;
    try {
      attachment = await upload.promise;
    } catch (err) {
      if (err instanceof UploadCanceled) return false;
      const reason = errorMessage(err);
      const named = (p.files?.length ?? 0) > 1 ? `"${file.name}": ${reason}` : reason;
      setFileFailed(nonce, file.id);
      updatePending(nonce, { status: 'failed', error: named });
      return false;
    } finally {
      if (uploads.get(nonce) === upload) uploads.delete(nonce);
    }
    if (!useChat.getState().pending[nonce]) {
      void endpoints.removeAttachment(attachment.id).catch(() => undefined);
      return false;
    }
    setFileUploaded(nonce, file.id, attachment);
  }
}

function setUploadPercent(fileId: string, percent: number) {
  if (useChat.getState().uploadPercent[fileId] === percent) return;
  useChat.setState((s) => ({ uploadPercent: { ...s.uploadPercent, [fileId]: percent } }));
}

function patchFile(nonce: string, fileId: string, patch: Partial<PendingFile>) {
  const p = useChat.getState().pending[nonce];
  if (!p?.files) return;
  updatePending(nonce, {
    files: p.files.map((f) => (f.id === fileId ? { ...f, ...patch } : f)),
  });
}

function setFileFailed(nonce: string, fileId: string) {
  patchFile(nonce, fileId, { failed: true });
}

function setFileUploaded(nonce: string, fileId: string, attachment: AttachmentDTO) {
  patchFile(nonce, fileId, { attachment, failed: false });
  useChat.setState((s) => {
    const uploadPercent = { ...s.uploadPercent };
    delete uploadPercent[fileId];
    return { uploadPercent };
  });
}

async function attemptSend(nonce: string) {
  const p = useChat.getState().pending[nonce];
  if (!p) return;
  if (uploads.has(nonce) || uploadLine.some((waiting) => waiting.nonce === nonce)) return;
  const uploading = p.files?.some((f) => !f.attachment) ?? false;
  const nextUp = uploadSlotFree() ? 'uploading' : 'waiting';
  updatePending(nonce, {
    status: uploading ? nextUp : p.attempts === 0 ? 'sending' : 'retrying',
    attempts: p.attempts + 1,
    error: null,
    ...(p.files ? { files: p.files.map((f) => ({ ...f, failed: false })) } : {}),
  });
  if (uploading) {
    if (!(await uploadFiles(nonce))) return;
    updatePending(nonce, { status: 'sending' });
  }
  const ready = useChat.getState().pending[nonce];
  if (!ready) return;
  try {
    const fileIds = ready.files?.flatMap((f) => (f.attachment ? [f.attachment.id] : []));
    const res = ready.replyToId
      ? await endpoints.send(
          ready.channelId,
          ready.content,
          ready.nonce,
          fileIds ?? [],
          ready.replyToId,
        )
      : fileIds
        ? await endpoints.send(ready.channelId, ready.content, ready.nonce, fileIds)
        : await endpoints.send(ready.channelId, ready.content, ready.nonce);
    const target = win(p.channelId);
    if (target.loaded && target.hasNewer) {
      await loadLatest(p.channelId);
      if (win(p.channelId).hasNewer) {
        updatePending(nonce, {
          status: 'failed',
          error: SENT_NOT_SHOWN,
        });
      } else {
        removePending(nonce);
      }
    } else {
      removePending(nonce);
      onMessageEvent(res.message);
    }
  } catch (err) {
    const current = useChat.getState().pending[nonce];
    if (!current) return;
    if (err instanceof ApiError && err.code === ErrorCode.AttachmentsNotClaimable) {
      forgetUnclaimableFiles(current);
      return;
    }
    const transient = err instanceof ApiError ? err.isTransient : true;
    if (transient && current.attempts < RETRY_DELAYS_MS.length) {
      const retryAfter =
        err instanceof ApiError && err.retryAfterSec ? err.retryAfterSec * 1000 : 0;
      const delay = Math.max(RETRY_DELAYS_MS[current.attempts - 1] ?? 15000, retryAfter);
      updatePending(nonce, { status: 'retrying', error: refusalMessage(err) });
      retryTimers.set(
        nonce,
        setTimeout(() => void attemptSend(nonce), delay),
      );
    } else {
      updatePending(nonce, { status: 'failed', error: refusalMessage(err) });
    }
  }
}

export function sendMessage(channelId: string, content: string) {
  const nonce = crypto.randomUUID();
  const tray = useChat.getState().trays[channelId] ?? [];
  const reply = useChat.getState().replies[channelId];
  if (reply || win(channelId).hasNewer) setFollowing(channelId, true);
  useChat.setState((s) => ({
    pending: {
      ...s.pending,
      [nonce]: {
        nonce,
        channelId,
        content,
        status: tray.length ? 'uploading' : 'sending',
        attempts: 0,
        createdAt: Date.now(),
        error: null,
        ...(tray.length ? { files: tray.map((f) => ({ ...f, attachment: null })) } : {}),
        ...(reply ? { replyToId: reply.id, replyQuote: reply } : {}),
      },
    },
    ...(reply ? { replies: { ...s.replies, [channelId]: undefined } } : {}),
    ...(tray.length
      ? {
          trays: { ...s.trays, [channelId]: [] },
          trayNotices: { ...s.trayNotices, [channelId]: undefined },
        }
      : {}),
  }));
  savePending();
  void attemptSend(nonce);
}

function forgetUnclaimableFiles(row: PendingMessage) {
  const files = row.files ?? [];
  const resendable = files.every((f) => localFiles.has(f.id));
  updatePending(row.nonce, {
    status: 'failed',
    error: resendable ? FILES_SWEPT_HELD : FILES_SWEPT_GONE,
    files: files.map((f) => ({ ...f, attachment: null, failed: false })),
  });
  for (const file of files) {
    if (file.attachment) void endpoints.removeAttachment(file.attachment.id).catch(() => undefined);
  }
}

export function isUploading(pending: Record<string, PendingMessage>): boolean {
  return Object.values(pending).some((p) => p.status === 'uploading' || p.status === 'waiting');
}

export function canRetryPending(p: PendingMessage): boolean {
  return !p.files?.some((f) => !f.attachment && !localFiles.has(f.id));
}

function filesLost(files: PendingFile[]): string {
  return files.some((f) => f.attachment) ? FILES_LOST_SOME : FILES_LOST;
}

export function canSendWhatGotThrough(p: PendingMessage): boolean {
  return !canRetryPending(p) && (p.files?.some((f) => f.attachment) ?? false);
}

export function sendWhatGotThrough(nonce: string) {
  const p = useChat.getState().pending[nonce];
  if (!p?.files || !canSendWhatGotThrough(p)) return;
  for (const file of p.files) if (!file.attachment) settleLocalFile(file);
  updatePending(nonce, { attempts: 0, files: p.files.filter((f) => f.attachment) });
  void attemptSend(nonce);
}

export function retryPending(nonce: string) {
  const p = useChat.getState().pending[nonce];
  if (!p || !canRetryPending(p)) return;
  updatePending(nonce, { attempts: 0 });
  void attemptSend(nonce);
}

export function discardPending(nonce: string) {
  const row = useChat.getState().pending[nonce];
  const uploaded = row?.files ?? [];
  uploads.get(nonce)?.abort();
  uploads.delete(nonce);
  removePending(nonce);
  for (const file of uploaded) {
    if (file.attachment) void endpoints.removeAttachment(file.attachment.id).catch(() => undefined);
  }
  if (row) giveBackWords(row);
}

function giveBackWords(row: PendingMessage) {
  if (!row.content || row.error === SENT_NOT_SHOWN) return;
  const draft = useChat.getState().drafts[row.channelId] ?? '';
  setDraft(row.channelId, draft.trim() ? `${row.content}\n${draft}` : row.content);
  useChat.setState((s) => ({
    composerFocus: row.channelId,
    ...(row.replyQuote && !s.replies[row.channelId]
      ? { replies: { ...s.replies, [row.channelId]: row.replyQuote } }
      : {}),
  }));
}

export function retryWaitingNow() {
  for (const p of Object.values(useChat.getState().pending)) {
    if (p.status === 'retrying') {
      const t = retryTimers.get(p.nonce);
      if (t) clearTimeout(t);
      void attemptSend(p.nonce);
    }
  }
}

export async function editMessage(messageId: string, content: string): Promise<boolean> {
  try {
    const { message } = await endpoints.edit(messageId, content);
    onMessageEvent(message);
    return true;
  } catch (err) {
    toast(`Could not edit: ${errorMessage(err)}`, 'error');
    return false;
  }
}

export async function deleteMessage(messageId: string): Promise<boolean> {
  try {
    const { message } = await endpoints.remove(messageId);
    onMessageEvent(message);
    return true;
  } catch (err) {
    toast(`Could not delete: ${errorMessage(err)}`, 'error');
    return false;
  }
}

export function startReply(message: MessageDTO) {
  useChat.setState((s) => ({
    replies: { ...s.replies, [message.channelId]: quoteOf(message) },
    composerFocus: message.channelId,
  }));
}

export function cancelReply(channelId: string) {
  if (!useChat.getState().replies[channelId]) return;
  useChat.setState((s) => ({ replies: { ...s.replies, [channelId]: undefined } }));
}

export function composerFocused() {
  useChat.setState({ composerFocus: null });
}

export function startEditing(channelId: string, messageId: string) {
  useChat.setState((s) => ({
    editing: { ...s.editing, [channelId]: messageId },
    editDrafts: { ...s.editDrafts, [channelId]: undefined },
  }));
}

export function stopEditing(channelId: string, messageId?: string): boolean {
  const current = useChat.getState().editing[channelId];
  if (!current || (messageId && current !== messageId)) return false;
  useChat.setState((s) => ({
    editing: { ...s.editing, [channelId]: undefined },
    editDrafts: { ...s.editDrafts, [channelId]: undefined },
  }));
  return true;
}

export function keepEditDraft(channelId: string, text: string) {
  useChat.setState((s) => ({ editDrafts: { ...s.editDrafts, [channelId]: text } }));
}

export function startForward(message: MessageDTO) {
  useChat.setState({ forwarding: message });
}

export function closeForward() {
  useChat.setState({ forwarding: null });
}

export function startDelete(message: MessageDTO) {
  useChat.setState({ deleting: message });
}

export function closeDelete() {
  useChat.setState({ deleting: null });
}

export async function forwardMessage(
  messageId: string,
  channelId: string,
  clientNonce: string,
): Promise<MessageDTO> {
  const { message } = await endpoints.forward(messageId, channelId, clientNonce);
  onMessageEvent(message);
  return message;
}

export interface DeliveredPreview {
  url: string;
  width: number | null;
  height: number | null;
}

interface LocalFile {
  file: File;
  previewUrl: string;
  measured: Promise<void>;
}

const SENT_NOT_SHOWN = 'Sent, but the channel could not be reloaded to show it.';
const FILES_LOST =
  'The page closed before its files finished uploading. Discard this and attach them again.';
const FILES_LOST_SOME =
  'The page closed before its files finished uploading. Send what got through, or discard this and attach them again.';
const FILES_SWEPT_HELD =
  'Its files were on the server for too long without being sent, and were removed. Retry uploads them again.';
const FILES_SWEPT_GONE =
  'Its files were on the server for too long without being sent, and were removed. Discard this and attach them again.';

const uploads = new Map<string, { abort(): void }>();
const localFiles = new Map<string, LocalFile>();
const deliveredPreviews = new Map<string, DeliveredPreview>();
const DELIVERED_PREVIEW_MS = 60_000;
const deliveredTimers = new Set<ReturnType<typeof setTimeout>>();
const NOTICE_MS = 8000;
const noticeTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function localPreviewUrl(fileId: string): string | null {
  return localFiles.get(fileId)?.previewUrl ?? null;
}

export function deliveredPreview(attachmentId: string): DeliveredPreview | null {
  return deliveredPreviews.get(attachmentId) ?? null;
}

function releaseLocalFile(fileId: string) {
  const local = localFiles.get(fileId);
  if (!local) return;
  URL.revokeObjectURL(local.previewUrl);
  localFiles.delete(fileId);
}

function settleLocalFile(file: PendingFile) {
  const local = localFiles.get(file.id);
  if (!local) return;
  const attachmentId = file.attachment?.id;
  if (!attachmentId || file.kind !== 'image') {
    releaseLocalFile(file.id);
    return;
  }
  localFiles.delete(file.id);
  deliveredPreviews.set(attachmentId, {
    url: local.previewUrl,
    width: file.width,
    height: file.height,
  });
  const timer = setTimeout(() => {
    deliveredTimers.delete(timer);
    deliveredPreviews.delete(attachmentId);
    URL.revokeObjectURL(local.previewUrl);
  }, DELIVERED_PREVIEW_MS);
  deliveredTimers.add(timer);
}

function releaseAllLocalFiles() {
  for (const id of [...localFiles.keys()]) releaseLocalFile(id);
  for (const timer of deliveredTimers) clearTimeout(timer);
  deliveredTimers.clear();
  for (const { url } of deliveredPreviews.values()) URL.revokeObjectURL(url);
  deliveredPreviews.clear();
  for (const timer of noticeTimers.values()) clearTimeout(timer);
  noticeTimers.clear();
}

function setTrayNotice(channelId: string, notice: string | undefined) {
  const timer = noticeTimers.get(channelId);
  if (timer) clearTimeout(timer);
  noticeTimers.delete(channelId);
  useChat.setState((s) => ({ trayNotices: { ...s.trayNotices, [channelId]: notice } }));
  if (notice) {
    noticeTimers.set(
      channelId,
      setTimeout(() => setTrayNotice(channelId, undefined), NOTICE_MS),
    );
  }
}

function applyMeasurement(fileId: string, width: number, height: number) {
  useChat.setState((s) => {
    const sized = <T extends OutgoingFile>(files: T[]): T[] =>
      files.map((f) => (f.id === fileId ? { ...f, width, height } : f));
    const trays = Object.fromEntries(
      Object.entries(s.trays).map(([channelId, files]) => [
        channelId,
        files.some((f) => f.id === fileId) ? sized(files) : files,
      ]),
    );
    const pending = Object.fromEntries(
      Object.entries(s.pending).map(([nonce, p]) => [
        nonce,
        p.files?.some((f) => f.id === fileId) ? { ...p, files: sized(p.files) } : p,
      ]),
    );
    return { trays, pending };
  });
}

export function addToTray(channelId: string, files: readonly File[]) {
  const current = useChat.getState().trays[channelId] ?? [];
  const { accepted, refused } = chooseFiles(files, current.length);
  const added = accepted.map(({ file, kind }) => {
    const id = crypto.randomUUID();
    const previewUrl = URL.createObjectURL(file);
    localFiles.set(id, {
      file,
      previewUrl,
      measured: measureLocalMedia(kind, previewUrl).then((size) => {
        if (size) applyMeasurement(id, size.width, size.height);
      }),
    });
    return { id, name: file.name, size: file.size, kind, width: null, height: null };
  });
  if (added.length) {
    useChat.setState((s) => ({
      trays: { ...s.trays, [channelId]: [...(s.trays[channelId] ?? []), ...added] },
    }));
  }
  setTrayNotice(channelId, describeRefusals(refused));
}

export function removeFromTray(channelId: string, fileId: string) {
  useChat.setState((s) => ({
    trays: {
      ...s.trays,
      [channelId]: (s.trays[channelId] ?? []).filter((f) => f.id !== fileId),
    },
  }));
  releaseLocalFile(fileId);
}

const readInFlight = new Map<string, number>();
const readSettled = new Map<string, string>();

export function markChannelRead(channelId: string) {
  const { windows, syncStale } = useChat.getState();
  const w = windows[channelId];
  const channel = useCommunity.getState().channels.find((c) => c.id === channelId);
  if (!w?.loaded || !channel || w.hasNewer || syncStale[channelId]) return;
  const seq = Math.max(newestSeq(w), 0);
  const current = useCommunity.getState().readStates[channelId] ?? 0;
  if (channel.lastMessageSeq <= current) return;
  const attempt = `${seq}:${channel.lastMessageSeq}`;
  if (readInFlight.get(channelId) === seq || readSettled.get(channelId) === attempt) return;
  readInFlight.set(channelId, seq);
  const optimistic = seq > current;
  if (optimistic) {
    useCommunity.setState((s) => ({
      readStates: { ...s.readStates, [channelId]: Math.max(seq, s.readStates[channelId] ?? 0) },
    }));
  }
  endpoints
    .markRead(channelId, seq)
    .then((res) => {
      readSettled.set(channelId, attempt);
      useCommunity.setState((s) => ({
        readStates: {
          ...s.readStates,
          [channelId]: Math.max(res.lastReadSeq, s.readStates[channelId] ?? 0),
        },
      }));
    })
    .catch(() => {
      if (!optimistic) return;
      useCommunity.setState((s) =>
        s.readStates[channelId] === seq
          ? { readStates: { ...s.readStates, [channelId]: current } }
          : s,
      );
    })
    .finally(() => readInFlight.delete(channelId));
}

export function setFollowing(channelId: string, following: boolean) {
  if (useChat.getState().following[channelId] === following) return;
  useChat.setState((s) => ({ following: { ...s.following, [channelId]: following } }));
}

let draftKey: string | null = null;
let pendingKey: string | null = null;
let draftSaveTimer: ReturnType<typeof setTimeout> | null = null;

export function loadDrafts(userId: string) {
  draftKey = `drafts:${userId}`;
  pendingKey = `pending:${userId}`;
  const pending = restorePending(loadJson<unknown>(pendingKey, []));
  useChat.setState({ drafts: loadJson<Record<string, string>>(draftKey, {}), pending });
  const count = Object.keys(pending).length;
  if (count)
    toast(
      count === 1
        ? 'One message was never sent. Open its channel to retry or discard it.'
        : `${count} messages were never sent. Open their channels to retry or discard them.`,
      'error',
    );
}

export function setDraft(channelId: string, text: string) {
  useChat.setState((s) => ({ drafts: { ...s.drafts, [channelId]: text } }));
  if (draftSaveTimer) clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(saveDrafts, 400);
}

function saveDrafts() {
  if (!draftKey) return;
  const drafts = Object.fromEntries(
    Object.entries(useChat.getState().drafts).filter(([, v]) => v.trim()),
  );
  saveJson(draftKey, drafts);
}

export function saveDraftsNow() {
  if (!draftSaveTimer) return;
  clearTimeout(draftSaveTimer);
  draftSaveTimer = null;
  saveDrafts();
}

function flushDrafts() {
  if (draftSaveTimer) {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = null;
  }
  saveDrafts();
  draftKey = null;
}

function savePending() {
  if (!pendingKey) return;
  saveJson(pendingKey, Object.values(useChat.getState().pending));
}

function restorePending(saved: unknown): Record<string, PendingMessage> {
  const out: Record<string, PendingMessage> = {};
  if (!Array.isArray(saved)) return out;
  for (const entry of saved as Partial<PendingMessage>[]) {
    if (
      typeof entry?.nonce !== 'string' ||
      typeof entry.channelId !== 'string' ||
      typeof entry.content !== 'string'
    )
      continue;
    const files = Array.isArray(entry.files) ? entry.files.flatMap(restoreFile) : [];
    if (!entry.content && !files.length) continue;
    const lost = files.some((f) => !f.attachment);
    out[entry.nonce] = {
      nonce: entry.nonce,
      channelId: entry.channelId,
      content: entry.content,
      status: 'failed',
      attempts: RETRY_DELAYS_MS.length,
      createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
      error: lost
        ? entry.error === FILES_SWEPT_HELD || entry.error === FILES_SWEPT_GONE
          ? FILES_SWEPT_GONE
          : filesLost(files)
        : (entry.error ?? 'Not sent before the app was closed.'),
      ...(files.length ? { files } : {}),
      ...restoreReply(entry),
    };
  }
  return out;
}

function restoreReply(saved: Partial<PendingMessage>): Partial<PendingMessage> {
  if (typeof saved.replyToId !== 'string') return {};
  const quote = saved.replyQuote;
  const whole =
    typeof quote?.id === 'string' &&
    typeof quote.seq === 'number' &&
    typeof quote.changeSeq === 'number' &&
    typeof quote.authorId === 'string' &&
    typeof quote.excerpt === 'string' &&
    typeof quote.attachmentCount === 'number' &&
    typeof quote.deleted === 'boolean';
  return { replyToId: saved.replyToId, ...(whole ? { replyQuote: quote } : {}) };
}

function restoreFile(saved: Partial<PendingFile>): PendingFile[] {
  if (
    typeof saved?.id !== 'string' ||
    typeof saved.name !== 'string' ||
    typeof saved.size !== 'number' ||
    (saved.kind !== 'image' && saved.kind !== 'video')
  )
    return [];
  return [
    {
      id: saved.id,
      name: saved.name,
      size: saved.size,
      kind: saved.kind,
      width: typeof saved.width === 'number' ? saved.width : null,
      height: typeof saved.height === 'number' ? saved.height : null,
      attachment: saved.attachment ?? null,
    },
  ];
}
