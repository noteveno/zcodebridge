'use strict';

// Platform identification sent in ZCode client headers.

const os = require('node:os');

function platformHeaders() {
  const platform = os.platform();
  const arch = os.arch();
  let xPlatform = `${platform}-${arch}`;
  if (platform === 'win32') xPlatform = arch === 'arm64' ? 'win32-arm64' : 'win32-x64';
  if (platform === 'darwin') xPlatform = arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  if (platform === 'linux') xPlatform = arch === 'arm64' ? 'linux-arm64' : 'linux-x64';

  let osCategory = 'linux';
  if (platform === 'win32') osCategory = 'windows';
  else if (platform === 'darwin') osCategory = 'macos';

  let osVersion = os.release();
  if (platform === 'win32') {
    const build = os.release().split('.')[2] || '22631';
    osVersion = `10.0.${build}`;
  }

  return { xPlatform, osCategory, osVersion };
}

module.exports = { platformHeaders };
