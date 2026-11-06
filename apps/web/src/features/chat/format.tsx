import { Fragment, type ReactNode } from 'react';
import { safeExternalUrl } from '@hostile/shared';
import { platform } from '../../platform';
import styles from './chat.module.scss';

const INLINE_SOURCE =
  '(`[^`\\n]+`)|(\\*\\*[^*\\n]+\\*\\*)|(__[^_\\n]+__)|(\\*[^*\\n]+\\*)|(_[^_\\n]+_)|(~~[^~\\n]+~~)|(https?:\\/\\/[^\\s<]+)';

function LinkText({ url }: { url: string }) {
  const trimmed = url.replace(/[),.;:!?]+$/, '');
  const tail = url.slice(trimmed.length);
  const safe = safeExternalUrl(trimmed);
  if (!safe) return <>{url}</>;
  return (
    <>
      <a
        href={safe}
        className={styles.link}
        rel="noopener noreferrer nofollow ugc"
        target="_blank"
        onClick={(e) => {
          if (platform().kind === 'desktop') {
            e.preventDefault();
            platform().openExternal(safe);
          }
        }}
      >
        {trimmed}
      </a>
      {tail}
    </>
  );
}

function inlineNodes(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  const inline = new RegExp(INLINE_SOURCE, 'g');
  let i = 0;
  while ((match = inline.exec(text))) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const key = `${keyPrefix}-${i++}`;
    const [token] = match;
    if (token.startsWith('`'))
      out.push(
        <code key={key} className={styles.code}>
          {token.slice(1, -1)}
        </code>,
      );
    else if (token.startsWith('**'))
      out.push(<strong key={key}>{inlineNodes(token.slice(2, -2), key)}</strong>);
    else if (token.startsWith('__'))
      out.push(<u key={key}>{inlineNodes(token.slice(2, -2), key)}</u>);
    else if (token.startsWith('~~'))
      out.push(<s key={key}>{inlineNodes(token.slice(2, -2), key)}</s>);
    else if (token.startsWith('*'))
      out.push(<em key={key}>{inlineNodes(token.slice(1, -1), key)}</em>);
    else if (token.startsWith('_'))
      out.push(<em key={key}>{inlineNodes(token.slice(1, -1), key)}</em>);
    else out.push(<LinkText key={key} url={token} />);
    last = match.index + token.length;
    inline.lastIndex = last;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function FormattedMessage({ content }: { content: string }) {
  const blocks = content.split(/```/);
  return (
    <>
      {blocks.map((block, index) => {
        if (index % 2 === 1) {
          const firstLine = block.indexOf('\n');
          const body =
            firstLine >= 0 && /^[a-z0-9+#-]{0,12}$/i.test(block.slice(0, firstLine).trim())
              ? block.slice(firstLine + 1)
              : block;
          return (
            <pre key={index} className={styles.codeBlock}>
              <code>{body.replace(/\n$/, '')}</code>
            </pre>
          );
        }
        return (
          <Fragment key={index}>
            {block.split('\n').map((line, lineIndex, lines) => {
              const quote = line.startsWith('> ');
              const text = quote ? line.slice(2) : line;
              return (
                <Fragment key={lineIndex}>
                  {quote ? (
                    <span className={styles.quote}>
                      {inlineNodes(text, `${index}-${lineIndex}`)}
                    </span>
                  ) : (
                    inlineNodes(text, `${index}-${lineIndex}`)
                  )}
                  {lineIndex < lines.length - 1 ? <br /> : null}
                </Fragment>
              );
            })}
          </Fragment>
        );
      })}
    </>
  );
}
