export interface GalleryFit {
  columns: number;
  width: number;
  height: number;
}

const TILE_ASPECT = 16 / 10;
const MAX_TILE_WIDTH = 720;
const FEWER_ROWS_ALLOWANCE = 0.9;

export function fitGallery(
  count: number,
  boxWidth: number,
  boxHeight: number,
  gap: number,
): GalleryFit {
  const empty = { columns: 1, width: 0, height: 0 };
  if (count <= 0 || boxWidth <= 0 || boxHeight <= 0) return empty;
  let best = empty;
  let bestRows = Infinity;
  for (let columns = 1; columns <= count; columns += 1) {
    const rows = Math.ceil(count / columns);
    const cellWidth = (boxWidth - gap * (columns - 1)) / columns;
    const cellHeight = (boxHeight - gap * (rows - 1)) / rows;
    if (cellWidth <= 0 || cellHeight <= 0) continue;
    const width = Math.min(cellWidth, cellHeight * TILE_ASPECT, MAX_TILE_WIDTH);
    if (width > best.width || (width >= best.width * FEWER_ROWS_ALLOWANCE && rows < bestRows)) {
      best = { columns, width, height: width / TILE_ASPECT };
      bestRows = rows;
    }
  }
  return { ...best, width: Math.floor(best.width), height: Math.floor(best.height) };
}

export interface TagBox {
  left: number;
  bottom: number;
  width: number;
  height: number;
}

const AVATAR_SHARE = 0.36;
const AVATAR_MAX = 128;
const AVATAR_FLOOR = 40;
const AVATAR_MIN = 32;
const TAG_CLEARANCE = 4;
const SPEAKING_SCALE = 1.04;

export function largeAvatarSize(width: number, height: number, tag: TagBox | null): number {
  const size = Math.round(Math.max(AVATAR_FLOOR, Math.min(height * AVATAR_SHARE, AVATAR_MAX)));
  if (!tag) return size;
  const top = height - tag.bottom - tag.height;
  const across = Math.max(tag.left - width / 2, 0, width / 2 - tag.left - tag.width);
  const down = Math.max(top - height / 2, 0, height / 2 - (height - tag.bottom));
  const fits = Math.floor((2 * (Math.hypot(across, down) - TAG_CLEARANCE)) / SPEAKING_SCALE);
  return fits >= size ? size : Math.max(AVATAR_MIN, fits);
}
