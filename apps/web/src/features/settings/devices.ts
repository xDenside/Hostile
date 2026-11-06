import type { SessionInfoDTO } from '@hostile/shared';

const SYSTEMS: [RegExp, string][] = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/Windows/, 'Windows'],
  [/CrOS/, 'ChromeOS'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Linux/, 'Linux'],
];

const BROWSERS: [RegExp, string][] = [
  [/Edg(e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/YaBrowser\//, 'Yandex Browser'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

const find = (table: [RegExp, string][], text: string) =>
  table.find(([pattern]) => pattern.test(text))?.[1] ?? null;

export function describeDevice(session: Pick<SessionInfoDTO, 'client' | 'userAgent'>): {
  name: string;
  phone: boolean;
} {
  const agent = session.userAgent ?? '';
  const system = find(SYSTEMS, agent);
  const program = session.client === 'desktop' ? 'Desktop app' : find(BROWSERS, agent);
  const phone = system === 'iPhone' || system === 'Android' || system === 'iPad';
  if (program && system) return { name: `${program} on ${system}`, phone };
  return { name: program ?? system ?? 'Unknown browser', phone };
}
