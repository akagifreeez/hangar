// GUID遡及検出: プロジェクトの Assets/*.meta のGUID群 × ライブラリ各パッケージのGUID群を突合。
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const GUID_LINE = /guid: ([0-9a-f]{32})/;
// シェーダ「導入」の証拠 = フォルダ境界で名乗るもの。マテリアル/テクスチャ名に'lilToon'/'poiyomi'が
// 入るだけ(例: body_lilToon.mat)では導入とみなさない(さもないと依存欠落の警告を握りつぶしてピンク見逃し)。
const LIL_DIR = /(^|\/)(liltoon|jp\.lilxyzw)[^/]*\//i;
const POI_DIR = /(^|\/)(_?poiyomishaders|com\.poiyomi)[^/]*\//i;

// プロジェクトの全アセットを GUID↔相対パス の両方向で索引化する。
// guid→path: 取り込みパッケージのGUIDが既存のどこを上書きするか(diff)に使う。
// path→guid: 同パスに別GUIDが来る「パス衝突」検出に使う。
// hasLilToon/Poiyomi: VPM(Packages/)導入 or Assets内シェーダフォルダの有無で「必要シェーダを持っているか」を判定。
export interface ProjectIndex {
  guidToPath: Map<string, string>;
  pathToGuid: Map<string, string>;
  hasLilToon: boolean;
  hasPoiyomi: boolean;
  metaCount: number;
}

// includePackages: Packages/(VPM)配下も索引する。diffで「VPMのlilToon/Poiyomiに、同梱シェーダが衝突」を
// 検出するのに必要(BOOTHアバター制作で最頻出の競合)。detect用のprojectGuidsはAssetsのみ(既存挙動維持)。
export async function projectIndex(projectRoot: string, opts: { includePackages?: boolean } = {}): Promise<ProjectIndex> {
  const guidToPath = new Map<string, string>();
  const pathToGuid = new Map<string, string>();
  let metaCount = 0;
  // VPM(Packages/)経由のシェーダ。BOOTHアバターはここに入った lilToon/Poiyomi を参照することが多い。
  let hasLilToon = existsSync(join(projectRoot, 'Packages', 'jp.lilxyzw.liltoon'));
  let hasPoiyomi = existsSync(join(projectRoot, 'Packages', 'com.poiyomi.toon'));

  const onMeta = async (file: string) => {
    if (!file.endsWith('.meta')) return;
    metaCount++;
    const rel = relative(projectRoot, file.slice(0, -5)).replace(/\\/g, '/'); // .meta除去・正規化
    if (!hasLilToon && LIL_DIR.test(rel)) hasLilToon = true;
    if (!hasPoiyomi && POI_DIR.test(rel)) hasPoiyomi = true;
    try {
      const head = (await readFile(file)).subarray(0, 400).toString('utf8');
      const m = GUID_LINE.exec(head);
      // Assetsを優先(同一GUIDがPackagesにもある稀ケースはAssets側のパスを残す)
      if (m && m[1] && !guidToPath.has(m[1])) { guidToPath.set(m[1], rel); pathToGuid.set(rel, m[1]); }
    } catch { /* unreadable meta は無視 */ }
  };

  const assets = join(projectRoot, 'Assets');
  if (existsSync(assets)) await walk(assets, onMeta);
  if (opts.includePackages) {
    const pkgs = join(projectRoot, 'Packages');
    if (existsSync(pkgs)) await walk(pkgs, onMeta);
  }
  return { guidToPath, pathToGuid, hasLilToon, hasPoiyomi, metaCount };
}

// 既存の detect 用: GUID集合だけ欲しい場合は projectIndex に委譲（二重walkを避ける）。
export async function projectGuids(projectRoot: string): Promise<{ guids: Set<string>; metaCount: number }> {
  const idx = await projectIndex(projectRoot);
  return { guids: new Set(idx.guidToPath.keys()), metaCount: idx.metaCount };
}

async function walk(dir: string, fn: (file: string) => Promise<void>): Promise<void> {
  let ents;
  try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, fn);
    else await fn(p);
  }
}

export interface DetectHit {
  packageId: number;
  fileName: string;
  matched: number;
  total: number;
  pct: number;
  installed: boolean;
}

export function matchPackages(
  projectGuidSet: Set<string>,
  packages: { id: number; file_name: string; guids: string[] }[],
  threshold = 30,
): DetectHit[] {
  return packages.map(p => {
    let matched = 0;
    for (const g of p.guids) if (projectGuidSet.has(g)) matched++;
    const total = p.guids.length;
    const pct = total ? (100 * matched) / total : 0;
    return { packageId: p.id, fileName: p.file_name, matched, total, pct, installed: pct >= threshold };
  });
}
