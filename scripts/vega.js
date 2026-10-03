#!/usr/bin/env node
// Vega OS (Fire TV Stick 4K Select and newer): build both probe builds from the same pages as the
// Fire OS app, install them side by side on the connected Vega device, and open one.
//   npm run vega              opens "WebView Probe" (manifest declares the media-control block)
//   npm run vega -- template  opens "WebView Probe (template manifest)"
//   npm run vega -- build     builds both, installs nothing
// Needs the Vega SDK (macOS or Ubuntu), `npm install` once in vega/, and a device in developer
// mode connected over VDA (Settings → My Fire TV → About → Developer Options → Connection Mode → TCP/IP,
// then `$(vega which vda) connect <ip>:5555`).
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VEGA = path.join(ROOT, 'vega');
const PAGES = path.join(ROOT, 'app', 'src', 'main', 'assets');
const BASE_ID = 'io.github.simpleciki.firetvprobe';
const args = process.argv.slice(2);
const buildOnly = args.includes('build');
const openTemplate = args.includes('template');

// The media-control declaration from Amazon's WebView guide ("Build Web Apps with WebView", Vega 0.24).
// The guide's sample names its own component; here it names this app's.
const MEDIA_BLOCK = (id) => `
[[extras]]
key = "interface.provider"
component-id = "${id}.main"

[extras.value.application]
[[extras.value.application.interface]]
interface_name = "com.amazon.kepler.media.IMediaPlaybackServer"
command_options = [
    "Play",
    "Pause",
    "SkipForward",
    "SkipBackward",
]
`;

const BUILDS = [
  { name: 'media', id: BASE_ID, title: 'WebView Probe', mediaControl: true },
  { name: 'template', id: BASE_ID + '.template', title: 'WebView Probe (template manifest)', mediaControl: false },
];

function sh(cmd, cmdArgs, opts = {}) {
  console.log('[probe] ' + [cmd, ...cmdArgs].join(' '));
  return execFileSync(cmd, cmdArgs, { stdio: 'inherit', cwd: VEGA, ...opts });
}

function syncPages() {
  const dest = path.join(VEGA, 'assets');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(PAGES, dest, { recursive: true });
}

function writeBuildFiles(b) {
  const manifest = fs.readFileSync(path.join(VEGA, 'manifest.template.toml'), 'utf8')
    .replaceAll('{{ID}}', b.id)
    .replaceAll('{{TITLE}}', b.title)
    .replaceAll('{{CATEGORIES}}', b.mediaControl ? '"com.amazon.category.main", "com.amazon.category.kepler.media"' : '"com.amazon.category.main"')
    .replaceAll('{{MEDIA}}', b.mediaControl ? MEDIA_BLOCK(b.id) : '');
  fs.writeFileSync(path.join(VEGA, 'manifest.toml'), manifest);
  fs.writeFileSync(path.join(VEGA, 'app.json'), JSON.stringify({ name: b.id + '.main', displayName: b.title }, null, 2) + '\n');
  fs.writeFileSync(path.join(VEGA, 'src', 'flavor.json'), JSON.stringify({ name: b.name, mediaControl: b.mediaControl }) + '\n');
}

function build(b) {
  writeBuildFiles(b);
  fs.rmSync(path.join(VEGA, 'build'), { recursive: true, force: true });
  sh('npx', ['react-native', 'build-vega', '--build-type', 'Release']);
  const out = path.join(VEGA, 'dist');
  fs.mkdirSync(out, { recursive: true });
  const built = {};
  for (const arch of ['armv7', 'aarch64']) {
    const dir = path.join(VEGA, 'build', `${arch}-release`);
    const vpkg = fs.existsSync(dir) && fs.readdirSync(dir).find((f) => f.endsWith('.vpkg'));
    if (!vpkg) throw new Error(`no ${arch} package in ${dir}`);
    built[arch] = path.join(out, `firetv-webview-probe-${b.name}-${arch}.vpkg`);
    fs.copyFileSync(path.join(dir, vpkg), built[arch]);
  }
  return built;
}

function deviceArch() {
  const out = execFileSync('vega', ['device', 'info'], { encoding: 'utf8' });
  const arch = (JSON.parse(out.slice(out.indexOf('{'))).architecture || '');
  if (!arch) throw new Error('No Vega device connected (vega device info has no architecture).');
  return arch.startsWith('aarch64') || arch.startsWith('arm64') ? 'aarch64' : 'armv7';
}

syncPages();
const packages = BUILDS.map((b) => ({ b, built: build(b) }));
if (buildOnly) process.exit(0);
const arch = deviceArch();
for (const { b, built } of packages) sh('vega', ['device', 'install-app', '--packagePath', built[arch]]);
const open = packages.find(({ b }) => b.name === (openTemplate ? 'template' : 'media')).b;
sh('vega', ['device', 'launch-app', '--appName', open.id + '.main']);
