import { Router } from 'express';
import {
  createChannelRequestSchema,
  idSchema,
  reorderChannelsRequestSchema,
  updateChannelRequestSchema,
} from '@hostile/shared';
import type { AppContext } from '../../context.js';
import { AdminService } from '../../admin/service.js';
import { letIn } from './join.js';
import { parseBody, parseQuery, requireAuth, requireOwner } from '../middleware.js';

export function adminRoutes(ctx: AppContext): Router {
  const router = Router();
  const admin = new AdminService(ctx);
  router.use(requireAuth, requireOwner);
  const id = (raw: unknown) => parseQuery(idSchema, raw);

  router.get('/join-requests', (_req, res) => {
    res.json({ requests: ctx.joinRequests.list() });
  });
  router.post('/join-requests/:id/let-in', async (req, res) => {
    await letIn(ctx, id(req.params.id));
    res.status(204).end();
  });
  router.post('/join-requests/:id/turn-away', (req, res) => {
    ctx.joinRequests.turnAway(id(req.params.id));
    res.status(204).end();
  });

  router.get('/users', async (_req, res) => {
    res.json({ users: await admin.listUsers() });
  });
  router.post('/users/:id/remove', async (req, res) => {
    res.json({ user: await admin.remove(req.auth!.user, id(req.params.id)) });
  });

  router.post('/channels', async (req, res) => {
    const body = parseBody(createChannelRequestSchema, req.body);
    res.status(201).json({ channel: await admin.createChannel(body) });
  });
  router.put('/channels/order', async (req, res) => {
    const body = parseBody(reorderChannelsRequestSchema, req.body);
    res.json({ channels: await admin.reorderChannels(body.channelIds) });
  });
  router.patch('/channels/:id', async (req, res) => {
    const body = parseBody(updateChannelRequestSchema, req.body);
    res.json({ channel: await admin.updateChannel(id(req.params.id), body) });
  });
  router.delete('/channels/:id', async (req, res) => {
    await admin.archiveChannel(id(req.params.id));
    res.status(204).end();
  });
  router.get('/channels/archived', async (_req, res) => {
    res.json({ channels: await admin.listArchivedChannels() });
  });
  router.post('/channels/:id/restore', async (req, res) => {
    res.json({ channel: await admin.restoreChannel(id(req.params.id)) });
  });

  return router;
}
