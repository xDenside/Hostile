export interface LivekitConfigInputs {
  port: number;
  udpPort: number;
  key: string;
  secret: string;
  apiPort: number;
  stunServers?: string[];
}

export function renderLivekitConfig(inputs: LivekitConfigInputs): string {
  const stun = inputs.stunServers;
  return [
    `port: ${inputs.port}`,
    'bind_addresses:',
    '  - "127.0.0.1"',
    'rtc:',
    `  udp_port: ${inputs.udpPort}`,
    '  tcp_port: 0',
    '  use_external_ip: true',
    '  use_ice_lite: false',
    ...(stun ? ['  stun_servers:', ...stun.map((server) => `    - "${server}"`)] : []),
    'keys:',
    `  ${inputs.key}: ${inputs.secret}`,
    'webhook:',
    `  api_key: ${inputs.key}`,
    '  urls:',
    `    - "http://127.0.0.1:${inputs.apiPort}/api/livekit/webhook"`,
    'room:',
    '  auto_create: true',
    '  empty_timeout: 60',
    '  departure_timeout: 10',
    'logging:',
    '  level: warn',
    'turn:',
    '  enabled: false',
    '',
  ].join('\n');
}
