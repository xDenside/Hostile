import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL_DIR } from '../scripts/lib/env.mjs';

const SAMPLE_RATE = 48_000;

function writeWav(file: string, samples: Int16Array): void {
  const data = Buffer.alloc(samples.length * 2);
  for (const [i, value] of samples.entries()) data.writeInt16LE(value, i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([header, data]));
}

export function ensureToneFile(): string {
  mkdirSync(LOCAL_DIR, { recursive: true });
  const file = join(LOCAL_DIR, 'e2e-tone.wav');
  if (existsSync(file)) return file;

  const seconds = 5;
  const count = SAMPLE_RATE * seconds;
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    const tremolo = 0.6 + 0.4 * Math.sin((2 * Math.PI * 2 * i) / SAMPLE_RATE);
    samples[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE) * 12000 * tremolo);
  }
  writeWav(file, samples);
  return file;
}

function readWavSamples(file: string): Int16Array {
  const buf = readFileSync(file);
  let at = 12;
  while (at + 8 <= buf.length) {
    const id = buf.toString('latin1', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'data') {
      const samples = new Int16Array(Math.floor(Math.min(size, buf.length - at - 8) / 2));
      for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(at + 8 + i * 2);
      return samples;
    }
    at += 8 + size + (size % 2);
  }
  throw new Error(`${file} has no data chunk`);
}

export function ensureSpeechNoiseFile(): string | null {
  mkdirSync(LOCAL_DIR, { recursive: true });
  const file = join(LOCAL_DIR, 'e2e-speech-noise.wav');
  if (existsSync(file)) return file;
  const spoken = join(LOCAL_DIR, 'e2e-speech-raw.wav');
  try {
    execFileSync(
      'say',
      [
        '-o',
        spoken,
        '--data-format=LEI16@48000',
        'The quick brown fox jumps over the lazy dog. ' +
          'Pack my box with five dozen liquor jugs.',
      ],
      { stdio: 'ignore', timeout: 60_000 },
    );
  } catch {
    return null;
  }
  let speech: Int16Array;
  try {
    speech = readWavSamples(spoken);
  } catch {
    return null;
  } finally {
    rmSync(spoken, { force: true });
  }
  if (speech.length < SAMPLE_RATE) return null;

  const pause = Math.round(SAMPLE_RATE * 1.2);
  const total = pause + speech.length + pause;
  const out = new Int16Array(total);
  let peak = 1;
  for (const value of speech) peak = Math.max(peak, Math.abs(value));
  const gain = (0.7 * 32767) / peak;
  const noiseAmplitude = 0.08 * 32767;
  let seed = 20260921;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < total; i++) {
    const voice = i >= pause && i < pause + speech.length ? speech[i - pause]! * gain : 0;
    const noise = (random() * 2 - 1) * noiseAmplitude;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(voice + noise)));
  }
  writeWav(file, out);
  return file;
}
