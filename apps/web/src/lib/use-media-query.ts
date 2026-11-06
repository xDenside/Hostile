import { useSyncExternalStore } from 'react';

export const PHONE_QUERY = '(max-width: 720px)';

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', notify);
      return () => list.removeEventListener('change', notify);
    },
    () => window.matchMedia(query).matches,
  );
}

export function useIsPhone(): boolean {
  return useMediaQuery(PHONE_QUERY);
}
