import { describe, expect, it } from 'vitest';
import { messageExcerpt } from '../src/excerpt.js';
import { LIMITS } from '../src/limits.js';

describe('messageExcerpt', () => {
  it('leaves a short plain message as it is', () => {
    expect(messageExcerpt('see you at nine')).toBe('see you at nine');
    expect(messageExcerpt('')).toBe('');
  });

  it('puts everything on one line', () => {
    expect(messageExcerpt('one\n\n\ntwo\t three')).toBe('one two three');
    expect(messageExcerpt('  \n  padded  \n ')).toBe('padded');
  });

  it('cuts at the limit, which includes the ellipsis', () => {
    const cut = messageExcerpt('a'.repeat(LIMITS.replyExcerptMax + 50));
    expect(Array.from(cut)).toHaveLength(LIMITS.replyExcerptMax);
    expect(cut.endsWith('…')).toBe(true);
    const whole = 'a'.repeat(LIMITS.replyExcerptMax);
    expect(messageExcerpt(whole)).toBe(whole);
  });

  it('does not leave a space before the ellipsis', () => {
    const text = `${'a'.repeat(8)} ${'b'.repeat(8)}`;
    expect(messageExcerpt(text, 10)).toBe('aaaaaaaa…');
  });

  it('never cuts a character in half', () => {
    const cut = messageExcerpt('😀'.repeat(LIMITS.replyExcerptMax + 10));
    expect(Array.from(cut)).toHaveLength(LIMITS.replyExcerptMax);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('counts Cyrillic as the characters they are', () => {
    expect(messageExcerpt('Привет, как дела?')).toBe('Привет, как дела?');
  });

  it('shows the words and not the markers the formatter would have read', () => {
    expect(messageExcerpt('**bold** and *italic* and _too_')).toBe('bold and italic and too');
    expect(messageExcerpt('__under__ ~~gone~~ `code`')).toBe('under gone code');
    expect(messageExcerpt('> quoted\nanswer')).toBe('quoted answer');
    expect(messageExcerpt('**bold with __inner__ word**')).toBe('bold with inner word');
  });

  it('shows a code block as its code, without the fence or its language', () => {
    expect(messageExcerpt('```ts\nconst a = 1;\n```')).toBe('const a = 1;');
    expect(messageExcerpt('```plain```')).toBe('plain');
  });

  it('leaves a link alone, whatever it has in it', () => {
    const url = 'https://example.com/a_b_c/**x**';
    expect(messageExcerpt(`see ${url} now`)).toBe(`see ${url} now`);
  });

  it('leaves markers that do not pair up, as the formatter does', () => {
    expect(messageExcerpt('2 * 3 = 6')).toBe('2 * 3 = 6');
    expect(messageExcerpt('snake_case')).toBe('snake_case');
  });
});
