import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const roots = ['packages/shared/dist', 'apps/server/dist'];
const forbidden = /(?:\.test\.(?:js|d\.ts)(?:\.map)?$|\.tsbuildinfo$)/;
const clientJavaScriptLimit = 650_000;
const requiredClientAssets = [
  /^JetBrainsMonoNerdFont-Regular-[^/]+\.ttf$/u,
  /^terminal-bell-[^/]+\.wav$/u,
];

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

const settingsViewChunks = filesUnder('apps/client/dist')
  .map((path) => relative('.', path))
  .filter((path) => /(?:^|\/)SettingsView-[^/]+\.js$/u.test(path));

if (settingsViewChunks.length > 0) {
  throw new Error(
    `Production client must not emit a separate SettingsView chunk: ${settingsViewChunks.join(', ')}`,
  );
}

const clientAssets = filesUnder('apps/client/dist/assets').map((path) =>
  path.slice('apps/client/dist/assets/'.length),
);
for (const requiredAsset of requiredClientAssets) {
  if (!clientAssets.some((path) => requiredAsset.test(path))) {
    throw new Error(`Production client asset is missing: ${requiredAsset}`);
  }
}

const serverPackage = JSON.parse(
  readFileSync('apps/server/package.json', 'utf8'),
);
for (const dependency of ['bcrypt', 'jose']) {
  if (typeof serverPackage.dependencies?.[dependency] !== 'string') {
    throw new Error(`Production server dependency is missing: ${dependency}`);
  }
}
