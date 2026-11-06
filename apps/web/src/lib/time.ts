const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});
const relativeFmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'medium' });

export function formatTime(iso: string): string {
  return timeFmt.format(new Date(iso));
}

export function formatFull(iso: string): string {
  return fullFmt.format(new Date(iso));
}

export function formatMessageTimestamp(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  if (t >= startOfToday) return `Today at ${timeFmt.format(d)}`;
  if (t >= startOfToday - 86_400_000) return `Yesterday at ${timeFmt.format(d)}`;
  return `${dateFmt.format(d)} ${timeFmt.format(d)}`;
}

export function isSameMinute(a: string, b: string): boolean {
  return Math.floor(Date.parse(a) / 60_000) === Math.floor(Date.parse(b) / 60_000);
}

export function isSameDay(a: string, b: string): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  );
}

export function formatDay(iso: string): string {
  return dateFmt.format(new Date(iso));
}

export function formatAgo(iso: string, now = Date.now()): string {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return relativeFmt.format(-Math.floor(seconds / 60), 'minute');
  if (seconds < 86_400) return relativeFmt.format(-Math.floor(seconds / 3600), 'hour');
  if (seconds < 30 * 86_400) return relativeFmt.format(-Math.floor(seconds / 86_400), 'day');
  return `on ${formatDate(iso)}`;
}

export function formatDate(iso: string): string {
  return dateFmt.format(new Date(iso));
}
