export default async function globalTeardown() {
  await globalThis.__HOSTILE_STACK__?.stop();
}
