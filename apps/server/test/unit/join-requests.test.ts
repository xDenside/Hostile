import { describe, expect, it, vi } from 'vitest';
import {
  JoinRequests,
  MAX_PENDING_REQUESTS,
  REQUEST_LIFETIME_MS,
} from '../../src/auth/join-requests.js';

function requests() {
  let now = 1_000_000;
  const list = new JoinRequests(() => now);
  return { list, advance: (ms: number) => (now += ms) };
}
const ask = (list: JoinRequests, address: string, nickname = 'Sam', picture = false) =>
  list.ask({ nickname, address, picture });
const picture = () => ({ bytes: Buffer.from('image'), contentType: 'image/png' });

describe('people asking to join', () => {
  it('holds one request per connection, however often it asks', () => {
    const { list } = requests();
    for (let i = 0; i < 50; i++) ask(list, 'one-connection', `name ${i}`);
    expect(list.list().map((r) => r.nickname)).toEqual(['name 49']);
  });

  it('refuses past the cap, and honest people stop counting once they stop looking', () => {
    const { list, advance } = requests();
    for (let i = 0; i < MAX_PENDING_REQUESTS; i++) ask(list, `address ${i}`);
    expect(() => ask(list, 'one more')).toThrowError(/Too many people are waiting/);
    advance(91_000);
    expect(ask(list, 'one more').ticket).toBeTruthy();
    expect(list.list()).toHaveLength(1);
  });

  it('keeps a request alive for someone who keeps looking, up to its lifetime', () => {
    const { list, advance } = requests();
    const { ticket } = ask(list, 'a');
    for (let at = 0; at < REQUEST_LIFETIME_MS - 60_000; at += 60_000) {
      advance(60_000);
      expect(list.look(ticket)?.kind).toBe('waiting');
      list.sweep();
    }
    advance(120_000);
    list.look(ticket);
    list.sweep();
    expect(list.look(ticket)).toBeNull();
  });

  it('shows a promised picture with the request, and shows the request without one if it never comes', () => {
    const { list, advance } = requests();
    const asked = vi.fn();
    list.events.on('asked', asked);
    const first = ask(list, 'a', 'With picture', true);
    expect(list.list()).toHaveLength(0);
    list.setPicture(first.ticket, picture());
    expect(list.list()[0]!.pictureUrl).toMatch(/^\/api\/join-pictures\//);
    const second = ask(list, 'b', 'Never sent', true);
    expect(list.expectsPicture(second.ticket)).toBe(true);
    advance(31_000);
    list.look(second.ticket);
    list.look(first.ticket);
    list.sweep();
    expect(list.list().map((r) => r.nickname)).toEqual(['With picture', 'Never sent']);
    expect(asked).toHaveBeenCalledTimes(2);
  });

  it('lets go of the picture when turned away, and says so to whoever looks', () => {
    const { list } = requests();
    const { ticket, id } = ask(list, 'a', 'Sam', true);
    list.setPicture(ticket, picture());
    const key = list.list()[0]!.pictureUrl!.split('/').pop()!;
    expect(list.picture(key)).not.toBeNull();
    list.turnAway(id);
    expect(list.picture(key)).toBeNull();
    expect(list.look(ticket)?.kind).toBe('turned-away');
    expect(list.list()).toHaveLength(0);
  });

  it('answers a second look with the same token, so a lost answer costs nothing', () => {
    const { list, advance } = requests();
    const { ticket, id } = ask(list, 'a');
    list.admitted(id, { token: 'the-token', sessionId: 's', userId: 'u' });
    const first = list.look(ticket);
    const second = list.look(ticket);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ kind: 'admitted', token: 'the-token' });
    advance(11 * 60_000);
    list.sweep();
    expect(list.look(ticket)).toBeNull();
  });

  it('cannot answer anyone twice, or someone unknown', () => {
    const { list } = requests();
    const { id } = ask(list, 'a');
    list.turnAway(id);
    expect(() => list.turnAway(id)).toThrowError();
    expect(() => list.claim('no such id')).toThrowError();
  });
});
