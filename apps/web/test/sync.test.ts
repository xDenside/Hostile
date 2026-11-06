import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  type AttachmentDTO,
  type ChangesDTO,
  type MessageDTO,
  type MessagePageDTO,
  type MessageQuoteDTO,
} from '@hostile/shared';
import {
  applyChanges,
  applyEvent,
  applyJumpPage,
  applyLatestPage,
  applyOlderPage,
  emptyWindow,
  enforceCap,
  newestSeq,
  patchQuote,
  patchQuotes,
  quoteOf,
  quoteSummary,
  type ChannelWindow,
} from '../src/features/chat/sync';

const CHANNEL = '0192d5b0-1111-7000-8000-000000000001';

function msg(seq: number, changeSeq = seq, over: Partial<MessageDTO> = {}): MessageDTO {
  return {
    id: `m${seq}`,
    channelId: CHANNEL,
    authorId: 'u1',
    content: `message ${seq}`,
    seq,
    changeSeq,
    clientNonce: `n${seq}`,
    createdAt: '2026-01-02T03:04:05.000Z',
    editedAt: null,
    deleted: false,
    attachments: [],
    replyTo: null,
    forwardedFrom: null,
    ...over,
  };
}

function deleted(seq: number, changeSeq: number): MessageDTO {
  return msg(seq, changeSeq, { content: '', deleted: true });
}

function page(messages: MessageDTO[], syncSeq: number, hasOlder = false): MessagePageDTO {
  return { messages, hasOlder, syncSeq };
}

function changes(list: MessageDTO[], syncSeq: number, reset = false): ChangesDTO {
  return { changes: list, syncSeq, reset };
}

function ids(w: ChannelWindow): string[] {
  return w.messages.map((m) => m.id);
}

function contentOf(w: ChannelWindow, id: string): string | undefined {
  return w.messages.find((m) => m.id === id)?.content;
}

function applied(result: ChannelWindow | 'reset'): ChannelWindow {
  if (result === 'reset') throw new Error('expected the changes to be applied, not a reset');
  return result;
}

function loaded(): ChannelWindow {
  return applyLatestPage(emptyWindow(), page([msg(1), msg(2), msg(3)], 3));
}

describe('applyLatestPage', () => {
  it('replaces the window and adopts the page snapshot as syncSeq', () => {
    const w = loaded();
    expect(ids(w)).toEqual(['m1', 'm2', 'm3']);
    expect(w.syncSeq).toBe(3);
    expect(w.loaded).toBe(true);
    expect(w.hasOlder).toBe(false);
    expect(w.hasNewer).toBe(false);
    expect(w.needsResync).toBe(false);
    expect(w.aheadSeqs).toEqual([]);
    expect(w.queued).toEqual([]);
  });

  it('carries hasOlder from the page and discards a previous window', () => {
    const stale = applyLatestPage(emptyWindow(), page([msg(90), msg(91)], 91, true));
    const fresh = applyLatestPage(stale, page([msg(1), msg(2)], 2, false));
    expect(ids(fresh)).toEqual(['m1', 'm2']);
    expect(fresh.hasOlder).toBe(false);
    expect(fresh.syncSeq).toBe(2);
  });

  it('replays events that arrived before the first page', () => {
    let w = applyEvent(emptyWindow(), msg(4));
    expect(w.messages).toEqual([]);
    expect(w.queued).toHaveLength(1);

    w = applyLatestPage(w, page([msg(1), msg(2), msg(3)], 3));
    expect(ids(w)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(w.syncSeq).toBe(4);
    expect(w.needsResync).toBe(false);
  });

  it('treats a queued event already contained in the page as a no-op', () => {
    let w = applyEvent(emptyWindow(), msg(3));
    w = applyLatestPage(w, page([msg(1), msg(2), msg(3)], 3));
    expect(ids(w)).toEqual(['m1', 'm2', 'm3']);
    expect(w.syncSeq).toBe(3);
    expect(w.needsResync).toBe(false);
  });

  it('asks for a resync when the page is older than what the window already applied', () => {
    const trimmed = enforceCap(loaded(), false, 2);
    expect(trimmed.hasNewer).toBe(true);
    const ahead = applyEvent(trimmed, msg(4));
    expect(ahead.syncSeq).toBe(4);

    const w = applyLatestPage(ahead, page([msg(2), msg(3)], 3, true));
    expect(w.syncSeq).toBe(3);
    expect(w.needsResync).toBe(true);
  });

  it('asks for a resync when the page cannot account for a change seen above a gap', () => {
    const ahead = applyEvent(loaded(), msg(6));
    expect(ahead.aheadSeqs).toEqual([6]);

    const w = applyLatestPage(ahead, page([msg(1), msg(2), msg(3)], 3));
    expect(w.syncSeq).toBe(3);
    expect(w.needsResync).toBe(true);
  });

  it('does not ask for a resync for a page at or ahead of the window', () => {
    expect(applyLatestPage(loaded(), page([msg(3), msg(4)], 4, true)).needsResync).toBe(false);
    expect(applyLatestPage(loaded(), page([msg(1), msg(2), msg(3)], 3)).needsResync).toBe(false);
    expect(applyLatestPage(emptyWindow(), page([msg(1)], 1)).needsResync).toBe(false);
  });
});

describe('applyEvent: syncSeq bookkeeping', () => {
  it('advances syncSeq for the very next change', () => {
    const w = applyEvent(loaded(), msg(4));
    expect(w.syncSeq).toBe(4);
    expect(w.aheadSeqs).toEqual([]);
    expect(w.needsResync).toBe(false);
  });

  it('applies an event above a gap but does not advance syncSeq', () => {
    const w = applyEvent(loaded(), msg(6));
    expect(ids(w)).toEqual(['m1', 'm2', 'm3', 'm6']);
    expect(w.syncSeq).toBe(3);
    expect(w.aheadSeqs).toEqual([6]);
    expect(w.needsResync).toBe(true);
  });

  it('advances past a whole waiting run once the gap is filled', () => {
    let w = applyEvent(loaded(), msg(6));
    w = applyEvent(w, msg(5));
    expect(w.syncSeq).toBe(3);
    expect(w.aheadSeqs).toEqual([5, 6]);

    w = applyEvent(w, msg(4));
    expect(w.syncSeq).toBe(6);
    expect(w.aheadSeqs).toEqual([]);
    expect(w.needsResync).toBe(false);
    expect(ids(w)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
  });

  it('stays blocked while only part of the gap is filled', () => {
    let w = applyEvent(loaded(), msg(7));
    w = applyEvent(w, msg(4));
    expect(w.syncSeq).toBe(4);
    expect(w.aheadSeqs).toEqual([7]);
    expect(w.needsResync).toBe(true);
  });

  it('is idempotent for a redelivered event', () => {
    let w = applyEvent(loaded(), msg(4));
    w = applyEvent(w, msg(4));
    w = applyEvent(w, msg(4));
    expect(ids(w)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(w.syncSeq).toBe(4);
    expect(w.aheadSeqs).toEqual([]);
  });

  it('does not queue duplicate ahead entries', () => {
    let w = applyEvent(loaded(), msg(6));
    w = applyEvent(w, msg(6, 6, { content: 'resent' }));
    expect(w.aheadSeqs).toEqual([6]);
  });
});

describe('applyEvent: newest state wins', () => {
  it('never lets an older version overwrite a newer one', () => {
    let w = loaded();
    w = applyEvent(w, msg(2, 5, { content: 'v3', editedAt: '2026-01-02T03:10:00.000Z' }));
    expect(contentOf(w, 'm2')).toBe('v3');

    w = applyEvent(w, msg(2, 4, { content: 'v2', editedAt: '2026-01-02T03:06:00.000Z' }));
    expect(contentOf(w, 'm2')).toBe('v3');
    expect(w.syncSeq).toBe(5);
    expect(w.needsResync).toBe(false);
  });

  it('ignores a re-delivery of the version already held', () => {
    let w = loaded();
    w = applyEvent(w, msg(2, 4, { content: 'edited' }));
    const before = w;
    w = applyEvent(w, msg(2, 4, { content: 'something else with the same changeSeq' }));
    expect(contentOf(w, 'm2')).toBe('edited');
    expect(w.messages).toBe(before.messages);
  });

  it('removes a message on a delete tombstone', () => {
    const w = applyEvent(loaded(), deleted(2, 4));
    expect(ids(w)).toEqual(['m1', 'm3']);
    expect(w.syncSeq).toBe(4);
    expect(w.needsResync).toBe(false);
  });

  it('accounts for a delete of a message it does not hold', () => {
    const w = applyEvent(loaded(), deleted(99, 4));
    expect(ids(w)).toEqual(['m1', 'm2', 'm3']);
    expect(w.syncSeq).toBe(4);
  });
});

describe('applyEvent: window boundaries', () => {
  it('ignores a message older than a window that has more history', () => {
    let w = applyLatestPage(emptyWindow(), page([msg(5), msg(6)], 6, true));
    w = applyEvent(w, msg(2, 7, { content: 'an edit of an unloaded message' }));
    expect(ids(w)).toEqual(['m5', 'm6']);
    expect(w.syncSeq).toBe(7);
    expect(w.needsResync).toBe(false);
  });

  it('ignores a message newer than a window that was trimmed at the top', () => {
    const w = enforceCap(
      applyLatestPage(emptyWindow(), page([msg(1), msg(2), msg(3), msg(4)], 4)),
      false,
      2,
    );
    expect(ids(w)).toEqual(['m1', 'm2']);
    expect(w.hasNewer).toBe(true);

    const next = applyEvent(w, msg(9, 5), false);
    expect(ids(next)).toEqual(['m1', 'm2']);
    expect(next.syncSeq).toBe(5);
  });

  it('still accepts a message inside the window when both ends are open', () => {
    const w = {
      ...applyLatestPage(emptyWindow(), page([msg(1), msg(5)], 5, true)),
      hasNewer: true,
    };
    const next = applyEvent(w, msg(3, 6), false);
    expect(ids(next)).toEqual(['m1', 'm3', 'm5']);
  });
});

describe('applyOlderPage', () => {
  it('prepends and keeps seq ordering without moving syncSeq', () => {
    let w = applyLatestPage(emptyWindow(), page([msg(3), msg(4)], 4, true));
    w = applyOlderPage(w, page([msg(1), msg(2)], 4, false));
    expect(ids(w)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(w.syncSeq).toBe(4);
    expect(w.hasOlder).toBe(false);
  });

  it('keeps hasOlder set while more history remains', () => {
    let w = applyLatestPage(emptyWindow(), page([msg(3), msg(4)], 4, true));
    w = applyOlderPage(w, page([msg(2)], 4, true));
    expect(ids(w)).toEqual(['m2', 'm3', 'm4']);
    expect(w.hasOlder).toBe(true);
  });

  it('does not overwrite a newer version held in the window', () => {
    let w = applyLatestPage(emptyWindow(), page([msg(3), msg(4)], 4, true));
    w = applyEvent(w, msg(3, 5, { content: 'edited after the page was requested' }));
    w = applyOlderPage(w, page([msg(1), msg(2), msg(3)], 5, false));
    expect(ids(w)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(contentOf(w, 'm3')).toBe('edited after the page was requested');
  });

  it('trims the newest messages when the merged window exceeds the cap', () => {
    let w = applyLatestPage(emptyWindow(), page([msg(4), msg(5)], 5, true));
    w = applyOlderPage(w, page([msg(1), msg(2), msg(3)], 5, false));
    expect(ids(w)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);

    const capped = enforceCap(w, false, 3);
    expect(ids(capped)).toEqual(['m1', 'm2', 'm3']);
    expect(capped.hasNewer).toBe(true);
  });
});

describe('enforceCap', () => {
  const five = applyLatestPage(
    emptyWindow(),
    page(
      [1, 2, 3, 4, 5].map((s) => msg(s)),
      5,
    ),
  );

  it('drops the oldest while following the latest', () => {
    const w = enforceCap(five, true, 3);
    expect(ids(w)).toEqual(['m3', 'm4', 'm5']);
    expect(w.hasOlder).toBe(true);
    expect(w.hasNewer).toBe(false);
  });

  it('drops the newest while paged back in history', () => {
    const w = enforceCap(five, false, 3);
    expect(ids(w)).toEqual(['m1', 'm2', 'm3']);
    expect(w.hasNewer).toBe(true);
    expect(w.hasOlder).toBe(false);
  });

  it('does nothing at or below the cap', () => {
    expect(enforceCap(five, true, 5)).toBe(five);
    expect(enforceCap(five, false, 9)).toBe(five);
  });

  it('defaults to the shared client history limit', () => {
    const seqs = Array.from({ length: LIMITS.clientHistoryMax + 10 }, (_, i) => msg(i + 1));
    const w = applyLatestPage(emptyWindow(), page(seqs, seqs.length));
    const capped = enforceCap(w, true);
    expect(capped.messages).toHaveLength(LIMITS.clientHistoryMax);
    expect(capped.messages[0]!.seq).toBe(11);
    expect(capped.hasOlder).toBe(true);
  });
});

describe('applyChanges', () => {
  it('asks for a reset when the server says so', () => {
    expect(applyChanges(loaded(), changes([], 900, true))).toBe('reset');
  });

  it('closes a gap and advances past the whole run', () => {
    const gapped = applyEvent(loaded(), msg(6));
    expect(gapped.needsResync).toBe(true);

    const w = applied(applyChanges(gapped, changes([msg(4), msg(5), msg(6)], 6)));
    expect(ids(w)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    expect(w.syncSeq).toBe(6);
    expect(w.aheadSeqs).toEqual([]);
    expect(w.needsResync).toBe(false);
  });

  it('applies edits and deletions that happened while disconnected', () => {
    const w = applied(
      applyChanges(
        loaded(),
        changes(
          [deleted(2, 4), msg(1, 5, { content: 'edited', editedAt: '2026-01-02T04:00:00.000Z' })],
          5,
        ),
      ),
    );
    expect(ids(w)).toEqual(['m1', 'm3']);
    expect(contentOf(w, 'm1')).toBe('edited');
    expect(w.syncSeq).toBe(5);
    expect(w.needsResync).toBe(false);
  });

  it('never moves syncSeq backwards', () => {
    const ahead = applyEvent(loaded(), msg(4));
    const w = applied(applyChanges(ahead, changes([], 2)));
    expect(w.syncSeq).toBe(4);
  });

  it('accepts an empty response as proof that nothing was missed', () => {
    const gapped = applyEvent(loaded(), msg(5));
    expect(gapped.needsResync).toBe(true);
    const w = applied(applyChanges(gapped, changes([], 5)));
    expect(w.syncSeq).toBe(5);
    expect(w.needsResync).toBe(false);
    expect(w.aheadSeqs).toEqual([]);
  });
});

describe('newestSeq', () => {
  it('is 0 for an empty window and the last seq otherwise', () => {
    expect(newestSeq(emptyWindow())).toBe(0);
    expect(newestSeq(loaded())).toBe(3);
    expect(newestSeq(applyEvent(loaded(), msg(4)))).toBe(4);
  });
});

describe('applyOlderPage with a stale snapshot', () => {
  it('flags the window for resync and drops the message once the changes arrive', () => {
    let w = applyLatestPage(emptyWindow(), page([msg(5), msg(6)], 6, true));
    w = applyEvent(w, deleted(3, 7));
    expect(w.syncSeq).toBe(7);

    w = applyOlderPage(w, page([msg(1), msg(2), msg(3), msg(4)], 6, false));
    expect(w.needsResync).toBe(true);

    w = applied(applyChanges(w, changes([deleted(3, 7)], 7)));
    expect(ids(w)).not.toContain('m3');
    expect(w.needsResync).toBe(false);
  });

  it('asks from the snapshot, so that the resync can repair rows the page brought back', () => {
    let w = applyLatestPage(emptyWindow(), page([msg(50), msg(60)], 99, true));
    const edited = msg(5, 100, { content: 'edited' });
    w = applyEvent(w, edited);
    expect(w.syncSeq).toBe(100);

    const quoting = msg(6, 6, {
      replyTo: {
        id: 'm5',
        seq: 5,
        changeSeq: 5,
        authorId: 'u1',
        excerpt: 'message 5',
        attachmentCount: 0,
        attachmentKind: null,
        deleted: false,
      },
    });
    w = applyOlderPage(w, page([msg(5), quoting], 99, false));
    expect(w.needsResync).toBe(true);
    expect(w.syncSeq).toBe(99);

    w = applied(applyChanges(w, changes([edited], 100)));
    expect(w.messages.find((m) => m.id === 'm5')?.content).toBe('edited');
    expect(w.messages.find((m) => m.id === 'm6')?.replyTo?.excerpt).toBe('edited');
    expect(w.syncSeq).toBe(100);
    expect(w.needsResync).toBe(false);
  });

  it('never asks from further forward than the window already is', () => {
    let w = applyLatestPage(emptyWindow(), page([msg(5), msg(6)], 6, true));
    w = applyEvent(w, msg(9));
    expect(w.syncSeq).toBe(6);
    w = applyOlderPage(w, page([msg(3)], 8, true));
    expect(w.syncSeq).toBe(6);
  });

  it('does not flag a window when the page snapshot is current', () => {
    let w = applyLatestPage(emptyWindow(), page([msg(5), msg(6)], 6, true));
    w = applyOlderPage(w, page([msg(3), msg(4)], 6, false));
    expect(w.needsResync).toBe(false);
    expect(ids(w)).toEqual(['m3', 'm4', 'm5', 'm6']);
  });
});

function attachment(kind: AttachmentDTO['kind'], id = 'a1'): AttachmentDTO {
  return {
    id,
    kind,
    url: `/api/attachments/${id}`,
    contentType: kind === 'video' ? 'video/mp4' : 'image/png',
    fileName: `${id}.bin`,
    byteSize: 10,
    width: 10,
    height: 10,
  };
}

function quote(over: Partial<MessageQuoteDTO> = {}): MessageQuoteDTO {
  return {
    id: 'm1',
    seq: 1,
    changeSeq: 1,
    authorId: 'u1',
    excerpt: 'message 1',
    attachmentCount: 0,
    attachmentKind: null,
    deleted: false,
    ...over,
  };
}

const reply = (quoted: MessageQuoteDTO = quote(), seq = 9) =>
  msg(seq, seq, { content: 'an answer', replyTo: quoted });

const quoteIn = (w: ChannelWindow, id: string) => w.messages.find((m) => m.id === id)?.replyTo;

describe('quoteOf', () => {
  it('says the same as the server would', () => {
    expect(quoteOf(msg(3, 7, { authorId: 'u9', content: '**big** news' }))).toEqual({
      id: 'm3',
      seq: 3,
      changeSeq: 7,
      authorId: 'u9',
      excerpt: 'big news',
      attachmentCount: 0,
      attachmentKind: null,
      deleted: false,
    });
  });

  it('counts files, and names the kind of the first', () => {
    const q = quoteOf(
      msg(3, 3, { content: '', attachments: [attachment('video'), attachment('image', 'a2')] }),
    );
    expect(q.attachmentCount).toBe(2);
    expect(q.attachmentKind).toBe('video');
  });

  it('says nothing of a deleted message but that it was deleted', () => {
    expect(quoteOf(deleted(3, 7))).toMatchObject({
      deleted: true,
      excerpt: '',
      attachmentCount: 0,
      attachmentKind: null,
    });
  });
});

describe('quoteSummary', () => {
  it('is the words when there are words, whatever else there is', () => {
    expect(quoteSummary(quote({ excerpt: 'hello', attachmentCount: 3 }))).toBe('hello');
  });

  it('says what kind of thing it was when there are none', () => {
    const none = { excerpt: '' };
    expect(quoteSummary(quote({ ...none, attachmentCount: 1, attachmentKind: 'image' }))).toBe(
      'Photo',
    );
    expect(quoteSummary(quote({ ...none, attachmentCount: 1, attachmentKind: 'video' }))).toBe(
      'Video',
    );
    expect(quoteSummary(quote({ ...none, attachmentCount: 2, attachmentKind: 'image' }))).toBe(
      '2 files',
    );
    expect(quoteSummary(quote({ ...none, attachmentCount: 10, attachmentKind: 'video' }))).toBe(
      '10 files',
    );
  });

  it('says so when the original was deleted', () => {
    expect(quoteSummary(quote({ excerpt: '', deleted: true }))).toBe(
      'Original message was deleted',
    );
  });
});

describe('patching quotes', () => {
  it('takes on the new state of its original', () => {
    const next = patchQuote(quote(), msg(1, 5, { content: 'changed' }));
    expect(next).toMatchObject({ excerpt: 'changed', changeSeq: 5, deleted: false });
  });

  it('is the same object when the change is of something else', () => {
    const q = quote();
    expect(patchQuote(q, msg(2, 5))).toBe(q);
  });

  it('ignores an older state of its original, which can arrive late', () => {
    const q = quote({ changeSeq: 6, excerpt: 'newer' });
    expect(patchQuote(q, msg(1, 5, { content: 'older' }))).toBe(q);
    expect(patchQuote(q, msg(1, 6, { content: 'same age' }))).toBe(q);
  });

  it('touches only the rows that quote it, so that only they redraw', () => {
    const untouched = msg(2);
    const quoting = reply();
    const other = reply(quote({ id: 'm7', seq: 7, changeSeq: 7 }), 10);
    const list = [untouched, quoting, other];
    const next = patchQuotes(list, msg(1, 20, { content: 'changed' }));
    expect(next).not.toBe(list);
    expect(next[0]).toBe(untouched);
    expect(next[1]).not.toBe(quoting);
    expect(next[1]?.replyTo?.excerpt).toBe('changed');
    expect(next[2]).toBe(other);
  });

  it('hands back the same array when nothing quotes it', () => {
    const list = [msg(2), reply()];
    expect(patchQuotes(list, msg(5, 20))).toBe(list);
  });
});

describe('a window keeps its quotes current', () => {
  const start = (...messages: MessageDTO[]) =>
    applyLatestPage(emptyWindow(), page(messages, messages[messages.length - 1]!.changeSeq));

  it('when the original is edited live, and it is in the window', () => {
    const w = start(msg(1), reply(quote(), 2));
    const next = applyEvent(w, msg(1, 3, { content: 'edited' }));
    expect(contentOf(next, 'm1')).toBe('edited');
    expect(quoteIn(next, 'm2')?.excerpt).toBe('edited');
  });

  it('when the original is deleted live', () => {
    const w = start(msg(1), reply(quote(), 2));
    const next = applyEvent(w, deleted(1, 3));
    expect(ids(next)).toEqual(['m2']);
    expect(quoteIn(next, 'm2')).toMatchObject({ deleted: true, excerpt: '', attachmentCount: 0 });
  });

  it('when the original is outside the window, which still hears about it', () => {
    const w = applyLatestPage(emptyWindow(), page([reply(quote(), 50)], 50, true));
    const edited = applyEvent(w, msg(1, 51, { content: 'edited' }));
    expect(ids(edited)).toEqual(['m50']);
    expect(quoteIn(edited, 'm50')?.excerpt).toBe('edited');
    const gone = applyEvent(edited, deleted(1, 52));
    expect(quoteIn(gone, 'm50')).toMatchObject({ deleted: true, excerpt: '' });
  });

  it('when the change arrives through changes?since after a reconnect', () => {
    const w = start(
      msg(1),
      msg(2),
      reply(quote(), 3),
      reply(quote({ id: 'm2', seq: 2, changeSeq: 2 }), 4),
    );
    const next = applied(
      applyChanges(w, changes([msg(1, 5, { content: 'edited' }), deleted(2, 6)], 6)),
    );
    expect(quoteIn(next, 'm3')?.excerpt).toBe('edited');
    expect(quoteIn(next, 'm4')).toMatchObject({ deleted: true, excerpt: '' });
    expect(next.syncSeq).toBe(6);
  });

  it('when the original is outside the window and the change comes through changes?since', () => {
    const w = applyLatestPage(emptyWindow(), page([reply(quote(), 50)], 50, true));
    const next = applied(applyChanges(w, changes([msg(1, 51, { content: 'edited' })], 51)));
    expect(ids(next)).toEqual(['m50']);
    expect(quoteIn(next, 'm50')?.excerpt).toBe('edited');
  });

  it('does not take a creation for a change, which nothing could have quoted yet', () => {
    const w = start(reply(quote({ id: 'm5', seq: 5, changeSeq: 5, excerpt: 'mine' }), 6));
    const next = applyEvent(w, msg(7));
    expect(next.messages[0]).toBe(w.messages[0]);
  });

  it('does not let a late event for the original undo a newer quote', () => {
    const w = start(reply(quote({ changeSeq: 9, excerpt: 'newest' }), 10));
    const next = applyEvent(w, msg(1, 8, { content: 'old news' }));
    expect(quoteIn(next, 'm10')?.excerpt).toBe('newest');
  });

  it('does not let a reply that arrived late bring an older quote into a newer window', () => {
    const w = start(msg(1, 11, { content: 'edited' }));
    const next = applyEvent(w, reply(quote({ changeSeq: 1, excerpt: 'as first written' }), 10));
    expect(quoteIn(next, 'm10')?.excerpt).toBe('edited');
  });

  it('does not let a late edit of the reply itself undo its quote', () => {
    const w = start(reply(quote(), 10));
    const quoted = applyEvent(w, msg(1, 12, { content: 'edited original' }));
    const late = msg(10, 11, { content: 'edited reply', replyTo: quote() });
    const next = applyEvent(quoted, late);
    expect(contentOf(next, 'm10')).toBe('edited reply');
    expect(quoteIn(next, 'm10')?.excerpt).toBe('edited original');
  });

  it('brings an older page up to what the window already knows', () => {
    const w = applyLatestPage(emptyWindow(), page([msg(5, 20, { content: 'edited' })], 20, true));
    const older = applyOlderPage(
      w,
      page([reply(quote({ id: 'm5', seq: 5, changeSeq: 5, excerpt: 'old' }), 4)], 15),
    );
    expect(quoteIn(older, 'm4')?.excerpt).toBe('edited');
  });

  it('leaves a message with no quote exactly as it was', () => {
    const plain = msg(2);
    const w = start(plain);
    const next = applyEvent(w, msg(1, 3));
    expect(next.messages.find((m) => m.id === 'm2')).toBe(plain);
  });
});

describe('applyJumpPage', () => {
  const present = () => applyLatestPage(emptyWindow(), page([msg(90), msg(91), msg(92)], 92, true));

  it('replaces the window with the page, away from the present', () => {
    const next = applyJumpPage(present(), page([msg(10), msg(11), msg(12)], 92, true));
    expect(ids(next)).toEqual(['m10', 'm11', 'm12']);
    expect(next.hasNewer).toBe(true);
    expect(next.hasOlder).toBe(true);
    expect(next.loaded).toBe(true);
    expect(next.needsResync).toBe(false);
    expect(next.syncSeq).toBe(92);
  });

  it('reports the start of the channel when that is what the page reached', () => {
    expect(applyJumpPage(present(), page([msg(1)], 92, false)).hasOlder).toBe(false);
  });

  it('leaves out tombstones', () => {
    expect(ids(applyJumpPage(present(), page([msg(10), deleted(11, 50)], 92)))).toEqual(['m10']);
  });

  it('keeps new messages out, as any window away from the present does', () => {
    const w = applyJumpPage(present(), page([msg(10), msg(11)], 92, true));
    const next = applyEvent(w, msg(93), false);
    expect(ids(next)).toEqual(['m10', 'm11']);
    expect(next.syncSeq).toBe(93);
    expect(next.needsResync).toBe(false);
  });

  it('still takes edits and deletes of what it holds, and quote changes', () => {
    const w = applyJumpPage(
      present(),
      page([msg(10), reply(quote({ id: 'm10', seq: 10, changeSeq: 10, excerpt: 'old' }), 11)], 92),
    );
    const edited = applyEvent(w, msg(10, 93, { content: 'edited' }));
    expect(contentOf(edited, 'm10')).toBe('edited');
    expect(quoteIn(edited, 'm11')?.excerpt).toBe('edited');
    expect(ids(applyEvent(edited, deleted(10, 94)))).toEqual(['m11']);
  });

  it('asks for what it may have missed when the page is older than the window', () => {
    const w = applyEvent(present(), msg(93));
    const next = applyJumpPage(w, page([msg(10)], 92, true));
    expect(next.needsResync).toBe(true);
    expect(next.syncSeq).toBe(92);
    const ahead = applyEvent(present(), msg(95));
    expect(applyJumpPage(ahead, page([msg(10)], 92, true)).needsResync).toBe(true);
  });

  it('is left behind by the latest page, which is how a reader gets back', () => {
    const away = applyJumpPage(present(), page([msg(10)], 92, true));
    const back = applyLatestPage(away, page([msg(91), msg(92)], 92, true));
    expect(back.hasNewer).toBe(false);
    expect(ids(back)).toEqual(['m91', 'm92']);
    expect(newestSeq(back)).toBe(92);
  });
});
