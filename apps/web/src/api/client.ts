import type {
  AdminUserDTO,
  ArchivedChannelDTO,
  AttachmentDTO,
  BootstrapDTO,
  ChangesDTO,
  ChannelDTO,
  CreateChannelRequest,
  HealthDTO,
  MessageDTO,
  MessagePageDTO,
  ProfileMediaKind,
  PublicConfigDTO,
  JoinAskResponse,
  JoinRequestDTO,
  JoinStatus,
  SessionInfoDTO,
  SelfUser,
  SendMessageResponse,
  UpdateChannelRequest,
  UpdateProfileRequest,
  UserPublic,
  VoiceTokenDTO,
} from '@hostile/shared';
import { platform } from '../platform';
import { isGuestBuild } from '../tunnel/net';
import { TunnelXhr } from '../tunnel/xhr';
import { ApiError, requestJson } from './http';

export { ApiError };

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export async function api<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const p = platform();
  const send = () =>
    requestJson<T>(`${p.apiBase()}${path}`, {
      method,
      credentials: p.kind === 'web' ? 'same-origin' : 'omit',
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...p.authHeaders(method),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  try {
    return await send();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && (await p.recoverFromUnauthorized()))
      return send();
    throw err;
  }
}

async function upload<T>(path: string, file: Blob): Promise<T> {
  const p = platform();
  const send = () =>
    requestJson<T>(`${p.apiBase()}${path}`, {
      method: 'PUT',
      credentials: p.kind === 'web' ? 'same-origin' : 'omit',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        ...p.authHeaders('PUT'),
      },
      body: file,
      timeoutMs: 120_000,
    });
  try {
    return await send();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && (await p.recoverFromUnauthorized()))
      return send();
    throw err;
  }
}

export const UPLOAD_CUT_OFF =
  'The connection was lost during the upload. Check your connection and try again.';
export const UPLOAD_STALLED = 'The upload stopped moving. Check your connection and try again.';

const UPLOAD_STALL_MS = 150_000;

export class UploadCanceled extends Error {
  constructor() {
    super('The upload was canceled.');
    this.name = 'UploadCanceled';
  }
}

export interface AttachmentUpload {
  promise: Promise<AttachmentDTO>;
  abort(): void;
}

export function uploadAttachment(
  channelId: string,
  file: Blob,
  details: { name?: string; width?: number | null; height?: number | null },
  onProgress: (percent: number) => void,
): AttachmentUpload {
  const query = [
    details.name ? `name=${enc(details.name)}` : null,
    details.width ? `width=${Math.round(details.width)}` : null,
    details.height ? `height=${Math.round(details.height)}` : null,
  ]
    .filter(Boolean)
    .join('&');
  const p = platform();
  const url = `${p.apiBase()}/api/channels/${enc(channelId)}/attachments${query ? `?${query}` : ''}`;
  let current: XMLHttpRequest | null = null;
  let canceled = false;

  const attempt = () =>
    new Promise<AttachmentDTO>((resolve, reject) => {
      const xhr = isGuestBuild()
        ? (new TunnelXhr() as unknown as XMLHttpRequest)
        : new XMLHttpRequest();
      current = xhr;
      let stalled = false;
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      const watchForStall = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          stalled = true;
          xhr.abort();
        }, UPLOAD_STALL_MS);
      };
      xhr.open('POST', url);
      const headers: Record<string, string> = {
        'Content-Type': file.type || 'application/octet-stream',
        ...p.authHeaders('POST'),
      };
      for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
      xhr.upload.onprogress = (e) => {
        watchForStall();
        if (e.lengthComputable && e.total > 0) onProgress(Math.floor((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        clearTimeout(stallTimer);
        let body: unknown = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {}
        if (xhr.status >= 200 && xhr.status < 300) {
          const attachment = (body as { attachment?: AttachmentDTO } | null)?.attachment;
          if (attachment) resolve(attachment);
          else reject(new ApiError(xhr.status, 'unknown', 'The server sent an unexpected answer.'));
        } else {
          reject(ApiError.from(xhr.status, body));
        }
      };
      xhr.onerror = () => {
        clearTimeout(stallTimer);
        reject(new ApiError(0, 'network_error', UPLOAD_CUT_OFF));
      };
      xhr.onabort = () => {
        clearTimeout(stallTimer);
        reject(stalled ? new ApiError(0, 'network_error', UPLOAD_STALLED) : new UploadCanceled());
      };
      watchForStall();
      xhr.send(file);
    });

  const promise = attempt().catch(async (err: unknown) => {
    if (err instanceof ApiError && err.status === 401 && (await p.recoverFromUnauthorized())) {
      if (canceled) throw new UploadCanceled();
      return attempt();
    }
    throw err;
  });

  return {
    promise,
    abort() {
      canceled = true;
      current?.abort();
    },
  };
}

export function mediaUrl(path: string): string {
  if (path.startsWith('blob:')) return path;
  return `${platform().apiBase()}${path}`;
}

const enc = encodeURIComponent;

export const endpoints = {
  publicConfig: (base = platform().apiBase()) =>
    requestJson<PublicConfigDTO>(`${base}/api/public-config`, { timeoutMs: 8000 }),
  health: () => requestJson<HealthDTO>(`${platform().apiBase()}/api/health`, { timeoutMs: 8000 }),
  bootstrap: () => api<BootstrapDTO>('GET', '/api/bootstrap'),

  history: (channelId: string, before?: number, limit = 50) =>
    api<MessagePageDTO>(
      'GET',
      `/api/channels/${enc(channelId)}/messages?limit=${limit}${before ? `&before=${before}` : ''}`,
    ),
  changes: (channelId: string, since: number) =>
    api<ChangesDTO>('GET', `/api/channels/${enc(channelId)}/changes?since=${since}`),
  send: (
    channelId: string,
    content: string,
    clientNonce: string,
    attachmentIds?: string[],
    replyToId?: string,
  ) =>
    api<SendMessageResponse>('POST', `/api/channels/${enc(channelId)}/messages`, {
      content,
      clientNonce,
      ...(attachmentIds?.length ? { attachmentIds } : {}),
      ...(replyToId ? { replyToId } : {}),
    }),
  forward: (messageId: string, channelId: string, clientNonce: string) =>
    api<SendMessageResponse>('POST', `/api/messages/${enc(messageId)}/forward`, {
      channelId,
      clientNonce,
    }),
  removeAttachment: (id: string) => api<void>('DELETE', `/api/attachments/${enc(id)}`),
  edit: (messageId: string, content: string) =>
    api<{ message: MessageDTO }>('PATCH', `/api/messages/${enc(messageId)}`, { content }),
  remove: (messageId: string) =>
    api<{ message: MessageDTO }>('DELETE', `/api/messages/${enc(messageId)}`),
  markRead: (channelId: string, seq: number) =>
    api<{ channelId: string; lastReadSeq: number }>(
      'POST',
      `/api/channels/${enc(channelId)}/read`,
      { seq },
    ),

  voiceToken: (channelId: string) => api<VoiceTokenDTO>('POST', '/api/voice/token', { channelId }),

  updateProfile: (req: UpdateProfileRequest) =>
    api<{ user: SelfUser }>('PATCH', '/api/auth/profile', req),
  uploadProfileMedia: (kind: ProfileMediaKind, file: Blob) =>
    upload<{ user: SelfUser }>(`/api/auth/profile/media/${kind}`, file),
  removeProfileMedia: (kind: ProfileMediaKind) =>
    api<{ user: SelfUser }>('DELETE', `/api/auth/profile/media/${kind}`),
  logoutOthers: () => api<{ revoked: number }>('POST', '/api/auth/logout-others', {}),
  sessions: () => api<{ sessions: SessionInfoDTO[] }>('GET', '/api/auth/sessions'),
  revokeSession: (id: string) => api<void>('DELETE', `/api/auth/sessions/${enc(id)}`),
  leave: () => api<void>('POST', '/api/auth/leave', {}),

  join: {
    ask: (nickname: string, picture: boolean) =>
      api<JoinAskResponse>('POST', '/api/join', { nickname, picture }),
    picture: (ticket: string, file: Blob) => upload<void>(`/api/join/${enc(ticket)}/picture`, file),
    status: (ticket: string) => api<JoinStatus>('GET', `/api/join/${enc(ticket)}`),
    cancel: (ticket: string) => api<void>('DELETE', `/api/join/${enc(ticket)}`),
  },

  admin: {
    joinRequests: () => api<{ requests: JoinRequestDTO[] }>('GET', '/api/admin/join-requests'),
    letIn: (id: string) => api<void>('POST', `/api/admin/join-requests/${enc(id)}/let-in`, {}),
    turnAway: (id: string) =>
      api<void>('POST', `/api/admin/join-requests/${enc(id)}/turn-away`, {}),
    users: () => api<{ users: AdminUserDTO[] }>('GET', '/api/admin/users'),
    removeUser: (id: string) =>
      api<{ user: UserPublic }>('POST', `/api/admin/users/${enc(id)}/remove`, {}),
    createChannel: (req: CreateChannelRequest) =>
      api<{ channel: ChannelDTO }>('POST', '/api/admin/channels', req),
    updateChannel: (id: string, req: UpdateChannelRequest) =>
      api<{ channel: ChannelDTO }>('PATCH', `/api/admin/channels/${enc(id)}`, req),
    reorderChannels: (channelIds: string[]) =>
      api<{ channels: ChannelDTO[] }>('PUT', '/api/admin/channels/order', { channelIds }),
    archiveChannel: (id: string) => api<void>('DELETE', `/api/admin/channels/${enc(id)}`),
    archivedChannels: () =>
      api<{ channels: ArchivedChannelDTO[] }>('GET', '/api/admin/channels/archived'),
    restoreChannel: (id: string) =>
      api<{ channel: ChannelDTO }>('POST', `/api/admin/channels/${enc(id)}/restore`, {}),
  },
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}
