import type { AttachmentKind } from '@hostile/shared';

const MEASURE_TIMEOUT_MS = 5000;

export interface MediaSize {
  width: number;
  height: number;
}

export function measureLocalMedia(kind: AttachmentKind, url: string): Promise<MediaSize | null> {
  return new Promise((resolve) => {
    let finish: (size: MediaSize | null) => void;
    const timer = setTimeout(() => finish(null), MEASURE_TIMEOUT_MS);
    const sized = (width: number, height: number) =>
      finish(width > 0 && height > 0 ? { width, height } : null);

    if (kind === 'image') {
      const img = new Image();
      finish = (size) => {
        clearTimeout(timer);
        img.onload = img.onerror = null;
        resolve(size);
      };
      img.onload = () => sized(img.naturalWidth, img.naturalHeight);
      img.onerror = () => finish(null);
      img.src = url;
      return;
    }

    const video = document.createElement('video');
    finish = (size) => {
      clearTimeout(timer);
      video.onloadedmetadata = video.onerror = null;
      video.removeAttribute('src');
      video.load();
      resolve(size);
    };
    video.preload = 'metadata';
    video.muted = true;
    video.onloadedmetadata = () => sized(video.videoWidth, video.videoHeight);
    video.onerror = () => finish(null);
    video.src = url;
  });
}
