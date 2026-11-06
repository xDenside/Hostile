import { deflateSync } from 'node:zlib';

const fromBase64 = (data: string) => Buffer.from(data, 'base64');

export const REAL_GIF_THREE_FRAMES = fromBase64(
  'R0lGODlhCAAIAPcfMQAAACQAAEgAAGwAAJAAALQAANgAAPwAAAAkACQkAEgkAGwkAJAkALQkANgkAPwkAABIACRIAEhI' +
    'AGxIAJBIALRIANhIAPxIAABsACRsAEhsAGxsAJBsALRsANhsAPxsAACQACSQAEiQAGyQAJCQALSQANiQAPyQAAC0ACS0' +
    'AEi0AGy0AJC0ALS0ANi0APy0AADYACTYAEjYAGzYAJDYALTYANjYAPzYAAD8ACT8AEj8AGz8AJD8ALT8ANj8APz8AAAA' +
    'VSQAVUgAVWwAVZAAVbQAVdgAVfwAVQAkVSQkVUgkVWwkVZAkVbQkVdgkVfwkVQBIVSRIVUhIVWxIVZBIVbRIVdhIVfxI' +
    'VQBsVSRsVUhsVWxsVZBsVbRsVdhsVfxsVQCQVSSQVUiQVWyQVZCQVbSQVdiQVfyQVQC0VSS0VUi0VWy0VZC0VbS0Vdi0' +
    'Vfy0VQDYVSTYVUjYVWzYVZDYVbTYVdjYVfzYVQD8VST8VUj8VWz8VZD8VbT8Vdj8Vfz8VQAAqiQAqkgAqmwAqpAAqrQA' +
    'qtgAqvwAqgAkqiQkqkgkqmwkqpAkqrQkqtgkqvwkqgBIqiRIqkhIqmxIqpBIqrRIqthIqvxIqgBsqiRsqkhsqmxsqpBs' +
    'qrRsqthsqvxsqgCQqiSQqkiQqmyQqpCQqrSQqtiQqvyQqgC0qiS0qki0qmy0qpC0qrS0qti0qvy0qgDYqiTYqkjYqmzY' +
    'qpDYqrTYqtjYqvzYqgD8qiT8qkj8qmz8qpD8qrT8qtj8qvz8qgAA/yQA/0gA/2wA/5AA/7QA/9gA//wA/wAk/yQk/0gk' +
    '/2wk/5Ak/7Qk/9gk//wk/wBI/yRI/0hI/2xI/5BI/7RI/9hI//xI/wBs/yRs/0hs/2xs/5Bs/7Rs/9hs//xs/wCQ/ySQ' +
    '/0iQ/2yQ/5CQ/7SQ/9iQ//yQ/wC0/yS0/0i0/2y0/5C0/7S0/9i0//y0/wDY/yTY/0jY/2zY/5DY/7TY/9jY//zY/wD8' +
    '/yT8/0j8/2z8/5D8/7T8/9j8//z8/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQEFAAfACwAAAAACAAIAAAINwAPHMCBAxiw' +
    'Y8cEEjSIUCAECACACAhi4AACCECABBHiEKJEjhYxAtjYMUCQE14EXgRQyguBgAAAIfkEBRQAAAAsBwAHAAEAAQAACAQA' +
    'AQQEACH5BAUUAAAALAcABwABAAEAAAgEAAEEBAA7',
);

export const REAL_APNG = fromBase64(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAABAAAAAQBPJcTWAAAACGFjVEwAAAADAAAA' +
    'AM7tusAAAAAaZmNUTAAAAAAAAAAIAAAACAAAAAAAAAAAAAEABQAA+RL9XwAAADxJREFUeJxj/MMAAiz/wBTTXyDxl+E/' +
    'SIQBB4BJ2EMoRzDzHzE6yJSQYjgLJDfWKWHRMbFrAsOXSU3NlwH0qQ4VR5zhvwAAABpmY1RMAAAAAQAAAAEAAAABAAAA' +
    'AAAAAAAAAQAFAADKUJ05AAAAEGZkQVQAAAACeJxj/MPAAAAC/AD+5TWQCAAAABpmY1RMAAAAAwAAAAEAAAABAAAAAAAA' +
    'AAAAAQAFAAAnxk7QAAAAEGZkQVQAAAAEeJxj/MPAAAAC/AD+RdBP1QAAAABJRU5ErkJggg==',
);

export const REAL_IMAGES = {
  png: {
    type: 'image/png',
    width: 23,
    height: 17,
    bytes: fromBase64(
      'iVBORw0KGgoAAAANSUhEUgAAABcAAAARCAIAAAC5EaDqAAAAZ0lEQVR4nGPUiFrAQDFgotwIBgYGFlwSJ/LmYApaTErBqpgR00cnsOnHbxaKKQT14zKLiTwjGFDVUyd0mchzCJouqrqFOqZY4EgI+AFcF7V9ZEGicyyQ1NMg7TIQMouEfEQGoE7oAgDxHCHrsT8ytgAAAABJRU5ErkJggg==',
    ),
  },
  apng: {
    type: 'image/png',
    width: 23,
    height: 17,
    bytes: fromBase64(
      'iVBORw0KGgoAAAANSUhEUgAAABcAAAARCAIAAAC5EaDqAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAAXAAAAEQAAAAAAAAAAAAEACgAAkIOfhgAAAGdJREFUeJxj1IhawEAxYKLcCAYGBhZcEify5mAKWkxKwaqYEdNHJ7Dpx28WiikE9eMyi4k8IxhQ1VMndJnIcwiaLqq6hTqmWOBICPgBXBe1fWRBonMskNTTIO0yEDKLhHxEBqBO6AIA8Rwh67E/MrYAAAAaZmNUTAAAAAEAAAAXAAAAEQAAAAAAAAAAAAEACgAAC/B1UgAAAGJmZEFUAAAAAnicY2SAAY2oBXA2AwPDibw5DBjAYlIKMvfGsgQIgwlTKQMOI/CIYzeFVMBEvIV4ZGnjlhN4HYJLDc3ChQwwagpx4YKWU7ACTDU0C10LvM7BKkvLmMblHFziAHy8GCJ+iL27AAAAAElFTkSuQmCC',
    ),
  },
  jpeg: {
    type: 'image/jpeg',
    width: 31,
    height: 19,
    bytes: fromBase64(
      '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAATAB8DASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDN0TRJtZndEkEUcYy8hGcZ6ADv0rroPCOkRIVeKSc5zukkII9vlwKx/CGsW9ostldSJErt5iO3AzjBBPboMfj7V2VeTneOxtPEumpOMeltL+d/6saYGhQlSUrXfUwrrwfpc6YgWS2YA4KuWBPbIOf0xXH6rpk2k3zW0rBuNyOP4l7HHbp0r0x3WNGd2CqoyzMcAD1rhPFeqw6jfRxW7B4rcEbx/Ex64PccD9a1yLG4yrX9nJuULat9Pn+hOPoUYQ5krMwangvry2Qpb3U0Kk5KxyFRn14oor7KUYyVpK54qbWqEnu7m62/aLiWbbnb5jlsfTNQ0UURioq0VZA227s//9k=',
    ),
  },
  jpegProgressive: {
    type: 'image/jpeg',
    width: 31,
    height: 19,
    bytes: fromBase64(
      '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wgARCAATAB8DASIAAhEBAxEB/8QAGAAAAwEBAAAAAAAAAAAAAAAAAAQFAgb/xAAYAQADAQEAAAAAAAAAAAAAAAAAAgQBBf/aAAwDAQACEAMQAAABWrp2ZGQj9NCbENh2YjAB/8QAGhAAAwEBAQEAAAAAAAAAAAAAAQIDAAQQMf/aAAgBAQABBQKMTYjkkM3HI6szJ+Syr583VUUfB3XFmbz/xAAZEQACAwEAAAAAAAAAAAAAAAABAgADERD/2gAIAQMBAT8BoRCuy9EA3v8A/8QAHBEAAQQDAQAAAAAAAAAAAAAAAQACAxEEEjEh/9oACAECAQE/Ac2eZsmt0FgzTOfqfQiAeoCuL//EAB4QAAIBBAMBAAAAAAAAAAAAAAECABARMXESIkEh/9oACAEBAAY/As2A9mCdmfLrOJhRjb2oC4WnViNGdmJ3T//EAB0QAQACAQUBAAAAAAAAAAAAAAEAERAhMUFRYdH/2gAIAQEAAT8hehyEHU+n4QnSnjcXpfI9kJCC0XCgVaDdY1F8nbgyh+qJW6Dta8f/2gAMAwEAAgADAAAAEAOngv/EABgRAQEBAQEAAAAAAAAAAAAAAAERACFB/9oACAEDAQE/EBsV902I4U6ZVa7/xAAcEQACAgIDAAAAAAAAAAAAAAABEQAhQWGBwfD/2gAIAQIBAT8QNQLAqe35R7Cmycc9QAgcACBCf//EAB8QAQEAAQMFAQAAAAAAAAAAAAERMQAhQRBRYYGhcf/aAAgBAQABPxA3xKxZcAc403W20CeMDUGSGKheKN+TRhtkfoZxjGsSzTFkReME9+OhlgVEA76NIZJ5Mx5Nj70ZsDVAvfbXPCbmPy9P/9k=',
    ),
  },
  gif87: {
    type: 'image/gif',
    width: 29,
    height: 13,
    bytes: fromBase64(
      'R0lGODdhHQANAIMAAMyZM/+ZM8zMM//MM/+ZZszMZv/MZgAzmTMzmQBmmTNmmQBmzDNmzAAAAAAAAAAAACwAAAAAHQANAAAIuwAVCBxIsKDBgwIPKFDIcOEAAQ8DQITYsOJABgIxDjAwYKMAjgY+duSoAGPJgQoRJHjIEmJHlxJbDlCJwODGkRANAHj5kOPNjwITJGQwMSbPkD5lskRgUiBOjwFCdhyws0BHAjkFKKi5UIFVl2CP8nTZUejAmgMCWPV4U6bPkAEYcFWwYOtKni/V4owJUYFQs1wxHuAoAOvUiCNnyt1qUqjCswo6fiVs4K/fy2dNKkzAQCjXmp+3Mq6pMCAAOw==',
    ),
  },
  gifAnimated: {
    type: 'image/gif',
    width: 29,
    height: 13,
    bytes: fromBase64(
      'R0lGODlhHQANAIMAAMyZM/+ZM8zMM//MM/+ZZszMZv/MZgAzmTMzmQBmmTNmmQBmzDNmzAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAFAAAACwAAAAAHQANAAAIuwAVCBxIsKDBgwIPKFDIcOEAAQ8DQITYsOJABgIxDjAwYKMAjgY+duSoAGPJgQoRJHjIEmJHlxJbDlCJwODGkRANAHj5kOPNjwITJGQwMSbPkD5lskRgUiBOjwFCdhyws0BHAjkFKKi5UIFVl2CP8nTZUejAmgMCWPV4U6bPkAEYcFWwYOtKni/V4owJUYFQs1wxHuAoAOvUiCNnyt1qUqjCswo6fiVs4K/fy2dNKkzAQCjXmp+3Mq6pMCAAOw==',
    ),
  },
  webpLossy: {
    type: 'image/webp',
    width: 23,
    height: 17,
    bytes: fromBase64(
      'UklGRtAAAABXRUJQVlA4IMQAAACQBQCdASoXABEAPtFYpk0oJSOiMBgIAQAaCWwArDM0OY+BM/+SeEQwE/oVWVgxvN38TlKPAAD+ucuhOeS/J07edTO9phFCsxOuHHTVZyg7l9j9Uq0TUry1WDNmDFLR2rwfR2iX5FIf1XotmB6H/g4p4+yfaaZoCaB4XFKtQ4qE53xyRHSx4KkhV+9BR64rsVQaGWoD3ZSZyQnGC/VnXhh/j0pg64W6+B/6V6mu7C21SFos9b2bvd+n97GNI/eKQJBTAAAA',
    ),
  },
  webpLossless: {
    type: 'image/webp',
    width: 23,
    height: 17,
    bytes: fromBase64(
      'UklGRkYAAABXRUJQVlA4TDoAAAAvFgAEAA9wSeTjwJ+HbP5jCWoiSYqG90IkYQUJFxJxOP9FRPQ/1rI3rTIKXVBBA+0XVNBCr4w1ba0H',
    ),
  },
  webpExtended: {
    type: 'image/webp',
    width: 37,
    height: 11,
    bytes: fromBase64(
      'UklGRioBAABXRUJQVlA4WAoAAAAQAAAAJAAACgAAQUxQSCsAAAABD/DA/4iIgKiR1KwDHPSkYA2pKGF/1RDR/1CNxUXYNEwKeL+GibCxuKgGAFZQOCDYAAAAEAYAnQEqJQALAD6lQppJpiOioTVIAMAUiWwAnTKEdQeuxIDMYKg8ZwDClM3hpLDq8ryx2sTP/AAAAP7ZU/3GFEs2Smm0V6/Ie9F7UPSdTNL8H3l6TBkLR7rawIH+SQWd+v+syeaTKGt4/4lCbcAx33fzYacz5TU0BfgOmecwvc6WWxPPCOVXHNhgANDk8yrhkqGLngnz8o9TwnI5wAQBMchAAWBcZMvzmZQ1UVFvPJXzhwJEZfDSPnU06bzMjqYyQztzwd+z/8ugrbpW0f6v42lQtkuOJMAA',
    ),
  },
  webpAnimated: {
    type: 'image/webp',
    width: 37,
    height: 11,
    bytes: fromBase64(
      'UklGRmwBAABXRUJQVlA4WAoAAAACAAAAJAAACgAAQU5JTQYAAAAAAAAAAABBTk1GVgAAAAAAAAAAACQAAAoAAGQAAAJWUDggPgAAAPACAJ0BKiUACwA+0V6oTiglJCIqqAEAGgljAMZ8HjuIAP7qZf64ubIw1/+N4/yXf277ef9AyrUT/AZV6wAAQU5NRuIAAAAAAAAAAAAkAAAKAABkAAAAVlA4IMoAAAAUBQCdASolAAsAPsFMnkuDVIAAAYCWwswL4A/gE0A/QCcAeIE4wD9M50xgcLMB6quAAP7rWdH/Av/yq1R9VH23M4ePyx93PX27rlEhmjl/eH2WbGP5Miw6ufpIPcM6RR2Rwzr/x79JiP8k8G/8bOzbJtq9E2nJySf29LRL6X9cznDLD3sPzCCvO3fdj19rFXnfgZHxFC54EfePgfgvzJeMxRjFFMAORgP/zjKDT/j3yx7UWSbE4pYbw36+j+d1EKn2qF/8uMY6QAAA',
    ),
  },
} as const;

const u16le = (value: number) => {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value);
  return out;
};
const u16be = (value: number) => {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(value);
  return out;
};
const u24le = (value: number) => {
  const out = Buffer.alloc(3);
  out.writeUIntLE(value, 0, 3);
  return out;
};
const u32le = (value: number) => {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value);
  return out;
};
const u32be = (value: number) => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
};

const pngChunk = (type: string, data: Buffer = Buffer.alloc(0)) =>
  Buffer.concat([u32be(data.length), Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function buildPng(width: number, height: number, size?: number): Buffer {
  const head = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', Buffer.concat([u32be(width), u32be(height), Buffer.from([8, 2, 0, 0, 0])])),
  ]);
  const tail = pngChunk('IEND');
  const dataLength = size === undefined ? 4 : size - head.length - tail.length - 12;
  return Buffer.concat([head, pngChunk('IDAT', Buffer.alloc(dataLength, 0x5a)), tail]);
}

export const jpegSegment = (marker: number, data: Buffer = Buffer.alloc(0)) =>
  Buffer.concat([Buffer.from([0xff, marker]), u16be(data.length + 2), data]);

export const jpegFrame = (width: number, height: number) =>
  jpegSegment(
    0xc0,
    Buffer.concat([Buffer.from([8]), u16be(height), u16be(width), Buffer.from([1, 1, 0x11, 0])]),
  );

const JPEG_SCAN = Buffer.concat([
  jpegSegment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
  Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56]),
]);

export const buildJpegFrom = (...segments: Buffer[]) =>
  Buffer.concat([Buffer.from([0xff, 0xd8]), ...segments, JPEG_SCAN, Buffer.from([0xff, 0xd9])]);

export const buildJpeg = (width: number, height: number) =>
  buildJpegFrom(jpegSegment(0xe0, Buffer.from('JFIF\0', 'latin1')), jpegFrame(width, height));

export function buildJpegOfSize(width: number, height: number, size: number): Buffer {
  const base = buildJpeg(width, height);
  const segments = Math.ceil((size - base.length) / 65_535);
  const app = (length: number) => jpegSegment(0xe1, Buffer.alloc(length, 0x41));
  const padding = Array.from({ length: Math.max(segments - 1, 0) }, () => app(65_533));
  const last = size - base.length - padding.reduce((sum, s) => sum + s.length, 0) - 4;
  return buildJpegFrom(
    jpegSegment(0xe0, Buffer.from('JFIF\0', 'latin1')),
    ...padding,
    app(Math.max(last, 0)),
    jpegFrame(width, height),
  );
}

export function buildBlankPng(width: number, height: number, bits: 1 | 8 = 1): Buffer {
  const header = Buffer.concat([
    u32be(width),
    u32be(height),
    Buffer.from([bits, bits === 8 ? 6 : 0, 0, 0, 0]),
  ]);
  const stride = (bits === 8 ? width * 4 : Math.ceil(width / 8)) + 1;
  const pixels = deflateSync(Buffer.alloc(stride * height), { level: 9 });
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', pixels),
    pngChunk('IEND'),
  ]);
}

export function buildApng(width: number, height: number, frames: [number, number][]): Buffer {
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', Buffer.concat([u32be(width), u32be(height), Buffer.from([8, 2, 0, 0, 0])])),
    pngChunk('acTL', Buffer.concat([u32be(frames.length), u32be(0)])),
    ...frames.map(([w, h], i) =>
      pngChunk('fcTL', Buffer.concat([u32be(i), u32be(w), u32be(h), Buffer.alloc(14)])),
    ),
    pngChunk('IDAT', Buffer.alloc(4)),
    pngChunk('IEND'),
  ]);
}

export function buildAnimatedWebp(
  width: number,
  height: number,
  frames: [number, number][],
): Buffer {
  const chunk = (fourcc: string, data: Buffer) =>
    Buffer.concat([
      Buffer.from(fourcc, 'latin1'),
      u32le(data.length),
      data,
      Buffer.alloc(data.length % 2),
    ]);
  const body = Buffer.concat([
    Buffer.from('WEBP', 'latin1'),
    chunk(
      'VP8X',
      Buffer.concat([Buffer.from([0x02, 0, 0, 0]), u24le(width - 1), u24le(height - 1)]),
    ),
    chunk('ANIM', Buffer.alloc(6)),
    ...frames.map(([w, h]) =>
      chunk(
        'ANMF',
        Buffer.concat([
          u24le(0),
          u24le(0),
          u24le(w - 1),
          u24le(h - 1),
          u24le(100),
          Buffer.alloc(3),
        ]),
      ),
    ),
  ]);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), u32le(body.length), body]);
}

interface GifFrame {
  left?: number;
  top?: number;
  width: number;
  height: number;
}

export function buildGif(
  width: number,
  height: number,
  frames: GifFrame[] = [{ width, height }],
): Buffer {
  return Buffer.concat([
    Buffer.from('GIF89a', 'latin1'),
    u16le(width),
    u16le(height),
    Buffer.from([0, 0, 0]),
    ...frames.map((frame) =>
      Buffer.concat([
        Buffer.from([0x2c]),
        u16le(frame.left ?? 0),
        u16le(frame.top ?? 0),
        u16le(frame.width),
        u16le(frame.height),
        Buffer.from([0, 2, 2, 0x44, 0x01, 0]),
      ]),
    ),
    Buffer.from([0x3b]),
  ]);
}

export function buildWebp(fourcc: string, chunk: Buffer, riffSize?: number): Buffer {
  const padded = chunk.length % 2 ? Buffer.concat([chunk, Buffer.alloc(1)]) : chunk;
  const size = 4 + 8 + padded.length;
  return Buffer.concat([
    Buffer.from('RIFF', 'latin1'),
    u32le(riffSize ?? size),
    Buffer.from(`WEBP${fourcc}`, 'latin1'),
    u32le(chunk.length),
    padded,
  ]);
}

export const vp8Chunk = (width: number, height: number) =>
  Buffer.concat([
    Buffer.from([0x10, 0x00, 0x00, 0x9d, 0x01, 0x2a]),
    u16le(width),
    u16le(height),
    Buffer.alloc(8),
  ]);

export const vp8lChunk = (width: number, height: number) =>
  Buffer.concat([
    Buffer.from([0x2f]),
    u32le(((width - 1) | ((height - 1) << 14)) >>> 0),
    Buffer.alloc(4),
  ]);

export const vp8xChunk = (width: number, height: number) =>
  Buffer.concat([Buffer.alloc(4), u24le(width - 1), u24le(height - 1)]);
