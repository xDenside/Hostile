import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  Clock,
  Copy,
  Forward,
  ImagePlus,
  Loader2,
  Paperclip,
  Pencil,
  Reply,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import { LIMITS, type ChannelDTO, type MessageDTO, type UserPublic } from '@hostile/shared';
import {
  Avatar,
  Banner,
  Button,
  cx,
  EmptyState,
  IconButton,
  Kbd,
  Spinner,
} from '../../components/ui';
import { NameText, OwnerMark } from '../profile/NameText';
import { memberTrigger } from '../profile/triggers';
import {
  formatDay,
  formatMessageTimestamp,
  formatTime,
  isSameDay,
  isSameMinute,
} from '../../lib/time';
import { emitTyping } from '../../realtime/socket';
import { useCommunity } from '../../stores/community';
import { useSession } from '../../stores/session';
import { closePopup, useUi } from '../../stores/ui';
import { ATTACH_ACCEPT, filesFromPaste, overallPercent } from './attachment-rules';
import { AttachmentTray } from './AttachmentTray';
import { Attachments, PendingAttachments } from './Attachments';
import { FormattedMessage } from './format';
import {
  confirmDelete,
  copyMessage,
  focusRow,
  messageCopyLabel,
  openForward,
  openMessageMenu,
  restoreSelection,
  rowOf,
  saveSelection,
} from './message-actions';
import { ForwardLabel, OriginLine, QuoteLine } from './Quote';
import styles from './chat.module.scss';
import mediaStyles from './attachments.module.scss';
import {
  addToTray,
  cancelReply,
  canRetryPending,
  canSendWhatGotThrough,
  clearJump,
  composerFocused,
  discardPending,
  editMessage,
  keepEditDraft,
  loadAround,
  loadLatest,
  loadOlder,
  markChannelRead,
  resyncChannel,
  retryPending,
  sendMessage,
  sendWhatGotThrough,
  setDraft,
  setFollowing,
  startEditing,
  startReply,
  stopEditing,
  useChat,
  type OutgoingFile,
  type PendingMessage,
} from './store';
import { quoteSummary } from './sync';
import { useFileDrop } from './useFileDrop';
import { useMessageGestures } from './useMessageGestures';

const GROUP_WINDOW_MS = 5 * 60 * 1000;
const NO_FILES: OutgoingFile[] = [];

export function ChannelView({ channel }: { channel: ChannelDTO }) {
  const window_ = useChat((s) => s.windows[channel.id]);
  const loading = useChat((s) => s.loading[channel.id]);
  const error = useChat((s) => s.errors[channel.id]);
  const unavailable = !window_?.loaded && !!error;
  const drop = useFileDrop((files) => addToTray(channel.id, files), !unavailable);

  useEffect(() => {
    if (!window_?.loaded) void loadLatest(channel.id);
  }, [channel.id, window_?.loaded]);

  return (
    <div className={styles.view} {...drop.zone}>
      {error && !window_?.loaded ? (
        <div style={{ padding: 'var(--sp-5)' }}>
          <Banner kind="error">{error}</Banner>
          <div style={{ marginTop: 'var(--sp-3)' }}>
            <Button onClick={() => void loadLatest(channel.id)}>Try again</Button>
          </div>
        </div>
      ) : !window_?.loaded ? (
        <div className={styles.loadingTop}>
          <Spinner /> Loading messages…
        </div>
      ) : (
        <MessageList key={channel.id} channel={channel} />
      )}
      <Composer channel={channel} disabled={unavailable} />
      {drop.over && (
        <div className={mediaStyles.dropOverlay} data-testid="drop-overlay" {...drop.overlay}>
          <div className={mediaStyles.dropMessage}>
            <ImagePlus size={26} aria-hidden />
            <strong>Drop to add to {channelLabel(channel)}</strong>
            Images and videos, up to {LIMITS.attachmentsPerMessage} on a message
          </div>
        </div>
      )}
      {loading === 'resync' && (
        <div className="visually-hidden" role="status">
          Catching up on missed messages
        </div>
      )}
    </div>
  );
}

function channelLabel(channel: ChannelDTO): string {
  return channel.type === 'text' ? `#${channel.name}` : channel.name;
}

function flashRow(row: HTMLElement) {
  row.removeAttribute('data-flash');
  void row.offsetWidth;
  row.setAttribute('data-flash', '');
  const done = (e: AnimationEvent) => {
    if (e.target !== row) return;
    row.removeEventListener('animationend', done);
    row.removeAttribute('data-flash');
  };
  row.addEventListener('animationend', done);
}

function focusLanding(row: HTMLElement, list: HTMLElement) {
  const now = document.activeElement;
  const free =
    !now || now === document.body || (list.contains(now) && !now.closest('textarea, input'));
  if (free && !window.matchMedia('(pointer: coarse)').matches) row.focus({ preventScroll: true });
}

function MessageList({ channel }: { channel: ChannelDTO }) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const win = useChat((s) => s.windows[channel.id]!);
  const pending = useChat((s) => s.pending);
  const loading = useChat((s) => s.loading[channel.id]);
  const editingId = useChat((s) => s.editing[channel.id]);
  const jump = useChat((s) => s.jumps[channel.id]);
  const following = useChat((s) => s.following[channel.id]);
  const members = useCommunity((s) => s.members);
  const channels = useCommunity((s) => s.channels);
  const selfId = useSession((s) => s.user?.id ?? '');
  const lastReadSeq = useCommunity((s) => s.readStates[channel.id] ?? 0);
  const syncStale = useChat((s) => s.syncStale[channel.id] ?? false);
  const [atBottom, setAtBottom] = useState(() => !useChat.getState().jumps[channel.id]);
  const stick = useRef(!useChat.getState().jumps[channel.id]);
  const arrivedByJump = useRef(!!useChat.getState().jumps[channel.id]);
  const previousHeight = useRef(0);
  const firstMessageId = useRef<string | undefined>(undefined);
  const ownScrollTop = useRef(0);
  const heldAtJump = useRef(false);
  const jumpStarted = useRef<object | null>(null);
  const selectionAtPress = useRef<Range[] | null>(null);
  const { handlers, cancelPress, pressOpenedMenu, icon } = useMessageGestures(channel.id);

  const channelPending = useMemo(
    () =>
      Object.values(pending)
        .filter((p) => p.channelId === channel.id)
        .sort((a, b) => a.createdAt - b.createdAt),
    [pending, channel.id],
  );

  useLayoutEffect(() => {
    if (following && !useChat.getState().jumps[channel.id]) stick.current = true;
  }, [following, channel.id]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const topId = win.messages[0]?.id;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else if (
      topId !== firstMessageId.current &&
      previousHeight.current &&
      el.scrollHeight > previousHeight.current
    ) {
      el.scrollTop += el.scrollHeight - previousHeight.current;
    }
    ownScrollTop.current = el.scrollTop;
    firstMessageId.current = topId;
    previousHeight.current = el.scrollHeight;
  }, [win.messages, channelPending.length, loading]);

  useLayoutEffect(() => {
    if (!jump) return;
    const el = scroller.current;
    if (!el) return;
    const settle = () => {
      if (win.hasNewer) return;
      const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      stick.current = bottom;
      setAtBottom(bottom);
      setFollowing(channel.id, bottom);
    };
    const row = el.querySelector<HTMLElement>(`[data-message-id="${jump.messageId}"]`);
    if (row) {
      const list = el.getBoundingClientRect();
      const box = row.getBoundingClientRect();
      const outOfView = box.top < list.top || box.bottom > list.bottom;
      if (outOfView) {
        el.scrollTop += box.top - list.top - Math.max(0, (list.height - box.height) / 2);
        ownScrollTop.current = el.scrollTop;
      }
      heldAtJump.current = win.hasNewer;
      if (outOfView || !stick.current) settle();
      flashRow(row);
      focusLanding(row, el);
      arrivedByJump.current = false;
      jumpStarted.current = null;
      clearJump(channel.id);
      return;
    }
    if (jumpStarted.current === jump) return;
    jumpStarted.current = jump;
    stick.current = false;
    setAtBottom(false);
    setFollowing(channel.id, false);
    void loadAround(channel.id, jump).then((found) => {
      if (found || useChat.getState().jumps[channel.id] !== jump) return;
      jumpStarted.current = null;
      clearJump(channel.id);
      if (arrivedByJump.current && el.scrollTop === ownScrollTop.current) {
        arrivedByJump.current = false;
        stick.current = true;
        el.scrollTop = el.scrollHeight;
        ownScrollTop.current = el.scrollTop;
        setAtBottom(true);
        setFollowing(channel.id, true);
        return;
      }
      settle();
    });
  }, [jump, win.messages, win.hasNewer, channel.id]);

  useEffect(
    () => () => {
      stopEditing(channel.id);
    },
    [channel.id],
  );

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (!stick.current) return;
      el.scrollTop = el.scrollHeight;
      ownScrollTop.current = el.scrollTop;
    });
    observer.observe(el);
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, []);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const bottom = distanceFromBottom < 40;
    if (!(stick.current && bottom) && el.scrollTop !== ownScrollTop.current) {
      cancelPress();
      const popup = useUi.getState().popup;
      if (
        popup?.kind === 'message-menu' &&
        el.scrollTop !== popup.listScrollTop &&
        el.clientHeight === popup.listHeight
      ) {
        closePopup();
      }
    }
    if (heldAtJump.current) {
      if (bottom && win.hasNewer) return;
      heldAtJump.current = false;
    }
    stick.current = bottom;
    setAtBottom(bottom);
    setFollowing(channel.id, bottom);
    if (bottom && document.visibilityState === 'visible') markChannelRead(channel.id);
    if (bottom && win.hasNewer && !loading) void loadLatest(channel.id);
    else if (el.scrollTop < 120 && win.hasOlder && !loading) void loadOlder(channel.id);
  }, [channel.id, win.hasOlder, win.hasNewer, loading, cancelPress]);

  const onContextMenu = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (e.shiftKey) return;
      const target = e.target as Element;
      if (target.closest('a, textarea, input')) return;
      const row = rowOf(target);
      if (!row) return;
      e.preventDefault();
      pressOpenedMenu();
      if (selectionAtPress.current) restoreSelection(selectionAtPress.current);
      selectionAtPress.current = null;
      openMessageMenu(channel.id, row, e.clientX, e.clientY, target);
    },
    [channel.id, pressOpenedMenu],
  );

  const onMouseDown = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    selectionAtPress.current =
      (e.button === 2 || e.ctrlKey) && !e.shiftKey && rowOf(e.target) ? saveSelection() : null;
  }, []);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
      const target = e.target as Element;
      if (target.closest('a, textarea, input, [data-avatar-host]')) return;
      const row = rowOf(target);
      if (!row) return;
      e.preventDefault();
      const box = row.getBoundingClientRect();
      openMessageMenu(channel.id, row, box.left + 16, box.top + 8, null);
    },
    [channel.id],
  );

  useEffect(() => {
    if (atBottom && document.hasFocus()) markChannelRead(channel.id);
    const onFocus = () => {
      if (stick.current) markChannelRead(channel.id);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [channel.id, atBottom, win.messages.length, syncStale]);

  const firstUnreadSeq = useMemo(() => {
    if (!lastReadSeq) return null;
    const first = win.messages.find((m) => m.seq > lastReadSeq && m.authorId !== selfId);
    return first?.seq ?? null;
  }, [win.messages, lastReadSeq, selfId]);

  return (
    <>
      <div
        className={styles.list}
        ref={scroller}
        onScroll={onScroll}
        onContextMenu={onContextMenu}
        onMouseDown={onMouseDown}
        onKeyDown={onKeyDown}
        {...handlers}
        role="log"
        aria-label={`Messages in ${channel.name}`}
      >
        <div ref={content}>
          {win.hasOlder ? (
            loading === 'older' ? (
              <div className={styles.loadingTop}>
                <Spinner /> Loading older messages…
              </div>
            ) : (
              <div className={styles.loadingTop}>
                <Button small onClick={() => void loadOlder(channel.id)}>
                  Load older messages
                </Button>
              </div>
            )
          ) : (
            <div className={styles.startOfChannel}>
              <div>
                <strong>{channel.type === 'text' ? `#${channel.name}` : channel.name}</strong> —
                this is the beginning of the channel.
              </div>
            </div>
          )}

          {win.messages.length === 0 && channelPending.length === 0 ? (
            <EmptyState title="No messages yet">
              Say something to start the conversation.
            </EmptyState>
          ) : null}

          {win.messages.map((msg, index) => {
            const previous = win.messages[index - 1];
            const author = members[msg.authorId];
            const newDay = !previous || !isSameDay(previous.createdAt, msg.createdAt);
            const groupStart =
              newDay ||
              !previous ||
              previous.authorId !== msg.authorId ||
              !!msg.replyTo ||
              !!msg.forwardedFrom ||
              new Date(msg.createdAt).getTime() - new Date(previous.createdAt).getTime() >
                GROUP_WINDOW_MS;
            const originChannel = msg.forwardedFrom
              ? channels.find((c) => c.id === msg.forwardedFrom?.channelId)
              : undefined;
            return (
              <div key={msg.id}>
                {newDay && <div className={styles.daySeparator}>{formatDay(msg.createdAt)}</div>}
                {firstUnreadSeq === msg.seq && <div className={styles.unreadDivider}>New</div>}
                <MessageRow
                  message={msg}
                  author={author}
                  groupStart={groupStart}
                  showTime={
                    !groupStart && !!previous && !isSameMinute(previous.createdAt, msg.createdAt)
                  }
                  isOwn={msg.authorId === selfId}
                  editing={msg.id === editingId}
                  quoteAuthor={msg.replyTo ? members[msg.replyTo.authorId] : undefined}
                  originAuthor={msg.forwardedFrom ? members[msg.forwardedFrom.authorId] : undefined}
                  originIsVoice={originChannel?.type === 'voice'}
                  originReachable={!!originChannel && !!msg.forwardedFrom?.messageId}
                />
              </div>
            );
          })}

          {channelPending.map((p) => (
            <PendingRow
              key={p.nonce}
              pending={p}
              author={members[selfId]}
              quoteAuthor={p.replyQuote ? members[p.replyQuote.authorId] : undefined}
            />
          ))}
        </div>
        <RowActionBars channelId={channel.id} scroller={scroller} />
      </div>

      <span ref={icon} className={styles.swipeIcon} data-testid="swipe-icon" aria-hidden>
        <Reply size={16} />
      </span>

      {(!atBottom || win.hasNewer) && (
        <div className={styles.composerWrap} style={{ padding: 0 }}>
          <div className={styles.jumpToPresent}>
            <Button
              small
              onClick={() => {
                clearJump(channel.id);
                stick.current = true;
                heldAtJump.current = false;
                const el = scroller.current;
                if (el) el.scrollTop = el.scrollHeight;
                setAtBottom(true);
                setFollowing(channel.id, true);
                if (win.hasNewer) void loadLatest(channel.id);
              }}
            >
              <ArrowDown size={14} /> {win.hasNewer ? 'Jump to present' : 'Newest messages'}
            </Button>
          </div>
        </div>
      )}

      {syncStale && (
        <div className={styles.syncWarning} role="status">
          <AlertTriangle size={14} />
          <span>Some messages may be missing — still trying to catch up.</span>
          <button className={styles.retryLink} onClick={() => void resyncChannel(channel.id)}>
            Retry now
          </button>
        </div>
      )}
    </>
  );
}

function RowActionBars({
  channelId,
  scroller,
}: {
  channelId: string;
  scroller: RefObject<HTMLDivElement | null>;
}) {
  const [hovered, setHovered] = useState<HTMLElement | null>(null);
  const [focused, setFocused] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onOver = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') setHovered(rowOf(e.target));
    };
    const onLeave = () => setHovered(null);
    const barFor = (target: EventTarget | null) => {
      const row = rowOf(target);
      if (!row || !window.matchMedia('(pointer: coarse)').matches || target === row) return row;
      return target instanceof Element && target.closest('[data-row-actions]') ? row : null;
    };
    const onFocusIn = (e: FocusEvent) => setFocused(barFor(e.target));
    const onFocusOut = (e: FocusEvent) => {
      if (document.hasFocus()) setFocused(barFor(e.relatedTarget));
    };
    el.addEventListener('pointerover', onOver);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('focusin', onFocusIn);
    el.addEventListener('focusout', onFocusOut);
    return () => {
      el.removeEventListener('pointerover', onOver);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('focusin', onFocusIn);
      el.removeEventListener('focusout', onFocusOut);
    };
  }, [scroller]);

  const rows = [...new Set([hovered, focused])].filter((row) => row !== null);
  return rows.map((row) => (
    <RowActions key={row.dataset.messageId} channelId={channelId} row={row} />
  ));
}

function RowActions({ channelId, row }: { channelId: string; row: HTMLElement }) {
  const messageId = row.dataset.messageId;
  const message = useChat((s) => s.windows[channelId]?.messages.find((m) => m.id === messageId));
  const editing = useChat((s) => s.editing[channelId] === messageId);
  const selfId = useSession((s) => s.user?.id);
  const isOwner = useSession((s) => s.user?.role === 'owner');
  if (!message || editing) return null;
  const isOwn = message.authorId === selfId;
  const copyLabel = messageCopyLabel(message);
  return createPortal(
    <div className={styles.actions} data-row-actions>
      <IconButton label="Reply" icon={<Reply size={15} />} onClick={() => startReply(message)} />
      <IconButton
        label="Forward"
        icon={<Forward size={15} />}
        onClick={() => openForward(message)}
      />
      {copyLabel && (
        <IconButton
          label={copyLabel}
          icon={<Copy size={15} />}
          onClick={() => void copyMessage(message)}
        />
      )}
      {isOwn && !message.forwardedFrom && (
        <IconButton
          label="Edit message"
          icon={<Pencil size={15} />}
          onClick={() => startEditing(channelId, message.id)}
        />
      )}
      {(isOwn || isOwner) && (
        <IconButton
          label="Delete message"
          tone="danger"
          icon={<Trash2 size={15} />}
          onClick={() => confirmDelete(message)}
        />
      )}
    </div>,
    row,
  );
}

function MessageEditor({ message, hasFiles }: { message: MessageDTO; hasFiles: boolean }) {
  const [draft, setDraftText] = useState(
    () => useChat.getState().editDrafts[message.channelId] ?? message.content,
  );
  const [busy, setBusy] = useState(false);

  function finish() {
    if (stopEditing(message.channelId, message.id)) focusRow(message.id);
  }

  async function commit() {
    const text = draft.trim();
    if ((!text && !hasFiles) || text === message.content) {
      finish();
      return;
    }
    setBusy(true);
    const ok = await editMessage(message.id, text);
    setBusy(false);
    if (ok) finish();
  }

  return (
    <div className={styles.editArea}>
      <textarea
        className={styles.textarea}
        style={{
          background: 'var(--bg-input)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: 8,
        }}
        value={draft}
        autoFocus
        placeholder={hasFiles ? 'Add a message' : undefined}
        aria-label="Edit message"
        rows={Math.min(8, draft.split('\n').length + 1)}
        maxLength={LIMITS.messageMax}
        onChange={(e) => {
          setDraftText(e.target.value);
          keepEditDraft(message.channelId, e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') finish();
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void commit();
          }
        }}
      />
      <div className={styles.stateRow}>
        <Button small variant="primary" busy={busy} onClick={() => void commit()}>
          <Check size={14} /> Save
        </Button>
        <Button small variant="ghost" onClick={finish}>
          <X size={14} /> Cancel
        </Button>
        <span>
          <Kbd>Esc</Kbd> cancels · <Kbd>Enter</Kbd> saves
        </span>
      </div>
    </div>
  );
}

const FRESH_MS = 5000;

const MessageRow = memo(function MessageRow({
  message,
  author,
  groupStart,
  showTime,
  isOwn,
  editing,
  quoteAuthor,
  originAuthor,
  originIsVoice,
  originReachable,
}: {
  message: MessageDTO;
  author: UserPublic | undefined;
  groupStart: boolean;
  showTime: boolean;
  isOwn: boolean;
  editing: boolean;
  quoteAuthor: UserPublic | undefined;
  originAuthor: UserPublic | undefined;
  originIsVoice: boolean;
  originReachable: boolean;
}) {
  const name = author?.displayName ?? 'Unknown member';
  const hasFiles = message.attachments.length > 0;
  const [arrived] = useState(
    () => !isOwn && Date.now() - new Date(message.createdAt).getTime() < FRESH_MS,
  );

  const origin = message.forwardedFrom;

  const body = message.content ? (
    <div className={styles.body} data-testid="message-text">
      <FormattedMessage content={message.content} />
      {message.editedAt && (
        <span className={styles.edited} title={formatMessageTimestamp(message.editedAt)}>
          (edited)
        </span>
      )}
    </div>
  ) : null;

  return (
    <div
      className={`${styles.group} ${groupStart ? styles.groupStart : ''} ${arrived ? styles.arrived : ''}`}
    >
      <div
        className={cx(styles.message, message.replyTo && styles.messageQuoting)}
        data-testid="message"
        data-message-id={message.id}
        data-editing={editing || undefined}
        tabIndex={0}
      >
        {message.replyTo && (
          <QuoteLine quote={message.replyTo} author={quoteAuthor} channelId={message.channelId} />
        )}
        {groupStart && (
          <>
            <button
              type="button"
              className={styles.avatarSlot}
              aria-label={`Profile of ${name}`}
              {...memberTrigger(message.authorId)}
            >
              <Avatar
                name={name}
                color={author?.avatarColor ?? '#525252'}
                src={author?.avatarUrl}
                size={36}
              />
            </button>
            <div className={styles.head}>
              <button
                type="button"
                className={styles.author}
                data-testid="message-author"
                {...memberTrigger(message.authorId)}
              >
                <NameText user={author ?? { displayName: name }} />
              </button>
              {author?.role === 'owner' && <OwnerMark className={styles.authorMark} />}
              {author?.disabled && <span className={styles.disabledTag}>Disabled</span>}
              <time
                className={styles.time}
                dateTime={message.createdAt}
                title={formatMessageTimestamp(message.createdAt)}
              >
                {formatMessageTimestamp(message.createdAt)}
              </time>
            </div>
          </>
        )}
        {showTime && (
          <time
            className={styles.hoverTime}
            data-testid="message-hover-time"
            dateTime={message.createdAt}
            title={formatMessageTimestamp(message.createdAt)}
          >
            {formatTime(message.createdAt)}
          </time>
        )}

        {origin ? (
          <>
            <div className={styles.forwardHead}>
              <ForwardLabel />
              <OriginLine
                origin={origin}
                author={originAuthor}
                channelLabel={originIsVoice ? origin.channelName : `#${origin.channelName}`}
                reachable={originReachable}
              />
            </div>
            <div className={styles.forwardBlock}>
              {body}
              {hasFiles && <Attachments attachments={message.attachments} />}
            </div>
          </>
        ) : (
          <>
            {editing ? <MessageEditor message={message} hasFiles={hasFiles} /> : body}
            {hasFiles && <Attachments attachments={message.attachments} />}
            {!editing && !message.content && message.editedAt && (
              <span className={styles.edited} title={formatMessageTimestamp(message.editedAt)}>
                (edited)
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
});

function PendingRow({
  pending,
  author,
  quoteAuthor,
}: {
  pending: PendingMessage;
  author: UserPublic | undefined;
  quoteAuthor: UserPublic | undefined;
}) {
  const name = author?.displayName ?? 'You';
  return (
    <div className={`${styles.group} ${styles.groupStart} ${styles.arrived}`}>
      <div
        className={cx(styles.message, pending.replyQuote && styles.messageQuoting)}
        data-testid="pending-message"
      >
        {pending.replyQuote && (
          <QuoteLine
            quote={pending.replyQuote}
            author={quoteAuthor}
            channelId={pending.channelId}
          />
        )}
        <span className={styles.avatarSlot}>
          <Avatar
            name={name}
            color={author?.avatarColor ?? '#525252'}
            src={author?.avatarUrl}
            size={36}
          />
        </span>
        <div className={styles.head}>
          <span className={styles.author}>
            <NameText user={author ?? { displayName: name }} />
          </span>
        </div>
        {pending.content && (
          <div
            className={`${styles.body} ${pending.status === 'failed' ? styles.failed : styles.pending}`}
          >
            <FormattedMessage content={pending.content} />
          </div>
        )}
        {pending.files && <PendingAttachments pending={pending} />}
        <div className={styles.stateRow}>
          {pending.status === 'waiting' && (
            <>
              <Clock size={12} aria-hidden /> Waiting for other uploads to finish…
              <button className={styles.retryLink} onClick={() => discardPending(pending.nonce)}>
                Cancel
              </button>
            </>
          )}
          {pending.status === 'uploading' && <UploadState pending={pending} />}
          {pending.status === 'sending' && (
            <>
              <Loader2 size={12} className="spin" /> Sending…
            </>
          )}
          {pending.status === 'retrying' && (
            <>
              <RotateCcw size={12} /> Retrying… {pending.error ? `(${pending.error})` : null}
            </>
          )}
          {pending.status === 'failed' && (
            <>
              <span className={styles.failed}>
                Not sent{pending.error ? `: ${pending.error}` : ''}
              </span>
              {canRetryPending(pending) && (
                <button className={styles.retryLink} onClick={() => retryPending(pending.nonce)}>
                  Retry
                </button>
              )}
              {canSendWhatGotThrough(pending) && (
                <button
                  className={styles.retryLink}
                  onClick={() => sendWhatGotThrough(pending.nonce)}
                >
                  Send what got through
                </button>
              )}
              <button className={styles.retryLink} onClick={() => discardPending(pending.nonce)}>
                Discard
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function UploadState({ pending }: { pending: PendingMessage }) {
  const files = pending.files ?? [];
  const percent = useChat((s) => overallPercent(files, s.uploadPercent));
  const done = files.filter((f) => f.attachment).length;
  return (
    <>
      <Loader2 size={12} className="spin" /> Uploading… {percent}%
      <span className="visually-hidden" role="status">
        Uploading file {Math.min(done + 1, files.length)} of {files.length}
      </span>
      <button className={styles.retryLink} onClick={() => discardPending(pending.nonce)}>
        Cancel
      </button>
    </>
  );
}

function Composer({ channel, disabled }: { channel: ChannelDTO; disabled?: boolean }) {
  const draft = useChat((s) => s.drafts[channel.id] ?? '');
  const tray = useChat((s) => s.trays[channel.id] ?? NO_FILES);
  const notice = useChat((s) => s.trayNotices[channel.id]);
  const reply = useChat((s) => s.replies[channel.id]);
  const wantsFocus = useChat((s) => s.composerFocus === channel.id);
  const typingUsers = useChat((s) => s.typing[channel.id]);
  const members = useCommunity((s) => s.members);
  const selfId = useSession((s) => s.user?.id);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastTypingSent = useRef(0);
  const hasFiles = tray.length > 0;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const limit = window.innerHeight * 0.4;
    el.style.height = `${Math.min(el.scrollHeight, limit)}px`;
    el.style.overflowY = el.scrollHeight > limit ? 'auto' : 'hidden';
  }, [draft, hasFiles]);

  useEffect(() => {
    if (!wantsFocus) return;
    ref.current?.focus();
    composerFocused();
  }, [wantsFocus]);

  const names = Object.keys(typingUsers ?? {})
    .filter((id) => id !== selfId)
    .map((id) => members[id]?.displayName ?? 'Someone');

  function send() {
    const text = draft.trim();
    if (!text && !hasFiles) return;
    sendMessage(channel.id, text);
    setDraft(channel.id, '');
    lastTypingSent.current = 0;
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape' && reply) {
      e.preventDefault();
      cancelReply(channel.id);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }

  function onPaste(e: ReactClipboardEvent<HTMLTextAreaElement>) {
    const files = filesFromPaste(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    addToTray(channel.id, files);
  }

  function chosen(e: ChangeEvent<HTMLInputElement>) {
    addToTray(channel.id, Array.from(e.target.files ?? []));
    e.target.value = '';
    typeAgain();
  }

  function typeAgain() {
    if (!window.matchMedia('(pointer: coarse)').matches) ref.current?.focus();
  }

  const label = `Message ${channelLabel(channel)}`;

  return (
    <div className={styles.composerWrap}>
      {notice && (
        <div className={styles.composerNotice}>
          <Banner kind="error">{notice}</Banner>
        </div>
      )}
      <div className={styles.composer}>
        {reply && (
          <ReplyBar
            summary={quoteSummary(reply)}
            placeholder={!reply.excerpt}
            author={members[reply.authorId]}
            onCancel={() => {
              cancelReply(channel.id);
              typeAgain();
            }}
          />
        )}
        {hasFiles && <AttachmentTray channelId={channel.id} files={tray} onRemoved={typeAgain} />}
        <div className={styles.composerRow}>
          <input
            ref={fileInput}
            type="file"
            hidden
            multiple
            accept={ATTACH_ACCEPT}
            onChange={chosen}
            data-testid="attach-input"
          />
          <IconButton
            label="Attach files"
            icon={<Paperclip size={17} />}
            disabled={disabled}
            onClick={() => fileInput.current?.click()}
          />
          <textarea
            ref={ref}
            className={styles.textarea}
            rows={1}
            value={draft}
            disabled={disabled}
            maxLength={LIMITS.messageMax}
            placeholder={label}
            aria-label={label}
            onChange={(e) => {
              setDraft(channel.id, e.target.value);
              const now = Date.now();
              if (e.target.value.trim() && now - lastTypingSent.current > LIMITS.typingThrottleMs) {
                lastTypingSent.current = now;
                emitTyping(channel.id);
              }
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          {hasFiles && (
            <IconButton
              label="Send message"
              tone="active"
              icon={<ArrowUp size={17} />}
              disabled={disabled}
              onClick={() => {
                send();
                typeAgain();
              }}
            />
          )}
        </div>
      </div>
      <div className={styles.composerMeta}>
        <span className={styles.typing} aria-live="polite">
          {names.length === 1
            ? `${names[0]} is typing…`
            : names.length === 2
              ? `${names[0]} and ${names[1]} are typing…`
              : names.length > 2
                ? 'Several people are typing…'
                : ''}
        </span>
        <span>
          {draft.length > LIMITS.messageMax - 200 && (
            <span
              className={`${styles.counter} ${draft.length >= LIMITS.messageMax ? styles.counterWarn : ''}`}
            >
              {draft.length}/{LIMITS.messageMax}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

function ReplyBar({
  summary,
  placeholder,
  author,
  onCancel,
}: {
  summary: string;
  placeholder: boolean;
  author: UserPublic | undefined;
  onCancel: () => void;
}) {
  return (
    <div className={styles.replyBar} data-testid="reply-bar">
      <span className={styles.replyBarWho}>
        Replying to{' '}
        <span className={styles.replyBarName}>
          <NameText user={author ?? { displayName: 'Unknown member' }} />
        </span>
      </span>
      <span className={cx(styles.replyBarText, placeholder && styles.quoteTextPlaceholder)}>
        {summary}
      </span>
      <IconButton
        label="Cancel reply"
        className={styles.replyBarClose}
        icon={<X size={14} />}
        onClick={onCancel}
      />
    </div>
  );
}
