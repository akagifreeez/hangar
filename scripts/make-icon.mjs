// アイコン生成: SVG(格納庫＋荷物=アセット) を Electron でレンダ → PNG/ICO 出力。
// 実行: env -u ELECTRON_RUN_AS_NODE electron scripts/make-icon.mjs
import { app, BrowserWindow, nativeImage } from 'electron';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'build');
mkdirSync(BUILD, { recursive: true });

const SVG = `<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#23232c"/><stop offset="1" stop-color="#141418"/>
    </linearGradient>
    <linearGradient id="han" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#6f8bff"/><stop offset="1" stop-color="#3f5fe0"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <path d="M96 392 L96 252 A160 160 0 0 1 416 252 L416 392 Z" fill="url(#han)"/>
  <path d="M168 392 L168 304 A88 88 0 0 1 344 304 L344 392 Z" fill="#15151a"/>
  <rect x="78" y="388" width="356" height="24" rx="12" fill="#6f8bff"/>
  <polygon points="256,300 308,326 256,352 204,326" fill="#d7ccff"/>
  <polygon points="204,326 256,352 256,390 204,364" fill="#aa99ee"/>
  <polygon points="308,326 256,352 256,390 308,364" fill="#8f7ee0"/>
</svg>`;

const HTML = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}
svg{display:block;width:512px;height:512px}</style>${SVG}`;

function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  const entries = Buffer.alloc(16 * images.length);
  let offset = 6 + 16 * images.length;
  images.forEach((im, i) => {
    const e = entries.subarray(i * 16, i * 16 + 16);
    e.writeUInt8(im.size >= 256 ? 0 : im.size, 0);
    e.writeUInt8(im.size >= 256 ? 0 : im.size, 1);
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(im.png.length, 8); e.writeUInt32LE(offset, 12);
    offset += im.png.length;
  });
  return Buffer.concat([header, entries, ...images.map(i => i.png)]);
}

app.whenReady().then(async () => {
  const htmlPath = join(BUILD, '_icon.html');
  writeFileSync(htmlPath, HTML);
  const win = new BrowserWindow({ width: 512, height: 512, useContentSize: true, show: false, frame: false, transparent: true, backgroundColor: '#00000000' });
  await win.loadFile(htmlPath);
  await new Promise(r => setTimeout(r, 400));
  let img = await win.webContents.capturePage();
  img = img.resize({ width: 512, height: 512 });
  writeFileSync(join(BUILD, 'icon.png'), img.toPNG());                 // electron-builder 用(>=256)
  const sizes = [256, 128, 64, 48, 32, 16];
  const images = sizes.map(size => ({ size, png: img.resize({ width: size, height: size }).toPNG() }));
  writeFileSync(join(BUILD, 'icon.ico'), buildIco(images));
  rmSync(htmlPath, { force: true });
  console.log('icon.png + icon.ico written to ' + BUILD);
  app.quit();
});
