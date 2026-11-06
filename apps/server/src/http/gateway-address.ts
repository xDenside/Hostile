import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

declare global {
  namespace Express {
    interface Request {
      fromGateway?: boolean;
    }
  }
}

export const GATEWAY_TOKEN_HEADER = 'x-hostile-gateway-token';

export function addressFromGatewayOnly(token: string): RequestHandler {
  const expected = Buffer.from(token);
  return (req, _res, next) => {
    const given = Buffer.from(String(req.headers[GATEWAY_TOKEN_HEADER] ?? ''));
    const fromGateway = given.length === expected.length && timingSafeEqual(given, expected);
    delete req.headers[GATEWAY_TOKEN_HEADER];
    req.fromGateway = fromGateway;
    if (!fromGateway) delete req.headers['x-forwarded-for'];
    next();
  };
}
