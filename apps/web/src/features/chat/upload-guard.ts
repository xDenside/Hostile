import { isUploading, useChat } from './store';

function askFirst(e: BeforeUnloadEvent) {
  e.preventDefault();
  e.returnValue = '';
}

export function installUploadGuard() {
  let guarding = false;
  useChat.subscribe((s, prev) => {
    if (s.pending === prev.pending) return;
    const uploading = isUploading(s.pending);
    if (uploading === guarding) return;
    guarding = uploading;
    if (uploading) window.addEventListener('beforeunload', askFirst);
    else window.removeEventListener('beforeunload', askFirst);
  });
}
