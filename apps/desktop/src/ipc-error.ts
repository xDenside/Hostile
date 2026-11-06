const REMOTE_PREFIX = /^Error invoking remote method '[^']*': /;
const ERROR_NAME = /^[A-Za-z]*Error: /;

export function plainIpcMessage(message: string): string {
  if (!REMOTE_PREFIX.test(message)) return message;
  const rest = message.replace(REMOTE_PREFIX, '').replace(ERROR_NAME, '');
  return rest.trim() ? rest : message;
}

export function plainIpcError(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const message = plainIpcMessage(err.message);
  return message === err.message ? err : new Error(message);
}
