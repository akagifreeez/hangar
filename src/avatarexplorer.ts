// AvatarExplorer エクスポート(ItemsData.json + Items/ + Thumbnail/)を取り込む。
// この形式は AvatarExplorer / KonoAsset がともに対応する“事実上の標準”＝移行の入口。
// v0: メタ(商品情報)を booth_items に取り込み、--scan 指定時のみ ItemPath 配下の .unitypackage を
//     カタログ解析して BOOTH商品に関連付ける。DLもログインもしない・読み取り専用。
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { scanDir, canonical } from './scan.js';
import type { Catalog } from './db.js';
import type { AssetType, BoothMeta } from './booth.js';
import { ASSET_TYPE_LABEL } from './booth.js';

// AvatarExplorer ItemsData.json の1要素(PascalCase・欠損に強く緩く型付け)。
interface AeItem {
  Title?: string;
  AuthorName?: string;
  ItemMemo?: string;
  BoothId?: number | string;
  ItemPath?: string;
  Type?: number;
  CustomCategory?: string;
  SupportedAvatar?: string[];
  ThumbnailUrl?: string;
}

export interface AeImportResult {
  dir: string;
  total: number;            // ItemsData.json の総件数
  importedMeta: number;     // booth_items に保存できた件数(有効なBoothId)
  skippedNoBooth: number;   // BoothId 無し(=BOOTH紐付け不可)でスキップ
  scanned: number;          // --scan で解析した .unitypackage 数
  linked: number;           // 関連付けた (file ↔ booth) 数
  byType: Record<string, number>;
  errors: string[];
}

// KonoAsset の AvatarExplorer エクスポータと同じ Type 対応: 0=Avatar / 1=Wearable / 2=World。
// 他の値(実AvatarExplorerのテクスチャ/ギミック等)は other 扱いとし、生の値は ae-type:N タグで温存。
function aeTypeToAssetType(t: number | undefined): AssetType {
  if (t === 0) return 'avatar';
  if (t === 1) return 'avatar_wearable';
  if (t === 2) return 'world_object';
  return 'other';
}

// dir 配下の .unitypackage を再帰列挙(canonical 済み)。ディレクトリ名が .unitypackage の場合は除外(isFile)。
export function collectUnitypackages(dir: string): string[] {
  const out: string[] = [];
  let ents: string[];
  try { ents = readdirSync(dir, { recursive: true }) as string[]; } catch { return out; }
  for (const rel of ents) {
    if (typeof rel === 'string' && rel.toLowerCase().endsWith('.unitypackage')) {
      const full = join(dir, rel);
      try { if (statSync(full).isFile()) out.push(canonical(full)); } catch { /* skip */ }
    }
  }
  return out;
}

export async function importAvatarExplorer(
  dir: string,
  cat: Catalog,
  opts: { scan?: boolean; cacheDir: string },
): Promise<AeImportResult> {
  const res: AeImportResult = { dir, total: 0, importedMeta: 0, skippedNoBooth: 0, scanned: 0, linked: 0, byType: {}, errors: [] };

  const jsonPath = join(dir, 'ItemsData.json');
  if (!existsSync(jsonPath)) {
    res.errors.push(`ItemsData.json が見つかりません: ${jsonPath}（AvatarExplorerのエクスポートフォルダを指定してください）`);
    return res;
  }
  let items: AeItem[];
  try {
    const raw = readFileSync(jsonPath, 'utf8').replace(/^﻿/, '');   // BOM除去
    const parsed = JSON.parse(raw);
    items = Array.isArray(parsed) ? parsed as AeItem[] : [];
  } catch (e) {
    res.errors.push(`ItemsData.json の解析に失敗: ${e instanceof Error ? e.message : String(e)}`);
    return res;
  }
  res.total = items.length;

  for (const it of items) {
    const boothId = typeof it.BoothId === 'string' ? parseInt(it.BoothId, 10) : (it.BoothId ?? -1);
    if (!Number.isFinite(boothId) || boothId <= 0) { res.skippedNoBooth++; continue; }

    const assetType = aeTypeToAssetType(it.Type);
    const tags: string[] = [];
    if (it.CustomCategory) tags.push(it.CustomCategory);
    if (typeof it.Type === 'number') tags.push(`ae-type:${it.Type}`);

    const meta: BoothMeta = {
      itemId: boothId,
      name: it.Title?.trim() || `(BOOTH ${boothId})`,
      creator: it.AuthorName?.trim() || '',
      shopSubdomain: null,
      categoryId: null,
      assetType,
      // ThumbnailUrl は http(s) のときだけ保持。AvatarExplorer のローカルパスは fetch 不可なので捨てる(booth-enrich で実サムネ取得)。
      thumbnailUrl: (it.ThumbnailUrl && /^https?:\/\//i.test(it.ThumbnailUrl.trim())) ? it.ThumbnailUrl.trim() : null,
      imageUrls: [],
      publishedAt: null,             // AvatarExplorer は登録日のみで公開日は不明 → 推測で埋めない（Honest notes）
      adult: false,
      tags,
      description: it.ItemMemo?.trim() || '',
      itemUrl: `https://booth.pm/ja/items/${boothId}`,
    };
    cat.upsertBoothItem(meta, 'avatar-explorer');
    res.importedMeta++;
    res.byType[assetType] = (res.byType[assetType] ?? 0) + 1;

    if (opts.scan && it.ItemPath) {
      // ItemPath は絶対パスのことがある(AvatarExplorer)。絶対ならそのまま、相対なら export dir 起点で解決。
      const itemDir = isAbsolute(it.ItemPath) ? it.ItemPath : join(dir, it.ItemPath);
      if (existsSync(itemDir)) {
        let pkgs: string[] = [];
        try {
          if (statSync(itemDir).isDirectory()) {
            const sum = await scanDir(itemDir, cat, opts.cacheDir);
            res.scanned += sum.parsed;
            pkgs = collectUnitypackages(itemDir);
          }
        } catch (e) { res.errors.push(`scan失敗 ${it.ItemPath}: ${e instanceof Error ? e.message : String(e)}`); }
        for (const cf of pkgs) { cat.linkBooth(cf, boothId, it.Title?.trim() || null); res.linked++; }
      }
    }
  }
  return res;
}

export function formatAeImportText(res: AeImportResult): string {
  const L: string[] = [];
  L.push(`=== AvatarExplorer 取込: ${res.dir}`);
  for (const e of res.errors) L.push(`  ⚠ ${e}`);
  if (res.errors.length && !res.total) return L.join('\n');
  L.push(`  総件数        : ${res.total}`);
  L.push(`  メタ取込      : ${res.importedMeta}`);
  if (res.skippedNoBooth) L.push(`  スキップ      : ${res.skippedNoBooth}（BoothId無し＝BOOTH紐付け不可）`);
  const typeLine = Object.entries(res.byType)
    .map(([t, n]) => `${ASSET_TYPE_LABEL[t as AssetType] ?? t}:${n}`).join(' / ');
  if (typeLine) L.push(`  種別内訳      : ${typeLine}`);
  if (res.scanned || res.linked) L.push(`  実体解析/関連 : ${res.scanned} パッケージ解析 / ${res.linked} 関連付け`);
  else L.push(`  ※ メタのみ取込（実体を取り込むには --scan）`);
  L.push(`\nbooth-info で確認できます。`);
  return L.join('\n');
}
