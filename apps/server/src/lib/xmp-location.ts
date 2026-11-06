const LOCATION_WORDS = /gps|location|latitude|longitude|longtitude|altitude/;

const PLACE_NAMES = new Set([
  'city',
  'state',
  'country',
  'countrycode',
  'countryname',
  'provincestate',
  'worldregion',
  'coverage',
]);

export const namesLocation = (key: string): boolean => {
  const lower = key.toLowerCase();
  return LOCATION_WORDS.test(lower) || lower.includes('iso6709');
};

function isLocationProperty(name: string): boolean {
  if (name === 'xmlns' || name.startsWith('xmlns:')) return false;
  const local = name.slice(name.indexOf(':') + 1).toLowerCase();
  return LOCATION_WORDS.test(local) || PLACE_NAMES.has(local);
}

function isNameChar(code: number): boolean {
  return (
    code >= 0x80 ||
    (code >= 0x30 && code <= 0x3a) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f ||
    code === 0x2d ||
    code === 0x2e
  );
}

function nameEnd(text: string, from: number): number {
  let at = from;
  while (at < text.length && isNameChar(text.charCodeAt(at))) at++;
  return at;
}

function skipSpace(text: string, from: number): number {
  let at = from;
  while (at < text.length) {
    const code = text.charCodeAt(at);
    if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break;
    at++;
  }
  return at;
}

function pastCloseTag(text: string, name: string, from: number): number {
  const close = `</${name}`;
  let at = text.indexOf(close, from);
  while (at !== -1) {
    const after = skipSpace(text, at + close.length);
    if (text[after] === '>') return after + 1;
    at = text.indexOf(close, at + close.length);
  }
  return -1;
}

function findRanges(text: string): { ranges: [number, number][]; complete: boolean } {
  const ranges: [number, number][] = [];
  const stop = { ranges, complete: false };
  let at = 0;
  for (;;) {
    const open = text.indexOf('<', at);
    if (open === -1) return { ranges, complete: true };

    let terminator: string | null = null;
    if (text.startsWith('<!--', open)) terminator = '-->';
    else if (text.startsWith('<![CDATA[', open)) terminator = ']]>';
    else if (text.startsWith('<?', open)) terminator = '?>';
    else if (text.startsWith('<!', open) || text.startsWith('</', open)) terminator = '>';
    if (terminator) {
      const end = text.indexOf(terminator, open + 2);
      if (end === -1) return stop;
      at = end + terminator.length;
      continue;
    }

    const afterName = nameEnd(text, open + 1);
    if (afterName === open + 1) {
      at = open + 1;
      continue;
    }
    const name = text.slice(open + 1, afterName);
    let pos = afterName;
    let selfClosed = false;
    for (;;) {
      pos = skipSpace(text, pos);
      if (pos >= text.length) return stop;
      if (text[pos] === '>') {
        pos++;
        break;
      }
      if (text.startsWith('/>', pos)) {
        pos += 2;
        selfClosed = true;
        break;
      }
      const attributeEnd = nameEnd(text, pos);
      if (attributeEnd === pos) return stop;
      const equals = skipSpace(text, attributeEnd);
      if (text[equals] !== '=') return stop;
      const valueStart = skipSpace(text, equals + 1);
      const quote = text[valueStart];
      if (quote !== '"' && quote !== "'") return stop;
      const valueEnd = text.indexOf(quote, valueStart + 1);
      if (valueEnd === -1) return stop;
      if (isLocationProperty(text.slice(pos, attributeEnd))) ranges.push([pos, valueEnd + 1]);
      pos = valueEnd + 1;
    }

    if (isLocationProperty(name)) {
      const end = selfClosed ? pos : pastCloseTag(text, name, pos);
      if (end === -1) return stop;
      ranges.push([open, end]);
      pos = end;
    }
    at = pos;
  }
}

export function blankXmpLocation(packet: Buffer, partial = false): Buffer | null | 'malformed' {
  if (packet.subarray(0, 128).includes(0)) return 'malformed';
  const { ranges, complete } = findRanges(packet.toString('latin1'));
  if (!complete && !partial) return 'malformed';
  if (!ranges.length) return null;
  const out = Buffer.from(packet);
  for (const [start, end] of ranges) out.fill(0x20, start, end);
  return out;
}
