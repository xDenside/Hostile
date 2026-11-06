import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { dragStartedOnThisPage } from '../../lib/drop-guard';
import { dragCarriesFiles } from './attachment-rules';

const DRAG_SILENCE_MS = 1200;

export function useFileDrop(onFiles: (files: File[]) => void, enabled: boolean) {
  const [over, setOver] = useState(false);
  const silence = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const stop = useCallback(() => {
    clearTimeout(silence.current);
    setOver(false);
  }, []);

  useEffect(() => () => clearTimeout(silence.current), []);

  const wanted = (e: DragEvent) =>
    enabled && !dragStartedOnThisPage() && dragCarriesFiles(e.dataTransfer.types);

  const hovering = (e: DragEvent) => {
    if (!wanted(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setOver(true);
    clearTimeout(silence.current);
    silence.current = setTimeout(stop, DRAG_SILENCE_MS);
  };

  return {
    over,
    zone: {
      onDragEnter: hovering,
      onDragOver: hovering,
      onDrop: (e: DragEvent) => {
        if (!wanted(e)) return;
        e.preventDefault();
        stop();
        onFiles(Array.from(e.dataTransfer.files));
      },
    },
    overlay: { onDragLeave: stop },
  };
}
