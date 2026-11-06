import { useTunnel } from '../../tunnel/state';

export const FILES_BLOCKED =
  'Images and videos from the room cannot be shown in this tab. Reloading the page, or another browser, may help.';

export function useFilesBlocked(): boolean {
  return useTunnel((s) => s.filesBlocked);
}
