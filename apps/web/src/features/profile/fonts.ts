import '@fontsource/unbounded/latin-700.css';
import '@fontsource/unbounded/cyrillic-700.css';
import '@fontsource/playfair-display/latin-700.css';
import '@fontsource/playfair-display/cyrillic-700.css';
import '@fontsource/pacifico/latin-400.css';
import '@fontsource/pacifico/cyrillic-400.css';
import '@fontsource/caveat/latin-700.css';
import '@fontsource/caveat/cyrillic-700.css';
import '@fontsource/press-start-2p/latin-400.css';
import '@fontsource/press-start-2p/cyrillic-400.css';
import '@fontsource/jetbrains-mono/latin-700.css';
import '@fontsource/jetbrains-mono/cyrillic-700.css';
import '@fontsource/comfortaa/latin-700.css';
import '@fontsource/comfortaa/cyrillic-700.css';
import '@fontsource/russo-one/latin-400.css';
import '@fontsource/russo-one/cyrillic-400.css';
import type { NameEffect, NameFont } from '@hostile/shared';

export const NAME_FONT_LABELS: Record<NameFont, string> = {
  default: 'Default',
  unbounded: 'Unbounded',
  playfair: 'Playfair',
  pacifico: 'Pacifico',
  caveat: 'Caveat',
  pixel: 'Pixel',
  mono: 'Mono',
  comfortaa: 'Comfortaa',
  russo: 'Russo',
};

export const NAME_EFFECT_LABELS: Record<NameEffect, string> = {
  none: 'Plain',
  gradient: 'Gradient',
  shine: 'Shine',
  neon: 'Neon',
  marker: 'Highlighter',
  aurora: 'Aurora',
  glitch: 'Glitch',
  pop: 'Pop',
};
