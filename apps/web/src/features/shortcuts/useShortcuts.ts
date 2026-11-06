import { useEffect } from 'react';
import { toast, useUi } from '../../stores/ui';
import { voice } from '../voice/controller';
import { toggleStreamFullscreen } from '../voice/fullscreen';
import { useVoice } from '../voice/store';
import {
  actionFor,
  bindingFromPress,
  firesWhileTyping,
  isMacLike,
  isTextTarget,
  type ShortcutAction,
} from './bindings';

function run(action: ShortcutAction) {
  if (action === 'toggleMute') voice().toggleMute();
  if (action === 'toggleDeafen') voice().toggleDeafen();
  if (action === 'fullscreenShare' && !toggleStreamFullscreen()) {
    toast('There is no stream on screen to make fullscreen.');
  }
}

export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.isComposing || useUi.getState().capturingKeys) return;
      const binding = bindingFromPress(e);
      if (!binding) return;
      const action = actionFor(useVoice.getState().shortcuts, binding);
      if (!action) return;
      if (
        isTextTarget(e.target) &&
        !firesWhileTyping(e, e.getModifierState('AltGraph'), isMacLike())
      ) {
        return;
      }
      e.preventDefault();
      run(action);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
