import { useIsPhone } from '../../lib/use-media-query';
import { useUi } from '../../stores/ui';

export function useVoiceChat() {
  const phone = useIsPhone();
  const open = useUi((s) => (phone ? s.phoneChatOpen : s.voiceChatOpen));
  const setOpen = (next: boolean) =>
    useUi.setState(phone ? { phoneChatOpen: next } : { voiceChatOpen: next });
  return { open, setOpen };
}
