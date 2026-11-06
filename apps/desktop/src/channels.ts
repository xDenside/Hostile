export const CHANNEL = {
  info: 'hostile:info',
  authRefresh: 'hostile:auth:refresh',
  authLogout: 'hostile:auth:logout',
  captureList: 'hostile:capture:list',
  captureSelect: 'hostile:capture:select',
  captureCapabilities: 'hostile:capture:capabilities',
  mediaStatus: 'hostile:media:status',
  mediaRequestMicrophone: 'hostile:media:request-microphone',
  mediaOpenPrivacySettings: 'hostile:media:open-privacy-settings',
  shortcutsGet: 'hostile:shortcuts:get',
  shortcutsSet: 'hostile:shortcuts:set',
  openExternal: 'hostile:open-external',
  roomGet: 'hostile:room:get',
  roomHost: 'hostile:room:host',
  roomJoin: 'hostile:room:join',
  roomLeave: 'hostile:room:leave',
  hostingStatus: 'hostile:hosting:status',
  hostingNewCode: 'hostile:hosting:new-code',
  bridgeReport: 'hostile:bridge:report',
} as const;

export const EVENT = {
  shortcutTriggered: 'hostile:event:shortcut',
  power: 'hostile:event:power',
  hostingStatus: 'hostile:event:hosting-status',
} as const;
