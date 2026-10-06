// Beta packaging flavor of after-pack.cjs: run the stock hook, then point the
// Dock at the beta icon.icns. The stock hook copies the official Assets.car and
// Info.plist's CFBundleIconName keeps macOS 13+ reading that catalog; the beta
// design is only rendered as PNG/icns here (actool needs full Xcode), so drop
// the asset-catalog pointer and let CFBundleIconFile resolve to the swapped
// Resources/icon.icns.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const stockAfterPack = require('./after-pack.cjs');

module.exports = async (context) => {
  await stockAfterPack(context);
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const resourcesPath = path.join(appPath, 'Contents', 'Resources');
  fs.rmSync(path.join(resourcesPath, 'Assets.car'), { force: true });
  try {
    execFileSync('/usr/bin/plutil', ['-remove', 'CFBundleIconName', path.join(appPath, 'Contents', 'Info.plist')]);
  } catch (error) {
    // The key is only a pointer; if plutil refused for another reason the
    // pack must not fail — the icns still ships and the name is cosmetic.
    console.warn('[package:beta] could not remove CFBundleIconName:', error.message);
  }
};
