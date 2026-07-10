import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const roots = ['packages/shared/dist', 'apps/server/dist'];
const forbidden = /(?:\.test\.(?:js|d\.ts)(?:\.map)?$|\.tsbuildinfo$)/;

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
