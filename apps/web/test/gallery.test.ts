import { describe, expect, it } from 'vitest';
import { fitGallery, largeAvatarSize, type TagBox } from '../src/features/voice/gallery';

const GAP = 12;

describe('fitting people into a call screen', () => {
  it('keeps one person from becoming a wall', () => {
    const fit = fitGallery(1, 1400, 900, GAP);
    expect(fit.columns).toBe(1);
    expect(fit.width).toBe(720);
    expect(fit.height).toBe(450);
  });

  it('puts two side by side on a wide screen, and stacks them on a phone', () => {
    expect(fitGallery(2, 1400, 900, GAP).columns).toBe(2);
    expect(fitGallery(2, 343, 620, GAP).columns).toBe(1);
  });

  it('splits five as three and two, not four and one', () => {
    expect(fitGallery(5, 1500, 600, GAP).columns).toBe(3);
  });

  it('makes four people a square block rather than a long row', () => {
    expect(fitGallery(4, 1000, 800, GAP).columns).toBe(2);
  });

  it('never overflows the box, for any group size on any shape', () => {
    for (const [w, h] of [
      [1200, 800],
      [700, 800],
      [343, 560],
      [1600, 300],
      [320, 200],
    ] as const) {
      for (let count = 1; count <= 12; count += 1) {
        const fit = fitGallery(count, w, h, GAP);
        const rows = Math.ceil(count / fit.columns);
        expect(
          fit.columns * fit.width + (fit.columns - 1) * GAP,
          `${count} in ${w}x${h}`,
        ).toBeLessThanOrEqual(w);
        expect(rows * fit.height + (rows - 1) * GAP, `${count} in ${w}x${h}`).toBeLessThanOrEqual(
          h,
        );
        expect(fit.width).toBeGreaterThan(0);
      }
    }
  });

  it('holds a tile back while there is no room to measure yet', () => {
    expect(fitGallery(3, 0, 0, GAP).width).toBe(0);
    expect(fitGallery(0, 800, 600, GAP).width).toBe(0);
  });
});

describe('the avatar in a large call tile', () => {
  const tag = (width: number, height: number): TagBox => ({ left: 8, bottom: 8, width, height });

  it('keeps the size it always had where the name tag is out of the way', () => {
    expect(largeAvatarSize(720, 450, null)).toBe(128);
    expect(largeAvatarSize(720, 450, tag(120, 49))).toBe(128);
    expect(largeAvatarSize(189, 118, null)).toBe(42);
    expect(largeAvatarSize(189, 118, tag(60, 49))).toBe(42);
    expect(largeAvatarSize(160, 100, null)).toBe(40);
  });

  it('shrinks until it clears a tag that reaches under it, by 4 px even while speaking', () => {
    expect(largeAvatarSize(300, 170, null)).toBe(61);
    const size = largeAvatarSize(300, 170, tag(284, 49));
    expect(size).toBe(46);
    expect(170 - 8 - 49 - (170 / 2 + (size / 2) * 1.04)).toBeGreaterThanOrEqual(4);
  });

  it('stops at 32 px and accepts the overlap below that', () => {
    expect(largeAvatarSize(189, 118, tag(173, 31))).toBe(32);
    expect(largeAvatarSize(189, 118, tag(173, 60))).toBe(32);
  });

  it('is never larger than before, never under 32 px, and clears the tag whenever it is above 32 px', () => {
    for (let height = 60; height <= 500; height += 7) {
      for (const width of [height, height * 1.6, height * 2.4]) {
        for (const [w, h] of [
          [40, 31],
          [90, 49],
          [width / 2, 31],
          [width - 16, 49],
        ] as const) {
          const box = tag(Math.min(w, width - 16), h);
          const size = largeAvatarSize(width, height, box);
          expect(size).toBeLessThanOrEqual(largeAvatarSize(width, height, null));
          expect(size).toBeGreaterThanOrEqual(32);
          if (size > 32) {
            const across = Math.max(0, width / 2 - box.left - box.width);
            const down = Math.max(0, height - box.bottom - box.height - height / 2);
            expect(Math.hypot(across, down) - (size / 2) * 1.04).toBeGreaterThanOrEqual(4);
          }
        }
      }
    }
  });
});
