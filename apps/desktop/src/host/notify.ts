const MOST_SHOWN = 48;
export const NOTE_EVERY_MS = 10_000;

export function notificationBody(nickname: string, platform: NodeJS.Platform): string {
  const short = [...nickname].slice(0, MOST_SHOWN).join('');
  if (platform !== 'linux') return short;
  return short.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export interface Asking {
  nickname: string;
  waiting: number;
}

export interface NoteWords {
  title: string;
  body: string;
}

function wordsFor({ nickname, waiting }: Asking, platform: NodeJS.Platform): NoteWords {
  if (waiting > 1)
    return { title: `${waiting} people are asking to join`, body: 'Open the app to answer them.' };
  return { title: 'Someone is asking to join', body: notificationBody(nickname, platform) };
}

export function noteEachAsking(show: (words: NoteWords) => void, platform: NodeJS.Platform) {
  let quietUntil = 0;
  let held: Asking | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const send = (asking: Asking) => {
    quietUntil = Date.now() + NOTE_EVERY_MS;
    show(wordsFor(asking, platform));
  };
  return (asking: Asking) => {
    const wait = quietUntil - Date.now();
    if (wait <= 0) return send(asking);
    held = asking;
    timer ??= setTimeout(() => {
      timer = null;
      send(held!);
    }, wait);
    timer.unref?.();
  };
}
