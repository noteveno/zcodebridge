#!/usr/bin/env node
'use strict';

/*
 * ZCodeBridge backup
 * ------------------
 *   node backup.js      (or: npm run backup)
 *
 * Packs the entire project folder - INCLUDING SECRETS (accounts/, config
 * files) - into zcodebridge-backup.zip. The zip is meant for the admin only:
 * it is listed in .gitignore and must never be committed. Re-run it (or let
 * the git pre-commit hook do it) after every change.
 *
 * Zero dependencies: a minimal ZIP writer (deflate) is implemented here.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'zcodebridge-backup.zip');

const SKIP_DIRS = new Set(['.git', 'node_modules', 'archive']);
const SKIP_FILES = new Set([path.basename(OUT), 'server.log']);

// --- minimal zip writer ----------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

function* walk(dir, base = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.memory' && entry.isDirectory()) continue; // skip .git etc.
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    if (entry.isFile() && SKIP_FILES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walk(full, rel);
    else if (entry.isFile()) yield { full, rel };
  }
}

function buildZip() {
  const files = [...walk(ROOT)];
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { full, rel } of files) {
    const data = fs.readFileSync(full);
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const name = Buffer.from(rel.replace(/\\/g, '/'), 'utf8');
    const { time, day } = dosDateTime(fs.statSync(full).mtime);
    const crc = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);          // version needed
    localHeader.writeUInt16LE(0, 6);           // flags
    localHeader.writeUInt16LE(8, 8);           // method: deflate
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(day, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    chunks.push(localHeader, name, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(day, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);        // extra len
    centralHeader.writeUInt16LE(0, 32);        // comment len
    centralHeader.writeUInt16LE(0, 34);        // disk number
    centralHeader.writeUInt16LE(0, 36);        // internal attrs
    centralHeader.writeUInt32LE(0, 38);        // external attrs
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, name);

    offset += 30 + name.length + compressed.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  fs.writeFileSync(OUT, Buffer.concat([...chunks, centralBuffer, end]));
  return { count: files.length, bytes: fs.statSync(OUT).size };
}

function runBackup() {
const result = buildZip();
  console.log(`backup written: ${OUT}`);
console.log(`${result.count} files, ${(result.bytes / 1024).toFixed(1)} KB`);
console.log('This zip contains secrets (accounts/, configs). Never commit or share it.');

}

module.exports = { runBackup };
