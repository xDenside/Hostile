import type { Session } from 'electron';
import { developmentContentSecurityPolicy } from './csp.js';
import { log } from './log.js';
import { isSameOrigin } from './origin.js';
import type { CaptureService } from './capture.js';
import type { RendererTarget, Runtime } from './runtime.js';

const ALLOWED_PERMISSIONS = new Set([
  'media',
  'speaker-selection',
  'clipboard-sanitized-write',
  'fullscreen',
]);

const isRendererOrigin = (target: RendererTarget, origin: string | undefined | null): boolean =>
  isSameOrigin(origin, target.origin);

export function installPermissionHandlers(session: Session, target: RendererTarget): void {
  session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const fromRenderer = details.isMainFrame && isRendererOrigin(target, details.requestingUrl);
    const mediaTypes = 'mediaTypes' in details ? (details.mediaTypes ?? []) : [];
    const wantsCamera = mediaTypes.includes('video');
    const granted = fromRenderer && ALLOWED_PERMISSIONS.has(permission) && !wantsCamera;
    if (!granted) {
      log.warn(
        `denied permission "${permission}" for ${details.requestingUrl ?? 'unknown origin'}`,
      );
    }
    callback(granted);
  });

  session.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    if (!ALLOWED_PERMISSIONS.has(permission)) return false;
    if (details.mediaType === 'video') return false;
    return isRendererOrigin(target, details.securityOrigin ?? requestingOrigin);
  });
}

export function installDisplayMediaHandler(
  session: Session,
  capture: CaptureService,
  target: RendererTarget,
): void {
  session.setDisplayMediaRequestHandler(
    (request, callback) => {
      const cancel = callback as unknown as (streams: null) => void;

      if (!isRendererOrigin(target, request.securityOrigin)) {
        log.warn(`refused a screen capture request from ${request.securityOrigin}`);
        cancel(null);
        return;
      }

      void capture
        .takeArmedSource(request.audioRequested)
        .then((streams) => {
          if (!streams) {
            cancel(null);
            return;
          }
          callback(streams);
        })
        .catch((err: unknown) => {
          log.error(`screen capture request failed: ${String(err)}`);
          cancel(null);
        });
    },
    { useSystemPicker: false },
  );
}

export function installDevelopmentCsp(session: Session, runtime: Runtime, devOrigin: string): void {
  session.webRequest.onHeadersReceived({ urls: [`${devOrigin}/*`] }, (details, callback) => {
    const headers = { ...details.responseHeaders };
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-security-policy') delete headers[key];
    }
    headers['Content-Security-Policy'] = [
      developmentContentSecurityPolicy(runtime.cspInputs(), devOrigin),
    ];
    callback({ responseHeaders: headers });
  });
  log.info(`development Content-Security-Policy applied to ${devOrigin}`);
}
