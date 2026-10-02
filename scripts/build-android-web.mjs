import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'android-web');
const release = process.argv.includes('--release');
const apiBaseUrl = (process.env.ANDROID_API_BASE_URL || '').trim();

function validateApiBaseUrl(value) {
  if (!value) {
    if (release) throw new Error('ANDROID_API_BASE_URL must be set to the production HTTPS API origin before a release build.');
    return '';
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('ANDROID_API_BASE_URL must be a valid absolute URL.');
  }
  if (parsed.username || parsed.password || !['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('ANDROID_API_BASE_URL must not contain credentials and must use HTTP or HTTPS.');
  }
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (release && localHost) throw new Error('Release builds must not target a localhost API.');
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('ANDROID_API_BASE_URL must be an origin without a path, query, or fragment.');
  }
  if (parsed.protocol !== 'https:' && !(localHost && !release)) {
    throw new Error('ANDROID_API_BASE_URL must use HTTPS, except for a non-release localhost development build.');
  }
  return parsed.href.replace(/\/$/, '');
}

const validatedApiBaseUrl = validateApiBaseUrl(apiBaseUrl);
const rootEntries = await readdir(root, { withFileTypes: true });
const htmlFiles = rootEntries
  .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
  .map((entry) => entry.name);

if (!htmlFiles.includes('index.html')) throw new Error('The ARENA X web entry point index.html is missing.');

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const entry of ['css', 'js', 'assets']) {
  await cp(path.join(root, entry), path.join(output, entry), { recursive: true });
}
for (const file of [...htmlFiles, 'manifest.webmanifest', 'service-worker.js']) {
  await cp(path.join(root, file), path.join(output, file));
}

const nativeBackBundle = await import('esbuild').then(({ build }) => build({
  absWorkingDir: root,
  entryPoints: ['scripts/native-back-navigation.js'],
  bundle: true,
  platform: 'browser',
  target: 'es2020',
  write: false
})).then((result) => result.outputFiles[0].text);
await writeFile(path.join(output, 'js', 'native-back-navigation.js'), nativeBackBundle, 'utf8');

const runtimeConfig = `globalThis.ARENA_API_BASE_URL = ${JSON.stringify(validatedApiBaseUrl)};\n`;
await writeFile(path.join(output, 'android-runtime-config.js'), runtimeConfig, 'utf8');

for (const file of htmlFiles) {
  const htmlPath = path.join(output, file);
  const html = await readFile(htmlPath, 'utf8');
  if (!html.includes('</head>')) throw new Error(`${file} does not contain a closing head element.`);
  const bootstrap = [
    '<script src="android-runtime-config.js"></script>',
    '<script src="js/native-back-navigation.js" defer></script>'
  ].join('\n  ');
  await writeFile(htmlPath, html.replace('</head>', `  ${bootstrap}\n</head>`), 'utf8');
}

console.log(`Prepared ${htmlFiles.length} ARENA X pages for Android.`);
console.log(validatedApiBaseUrl
  ? 'Android API base: configured from ANDROID_API_BASE_URL.'
  : 'Android API base: not configured; backend-dependent operations will report unavailable.');
