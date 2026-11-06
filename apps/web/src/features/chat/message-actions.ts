import type { AttachmentDTO, MessageDTO, MessageOriginDTO } from '@hostile/shared';
import { mediaUrl } from '../../api/client';
import { useCommunity } from '../../stores/community';
import { useSession } from '../../stores/session';
import { openPopup, selectChannel, toast, useUi } from '../../stores/ui';
import { requestJump, startDelete, startForward } from './store';

const ROW_SELECTOR = '[data-message-id]';

export const rowOf = (target: EventTarget | null): HTMLElement | null =>
  target instanceof Element ? target.closest<HTMLElement>(ROW_SELECTOR) : null;

export const findRow = (messageId: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);

export function focusRow(messageId: string) {
  findRow(messageId)?.focus({ preventScroll: true });
}

export function selectionIn(row: HTMLElement): string {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return '';
  return row.contains(selection.getRangeAt(0).commonAncestorContainer) ? selection.toString() : '';
}

export function saveSelection(): Range[] {
  const selection = window.getSelection();
  if (!selection) return [];
  return Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i));
}

export function restoreSelection(ranges: Range[]) {
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  for (const range of ranges) selection.addRange(range);
}

export function openMessageMenu(
  channelId: string,
  row: HTMLElement,
  x: number,
  y: number,
  target: EventTarget | null,
) {
  const file =
    target instanceof Element
      ? target.closest<HTMLElement>('[data-attachment-id]')?.dataset.attachmentId
      : undefined;
  const selection = selectionIn(row);
  const list = row.closest('[role="log"]');
  row.focus({ preventScroll: true });
  openPopup({
    kind: 'message-menu',
    channelId,
    messageId: row.dataset.messageId!,
    attachmentId: file ?? null,
    selection,
    listScrollTop: list?.scrollTop ?? 0,
    listHeight: list?.clientHeight ?? 0,
    x,
    y,
  });
}

export async function copyToClipboard(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done, 'success');
  } catch {
    toast('Could not copy that. This browser refused.', 'error');
  }
}

const copiesAsPicture = (file: AttachmentDTO) =>
  file.kind === 'image' &&
  file.contentType !== 'image/gif' &&
  typeof ClipboardItem !== 'undefined' &&
  !!navigator.clipboard?.write;

const fileLink = (file: AttachmentDTO) => new URL(mediaUrl(file.url), window.location.href).href;

function moves(head: Uint8Array): boolean {
  const text = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to));
  if (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') {
    return text(12, 16) === 'VP8X' && ((head[20] ?? 0) & 0x02) !== 0;
  }
  if (text(1, 4) !== 'PNG') return false;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  for (let at = 8; at + 8 <= head.length; at += 12 + view.getUint32(at)) {
    const type = text(at + 4, at + 8);
    if (type === 'acTL') return true;
    if (type === 'IDAT') return false;
  }
  return false;
}

const HEAD_BYTES = 64 * 1024;

async function pngOf(file: AttachmentDTO): Promise<Blob> {
  const response = await fetch(mediaUrl(file.url));
  if (!response.ok) throw new Error(`The picture answered ${response.status}.`);
  const blob = await response.blob();
  if (moves(new Uint8Array(await blob.slice(0, HEAD_BYTES).arrayBuffer()))) {
    throw new Error('A picture that moves goes as a link.');
  }
  if (blob.type === 'image/png') return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  bitmap.close();
  return await new Promise((resolve, reject) => {
    canvas.toBlob((png) => (png ? resolve(png) : reject(new Error('No PNG.'))), 'image/png');
  });
}

export async function copyFile(file: AttachmentDTO) {
  if (copiesAsPicture(file)) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngOf(file) })]);
      toast('Image copied.', 'success');
      return;
    } catch {}
  }
  await copyToClipboard(fileLink(file), 'Link copied.');
}

export const fileCopyLabel = (file: AttachmentDTO) =>
  copiesAsPicture(file) ? 'Copy image' : 'Copy link';

export function messageCopyLabel(message: MessageDTO): string | null {
  if (message.content) return 'Copy text';
  const [first, ...rest] = message.attachments;
  if (!first) return null;
  return rest.length > 0 ? 'Copy links' : fileCopyLabel(first);
}

export async function copyMessage(message: MessageDTO) {
  if (message.content) return copyToClipboard(message.content, 'Text copied.');
  const [first, ...rest] = message.attachments;
  if (!first) return;
  if (rest.length === 0) return copyFile(first);
  return copyToClipboard(message.attachments.map(fileLink).join('\n'), 'Links copied.');
}

export const keyboardIsOnRow = (messageId: string): boolean =>
  !!findRow(messageId)?.contains(document.activeElement) &&
  !window.matchMedia('(pointer: coarse)').matches;

export function rowInstead(messageId: string): HTMLElement | null {
  const row = findRow(messageId);
  if (!row) return null;
  const rows = Array.from(
    row.closest('[role="log"]')?.querySelectorAll<HTMLElement>(ROW_SELECTOR) ?? [],
  );
  const at = rows.indexOf(row);
  return rows[at + 1] ?? rows[at - 1] ?? null;
}

export function confirmDelete(message: MessageDTO) {
  focusRow(message.id);
  startDelete(message);
}

export function openForward(message: MessageDTO) {
  focusRow(message.id);
  startForward(message);
}

export function jumpToOrigin(origin: MessageOriginDTO) {
  if (!origin.messageId || origin.seq === null) return;
  const channel = useCommunity.getState().channels.find((c) => c.id === origin.channelId);
  if (!channel) return;
  requestJump(origin.channelId, { messageId: origin.messageId, seq: origin.seq });
  selectChannel(origin.channelId, useSession.getState().user?.id);
  if (channel.type === 'voice') useUi.setState({ voiceChatOpen: true, phoneChatOpen: true });
}
