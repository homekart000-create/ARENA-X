const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const builder = path.join(root, 'scripts', 'build-android-web.mjs');

function runBuilder(args, apiBaseUrl) {
  const env = { ...process.env };
  if (apiBaseUrl === undefined) delete env.ANDROID_API_BASE_URL;
  else env.ANDROID_API_BASE_URL = apiBaseUrl;
  return spawnSync(process.execPath, [builder, ...args], {
    cwd: root,
    env,
    encoding: 'utf8'
  });
}

test('release web build requires a production API origin', () => {
  const result = runBuilder(['--release']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ANDROID_API_BASE_URL must be set/);
});

test('release web build rejects localhost and non-HTTPS API origins', () => {
  const localhost = runBuilder(['--release'], 'https://localhost');
  assert.notEqual(localhost.status, 0);
  assert.match(localhost.stderr, /must not target a localhost API/);

  const cleartext = runBuilder(['--release'], 'http://api.example.test');
  assert.notEqual(cleartext.status, 0);
  assert.match(cleartext.stderr, /must use HTTPS/);
});

test('Android web stage contains only static app assets and the configured API origin', () => {
  const result = runBuilder(['--release'], 'https://api.example.test');
  assert.equal(result.status, 0, result.stderr);

  const stage = path.join(root, 'android-web');
  const files = readdirSync(stage);
  const htmlFiles = files.filter((file) => file.endsWith('.html'));
  assert.equal(htmlFiles.length, 15);
  assert.ok(files.includes('assets'));
  assert.ok(files.includes('css'));
  assert.ok(files.includes('js'));
  assert.ok(files.includes('manifest.webmanifest'));
  assert.ok(files.includes('service-worker.js'));
  assert.equal(files.includes('backend'), false);
  assert.equal(files.includes('docs'), false);

  const runtimeConfig = readFileSync(path.join(stage, 'android-runtime-config.js'), 'utf8');
  assert.equal(runtimeConfig, 'globalThis.ARENA_API_BASE_URL = "https://api.example.test";\n');
  const home = readFileSync(path.join(stage, 'index.html'), 'utf8');
  assert.match(home, /android-runtime-config\.js/);
  assert.match(home, /native-back-navigation\.js/);
});
