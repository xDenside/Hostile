import { describe, expect, it } from 'vitest';
import { BRAND } from '../src/brand.js';
import { channelIdFromRoomName, voiceRoomName } from '../src/voice-room.js';

const CHANNEL_ID = '0192d5b0-1111-7000-8000-000000000042';

describe('voice room names', () => {
  it('derives the room name from the channel id', () => {
    expect(voiceRoomName(CHANNEL_ID)).toBe(`${BRAND.slug}-ch-${CHANNEL_ID}`);
  });

  it('round-trips through channelIdFromRoomName', () => {
    expect(channelIdFromRoomName(voiceRoomName(CHANNEL_ID))).toBe(CHANNEL_ID);
  });

  it('returns null for room names that are not ours', () => {
    for (const foreign of [
      'some-other-room',
      `x-${BRAND.slug}-ch-${CHANNEL_ID}`,
      `${BRAND.slug}-${CHANNEL_ID}`,
      `${BRAND.slug.toUpperCase()}-ch-${CHANNEL_ID}`,
      '',
    ]) {
      expect(channelIdFromRoomName(foreign)).toBeNull();
    }
  });

  it('returns an empty (falsy) id for the bare prefix', () => {
    expect(channelIdFromRoomName(`${BRAND.slug}-ch-`)).toBe('');
  });
});
