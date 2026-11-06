import { useRef, useState } from 'react';
import { Film, X } from 'lucide-react';
import { cx, uiStyles } from '../../components/ui';
import { formatBytes } from './attachment-rules';
import { useVideoRelease } from './media-recovery';
import { localPreviewUrl, removeFromTray, type OutgoingFile } from './store';
import styles from './attachments.module.scss';

export function LocalVideoFrame({ url, className }: { url: string; className?: string }) {
  const [playable, setPlayable] = useState(true);
  const element = useRef<HTMLVideoElement>(null);
  const src = `${url}#t=0.001`;
  useVideoRelease(element, src);
  if (!playable) return null;
  return (
    <video
      ref={element}
      className={className}
      src={src}
      muted
      playsInline
      preload="metadata"
      tabIndex={-1}
      aria-hidden
      onError={() => setPlayable(false)}
    />
  );
}

export function AttachmentTray({
  channelId,
  files,
  onRemoved,
}: {
  channelId: string;
  files: OutgoingFile[];
  onRemoved: () => void;
}) {
  return (
    <ul className={styles.tray} aria-label="Files to send" data-testid="attachment-tray">
      {files.map((file) => {
        const preview = localPreviewUrl(file.id);
        return (
          <li key={file.id} className={styles.chip} data-testid="tray-file">
            <span className={styles.chipThumb}>
              {file.kind === 'video' && (
                <span className={styles.chipThumbIcon}>
                  <Film size={13} aria-hidden />
                </span>
              )}
              {preview &&
                (file.kind === 'image' ? (
                  <img
                    className={styles.chipMedia}
                    src={preview}
                    alt=""
                    decoding="async"
                    draggable={false}
                  />
                ) : (
                  <LocalVideoFrame url={preview} className={styles.chipMedia} />
                ))}
            </span>
            <span className={styles.chipText}>
              <span className={styles.chipName} title={file.name}>
                {file.name}
              </span>
              <span className={styles.chipSize}>{formatBytes(file.size)}</span>
            </span>
            <button
              type="button"
              className={cx(uiStyles.iconButton, styles.chipRemove)}
              aria-label={`Remove ${file.name}`}
              onClick={() => {
                removeFromTray(channelId, file.id);
                onRemoved();
              }}
            >
              <X size={15} aria-hidden />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
