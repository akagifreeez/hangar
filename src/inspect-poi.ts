// 使い捨て: パッケージがPoiyomiを使っているか/ロック済みか/同梱シェーダ有無を診断する。
import { createReadStream } from 'node:fs';
import zlib from 'node:zlib';
import * as tar from 'tar-stream';
import { extname } from 'node:path';

const file = process.argv[2];
if (!file) { console.error('usage: inspect-poi <file>'); process.exit(1); }

const GUID_RE = /^[0-9a-f]{32}$/;
const path = new Map<string, string>();      // guid -> pathname
const matText = new Map<string, string>();    // guid -> material yaml (first 4KB)
const shaderFiles: string[] = [];             // 同梱.shaderのpathname
let kinds: Record<string, number> = {};

function ext(p: string) { return extname(p).toLowerCase(); }

function run(onEntry: (guid: string, fname: string, s: NodeJS.ReadableStream, next: () => void) => void): Promise<void> {
  return new Promise((res, rej) => {
    const ex = tar.extract();
    ex.on('entry', (h, s, n) => {
      const name = String(h.name).replace(/\\/g, '/');
      const i = name.indexOf('/');
      const guid = i < 0 ? '' : name.slice(0, i);
      const fname = i < 0 ? '' : name.slice(i + 1);
      if (!GUID_RE.test(guid) || !fname) { s.on('end', n); s.resume(); return; }
      onEntry(guid, fname, s, n);
    });
    ex.on('finish', () => res());
    ex.on('error', rej);
    createReadStream(file).on('error', rej).pipe(zlib.createGunzip()).on('error', rej).pipe(ex);
  });
}

// pass1: pathname収集
await run((guid, fname, s, next) => {
  if (fname === 'pathname') {
    const c: Buffer[] = [];
    s.on('data', (x: Buffer) => c.push(x));
    s.on('end', () => { path.set(guid, Buffer.concat(c).toString('utf8').split('\n')[0]!.trim().replace(/\\/g, '/')); next(); });
  } else { s.on('end', next); s.resume(); }
});

for (const [, p] of path) {
  const e = ext(p) || '(none)';
  kinds[e] = (kinds[e] ?? 0) + 1;
  if (ext(p) === '.shader') shaderFiles.push(p);
}

// pass2: .mat の中身を読む
const matGuids = new Set([...path].filter(([, p]) => ext(p) === '.mat').map(([g]) => g));
await run((guid, fname, s, next) => {
  if (fname === 'asset' && matGuids.has(guid)) {
    const c: Buffer[] = []; let len = 0;
    s.on('data', (x: Buffer) => { if (len < 8192) { c.push(x); len += x.length; } });
    s.on('end', () => { matText.set(guid, Buffer.concat(c).toString('utf8').slice(0, 8192)); next(); });
  } else { s.on('end', next); s.resume(); }
});

// 解析
let poiMats = 0, lilMats = 0, lockedMats = 0, otherMats = 0;
const shaderNames = new Map<string, number>();
for (const [guid, t] of matText) {
  const nameMatch = t.match(/m_Shader:.*?guid:\s*([0-9a-f]{32})/s);
  const poi = /poiyomi|_ShaderOptimizerEnabled|shader_is_using_thry_editor|\.poiyomi/i.test(t);
  const lil = /_lilToonVersion|lilToon|jp\.lilxyzw/i.test(t);
  const locked = /_ShaderOptimizerEnabled:\s*1/i.test(t) || /Hidden\/Locked/i.test(t);
  if (poi) poiMats++; else if (lil) lilMats++; else otherMats++;
  if (locked) lockedMats++;
  // shader name 推定（m_Name直後やHidden/Locked参照）
  const hn = t.match(/Hidden\/[^\s\n"]+/);
  if (hn) shaderNames.set(hn[0], (shaderNames.get(hn[0]) ?? 0) + 1);
}

console.log('=== ' + file);
console.log('総アセット種別:', JSON.stringify(kinds));
console.log(`マテリアル: ${matText.size}  (Poiyomi:${poiMats} / lilToon:${lilMats} / その他:${otherMats})`);
console.log(`ロック済み(_ShaderOptimizerEnabled:1 or Hidden/Locked参照): ${lockedMats}`);
console.log(`同梱.shaderファイル: ${shaderFiles.length}`);
for (const s of shaderFiles.slice(0, 20)) console.log('   ' + s);
if (shaderNames.size) { console.log('参照Hidden/Lockedシェーダ名(マテリアル内):'); for (const [n, c] of shaderNames) console.log(`   ${n}  x${c}`); }
