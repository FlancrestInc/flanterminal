import { mkdir, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { dirname, resolve } from 'node:path';

const destination = resolve('apps/client/src/assets/sounds/terminal-bell.wav');
const sampleRate = 16_000;
const durationSeconds = 0.14;
const samples = Math.floor(sampleRate * durationSeconds);
const dataBytes = samples * 2;
const buffer = Buffer.alloc(44 + dataBytes);

buffer.write('RIFF', 0);
buffer.writeUInt32LE(36 + dataBytes, 4);
buffer.write('WAVE', 8);
buffer.write('fmt ', 12);
buffer.writeUInt32LE(16, 16);
buffer.writeUInt16LE(1, 20);
buffer.writeUInt16LE(1, 22);
buffer.writeUInt32LE(sampleRate, 24);
buffer.writeUInt32LE(sampleRate * 2, 28);
buffer.writeUInt16LE(2, 32);
buffer.writeUInt16LE(16, 34);
buffer.write('data', 36);
buffer.writeUInt32LE(dataBytes, 40);

for (let index = 0; index < samples; index += 1) {
  const time = index / sampleRate;
  const envelope = Math.max(0, 1 - index / samples) ** 2;
  const wave = Math.sin(2 * Math.PI * 660 * time) * envelope;
  buffer.writeInt16LE(Math.round(wave * 7_000), 44 + index * 2);
}

await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, buffer);
