import { BRAND } from './brand.js';

const ROOM_PREFIX = `${BRAND.slug}-ch-`;

export function voiceRoomName(channelId: string): string {
  return `${ROOM_PREFIX}${channelId}`;
}

export function channelIdFromRoomName(roomName: string): string | null {
  return roomName.startsWith(ROOM_PREFIX) ? roomName.slice(ROOM_PREFIX.length) : null;
}
