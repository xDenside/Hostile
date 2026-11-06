import type { ServerToClientEvents } from '@hostile/shared';

export interface RealtimeEmitter {
  toCommunity<E extends keyof ServerToClientEvents>(
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void;
  toOwner<E extends keyof ServerToClientEvents>(
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void;
  toUser<E extends keyof ServerToClientEvents>(
    userId: string,
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void;
  endSessions(
    sessionIds: string[],
    reason: Parameters<ServerToClientEvents['session:ended']>[0]['reason'],
  ): void;
  isOnline(userId: string): boolean;
  onlineUserIds(): string[];
}

export class NullEmitter implements RealtimeEmitter {
  toCommunity() {}
  toOwner() {}
  toUser() {}
  endSessions() {}
  isOnline() {
    return false;
  }
  onlineUserIds() {
    return [];
  }
}
