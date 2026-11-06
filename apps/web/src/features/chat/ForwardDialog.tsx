import { useMemo, useRef, useState } from 'react';
import { Film, Hash, ImageOff, Volume2 } from 'lucide-react';
import type { ChannelDTO, MessageDTO } from '@hostile/shared';
import { mediaUrl } from '../../api/client';
import { Avatar, Banner, cx, EmptyState, Modal, Spinner, TextInput } from '../../components/ui';
import { useCommunity } from '../../stores/community';
import { toast } from '../../stores/ui';
import { NameText } from '../profile/NameText';
import { useFilesBlocked } from './files-blocked';
import { closeForward, deliveredPreview, forwardMessage, refusalMessage, useChat } from './store';
import { quoteOf, quoteSummary } from './sync';
import styles from './chat.module.scss';

const label = (channel: ChannelDTO) =>
  channel.type === 'text' ? `#${channel.name}` : channel.name;

export function Preview({ message }: { message: MessageDTO }) {
  const author = useCommunity((s) => s.members[message.authorId]);
  const name = author?.displayName ?? 'Unknown member';
  const quote = quoteOf(message);
  const first = message.attachments[0];
  const blocked = useFilesBlocked();
  const thumb =
    first?.kind === 'image' ? (deliveredPreview(first.id)?.url ?? mediaUrl(first.url)) : null;
  return (
    <div className={styles.forwardPreview} data-testid="forward-preview">
      {first?.kind === 'image' && blocked && !deliveredPreview(first.id) ? (
        <span className={cx(styles.forwardThumb, styles.forwardThumbIcon)}>
          <ImageOff size={16} aria-hidden />
        </span>
      ) : thumb ? (
        <img className={styles.forwardThumb} src={thumb} alt="" draggable={false} />
      ) : first?.kind === 'video' ? (
        <span className={cx(styles.forwardThumb, styles.forwardThumbIcon)}>
          <Film size={16} aria-hidden />
        </span>
      ) : (
        <Avatar
          name={name}
          color={author?.avatarColor ?? '#525252'}
          src={author?.avatarUrl}
          size={32}
        />
      )}
      <span className={styles.forwardPreviewText}>
        <span className={styles.forwardPreviewName}>
          <NameText user={author ?? { displayName: name }} />
        </span>
        <span
          className={cx(styles.forwardPreviewLine, !quote.excerpt && styles.quoteTextPlaceholder)}
        >
          {quoteSummary(quote)}
        </span>
      </span>
    </div>
  );
}

function Body({ message }: { message: MessageDTO }) {
  const channels = useCommunity((s) => s.channels);
  const coarse = useMemo(() => window.matchMedia('(pointer: coarse)').matches, []);
  const [filter, setFilter] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nonces = useRef(new Map<string, string>());

  const targets = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const others = channels.filter(
      (c) => c.id !== message.channelId && c.name.toLowerCase().includes(query),
    );
    return [
      ...others.filter((c) => c.type === 'text'),
      ...others.filter((c) => c.type === 'voice'),
    ];
  }, [channels, filter, message.channelId]);

  const stillOpen = () => useChat.getState().forwarding === message;

  async function send(channel: ChannelDTO) {
    if (busyId) return;
    setBusyId(channel.id);
    setError(null);
    const nonce = nonces.current.get(channel.id) ?? crypto.randomUUID();
    nonces.current.set(channel.id, nonce);
    try {
      await forwardMessage(message.id, channel.id, nonce);
      if (stillOpen()) closeForward();
      toast(`Forwarded to ${label(channel)}`, 'success');
    } catch (err) {
      if (!stillOpen()) {
        toast(`Could not forward to ${label(channel)}: ${refusalMessage(err)}`, 'error');
        return;
      }
      setBusyId(null);
      setError(refusalMessage(err));
    }
  }

  return (
    <>
      <Preview message={message} />
      {error && (
        <div className={styles.forwardError}>
          <Banner kind="error">{error}</Banner>
        </div>
      )}
      <TextInput
        className={styles.forwardFilter}
        value={filter}
        placeholder="Find a channel"
        aria-label="Find a channel"
        data-no-autofocus={coarse || undefined}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && targets.length === 1 && targets[0]) void send(targets[0]);
        }}
      />
      <div className={styles.forwardList} role="list" aria-label="Channels" aria-busy={!!busyId}>
        {targets.map((channel) => (
          <div key={channel.id} role="listitem">
            <button
              type="button"
              className={styles.forwardTarget}
              disabled={!!busyId}
              onClick={() => void send(channel)}
            >
              {channel.type === 'text' ? (
                <Hash size={16} aria-hidden />
              ) : (
                <Volume2 size={16} aria-hidden />
              )}
              <span className={styles.forwardTargetName}>{channel.name}</span>
              {busyId === channel.id && <Spinner label={`Forwarding to ${channel.name}`} />}
            </button>
          </div>
        ))}
        {targets.length === 0 && (
          <EmptyState title={filter.trim() ? 'No channel by that name' : 'Nowhere to send it'}>
            {filter.trim() ? null : 'This is the only channel there is.'}
          </EmptyState>
        )}
      </div>
    </>
  );
}

export function ForwardDialog() {
  const [message] = useState(() => useChat.getState().forwarding);
  if (!message) return null;
  return (
    <Modal title="Forward to" onClose={closeForward} width={420}>
      <Body message={message} />
    </Modal>
  );
}
