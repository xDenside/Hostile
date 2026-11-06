import {
  LIMITS,
  messageExcerpt,
  type ChangesDTO,
  type MessageDTO,
  type MessagePageDTO,
  type MessageQuoteDTO,
} from '@hostile/shared';

export interface ChannelWindow {
  messages: MessageDTO[];
  hasOlder: boolean;
  hasNewer: boolean;
  loaded: boolean;
  syncSeq: number;
  aheadSeqs: number[];
  needsResync: boolean;
  queued: MessageDTO[];
}

export function emptyWindow(): ChannelWindow {
  return {
    messages: [],
    hasOlder: false,
    hasNewer: false,
    loaded: false,
    syncSeq: 0,
    aheadSeqs: [],
    needsResync: false,
    queued: [],
  };
}

export function quoteOf(message: MessageDTO): MessageQuoteDTO {
  const { deleted } = message;
  return {
    id: message.id,
    seq: message.seq,
    changeSeq: message.changeSeq,
    authorId: message.authorId,
    excerpt: deleted ? '' : messageExcerpt(message.content),
    attachmentCount: deleted ? 0 : message.attachments.length,
    attachmentKind: deleted ? null : (message.attachments[0]?.kind ?? null),
    deleted,
  };
}

export function quoteSummary(quote: MessageQuoteDTO): string {
  if (quote.deleted) return 'Original message was deleted';
  if (quote.excerpt) return quote.excerpt;
  if (quote.attachmentCount > 1) return `${quote.attachmentCount} files`;
  if (quote.attachmentCount === 1) return quote.attachmentKind === 'video' ? 'Video' : 'Photo';
  return '';
}

export function patchQuote(quote: MessageQuoteDTO, changed: MessageDTO): MessageQuoteDTO {
  if (quote.id !== changed.id || quote.changeSeq >= changed.changeSeq) return quote;
  return quoteOf(changed);
}

export function patchQuotes(messages: MessageDTO[], changed: MessageDTO): MessageDTO[] {
  let out: MessageDTO[] | null = null;
  messages.forEach((message, index) => {
    if (!message.replyTo) return;
    const replyTo = patchQuote(message.replyTo, changed);
    if (replyTo === message.replyTo) return;
    out ??= messages.slice();
    out[index] = { ...message, replyTo };
  });
  return out ?? messages;
}

export function forgetOrigin(messages: MessageDTO[], deletedId: string): MessageDTO[] {
  let out: MessageDTO[] | null = null;
  messages.forEach((message, index) => {
    const origin = message.forwardedFrom;
    if (origin?.messageId !== deletedId) return;
    out ??= messages.slice();
    out[index] = { ...message, forwardedFrom: { ...origin, messageId: null, seq: null } };
  });
  return out ?? messages;
}

function withNewestQuote(
  message: MessageDTO,
  current: MessageDTO | undefined,
  known: readonly MessageDTO[],
): MessageDTO {
  const quote = message.replyTo;
  if (!quote) return message;
  const held = current?.replyTo;
  const original = known.find((m) => m.id === quote.id);
  let newest = held && held.changeSeq > quote.changeSeq ? held : quote;
  if (original) newest = patchQuote(newest, original);
  return newest === quote ? message : { ...message, replyTo: newest };
}

function reconcileQuotes(messages: MessageDTO[]): MessageDTO[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  let out: MessageDTO[] | null = null;
  messages.forEach((message, index) => {
    const original = message.replyTo && byId.get(message.replyTo.id);
    if (!message.replyTo || !original) return;
    const replyTo = patchQuote(message.replyTo, original);
    if (replyTo === message.replyTo) return;
    out ??= messages.slice();
    out[index] = { ...message, replyTo };
  });
  return out ?? messages;
}

function insertSorted(list: MessageDTO[], msg: MessageDTO): MessageDTO[] {
  const out = list.slice();
  let i = out.length;
  while (i > 0 && out[i - 1]!.seq > msg.seq) i--;
  out.splice(i, 0, msg);
  return out;
}

function upsert(w: ChannelWindow, msg: MessageDTO): ChannelWindow {
  const quoted = msg.changeSeq === msg.seq ? w : patchWindowQuotes(w, msg);
  const idx = quoted.messages.findIndex((m) => m.id === msg.id);
  if (idx >= 0) {
    const existing = quoted.messages[idx]!;
    if (existing.changeSeq >= msg.changeSeq) return quoted;
    const messages = quoted.messages.slice();
    if (msg.deleted) messages.splice(idx, 1);
    else messages[idx] = withNewestQuote(msg, existing, quoted.messages);
    return { ...quoted, messages };
  }
  if (msg.deleted) return quoted;
  const first = quoted.messages[0];
  const last = quoted.messages[quoted.messages.length - 1];
  if (quoted.hasOlder && first && msg.seq < first.seq) return quoted;
  if (quoted.hasNewer && last && msg.seq > last.seq) return quoted;
  return {
    ...quoted,
    messages: insertSorted(quoted.messages, withNewestQuote(msg, undefined, quoted.messages)),
  };
}

function patchWindowQuotes(w: ChannelWindow, changed: MessageDTO): ChannelWindow {
  const messages = patchQuotes(w.messages, changed);
  return messages === w.messages ? w : { ...w, messages };
}

function advance(w: ChannelWindow, changeSeq: number): ChannelWindow {
  let syncSeq = w.syncSeq;
  let ahead = w.aheadSeqs;
  if (changeSeq === syncSeq + 1) {
    syncSeq = changeSeq;
  } else if (changeSeq > syncSeq + 1 && !ahead.includes(changeSeq)) {
    ahead = [...ahead, changeSeq].sort((a, b) => a - b);
  }
  while (ahead.length && ahead[0]! <= syncSeq + 1) {
    syncSeq = Math.max(syncSeq, ahead[0]!);
    ahead = ahead.slice(1);
  }
  return { ...w, syncSeq, aheadSeqs: ahead, needsResync: ahead.length > 0 };
}

export function enforceCap(
  w: ChannelWindow,
  followingLatest: boolean,
  cap: number = LIMITS.clientHistoryMax,
): ChannelWindow {
  if (w.messages.length <= cap) return w;
  if (followingLatest) return { ...w, messages: w.messages.slice(-cap), hasOlder: true };
  return { ...w, messages: w.messages.slice(0, cap), hasNewer: true };
}

export function applyEvent(
  w: ChannelWindow,
  msg: MessageDTO,
  followingLatest = true,
): ChannelWindow {
  if (!w.loaded) return { ...w, queued: [...w.queued, msg] };
  return enforceCap(advance(upsert(w, msg), msg.changeSeq), followingLatest);
}

export function applyLatestPage(w: ChannelWindow, page: MessagePageDTO): ChannelWindow {
  const stale = w.loaded && (w.syncSeq > page.syncSeq || w.aheadSeqs.some((s) => s > page.syncSeq));
  let next: ChannelWindow = {
    ...emptyWindow(),
    messages: page.messages.filter((m) => !m.deleted),
    hasOlder: page.hasOlder,
    loaded: true,
    syncSeq: page.syncSeq,
    needsResync: stale,
  };
  for (const msg of w.queued) next = applyEvent(next, msg);
  return { ...next, needsResync: next.needsResync || stale };
}

export function applyJumpPage(w: ChannelWindow, page: MessagePageDTO): ChannelWindow {
  const stale = w.loaded && (w.syncSeq > page.syncSeq || w.aheadSeqs.some((s) => s > page.syncSeq));
  let next: ChannelWindow = {
    ...emptyWindow(),
    messages: page.messages.filter((m) => !m.deleted),
    hasOlder: page.hasOlder,
    hasNewer: true,
    loaded: true,
    syncSeq: page.syncSeq,
    needsResync: stale,
  };
  for (const msg of w.queued) next = applyEvent(next, msg, false);
  return { ...next, needsResync: next.needsResync || stale };
}

export function applyOlderPage(w: ChannelWindow, page: MessagePageDTO): ChannelWindow {
  const byId = new Map(w.messages.map((m) => [m.id, m]));
  for (const msg of page.messages) {
    const existing = byId.get(msg.id);
    if (existing && existing.changeSeq >= msg.changeSeq) continue;
    if (msg.deleted) byId.delete(msg.id);
    else byId.set(msg.id, msg);
  }
  const messages = reconcileQuotes([...byId.values()].sort((a, b) => a.seq - b.seq));
  const stale = page.syncSeq < w.syncSeq;
  return enforceCap(
    {
      ...w,
      messages,
      hasOlder: page.hasOlder,
      syncSeq: Math.min(w.syncSeq, page.syncSeq),
      needsResync: w.needsResync || stale,
    },
    false,
  );
}

export function applyChanges(w: ChannelWindow, changes: ChangesDTO): ChannelWindow | 'reset' {
  if (changes.reset) return 'reset';
  let next = w;
  for (const msg of changes.changes) next = upsert(next, msg);
  const syncSeq = Math.max(next.syncSeq, changes.syncSeq);
  const aheadSeqs = next.aheadSeqs.filter((s) => s > syncSeq + 1);
  return advance({ ...next, syncSeq, aheadSeqs, needsResync: false }, syncSeq);
}

export function newestSeq(w: ChannelWindow): number {
  return w.messages[w.messages.length - 1]?.seq ?? 0;
}
