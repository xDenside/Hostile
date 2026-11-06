import { describe, expect, it } from 'vitest';
import { webCsp } from '../../src/http/app.js';
import type { AppContext } from '../../src/context.js';

const contextWith = (publicUrl: string) =>
  ({ config: { livekit: { publicUrl } } }) as unknown as AppContext;

const directive = (policy: string, name: string): string =>
  policy
    .split(';')
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `)) ?? '';

describe('webCsp', () => {
  it('allows WebAssembly compilation for the noise suppressor, and not eval', () => {
    const policy = webCsp(contextWith('ws://localhost:17890'));
    expect(directive(policy, 'script-src')).toBe("script-src 'self' 'wasm-unsafe-eval'");
    expect(policy).not.toContain("'unsafe-eval'");
  });

  it('serves the worklet module and the wasm from this origin only', () => {
    const policy = webCsp(contextWith('wss://lk.example.com'));
    expect(directive(policy, 'script-src')).toContain("'self'");
    expect(directive(policy, 'connect-src')).toBe(
      "connect-src 'self' wss://lk.example.com https://lk.example.com",
    );
    expect(directive(policy, 'worker-src')).toBe("worker-src 'self' blob:");
    expect(directive(policy, 'default-src')).toBe("default-src 'self'");
    expect(directive(policy, 'object-src')).toBe("object-src 'none'");
  });
});
