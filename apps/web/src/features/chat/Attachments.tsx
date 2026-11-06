import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AlertTriangle, Check, Download, Film, ImageOff, RotateCcw, VideoOff } from 'lucide-react';
import type { AttachmentDTO } from '@hostile/shared';
import { mediaUrl } from '../../api/client';
import { cx, uiStyles } from '../../components/ui';
import { useTunnel } from '../../tunnel/state';
import {
  attachmentGrid,
  attachmentRuns,
  fitImage,
  fitVideo,
  formatBytes,
  sameShape,
  MEDIA_MAX_WIDTH,
  type Box,
  type GridCell,
} from './attachment-rules';
import { LocalVideoFrame } from './AttachmentTray';
import { AttachmentViewer } from './AttachmentViewer';
import { useMediaLoad, useNearViewport, useVideoRelease } from './media-recovery';
import {
  deliveredPreview,
  localPreviewUrl,
  useChat,
  type PendingFile,
  type PendingMessage,
} from './store';
import styles from './attachments.module.scss';

const boxStyle = (box: Box): CSSProperties => ({
  width: `min(100%, ${box.width}px)`,
  aspectRatio: `${box.width} / ${box.height}`,
});

const cellStyle = (cell: GridCell): CSSProperties => ({
  gridColumn: `span ${cell.columns}`,
  gridRow: `span ${cell.rows}`,
  aspectRatio: cell.aspect,
});

function FileCard({
  icon,
  name,
  line,
  action,
}: {
  icon: ReactNode;
  name: string;
  line: string;
  action?: ReactNode;
}) {
  return (
    <div className={styles.card} data-testid="attachment-card">
      <span className={styles.cardIcon}>{icon}</span>
      <span className={styles.cardText}>
        <span className={styles.cardName} title={name}>
          {name}
        </span>
        <span className={styles.cardLine}>{line}</span>
      </span>
      {action}
    </div>
  );
}

const IMAGE_FAILED = 'This image could not be loaded.';
const FILES_BLOCKED =
  'Images and videos from the room cannot be shown in this tab. Reloading the page, or another browser, may help.';

function MediaRetry({ name, onRetry }: { name: string; onRetry: () => void }) {
  return (
    <button
      type="button"
      className={styles.retry}
      aria-label={`Could not load ${name}. Try again`}
      title={`Could not load ${name}. Try again`}
      data-testid="media-retry"
      onClick={onRetry}
    >
      <RotateCcw size={18} aria-hidden />
      <span className={styles.retryText} aria-hidden>
        Could not load. Try again
      </span>
    </button>
  );
}

function ImageButton({
  attachment,
  src,
  fit,
  ready,
  onOpen,
  onLoad,
  onError,
}: {
  attachment: AttachmentDTO;
  src: string;
  fit: 'cover' | 'contain';
  ready: boolean;
  onOpen: () => void;
  onLoad: (image: HTMLImageElement) => void;
  onError: () => void;
}) {
  return (
    <button
      type="button"
      className={styles.imageButton}
      aria-label={`Open image ${attachment.fileName}`}
      onClick={(e) => {
        e.currentTarget.focus({ preventScroll: true });
        onOpen();
      }}
    >
      <img
        className={cx(
          styles.picture,
          fit === 'contain' && styles.pictureContain,
          ready && styles.pictureReady,
        )}
        src={src}
        alt={attachment.fileName}
        loading="lazy"
        decoding="async"
        onLoad={(e) => onLoad(e.currentTarget)}
        onError={onError}
      />
    </button>
  );
}

function useImageSource(attachment: AttachmentDTO) {
  const [preview, setPreview] = useState(() => deliveredPreview(attachment.id));
  const [ready, setReady] = useState(preview !== null);
  const url = mediaUrl(attachment.url);
  const load = useMediaLoad(url);
  const blocked = useTunnel((s) => s.filesBlocked) && !preview;
  return {
    src: preview?.url ?? url,
    drawnAt: preview,
    ready,
    attempt: load.attempt,
    failedLine: blocked ? FILES_BLOCKED : IMAGE_FAILED,
    failed: blocked || load.failure === 'missing' || load.failure === 'broken',
    unreachable: load.failure === 'unreachable',
    tryAgain: load.tryAgain,
    loaded: () => {
      load.loaded();
      setReady(true);
    },
    errored: () => {
      if (preview) setPreview(null);
      else void load.imageFailed();
    },
  };
}

function SingleImage({ attachment, onOpen }: { attachment: AttachmentDTO; onOpen: () => void }) {
  const source = useImageSource(attachment);
  const [drawn, setDrawn] = useState<{ width: number | null; height: number | null } | null>(
    source.drawnAt,
  );
  if (source.failed) {
    return (
      <FileCard
        icon={<ImageOff size={18} aria-hidden />}
        name={attachment.fileName}
        line={source.failedLine}
      />
    );
  }
  const size = drawn?.width && drawn.height ? drawn : attachment;
  return (
    <div
      className={styles.box}
      style={boxStyle(fitImage(size.width, size.height))}
      data-testid="attachment-image"
      data-attachment-id={attachment.id}
    >
      {source.unreachable ? (
        <MediaRetry name={attachment.fileName} onRetry={source.tryAgain} />
      ) : (
        <ImageButton
          key={source.attempt}
          attachment={attachment}
          src={source.src}
          fit="contain"
          ready={source.ready}
          onOpen={onOpen}
          onLoad={(img) => {
            source.loaded();
            const { naturalWidth: width, naturalHeight: height } = img;
            if (width && height && !sameShape(width, height, size.width, size.height)) {
              setDrawn({ width, height });
            }
          }}
          onError={source.errored}
        />
      )}
    </div>
  );
}

function GridImage({
  attachment,
  cell,
  onOpen,
}: {
  attachment: AttachmentDTO;
  cell: GridCell;
  onOpen: () => void;
}) {
  const source = useImageSource(attachment);
  return (
    <div
      className={styles.cell}
      style={cellStyle(cell)}
      data-testid="attachment-image"
      data-attachment-id={attachment.id}
    >
      {source.failed ? (
        <span className={styles.cellFailed} title={`${attachment.fileName}: ${source.failedLine}`}>
          <ImageOff size={18} aria-hidden />
          <span className="visually-hidden">
            {attachment.fileName}: {source.failedLine}
          </span>
        </span>
      ) : source.unreachable ? (
        <MediaRetry name={attachment.fileName} onRetry={source.tryAgain} />
      ) : (
        <ImageButton
          key={source.attempt}
          attachment={attachment}
          src={source.src}
          fit="cover"
          ready={source.ready}
          onOpen={onOpen}
          onLoad={source.loaded}
          onError={source.errored}
        />
      )}
    </div>
  );
}

const RESUME_FROM_SECONDS = 0.1;

function MountedVideo({
  src,
  name,
  resumeAtRef,
  onPlaying,
  onSilent,
  onLoaded,
  onFailed,
}: {
  src: string;
  name: string;
  resumeAtRef: { current: number };
  onPlaying: (playing: boolean) => void;
  onSilent: () => void;
  onLoaded: () => void;
  onFailed: (code: number | undefined) => void;
}) {
  const element = useRef<HTMLVideoElement>(null);
  useVideoRelease(element, src, (el) => {
    if (el.currentTime > RESUME_FROM_SECONDS) resumeAtRef.current = el.currentTime;
  });
  return (
    <video
      ref={element}
      className={styles.video}
      src={src}
      controls
      preload="metadata"
      playsInline
      aria-label={name}
      onLoadedMetadata={(e) => {
        const el = e.currentTarget;
        if (el.videoWidth === 0) return onSilent();
        onLoaded();
        if (resumeAtRef.current) el.currentTime = resumeAtRef.current;
      }}
      onPlay={() => onPlaying(true)}
      onPause={() => onPlaying(false)}
      onEnded={() => onPlaying(false)}
      onError={(e) => {
        onPlaying(false);
        onFailed(e.currentTarget.error?.code);
      }}
    />
  );
}

function VideoAttachment({ attachment }: { attachment: AttachmentDTO }) {
  const blocked = useTunnel((s) => s.filesBlocked);
  if (blocked) {
    return (
      <FileCard
        icon={<VideoOff size={18} aria-hidden />}
        name={attachment.fileName}
        line={FILES_BLOCKED}
      />
    );
  }
  return <LoadedVideo attachment={attachment} />;
}

function LoadedVideo({ attachment }: { attachment: AttachmentDTO }) {
  const url = mediaUrl(attachment.url);
  const load = useMediaLoad(url);
  const box = useRef<HTMLDivElement>(null);
  const near = useNearViewport(box);
  const [playing, setPlaying] = useState(false);
  const [silent, setSilent] = useState(false);
  const resumeAt = useRef(0);
  if (load.failure === 'missing') {
    return (
      <FileCard
        icon={<VideoOff size={18} aria-hidden />}
        name={attachment.fileName}
        line="This video could not be loaded."
      />
    );
  }
  if (load.failure === 'broken' || silent) {
    return (
      <FileCard
        icon={<VideoOff size={18} aria-hidden />}
        name={attachment.fileName}
        line={`${formatBytes(attachment.byteSize)}. This browser cannot play it.`}
        action={
          <a
            className={cx(uiStyles.button, uiStyles.secondary, uiStyles.small, styles.cardAction)}
            href={url}
            download={attachment.fileName}
          >
            <Download size={14} aria-hidden /> Download
          </a>
        }
      />
    );
  }
  return (
    <div
      ref={box}
      className={styles.box}
      style={boxStyle(fitVideo(attachment.width, attachment.height))}
      data-testid="attachment-video"
      data-attachment-id={attachment.id}
    >
      {load.failure === 'unreachable' ? (
        <MediaRetry name={attachment.fileName} onRetry={load.tryAgain} />
      ) : near || playing ? (
        <MountedVideo
          key={load.attempt}
          src={`${url}#t=0.001`}
          name={attachment.fileName}
          resumeAtRef={resumeAt}
          onPlaying={setPlaying}
          onSilent={() => setSilent(true)}
          onLoaded={load.loaded}
          onFailed={(code) => void load.videoFailed(code)}
        />
      ) : null}
    </div>
  );
}

export function Attachments({ attachments }: { attachments: AttachmentDTO[] }) {
  const images = useMemo(() => attachments.filter((a) => a.kind === 'image'), [attachments]);
  const runs = useMemo(() => attachmentRuns(attachments), [attachments]);
  const [viewing, setViewing] = useState<number | null>(null);
  const openImage = (attachment: AttachmentDTO) =>
    setViewing(images.findIndex((a) => a.id === attachment.id));

  return (
    <div className={styles.media} style={{ maxWidth: MEDIA_MAX_WIDTH }} data-testid="attachments">
      {runs.map((run) => {
        const first = run.items[0];
        if (run.kind === 'video') return <VideoAttachment key={first.id} attachment={first} />;
        if (run.items.length === 1) {
          return (
            <SingleImage key={first!.id} attachment={first!} onOpen={() => openImage(first!)} />
          );
        }
        const cells = attachmentGrid(run.items.length);
        return (
          <div key={first!.id} className={styles.grid}>
            {run.items.map((attachment, i) => (
              <GridImage
                key={attachment.id}
                attachment={attachment}
                cell={cells[i]!}
                onOpen={() => openImage(attachment)}
              />
            ))}
          </div>
        );
      })}
      {viewing !== null && images[viewing] && (
        <AttachmentViewer
          images={images}
          index={viewing}
          onIndex={setViewing}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}

function PendingVideoFrame({ url, className }: { url: string; className: string }) {
  const area = useRef<HTMLSpanElement>(null);
  const near = useNearViewport(area);
  return (
    <span ref={area} className={styles.fill}>
      {near && <LocalVideoFrame url={url} className={className} />}
    </span>
  );
}

function PendingTile({ file, uploading }: { file: PendingFile; uploading: boolean }) {
  const percent = useChat((s) => s.uploadPercent[file.id]);
  const url = file.attachment ? mediaUrl(file.attachment.url) : null;
  const preview = localPreviewUrl(file.id) ?? url;
  const waiting = !file.attachment;
  const moving = uploading && waiting && percent !== undefined;
  const pictureClass = cx(styles.picture, styles.pictureReady, waiting && styles.pictureWaiting);
  if (!preview) return null;
  return (
    <>
      {file.kind === 'image' ? (
        <img
          className={pictureClass}
          src={preview}
          alt={file.name}
          decoding="async"
          draggable={false}
        />
      ) : (
        <PendingVideoFrame url={preview} className={pictureClass} />
      )}
      {file.attachment && uploading ? (
        <span className={styles.tileBadge}>
          <Check size={13} aria-hidden />
        </span>
      ) : (
        file.kind === 'video' && (
          <span className={styles.tileBadge}>
            <Film size={13} aria-hidden />
          </span>
        )
      )}
      {moving && (
        <>
          <span className={styles.tilePercent} aria-hidden>
            {percent}%
          </span>
          <span
            className={styles.tileTrack}
            role="progressbar"
            aria-label={`Uploading ${file.name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span className={styles.tileFill} style={{ transform: `scaleX(${percent / 100})` }} />
          </span>
        </>
      )}
      {file.failed && (
        <span className={cx(styles.tileBadge, styles.tileBadgeFailed)}>
          <AlertTriangle size={13} aria-hidden />
        </span>
      )}
    </>
  );
}

export function PendingAttachments({ pending }: { pending: PendingMessage }) {
  const files = pending.files ?? [];
  const uploading = pending.status === 'uploading';
  const shown = files.filter((f) => f.attachment || localPreviewUrl(f.id));
  const missing = files.filter((f) => !f.attachment && !localPreviewUrl(f.id));
  const runs = attachmentRuns(shown);
  const tileClass = (file: PendingFile) => cx(styles.box, file.failed && styles.tileFailed);

  return (
    <div className={styles.media} style={{ maxWidth: MEDIA_MAX_WIDTH }}>
      {runs.map((run) => {
        const first = run.items[0]!;
        if (run.items.length === 1) {
          const box =
            first.kind === 'video'
              ? fitVideo(first.width, first.height)
              : fitImage(first.width, first.height);
          return (
            <div
              key={first.id}
              className={tileClass(first)}
              style={boxStyle(box)}
              data-testid="pending-file"
            >
              <PendingTile file={first} uploading={uploading} />
            </div>
          );
        }
        const cells = attachmentGrid(run.items.length);
        return (
          <div key={first.id} className={styles.grid}>
            {run.items.map((file, i) => (
              <div
                key={file.id}
                className={cx(styles.cell, file.failed && styles.tileFailed)}
                style={cellStyle(cells[i]!)}
                data-testid="pending-file"
              >
                <PendingTile file={file} uploading={uploading} />
              </div>
            ))}
          </div>
        );
      })}
      {missing.map((file) => (
        <FileCard
          key={file.id}
          icon={
            file.kind === 'video' ? (
              <VideoOff size={18} aria-hidden />
            ) : (
              <ImageOff size={18} aria-hidden />
            )
          }
          name={file.name}
          line={`${formatBytes(file.size)}. Not uploaded.`}
        />
      ))}
    </div>
  );
}
