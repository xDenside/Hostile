let fromThisPage = false;

export const dragStartedOnThisPage = () => fromThisPage;

function browserWouldOpen(e: DragEvent): boolean {
  const types = e.dataTransfer?.types ?? [];
  if (types.includes('Files')) return true;
  if (!types.includes('text/uri-list')) return false;
  return !(e.target instanceof Element && e.target.closest('input, textarea, [contenteditable]'));
}

function refuse(e: DragEvent) {
  if (e.defaultPrevented || !browserWouldOpen(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
}

let installed = false;

export function installDropGuard() {
  if (installed) return;
  installed = true;
  window.addEventListener('dragstart', () => {
    fromThisPage = true;
  });
  window.addEventListener('dragend', () => {
    fromThisPage = false;
  });
  window.addEventListener('dragover', refuse);
  window.addEventListener('drop', refuse);
}
