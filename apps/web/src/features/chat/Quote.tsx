import { Forward } from 'lucide-react';
import type { MessageOriginDTO, MessageQuoteDTO, UserPublic } from '@hostile/shared';
import { Avatar, cx } from '../../components/ui';
import { formatMessageTimestamp } from '../../lib/time';
import { NameText } from '../profile/NameText';
import { jumpToOrigin } from './message-actions';
import { requestJump } from './store';
import { quoteSummary } from './sync';
import styles from './chat.module.scss';

export function QuoteLine({
  quote,
  author,
  channelId,
}: {
  quote: MessageQuoteDTO;
  author: UserPublic | undefined;
  channelId: string;
}) {
  const name = author?.displayName ?? 'Unknown member';
  const summary = quoteSummary(quote);
  const inner = (
    <>
      <span className={styles.quoteAvatar}>
        <Avatar
          name={name}
          color={author?.avatarColor ?? '#525252'}
          src={author?.avatarUrl}
          size={16}
        />
      </span>
      <span className={styles.quoteName}>
        <NameText user={author ?? { displayName: name }} />
      </span>
      <span className={cx(styles.quoteText, !quote.excerpt && styles.quoteTextPlaceholder)}>
        {summary}
      </span>
    </>
  );
  if (quote.deleted) {
    return (
      <div className={styles.quoteLine} data-testid="reply-quote">
        {inner}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={styles.quoteLine}
      data-testid="reply-quote"
      aria-label={`Jump to the message from ${name}: ${summary}`}
      onClick={() => requestJump(channelId, { messageId: quote.id, seq: quote.seq })}
    >
      {inner}
    </button>
  );
}

export function ForwardLabel() {
  return (
    <div className={styles.forwardLabel} data-testid="forward-label">
      <Forward size={13} aria-hidden />
      Forwarded
    </div>
  );
}

export function OriginLine({
  origin,
  author,
  channelLabel,
  reachable,
}: {
  origin: MessageOriginDTO;
  author: UserPublic | undefined;
  channelLabel: string;
  reachable: boolean;
}) {
  const name = author?.displayName ?? 'Unknown member';
  const inner = (
    <>
      <span className={styles.originName}>
        <NameText user={author ?? { displayName: name }} />
      </span>
      <span className={styles.originPart}>{channelLabel}</span>
      <time className={cx(styles.originPart, styles.originTime)} dateTime={origin.createdAt}>
        {formatMessageTimestamp(origin.createdAt)}
      </time>
    </>
  );
  if (!reachable) {
    return (
      <div className={styles.originLine} data-testid="forward-origin">
        {inner}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={styles.originLine}
      data-testid="forward-origin"
      aria-label={`Jump to the original, from ${name} in ${channelLabel}`}
      onClick={() => jumpToOrigin(origin)}
    >
      {inner}
    </button>
  );
}
