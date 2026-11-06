import { Router } from 'express';
import { idSchema } from '@hostile/shared';
import type { AppContext } from '../../context.js';
import { errors } from '../../lib/errors.js';
import { SharedReads } from '../../lib/shared-reads.js';

const MAX_HELD_BYTES = 32 * 1024 * 1024;
const MAX_READS_AT_ONCE = 2;

export function mediaRoutes(ctx: AppContext): Router {
  const router = Router();
  const images = new SharedReads(
    async (id) => {
      const row = await ctx.db.profileMedia.findUnique({
        where: { id },
        select: { bytes: true },
      });
      return row && Buffer.from(row.bytes.buffer, row.bytes.byteOffset, row.bytes.byteLength);
    },
    MAX_HELD_BYTES,
    MAX_READS_AT_ONCE,
  );

  router.get('/:id', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const id = idSchema.safeParse(req.params.id);
    if (!id.success) throw errors.notFound('Image');
    const media = await ctx.db.profileMedia.findUnique({
      where: { id: id.data },
      select: { contentType: true },
    });
    if (!media) throw errors.notFound('Image');
    res.setHeader('ETag', `"${id.data}"`);
    const revalidating = req.fresh;
    const bytes = revalidating ? null : await images.get(id.data);
    if (!revalidating && !bytes) {
      res.removeHeader('ETag');
      throw errors.notFound('Image');
    }

    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (revalidating) {
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Type', media.contentType);
    res.send(bytes);
  });

  return router;
}
