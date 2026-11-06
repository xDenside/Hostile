export const BRAND = {
  displayName: 'Hostile',
  name: 'Hostile',
  slug: 'hostile',
  desktopScheme: 'hostile',
  desktopHost: 'hostile',
} as const;

export const DESKTOP_ORIGIN = `${BRAND.desktopScheme}://${BRAND.desktopHost}` as const;
