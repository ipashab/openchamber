// Beta packaging flavor: the same code with its own name, appId and icon, so
// the app with our changes sits next to the official OpenChamber in
// /Applications and is obvious in the Dock.
//
// The beta icon is rendered from the stock PNG with a corner badge, compiled
// into an .icns, and swapped into the fixed asset paths for the duration of
// the build. after-pack-beta.cjs then strips the CFBundleIconName pointer so
// macOS reads the swapped icon.icns instead of the official asset catalog.
//
// Usage: node ./scripts/package-beta.mjs [extra electron-builder args...]

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = path.join(packageRoot, 'resources', 'icons');
const betaDir = path.join(iconsDir, 'beta');

const BETA_PRODUCT_NAME = 'OpenChamber Beta';
const BETA_APP_ID = 'dev.openchamber.desktop.beta';
const BETA_BADGE_COLOR = '#F97316';

// The stock assets after-pack.cjs and electron-builder read by fixed path.
const SWAPPED_ASSETS = [
  ['icon.icns', 'beta/icon-beta.icns'],
  ['icon.png', 'beta/icon-beta.png'],
];

const run = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: 'utf8', ...options }).trim();

const renderBetaPng = () => {
  fs.mkdirSync(betaDir, { recursive: true });
  // A Pillow pass draws the corner badge; python3 with Pillow is available in
  // the QA environment, and the parameters stay here rather than in a scratch
  // file so the icon can always be regenerated.
  run('python3', [
    '-c',
    `
from PIL import Image, ImageDraw, ImageFont

base = Image.open(${JSON.stringify(path.join(iconsDir, 'icon.png'))}).convert('RGBA')
draw = ImageDraw.Draw(base)

center, radius = (772, 772), 150
draw.ellipse(
    (center[0] - radius, center[1] - radius, center[0] + radius, center[1] + radius),
    fill=${JSON.stringify(BETA_BADGE_COLOR)}, outline='#0B0B0B', width=12,
)

text = 'β'
size = 200
font = None
for font_path, index in (
    ('/System/Library/Fonts/Helvetica.ttc', 1),
    ('/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf', 0),
):
    try:
        font = ImageFont.truetype(font_path, size, index=index)
        break
    except OSError:
        continue
if font is None:
    font = ImageFont.load_default(size)

box = draw.textbbox((0, 0), text, font=font)
draw.text(
    (center[0] - (box[0] + box[2]) / 2, center[1] - (box[1] + box[3]) / 2),
    text, font=font, fill='#0B0B0B',
)

base.save(${JSON.stringify(path.join(betaDir, 'icon-beta.png'))})
`,
  ]);
};

// iconutil wants the classic iconset layout at fixed names and sizes.
const ICONSET_FILES = [
  ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
];

const renderBetaIcns = () => {
  const iconset = path.join(betaDir, 'icon-beta.iconset');
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset, { recursive: true });
  const source = path.join(betaDir, 'icon-beta.png');
  for (const [name, px] of ICONSET_FILES) {
    run('sips', ['-z', String(px), String(px), source, '--out', path.join(iconset, name)]);
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', path.join(betaDir, 'icon-beta.icns')]);
};

const swapInBetaAssets = () => {
  const backups = [];
  for (const [stock, betaRelative] of SWAPPED_ASSETS) {
    const stockPath = path.join(iconsDir, stock);
    const backupPath = `${stockPath}.official-backup`;
    fs.copyFileSync(stockPath, backupPath);
    backups.push({ stockPath, backupPath });
    fs.copyFileSync(path.join(iconsDir, betaRelative), stockPath);
  }
  return () => {
    for (const { stockPath, backupPath } of backups) {
      fs.copyFileSync(backupPath, stockPath);
      fs.rmSync(backupPath, { force: true });
    }
  };
};

const main = async () => {
  if (process.platform !== 'darwin') {
    console.error('[package:beta] the beta flavor only makes sense on macOS');
    process.exit(1);
  }
  console.log('[package:beta] rendering beta icon assets');
  renderBetaPng();
  renderBetaIcns();

  const restore = swapInBetaAssets();
  const builderArgs = [
    `--config.appId=${BETA_APP_ID}`,
    `--config.productName=${BETA_PRODUCT_NAME}`,
    '--config.artifactName=OpenChamber-beta-${version}-${arch}.${ext}',
    '--config.mac.artifactName=OpenChamber-beta-${version}-mac-${arch}.${ext}',
    '--config.afterPack=scripts/after-pack-beta.cjs',
    ...process.argv.slice(2),
  ];
  try {
    console.log(`[package:beta] packaging as "${BETA_PRODUCT_NAME}" (appId ${BETA_APP_ID})`);
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(packageRoot, 'scripts', 'package.mjs'), ...builderArgs], {
        stdio: 'inherit',
        cwd: packageRoot,
      });
      child.on('exit', (code, signal) => {
        if (signal) process.kill(process.pid, signal);
        else if (code === 0) resolve();
        else reject(new Error(`electron-builder exited with ${code}`));
      });
      child.on('error', reject);
    });
  } finally {
    restore();
    console.log('[package:beta] stock icon assets restored');
  }
};

await main();
