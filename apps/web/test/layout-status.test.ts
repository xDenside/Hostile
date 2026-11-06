import { describe, expect, it } from 'vitest';
import type { VoiceParticipantDTO } from '@hostile/shared';
import {
  micIndicator,
  ownRoomParticipants,
  presenceDoubt,
  presenceSentence,
  PRESENCE_CONFIRM_TOLERANCE_MS,
  VOICE_NOTICE_WORDS,
  voiceServerNotice,
  withLiveMic,
} from '../src/features/layout/status';

function participant(over: Partial<VoiceParticipantDTO> = {}): VoiceParticipantDTO {
  return {
    userId: 'u1',
    identity: 'u1',
    joinedAt: '2026-01-02T03:04:05.000Z',
    micMuted: false,
    screenSharing: false,
    selfMuted: false,
    selfDeafened: false,
    watching: [],
    ...over,
  };
}

describe('micIndicator', () => {
  it('shows nothing for a participant with a live, unmuted microphone', () => {
    expect(micIndicator(participant())).toBeNull();
  });

  it('shows muted for a self-muted participant and for a muted track', () => {
    expect(micIndicator(participant({ selfMuted: true }))).toBe('muted');
    expect(micIndicator(participant({ micMuted: true }))).toBe('muted');
  });

  it('distinguishes a participant with no microphone published at all', () => {
    expect(micIndicator(participant({ micMuted: null }))).toBe('no-microphone');
  });

  it('keeps self-mute ahead of the no-microphone state', () => {
    expect(micIndicator(participant({ micMuted: null, selfMuted: true }))).toBe('muted');
  });
});

describe('what a notice says', () => {
  it('speaks to someone who has never heard of an API or a voice server', () => {
    for (const words of Object.values(VOICE_NOTICE_WORDS)) {
      expect(words).not.toMatch(/\bAPI\b|voice server/i);
    }
  });
});

describe('voiceServerNotice', () => {
  it('claims nothing before bootstrap has answered', () => {
    expect(voiceServerNotice(false, { mediaReachable: false, checkedAt: null })).toBeNull();
    expect(
      voiceServerNotice(false, { mediaReachable: false, checkedAt: '2026-01-02T03:04:05.000Z' }),
    ).toBeNull();
  });

  it('stays quiet while the voice server is reachable', () => {
    expect(
      voiceServerNotice(true, { mediaReachable: true, checkedAt: '2026-01-02T03:04:05.000Z' }),
    ).toBeNull();
  });

  it('reports a failed probe as unreachable', () => {
    expect(
      voiceServerNotice(true, { mediaReachable: false, checkedAt: '2026-01-02T03:04:05.000Z' }),
    ).toBe('unreachable');
  });

  it('reports a never-probed voice server as unconfirmed rather than unreachable', () => {
    expect(voiceServerNotice(true, { mediaReachable: false, checkedAt: null })).toBe('unconfirmed');
  });
});

describe('ownRoomParticipants', () => {
  const alice = {
    userId: 'alice',
    identity: 'alice',
    joinedAt: null,
    micMuted: false,
    screenSharing: false,
    selfMuted: false,
    selfDeafened: true,
    watching: [],
  };
  const bob = { ...alice, userId: 'bob', identity: 'bob', selfDeafened: false };
  const self = { userId: 'alice', muted: false, deafened: false };
  const remote = { hasMic: true, micMuted: true, screenShare: false };

  it('trusts the API snapshot while it is confirmed', () => {
    expect(ownRoomParticipants([alice, bob], null, self, {})).toEqual([alice, bob]);
  });

  it('drops someone the room no longer has once the snapshot is in doubt', () => {
    expect(ownRoomParticipants([alice, bob], 'unreachable', self, {})).toEqual([alice]);
  });

  it('adds someone who joined during the outage, from what the room knows', () => {
    const list = ownRoomParticipants([alice], 'unreachable', self, { carol: remote });
    expect(list.map((p) => p.userId)).toEqual(['alice', 'carol']);
    expect(list[1]).toMatchObject({ micMuted: true, screenSharing: false, selfDeafened: false });
    expect(list[0]).toBe(alice);
  });
});

describe('presenceDoubt', () => {
  const confirmedAt = '2026-01-02T03:04:05.000Z';
  const at = (msAfter: number) => new Date(Date.parse(confirmedAt) + msAfter).toISOString();
  const fresh = { mediaReachable: true, checkedAt: at(10), roomsConfirmedAt: confirmedAt };

  it('claims nothing before bootstrap has answered', () => {
    expect(
      presenceDoubt(false, { mediaReachable: false, checkedAt: null, roomsConfirmedAt: null }),
    ).toBeNull();
  });

  it('trusts a snapshot the server confirmed on its last pass', () => {
    expect(presenceDoubt(true, fresh)).toBeNull();
  });

  it('doubts everything while the API cannot reach the voice server', () => {
    expect(presenceDoubt(true, { ...fresh, mediaReachable: false })).toBe('unreachable');
    expect(
      presenceDoubt(true, { mediaReachable: false, checkedAt: null, roomsConfirmedAt: null }),
    ).toBeNull();
  });

  it('doubts a snapshot the server has been failing to confirm', () => {
    expect(presenceDoubt(true, { ...fresh, checkedAt: at(PRESENCE_CONFIRM_TOLERANCE_MS) })).toBe(
      null,
    );
    expect(
      presenceDoubt(true, { ...fresh, checkedAt: at(PRESENCE_CONFIRM_TOLERANCE_MS + 1) }),
    ).toBe('stale');
  });

  it('treats a missing or unusable confirmation time as stale', () => {
    expect(presenceDoubt(true, { ...fresh, roomsConfirmedAt: null })).toBe('stale');
    expect(presenceDoubt(true, { ...fresh, roomsConfirmedAt: 'not a date' })).toBe('stale');
  });
});

describe('presenceSentence', () => {
  it('speaks in the present tense about a confirmed snapshot', () => {
    expect(presenceSentence(['Alice'], null)).toBe('Alice is in this channel.');
    expect(presenceSentence(['Alice', 'Bob'], null)).toBe('Alice, Bob are in this channel.');
    expect(presenceSentence([], null)).toBe('Nobody is here yet.');
  });

  it('drops to the past tense when presence is in doubt', () => {
    expect(presenceSentence(['Alice'], 'unreachable')).toBe('Alice was last seen in this channel.');
    expect(presenceSentence(['Alice', 'Bob'], 'stale')).toBe(
      'Alice, Bob were last seen in this channel.',
    );
    expect(presenceSentence([], 'unreachable')).toBe(
      'Nobody was here when the voice server last answered.',
    );
  });
});

describe('withLiveMic', () => {
  const me = { userId: 'alice', muted: false, deafened: false, micPublished: true };
  const live = { hasMic: true, micMuted: false, screenShare: false };

  it('shows the viewer as unmuted the moment they unmute, whatever the API still says', () => {
    const stale = participant({ userId: 'alice', micMuted: true, selfMuted: true });
    expect(micIndicator(stale)).toBe('muted');
    expect(micIndicator(withLiveMic(stale, me, {}))).toBeNull();
  });

  it('follows the viewer into mute and deafen', () => {
    const p = participant({ userId: 'alice', micMuted: false });
    expect(micIndicator(withLiveMic(p, { ...me, muted: true }, {}))).toBe('muted');
    expect(withLiveMic(p, { ...me, muted: true, deafened: true }, {}).selfDeafened).toBe(true);
  });

  it('says "no microphone" for a viewer who published none', () => {
    const p = participant({ userId: 'alice', micMuted: false });
    expect(micIndicator(withLiveMic(p, { ...me, micPublished: false }, {}))).toBe('no-microphone');
  });

  it('trusts the live track over an older snapshot for other people', () => {
    const stale = participant({ userId: 'bob', micMuted: true, selfMuted: true });
    expect(micIndicator(withLiveMic(stale, me, { bob: live }))).toBeNull();
    expect(micIndicator(withLiveMic(stale, me, { bob: { ...live, micMuted: true } }))).toBe(
      'muted',
    );
  });

  it('keeps the snapshot for someone this client has no live view of', () => {
    const p = participant({ userId: 'carol', micMuted: true });
    expect(withLiveMic(p, me, {})).toBe(p);
  });
});
