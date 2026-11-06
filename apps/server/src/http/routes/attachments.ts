import { Router, type Response } from 'express';
import { idSchema } from '@hostile/shared';
import type { AppContext } from '../../context.js';
import { errors } from '../../lib/errors.js';
import { inlineDisposition } from '../../media/attachments.js';

const FILE_HEADERS = ['Content-Type', 'Content-Disposition', 'ETag'];

function setFileHeaders(
  res: Response,
  file: { id: string; contentType: string; fileName: string },
): void {
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Disposition', inlineDisposition(file.fileName));
  res.setHeader('ETag', `"${file.id}"`);
}

export function attachmentFileRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/:id', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const id = idSchema.safeParse(req.params.id);
    if (!id.success) throw errors.notFound('Attachment');
    const file = await ctx.db.messageAttachment.findUnique({
      where: { id: id.data },
      select: { id: true, contentType: true, fileName: true },
    });
    if (!file || !(await ctx.attachments.hasFile(file.id))) throw errors.notFound('Attachment');

    setFileHeaders(res, file);
    res.sendFile(
      file.id,
      { root: ctx.attachments.dir, cacheControl: false, lastModified: false },
      (err?: Error & { status?: number; code?: string }) => {
        if (!err || err.code === 'ECONNABORTED' || res.headersSent) return;
        for (const header of FILE_HEADERS) res.removeHeader(header);
        res.setHeader('Cache-Control', 'no-store');
        if (err.status === 412 || err.status === 416) {
          res.status(err.status).end();
          return;
        }
        next(err.status === 404 ? errors.notFound('Attachment') : err);
      },
    );
  });

  return router;
}
