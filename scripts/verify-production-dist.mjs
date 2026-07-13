import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const roots = ['packages/shared/dist', 'apps/server/dist'];
const forbidden = /(?:\.test\.(?:js|d\.ts)(?:\.map)?$|\.tsbuildinfo$)/;
const clientJavaScriptLimit = 650_000;

function filesUnder(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

const invalidFiles = roots
  .flatMap(filesUnder)
  .map((path) => relative('.', path))
  .filter((path) => forbidden.test(path));

if (invalidFiles.length > 0) {
  throw new Error(
    `Production dist contains forbidden files: ${invalidFiles.join(', ')}`,
  );
}

const oversizedClientChunks = filesUnder('apps/client/dist')
  .filter((path) => path.endsWith('.js'))
  .map((path) => ({ path: relative('.', path), size: statSync(path).size }))
  .filter(({ size }) => size > clientJavaScriptLimit);

if (oversizedClientChunks.length > 0) {
  throw new Error(
    `Production client chunks exceed ${clientJavaScriptLimit} bytes: ${oversizedClientChunks
      .map(({ path, size }) => `${path} (${size} bytes)`)
      .join(', ')}`,
  );
}
