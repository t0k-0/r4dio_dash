import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(projectRoot, '_site');
const requiredFiles = [
  'index.html',
  'manifest.webmanifest',
  'aviation-data.js',
  'three.min.js',
  'polygon-clipping.min.js',
  'radio-audio-worklet.js',
  'CZ-WPT-National-XCSoar.cup',
  'CZ_low_plus_CE_26-04-01.cub',
  'enr_1_en.pdf'
];
const optionalFiles = ['icon_darkmode.svg', 'icon_lightmode.svg'];

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function escapeHtmlAttribute(value) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

for (const relativePath of requiredFiles) {
  await cp(path.join(projectRoot, relativePath), path.join(outputRoot, relativePath));
}
for (const relativePath of optionalFiles) {
  const source = path.join(projectRoot, relativePath);
  if (await exists(source)) await cp(source, path.join(outputRoot, relativePath));
}
await mkdir(path.join(outputRoot, 'vendor'), { recursive: true });
await cp(path.join(projectRoot, 'vendor', 'webrtlsdr'), path.join(outputRoot, 'vendor', 'webrtlsdr'), { recursive: true });

const apiBase = String(process.env.R4DIO_DASH_API_BASE || '').trim().replace(/\/$/, '');
if (apiBase && !/^https:\/\//i.test(apiBase)) {
  throw new Error('R4DIO_DASH_API_BASE must be an HTTPS origin.');
}
const indexPath = path.join(outputRoot, 'index.html');
let indexHtml = await readFile(indexPath, 'utf8');
indexHtml = indexHtml.replace(
  /(<meta name="r4dio-dash-api-base" content=")[^"]*(">)/,
  `$1${escapeHtmlAttribute(apiBase)}$2`
);
await writeFile(indexPath, indexHtml, 'utf8');
await writeFile(path.join(outputRoot, '.nojekyll'), '', 'utf8');
await cp(indexPath, path.join(outputRoot, '404.html'));

console.log(`R4DIO DASH GitHub Pages bundle created in ${outputRoot}`);
console.log(apiBase ? `Live-data relay: ${apiBase}` : 'Live-data relay: not configured (static features only)');
