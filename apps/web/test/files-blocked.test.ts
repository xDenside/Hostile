import { afterEach, describe, expect, it } from 'vitest';
import type { AttachmentDTO, MessageDTO } from '@hostile/shared';
import { FILES_BLOCKED } from '../src/features/chat/files-blocked';
import { copyMessage, fileCopyLabel, messageCopyLabel } from '../src/features/chat/message-actions';
import { useUi } from '../src/stores/ui';
import { useTunnel } from '../src/tunnel/state';

const image = (id: string): AttachmentDTO =>
  ({
    id,
    kind: 'image',
    fileName: `${id}.png`,
    mimeType: 'image/png',
    byteSize: 1200,
    url: `/api/attachments/${id}`,
    width: 320,
    height: 200,
  }) as unknown as AttachmentDTO;

const message = (content: string, attachments: AttachmentDTO[]): MessageDTO =>
  ({ id: 'm1', channelId: 'c1', authorId: 'u1', content, attachments }) as unknown as MessageDTO;

afterEach(() => {
  useTunnel.setState({ filesBlocked: false });
  useUi.setState({ toasts: [] });
});

describe('a guest whose browser refuses the file worker', () => {
  it('is not offered a copy of a message that holds only files', () => {
    expect(messageCopyLabel(message('', [image('a')]), false)).toBe(fileCopyLabel(image('a')));
    expect(messageCopyLabel(message('', [image('a')]), true)).toBeNull();
    expect(messageCopyLabel(message('', [image('a'), image('b')]), true)).toBeNull();
  });

  it('can still copy the words of a message', () => {
    expect(messageCopyLabel(message('hello', [image('a')]), true)).toBe('Copy text');
  });

  it('is told why, instead of being handed a dead link', async () => {
    useTunnel.setState({ filesBlocked: true });
    useUi.setState({ toasts: [] });
    await copyMessage(message('', [image('a')]));
    expect(useUi.getState().toasts.map((t) => t.text)).toEqual([FILES_BLOCKED]);
  });
});
