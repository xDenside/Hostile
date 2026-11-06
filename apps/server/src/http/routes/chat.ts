import { Router, type RequestHandler } from 'express';
import {
  changesQuerySchema,
  editMessageRequestSchema,
  forwardMessageRequestSchema,
  historyQuerySchema,
  idSchema,
  markReadRequestSchema,
  sendMessageRequestSchema,
} from '@hostile/shared';
import type { AppContext } from '../../context.js';
import { ChatService } from '../../chat/service.js';
import { errors } from '../../lib/errors.js';
import { toAttachmentDTO } from '../../lib/mappers.js';
import { parseBody, parseQuery, requireAuth } from '../middleware.js';
import { discardRequestBody } from '../request-deadline.js';

export const ATTACHMENT_UPLOADS_PER_HOUR = 120;
const HOUR_MS = 60 * 60 * 1000;

export function chatRoutes(ctx: AppContext): Router {
  const router = Router();
  const chat = new ChatService(ctx);
  router.use(requireAuth);

  const channelId = (raw: unknown) => parseQuery(idSchema, raw);

  const uploadAttachment: RequestHandler = async (req, res) => {
    try {
      const limit = ctx.limiter.consume(
        `attachment-upload:user:${req.auth!.user.id}`,
        ATTACHMENT_UPLOADS_PER_HOUR,
        HOUR_MS,
      );
      if (!limit.ok) throw errors.rateLimited(limit.retryAfterSec);
      const channel = await chat.openChannelOrThrow(channelId(req.params.channelId));
      const attachment = await ctx.attachments.receive(req, {
        channelId: channel.id,
        uploaderId: req.auth!.user.id,
        name: req.query.name,
        width: req.query.width,
        height: req.query.height,
      });
      if (attachment) res.status(201).json({ attachment: toAttachmentDTO(attachment) });
    } catch (err) {
      discardRequestBody(req);
      throw err;
    }
  };

  router.post('/channels/:channelId/attachments', uploadAttachment);

  router.delete('/attachments/:id', async (req, res) => {
    await ctx.attachments.discard(req.auth!.user.id, parseQuery(idSchema, req.params.id));
    res.status(204).end();
  });

  router.get('/channels/:channelId/messages', async (req, res) => {
    const q = parseQuery(historyQuerySchema, req.query);
    res.json(await chat.history(channelId(req.params.channelId), q.before, q.limit));
  });

  router.get('/channels/:channelId/changes', async (req, res) => {
    const q = parseQuery(changesQuerySchema, req.query);
    res.json(await chat.changes(channelId(req.params.channelId), q.since));
  });

  router.post('/channels/:channelId/messages', async (req, res) => {
    const body = parseBody(sendMessageRequestSchema, req.body);
    const result = await chat.send(
      req.auth!.user,
      channelId(req.params.channelId),
      body.content,
      body.clientNonce,
      body.attachmentIds,
      body.replyToId,
    );
    res.status(result.duplicate ? 200 : 201).json(result);
  });

  router.post('/messages/:messageId/forward', async (req, res) => {
    const body = parseBody(forwardMessageRequestSchema, req.body);
    const result = await chat.forward(
      req.auth!.user,
      parseQuery(idSchema, req.params.messageId),
      body.channelId,
      body.clientNonce,
    );
    res.status(result.duplicate ? 200 : 201).json(result);
  });

  router.post('/channels/:channelId/read', async (req, res) => {
    const body = parseBody(markReadRequestSchema, req.body);
    res.json(await chat.markRead(req.auth!.user, channelId(req.params.channelId), body.seq));
  });

  router.patch('/messages/:messageId', async (req, res) => {
    const body = parseBody(editMessageRequestSchema, req.body);
    res.json({
      message: await chat.edit(
        req.auth!.user,
        parseQuery(idSchema, req.params.messageId),
        body.content,
      ),
    });
  });

  router.delete('/messages/:messageId', async (req, res) => {
    res.json({
      message: await chat.remove(req.auth!.user, parseQuery(idSchema, req.params.messageId)),
    });
  });

  return router;
}
