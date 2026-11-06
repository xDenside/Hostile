import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FormattedMessage } from '../src/features/chat/format';

function render(content: string): string {
  return renderToStaticMarkup(<FormattedMessage content={content} />);
}

describe('message formatting', () => {
  it('renders plain text unchanged', () => {
    expect(render('hello world')).toContain('hello world');
  });

  it('never emits user-provided markup as HTML', () => {
    const html = render('<b>not bold</b> <img src=x onerror=alert(1)>');
    expect(html).not.toContain('<b>not bold</b>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;b&gt;not bold&lt;/b&gt;');
  });

  it('supports bold, italic, strikethrough and inline code', () => {
    const html = render('**b** *i* ~~s~~ `c`');
    expect(html).toContain('<strong>b</strong>');
    expect(html).toContain('<em>i</em>');
    expect(html).toContain('<s>s</s>');
    expect(html).toContain('>c</code>');
  });

  it('handles several inline tokens in one line without looping', () => {
    const html = render('**a** and **b** and `c` and *d*');
    expect(html).toContain('<strong>a</strong>');
    expect(html).toContain('<strong>b</strong>');
    expect(html).toContain('<em>d</em>');
  });

  it('links only http(s) URLs and leaves other schemes as text', () => {
    const safe = render('see https://example.com/x');
    expect(safe).toContain('href="https://example.com/x"');
    expect(safe).toContain('rel="noopener noreferrer nofollow ugc"');
    const unsafe = render('javascript:alert(1) and file:///etc/passwd');
    expect(unsafe).not.toContain('href=');
  });

  it('renders fenced code blocks verbatim', () => {
    const html = render('before\n```js\nconst a = **1**;\n```\nafter');
    expect(html).toContain('const a = **1**;');
    expect(html).toContain('<pre');
  });

  it('supports Cyrillic and emoji', () => {
    expect(render('Привет 👋 мир')).toContain('Привет 👋 мир');
  });
});
