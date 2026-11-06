import { createHash, randomUUID } from 'node:crypto';
import { AccessToken, TokenVerifier, type ClaimGrants } from 'livekit-server-sdk';

export async function signWebhook(
  apiKey: string,
  apiSecret: string,
  body: string,
): Promise<string> {
  const token = new AccessToken(apiKey, apiSecret, { ttl: 60 });
  token.sha256 = createHash('sha256').update(body).digest('base64');
  return token.toJwt();
}

export function verifyVoiceToken(
  apiKey: string,
  apiSecret: string,
  token: string,
): Promise<ClaimGrants> {
  return new TokenVerifier(apiKey, apiSecret).verify(token);
}

export interface FakeTrack {
  source: 'MICROPHONE' | 'SCREEN_SHARE' | 'SCREEN_SHARE_AUDIO' | 'CAMERA';
  muted?: boolean;
}

export interface FakeParticipant {
  identity: string;
  name?: string;
  joinedAtMs?: number;
  tracks?: FakeTrack[];
}

export function webhookBody(
  event: 'participant_joined' | 'participant_left' | 'room_finished',
  roomName: string,
  participant?: FakeParticipant,
): string {
  const nowSec = Math.floor(Date.now() / 1000);
  return JSON.stringify({
    event,
    id: `EV_${randomUUID()}`,
    createdAt: String(nowSec),
    room: {
      sid: `RM_${randomUUID().slice(0, 12)}`,
      name: roomName,
      creationTime: String(nowSec),
      numParticipants: participant ? 1 : 0,
    },
    ...(participant
      ? {
          participant: {
            sid: `PA_${randomUUID().slice(0, 12)}`,
            identity: participant.identity,
            name: participant.name ?? participant.identity,
            state: 'ACTIVE',
            joinedAtMs: String(participant.joinedAtMs ?? Date.now()),
            tracks: (participant.tracks ?? []).map((t, i) => ({
              sid: `TR_${i}_${randomUUID().slice(0, 8)}`,
              source: t.source,
              muted: t.muted ?? false,
            })),
          },
        }
      : {}),
  });
}
