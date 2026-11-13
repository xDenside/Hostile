export function tabTitle(base: string, unread: number): string {
  if (unread <= 0) return base;
  return `(${unread > 99 ? '99+' : unread}) ${base}`;
}
