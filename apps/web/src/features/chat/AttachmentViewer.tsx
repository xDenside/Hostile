import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, ImageOff, X } from 'lucide-react';
import type { AttachmentDTO } from '@hostile/shared';
import { mediaUrl } from '../../api/client';
import { cx, IconButton, Spinner, uiStyles, useDialog } from '../../components/ui';
import styles from './attachments.module.scss';

function ViewerImage({ image }: { image: AttachmentDTO }) {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  if (state === 'failed') {
    return (
      <div className={styles.viewerFailed}>
        <ImageOff size={22} aria-hidden />
        This image could not be loaded.
      </div>
    );
  }
  return (
    <>
      {state === 'loading' && (
        <div className={styles.viewerLoading}>
          <Spinner />
        </div>
      )}
      <img
        className={cx(styles.viewerImage, state === 'ready' && styles.viewerImageReady)}
        src={mediaUrl(image.url)}
        alt={image.fileName}
        draggable={false}
        onLoad={() => setState('ready')}
        onError={() => setState('failed')}
      />
    </>
  );
}

export function AttachmentViewer({
  images,
  index,
  onIndex,
  onClose,
}: {
  images: AttachmentDTO[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const image = images[index]!;
  const several = images.length > 1;

  useDialog(ref, onClose);

  useEffect(() => {
    const root = document.getElementById('root');
    if (root) root.inert = true;
    ref.current?.focus();
  }, []);
  useLayoutEffect(
    () => () => {
      const root = document.getElementById('root');
      if (root) root.inert = false;
    },
    [],
  );

  const step = (by: number) => onIndex((index + by + images.length) % images.length);
  const stepRef = useRef(step);
  useEffect(() => {
    stepRef.current = step;
  });
  useEffect(() => {
    if (!several) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      e.stopPropagation();
      stepRef.current(e.key === 'ArrowLeft' ? -1 : 1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [several]);

  const onBackgroundClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, a')) return;
    if (target.tagName === 'IMG' && !window.matchMedia('(pointer: coarse)').matches) return;
    onClose();
  };

  return createPortal(
    <div
      ref={ref}
      className={styles.viewer}
      role="dialog"
      aria-modal="true"
      aria-label={`Image: ${image.fileName}`}
      tabIndex={-1}
      data-testid="image-viewer"
      onClick={onBackgroundClick}
    >
      <div className={styles.viewerBar}>
        <span className={styles.viewerName} title={image.fileName}>
          {image.fileName}
        </span>
        {several && (
          <span className={styles.viewerCount} aria-live="polite">
            {index + 1} of {images.length}
          </span>
        )}
        <a
          className={cx(uiStyles.button, uiStyles.ghost, uiStyles.small, styles.viewerDownload)}
          href={mediaUrl(image.url)}
          download={image.fileName}
        >
          <Download size={14} aria-hidden /> Download
        </a>
        <IconButton label="Close" icon={<X size={18} />} tipBelow data-close onClick={onClose} />
      </div>
      <div className={styles.viewerStage}>
        <ViewerImage key={image.id} image={image} />
        {several && (
          <>
            <span className={cx(styles.viewerNav, styles.viewerPrev)}>
              <button
                type="button"
                className={uiStyles.iconButton}
                aria-label="Previous image"
                onClick={() => step(-1)}
              >
                <ChevronLeft size={20} aria-hidden />
              </button>
            </span>
            <span className={cx(styles.viewerNav, styles.viewerNext)}>
              <button
                type="button"
                className={uiStyles.iconButton}
                aria-label="Next image"
                onClick={() => step(1)}
              >
                <ChevronRight size={20} aria-hidden />
              </button>
            </span>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
