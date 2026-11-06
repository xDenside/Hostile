import { LIMITS } from './limits.js';

const INLINE_MARKUP =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~\n]+~~)|(https?:\/\/[^\s<]+)/g;

function withoutMarkers(token: string): string {
  if (/^https?:/.test(token)) return token;
  const width = /^(\*\*|__|~~)/.test(token) ? 2 : 1;
  return withoutInlineMarkup(token.slice(width, -width));
}

function withoutInlineMarkup(text: string): string {
  return text.replace(INLINE_MARKUP, withoutMarkers);
}

export function messageExcerpt(content: string, max: number = LIMITS.replyExcerptMax): string {
  const plain = withoutInlineMarkup(
    content
      .replace(/```[a-z0-9+#-]{0,12}\n/gi, '')
      .replace(/```/g, '')
      .replace(/^> /gm, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(plain);
  if (chars.length <= max) return plain;
  return `${chars
    .slice(0, max - 1)
    .join('')
    .trimEnd()}…`;
}
