// .unitypackage を「展開せず」ストリームでメンバ列挙して解析する。
// opts.previewDir 指定時は preview.png を <previewDir>/<guid>.png に抽出する。
import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import zlib from 'node:zlib';
import { basename, extname, join } from 'node:path';
import * as tar from 'tar-stream';
import { classify, importerOf, type AssetKind } from './classify.js';

export interface PackageEntry {
  guid: string;
  pathname: string;
  ext: string;
  kind: AssetKind;
  importer?: string;
  hasAsset: boolean;
  hasPreview: boolean;
  assetSize: number;
  previewSize: number;
}

export interface ShaderReq {
  liltoon: boolean;         // lilToon マテリアルを含む
  poiyomi: boolean;         // Poiyomi マテリアルを含む
  locked: boolean;          // Poiyomi ロック済み(_ShaderOptimizerEnabled:1)
}

export interface ParsedPackage {
  file: string;
  fileName: string;
  sizeBytes: number;
  mtimeMs: number;          // 最終更新時刻(ms)。差分スキャンで未変更パッケージを再解析せずスキップするのに使う
  guids: string[];          // 全GUIDフォルダ名（= 各アセットのguid。遡及検出に使う）
  entries: PackageEntry[];
  fileCount: number;
  previewCount: number;
  kindBreakdown: Record<string, number>;
  shaders: ShaderReq;       // 必要シェーダ(マテリアル先頭の指紋から判定)
  coverGuid?: string;       // カタログ代表サムネに使うguid
  previewDir?: string;      // preview.png を抽出した先
}

// マテリアルYAML(先頭~32KB)からシェーダ系統を判定。追加I/Oなし(既存drainで通過するバイト列を覗くだけ)。
const MAT_PEEK = 32 * 1024;
function fingerprintMaterial(text: string, s: ShaderReq): void {
  if (!/^Material:/m.test(text) && !text.includes('!u!21')) return;   // マテリアルのみ
  if (/_lilToonVersion|jp\.lilxyzw|lilToon/i.test(text)) s.liltoon = true;
  if (/poiyomi|_ShaderOptimizerEnabled|shader_is_using_thry_editor|\.poi\b/i.test(text)) s.poiyomi = true;
  if (/_ShaderOptimizerEnabled:\s*1\b/.test(text) || /Hidden\/(?:Locked|Poiyomi)/i.test(text)) s.locked = true;
}

interface Group { pathname?: string; importer?: string; hasAsset: boolean; hasPreview: boolean; assetSize: number; previewSize: number; }

const GUID_RE = /^[0-9a-f]{32}$/;

export async function parsePackage(file: string, opts: { previewDir?: string } = {}): Promise<ParsedPackage> {
  const groups = new Map<string, Group>();
  const shaders: ShaderReq = { liltoon: false, poiyomi: false, locked: false };
  const st = await stat(file);
  if (opts.previewDir) mkdirSync(opts.previewDir, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const ex = tar.extract();
    ex.on('entry', (header, stream, next) => {
      const name = String(header.name).replace(/\\/g, '/');
      const slash = name.indexOf('/');
      const guid = slash < 0 ? '' : name.slice(0, slash);
      const fname = slash < 0 ? '' : name.slice(slash + 1);
      if (!GUID_RE.test(guid) || fname.length === 0) { drain(stream, next); return; }

      let g = groups.get(guid);
      if (!g) { g = { hasAsset: false, hasPreview: false, assetSize: 0, previewSize: 0 }; groups.set(guid, g); }

      if (fname === 'pathname' || fname === 'asset.meta') {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('error', reject);
        stream.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (fname === 'pathname') {
            const first = text.split('\n')[0] ?? '';
            g!.pathname = first.trim().replace(/\\/g, '/');
          } else {
            g!.importer = importerOf(text);
          }
          next();
        });
      } else if (fname === 'preview.png') {
        g.hasPreview = true;
        if (opts.previewDir) {
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('error', reject);
          stream.on('end', () => {
            const buf = Buffer.concat(chunks);
            g!.previewSize = buf.length;
            try { writeFileSync(join(opts.previewDir!, guid + '.png'), buf); } catch { /* ignore */ }
            next();
          });
        } else {
          g.previewSize = Number(header.size ?? 0);
          drain(stream, next);
        }
      } else if (fname === 'asset') {
        g.hasAsset = true; g.assetSize = Number(header.size ?? 0);
        // YAML(テキスト)資産の先頭だけ覗いてマテリアルのシェーダ系統を判定。バイナリ資産は即drain。
        let isText: boolean | null = null;
        let buf = ''; let full = false;
        stream.on('data', (c: Buffer) => {
          if (full) return;
          if (isText === null) isText = c.slice(0, 8).toString('latin1').startsWith('%YAML');
          if (!isText) { full = true; return; }
          buf += c.toString('utf8');
          if (buf.length >= MAT_PEEK) full = true;
        });
        stream.on('error', reject);
        stream.on('end', () => { if (isText && buf) fingerprintMaterial(buf, shaders); next(); });
        stream.resume();
      } else {
        drain(stream, next);
      }
    });
    ex.on('finish', () => resolve());
    ex.on('error', reject);
    createReadStream(file).on('error', reject)
      .pipe(zlib.createGunzip()).on('error', reject)
      .pipe(ex);
  });

  const entries: PackageEntry[] = [];
  const kindBreakdown: Record<string, number> = {};
  let previewCount = 0;
  for (const [guid, g] of groups) {
    if (!g.hasAsset && !g.pathname) continue;
    const pathname = g.pathname ?? '';
    const ext = extname(pathname).toLowerCase();
    const kind: AssetKind = (g.hasAsset || ext) ? classify(ext, g.importer) : 'folder';
    if (g.hasPreview) previewCount++;
    kindBreakdown[kind] = (kindBreakdown[kind] ?? 0) + 1;
    entries.push({ guid, pathname, ext, kind, importer: g.importer, hasAsset: g.hasAsset, hasPreview: g.hasPreview, assetSize: g.assetSize, previewSize: g.previewSize });
  }

  const cover = pickCover(entries);

  return {
    file,
    fileName: basename(file),
    sizeBytes: st.size,
    mtimeMs: Math.round(st.mtimeMs),
    guids: [...groups.keys()],
    entries,
    fileCount: entries.length,
    previewCount,
    kindBreakdown,
    shaders,
    coverGuid: cover?.guid,
    previewDir: opts.previewDir,
  };
}

// 代表サムネ: prefab > model > material > texture の順、同種では preview が大きい(=詳細)もの。
function pickCover(entries: PackageEntry[]): PackageEntry | undefined {
  const prio = (k: AssetKind) => (k === 'prefab' ? 0 : k === 'model' ? 1 : k === 'material' ? 2 : k === 'texture' ? 3 : 4);
  return entries.filter(e => e.hasPreview).sort((a, b) => prio(a.kind) - prio(b.kind) || b.previewSize - a.previewSize)[0];
}

function drain(stream: NodeJS.ReadableStream, next: () => void) {
  stream.on('end', next);
  stream.resume();
}
