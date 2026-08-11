/*
 * 生成 AI Reader 的应用图标(PNG + ICO + ICNS)。
 * 用法:node scripts/generate-icons.mjs
 * 输出到 apps/reader/src-tauri/icons/,供 Tauri 打包与窗口图标使用。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'apps', 'reader', 'src-tauri', 'icons');

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint32BE(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const payload = Buffer.concat([typeBuffer, data]);
  return Buffer.concat([uint32BE(data.length), payload, uint32BE(crc32(payload))]);
}

function encodePng(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // color type: RGBA
  const stride = size * 4;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    signature,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const TOP = { r: 0x3b, g: 0x82, b: 0xf6 };
const BOTTOM = { r: 0x8b, g: 0x5c, b: 0xf6 };

function insideRoundedSquare(x, y, size, radius) {
  if (x < 0 || y < 0 || x >= size || y >= size) return false;
  const corners = [
    [radius, radius],
    [size - radius, radius],
    [radius, size - radius],
    [size - radius, size - radius],
  ];
  const inCornerX = x < radius || x >= size - radius;
  const inCornerY = y < radius || y >= size - radius;
  if (inCornerX && inCornerY) {
    const [cx, cy] =
      x < radius
        ? y < radius
          ? corners[0]
          : corners[2]
        : y < radius
          ? corners[1]
          : corners[3];
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  }
  return true;
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  for (let y = 0; y < size; y += 1) {
    const t = y / (size - 1);
    const r = Math.round(TOP.r + (BOTTOM.r - TOP.r) * t);
    const g = Math.round(TOP.g + (BOTTOM.g - TOP.g) * t);
    const b = Math.round(TOP.b + (BOTTOM.b - TOP.b) * t);
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      if (insideRoundedSquare(x + 0.5, y + 0.5, size, radius)) {
        rgba[offset] = r;
        rgba[offset + 1] = g;
        rgba[offset + 2] = b;
        rgba[offset + 3] = 255;
      }
    }
  }
  return rgba;
}

function encodeIco(sizes) {
  const images = sizes.map((size) => ({ size, png: encodePng(size, drawIcon(size)) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let dataOffset = 6 + images.length * 16;
  const entries = [];
  const payloads = [];
  for (const image of images) {
    const entry = Buffer.alloc(16);
    entry[0] = image.size >= 256 ? 0 : image.size;
    entry[1] = image.size >= 256 ? 0 : image.size;
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(image.png.length, 8);
    entry.writeUInt32LE(dataOffset, 12);
    entries.push(entry);
    payloads.push(image.png);
    dataOffset += image.png.length;
  }
  return Buffer.concat([header, ...entries, ...payloads]);
}

function encodeIcns(entries) {
  const payloads = entries.map(({ type, size }) => {
    const png = encodePng(size, drawIcon(size));
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, 'ascii');
    header.writeUInt32BE(8 + png.length, 4);
    return Buffer.concat([header, png]);
  });
  const body = Buffer.concat(payloads);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([header, body]);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, '32x32.png'), encodePng(32, drawIcon(32)));
writeFileSync(join(OUT_DIR, '128x128.png'), encodePng(128, drawIcon(128)));
writeFileSync(join(OUT_DIR, '128x128@2x.png'), encodePng(256, drawIcon(256)));
writeFileSync(join(OUT_DIR, 'icon.png'), encodePng(512, drawIcon(512)));
writeFileSync(join(OUT_DIR, 'icon.ico'), encodeIco([16, 24, 32, 48, 64, 256]));
writeFileSync(
  join(OUT_DIR, 'icon.icns'),
  encodeIcns([
    { type: 'ic07', size: 128 },
    { type: 'ic08', size: 256 },
    { type: 'ic09', size: 512 },
    { type: 'ic10', size: 1024 },
  ]),
);
console.log(`icons written to ${OUT_DIR}`);
