type SafariVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

export function enterVideoFullscreen(video: SafariVideo | null | undefined) {
  if (!video) return;
  if (video.requestFullscreen) void video.requestFullscreen().catch(() => undefined);
  else video.webkitEnterFullscreen?.();
}

export function toggleStreamFullscreen(): boolean {
  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => undefined);
    return true;
  }
  const video = document.querySelector<HTMLVideoElement>('video[data-share-video]');
  enterVideoFullscreen(video);
  return !!video;
}
