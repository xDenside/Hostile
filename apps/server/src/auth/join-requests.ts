import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { JoinRequestDTO } from '@hostile/shared';
import { errors } from '../lib/errors.js';
import { randomToken } from './crypto.js';

export const MAX_PENDING_REQUESTS = 20;
const NOT_LOOKING_MS = 90_000;
export const REQUEST_LIFETIME_MS = 30 * 60_000;
const PICTURE_WAIT_MS = 30_000;
const ANSWER_KEPT_MS = 10 * 60_000;
const SWEEP_EVERY_MS = 5_000;

export interface JoinPicture {
  bytes: Buffer;
  contentType: string;
}

type Answer =
  | { kind: 'waiting' }
  | { kind: 'turned-away'; at: number }
  | { kind: 'admitted'; at: number; token: string; sessionId: string; userId: string };

interface Pending {
  id: string;
  ticket: string;
  nickname: string;
  address: string;
  userAgent: string | undefined;
  deviceKey: string | undefined;
  picture: JoinPicture | null;
  pictureKey: string;
  picturePromised: boolean;
  askedAt: number;
  lastLooked: number;
  answer: Answer;
}

export interface JoinRequestEvents {
  changed: [];
  asked: [{ nickname: string }];
}

export class JoinRequests {
  readonly events = new EventEmitter<JoinRequestEvents>();
  private readonly byTicket = new Map<string, Pending>();
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(private readonly now: () => number = Date.now) {}

  start() {
    this.sweeper ??= setInterval(() => this.sweep(), SWEEP_EVERY_MS);
    this.sweeper.unref();
  }

  stop() {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    this.byTicket.clear();
  }

  ask(input: {
    nickname: string;
    address: string;
    userAgent?: string;
    deviceKey?: string;
    picture: boolean;
  }) {
    if (this.closed) throw errors.joinClosed();
    this.sweep();
    for (const other of this.byTicket.values()) {
      if (other.address === input.address && other.answer.kind === 'waiting')
        this.byTicket.delete(other.ticket);
    }
    const waiting = [...this.byTicket.values()].filter((p) => p.answer.kind === 'waiting');
    if (waiting.length >= MAX_PENDING_REQUESTS) throw errors.joinQueueFull();
    const now = this.now();
    const request: Pending = {
      id: randomUUID(),
      ticket: randomToken(32),
      nickname: input.nickname,
      address: input.address,
      userAgent: input.userAgent,
      deviceKey: input.deviceKey,
      picture: null,
      pictureKey: randomUUID(),
      picturePromised: input.picture,
      askedAt: now,
      lastLooked: now,
      answer: { kind: 'waiting' },
    };
    this.byTicket.set(request.ticket, request);
    if (!input.picture) this.announce(request);
    return { ticket: request.ticket, id: request.id };
  }

  private announce(request: Pending) {
    this.events.emit('asked', { nickname: request.nickname });
    this.events.emit('changed');
  }

  expectsPicture(ticket: string) {
    const request = this.byTicket.get(ticket);
    return !!request && request.answer.kind === 'waiting' && request.picturePromised;
  }

  setPicture(ticket: string, picture: JoinPicture) {
    const request = this.byTicket.get(ticket);
    if (!request || request.answer.kind !== 'waiting' || !request.picturePromised)
      throw errors.notFound('Request');
    request.picture = picture;
    request.picturePromised = false;
    this.announce(request);
  }

  look(ticket: string): Answer | null {
    const request = this.byTicket.get(ticket);
    if (!request) return null;
    request.lastLooked = this.now();
    return request.answer;
  }

  cancel(ticket: string) {
    const request = this.byTicket.get(ticket);
    if (!request) return;
    this.byTicket.delete(ticket);
    if (request.answer.kind === 'waiting') this.events.emit('changed');
  }

  list(): JoinRequestDTO[] {
    return [...this.byTicket.values()]
      .filter((r) => r.answer.kind === 'waiting' && !r.picturePromised)
      .sort((a, b) => a.askedAt - b.askedAt)
      .map((r) => ({
        id: r.id,
        nickname: r.nickname,
        pictureUrl: r.picture ? `/api/join-pictures/${r.pictureKey}` : null,
        askedAt: new Date(r.askedAt).toISOString(),
      }));
  }

  picture(pictureKey: string): JoinPicture | null {
    for (const request of this.byTicket.values()) {
      if (request.pictureKey === pictureKey && request.answer.kind === 'waiting')
        return request.picture;
    }
    return null;
  }

  private waitingById(id: string) {
    for (const request of this.byTicket.values()) {
      if (request.id === id && request.answer.kind === 'waiting') return request;
    }
    throw errors.notFound('Request');
  }

  get isClosed() {
    return this.closed;
  }

  setClosed(closed: boolean) {
    this.closed = closed;
    if (!closed) return;
    const now = this.now();
    for (const request of this.byTicket.values()) {
      if (request.answer.kind !== 'waiting') continue;
      request.picture = null;
      request.answer = { kind: 'turned-away', at: now };
    }
    this.events.emit('changed');
  }

  private readonly claimed = new Set<string>();

  claim(id: string) {
    const { nickname, picture, userAgent, deviceKey } = this.waitingById(id);
    if (this.claimed.has(id)) throw errors.notFound('Request');
    this.claimed.add(id);
    return { nickname, picture, userAgent, deviceKey };
  }

  release(id: string) {
    this.claimed.delete(id);
  }

  admitted(id: string, result: { token: string; sessionId: string; userId: string }) {
    this.claimed.delete(id);
    const request = this.waitingById(id);
    request.picture = null;
    request.answer = { kind: 'admitted', at: this.now(), ...result };
    this.events.emit('changed');
  }

  turnAway(id: string) {
    const request = this.waitingById(id);
    if (this.claimed.has(id)) throw errors.notFound('Request');
    request.picture = null;
    request.answer = { kind: 'turned-away', at: this.now() };
    this.events.emit('changed');
  }

  size() {
    return this.byTicket.size;
  }

  sweep() {
    const now = this.now();
    let changed = false;
    for (const request of this.byTicket.values()) {
      const { answer } = request;
      if (answer.kind !== 'waiting') {
        if (now - answer.at > ANSWER_KEPT_MS) this.byTicket.delete(request.ticket);
        continue;
      }
      if (
        now - request.lastLooked > NOT_LOOKING_MS ||
        now - request.askedAt > REQUEST_LIFETIME_MS
      ) {
        this.byTicket.delete(request.ticket);
        changed = true;
      } else if (request.picturePromised && now - request.askedAt > PICTURE_WAIT_MS) {
        request.picturePromised = false;
        this.announce(request);
      }
    }
    if (changed) this.events.emit('changed');
  }
}
