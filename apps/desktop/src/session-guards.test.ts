import { strict as assert } from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';
import type { Session } from 'electron';
import { log } from './log.js';
import { installPermissionHandlers } from './session-guards.js';
import type { RendererTarget } from './runtime.js';

const target: RendererTarget = {
  origin: 'hostile://hostile',
  url: 'hostile://hostile/index.html',
  devOrigin: null,
};

type RequestHandler = (
  contents: unknown,
  permission: string,
  callback: (granted: boolean) => void,
  details: Record<string, unknown>,
) => void;

type CheckHandler = (
  contents: unknown,
  permission: string,
  requestingOrigin: string,
  details: Record<string, unknown>,
) => boolean;

let request: RequestHandler;
let check: CheckHandler;

beforeEach(() => {
  mock.method(log, 'warn', () => undefined);
  const session = {
    setPermissionRequestHandler(handler: RequestHandler) {
      request = handler;
    },
    setPermissionCheckHandler(handler: CheckHandler) {
      check = handler;
    },
  };
  installPermissionHandlers(session as unknown as Session, target);
});

const requested = (permission: string, details: Record<string, unknown> = {}): boolean => {
  let granted: boolean | undefined;
  request(
    null,
    permission,
    (value) => {
      granted = value;
    },
    { isMainFrame: true, requestingUrl: 'hostile://hostile/index.html', ...details },
  );
  assert.notEqual(granted, undefined, 'the handler must always answer');
  return granted === true;
};

const checked = (permission: string, details: Record<string, unknown> = {}): boolean =>
  check(null, permission, 'hostile://hostile/', {
    securityOrigin: 'hostile://hostile/',
    ...details,
  });

describe('permission request handler', () => {
  it('grants what the app actually uses from its own main frame', () => {
    assert.equal(requested('media', { mediaTypes: ['audio'] }), true);
    assert.equal(requested('media', { mediaTypes: [] }), true);
    assert.equal(requested('speaker-selection'), true);
    assert.equal(requested('clipboard-sanitized-write'), true);
    assert.equal(requested('fullscreen'), true);
  });

  it('refuses the camera even inside a media request', () => {
    assert.equal(requested('media', { mediaTypes: ['audio', 'video'] }), false);
    assert.equal(requested('media', { mediaTypes: ['video'] }), false);
  });

  it('refuses everything else, including clipboard reads', () => {
    for (const permission of [
      'clipboard-read',
      'deprecated-sync-clipboard-read',
      'automatic-fullscreen',
      'notifications',
      'geolocation',
      'midi',
      'hid',
      'serial',
      'usb',
      'openExternal',
      'pointerLock',
    ]) {
      assert.equal(requested(permission), false, permission);
    }
  });

  it('refuses any origin but the renderer, and any frame but the main one', () => {
    assert.equal(requested('media', { requestingUrl: 'https://evil.example/' }), false);
    assert.equal(
      requested('clipboard-sanitized-write', { requestingUrl: 'hostile://other/' }),
      false,
    );
    assert.equal(requested('fullscreen', { isMainFrame: false }), false);
    assert.equal(requested('media', { requestingUrl: undefined }), false);
  });
});

describe('permission check handler', () => {
  it('answers for the same set', () => {
    assert.equal(checked('clipboard-sanitized-write'), true);
    assert.equal(checked('media', { mediaType: 'audio' }), true);
    assert.equal(checked('fullscreen'), true);
    assert.equal(checked('clipboard-read'), false);
    assert.equal(checked('notifications'), false);
    assert.equal(checked('media', { mediaType: 'video' }), false);
  });

  it('falls back to the requesting origin and still requires the renderer', () => {
    assert.equal(checked('clipboard-sanitized-write', { securityOrigin: undefined }), true);
    assert.equal(
      checked('clipboard-sanitized-write', { securityOrigin: 'https://evil.example/' }),
      false,
    );
  });
});
