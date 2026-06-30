// BOOTH 公開メタ取得（鍵不要・読み取り専用）。
// KonoAsset と同じ公開エンドポイント `https://booth.pm/ja/items/<id>.json` を使う。
// ※ ログイン/cookie は使わない。実ファイルのダウンロードはしない（メタ補完のみ）。
//   ファイルはユーザーがブラウザで取得済みのローカルパスを受け取る前提（[[whitelabel-warm-channel]]ではなく
//   AssetConnect 方式のローカルパス渡し）。

import { dirname } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

export type AssetType = 'avatar' | 'avatar_wearable' | 'world_object' | 'other';

export interface BoothMeta {
  itemId: number;
  name: string;
  creator: string;          // shop.name
  shopSubdomain: string | null;
  categoryId: number | null;
  assetType: AssetType;     // categoryId から推定
  thumbnailUrl: string | null;
  imageUrls: string[];
  publishedAt: number | null;   // epoch ms
  adult: boolean;
  tags: string[];
  description: string;
  itemUrl: string | null;
}

// BOOTH カテゴリID → アセット種別。KonoAsset の booth クレートと同じ対応表。
//   208 = Avatar / 209,217,210,214,215,216,127 = Wearable / 211 = World / 他 = Other
const WEARABLE_CATEGORIES = new Set([209, 217, 210, 214, 215, 216, 127]);
export function categoryToAssetType(categoryId: number | null | undefined): AssetType {
  if (categoryId == null) return 'other';
  if (categoryId === 208) return 'avatar';
  if (WEARABLE_CATEGORIES.has(categoryId)) return 'avatar_wearable';
  if (categoryId === 211) return 'world_object';
  return 'other';
}

// booth.pm/ja/items/<id>.json の必要部分だけを緩く型付け（欠損に強くする）。
interface BoothJson {
  id?: number;
  name?: string;
  description?: string;
  is_adult?: boolean;
  published_at?: string;
  url?: string;
  shop?: { name?: string; subdomain?: string; thumbnail_url?: string };
  category?: { id?: number; name?: string };
  images?: { original?: string; resized?: string }[];
  tags?: { name?: string }[] | string[];
}

export class BoothFetchError extends Error {
  constructor(message: string, readonly kind: 'not-found' | 'needs-login' | 'http' | 'network' | 'parse', readonly status?: number) {
    super(message);
    this.name = 'BoothFetchError';
  }
}

function normalizeTags(raw: BoothJson['tags']): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(t => (typeof t === 'string' ? t : t?.name ?? '')).filter(Boolean);
}

export function boothItemUrl(id: number): string {
  return `https://booth.pm/ja/items/${id}.json`;
}

// 1件の BOOTH 商品メタを取得。302(→sign_in)=要ログイン/非公開、404=不在 を区別して投げる。
export async function fetchBoothItem(id: number, opts: { timeoutMs?: number } = {}): Promise<BoothMeta> {
  const url = boothItemUrl(id);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20000);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'hangar/0 (+https://github.com/akagifreeez/hangar)', 'Accept': 'application/json' },
      redirect: 'manual',        // 302(sign_in)を追わずに検出する
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new BoothFetchError(`通信に失敗しました: ${e instanceof Error ? e.message : String(e)}`, 'network');
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 404) throw new BoothFetchError(`商品が見つかりません (id=${id})`, 'not-found', 404);
  // redirect:'manual' では 30x は status=0(opaqueredirect) になることがある。どちらも要ログイン/非公開とみなす。
  if (res.status === 0 || (res.status >= 300 && res.status < 400)) {
    throw new BoothFetchError(`公開メタを取得できません (id=${id})。R-18/非公開でログインが要る商品の可能性があります。`, 'needs-login', res.status);
  }
  if (!res.ok) throw new BoothFetchError(`HTTP ${res.status} (id=${id})`, 'http', res.status);

  let j: BoothJson;
  try { j = (await res.json()) as BoothJson; }
  catch (e) { throw new BoothFetchError(`JSONの解析に失敗: ${e instanceof Error ? e.message : String(e)}`, 'parse'); }

  const categoryId = j.category?.id ?? null;
  const images = (j.images ?? []).map(im => im.original ?? im.resized ?? '').filter(Boolean);
  const publishedMs = j.published_at ? Date.parse(j.published_at) : NaN;

  return {
    itemId: j.id ?? id,
    name: j.name ?? `(no name) ${id}`,
    creator: j.shop?.name ?? '',
    shopSubdomain: j.shop?.subdomain ?? null,
    categoryId,
    assetType: categoryToAssetType(categoryId),
    thumbnailUrl: images[0] ?? j.shop?.thumbnail_url ?? null,
    imageUrls: images,
    publishedAt: Number.isFinite(publishedMs) ? publishedMs : null,
    adult: !!j.is_adult,
    tags: normalizeTags(j.tags),
    description: j.description ?? '',
    itemUrl: j.url ?? null,
  };
}

// 公開画像URL(BOOTH CDN等)をローカルへ1回だけ保存(カタログのサムネ用)。鍵不要・公開CDNのみ想定。
// 取得した画像はローカルにキャッシュし catalog は file:// で参照する＝CSP不要・再取得なし・初回以降オフライン。
export async function downloadImage(url: string, destPath: string, opts: { timeoutMs?: number } = {}): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'hangar/0 (+https://github.com/akagifreeez/hangar)' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return false;
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, buf);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export const ASSET_TYPE_LABEL: Record<AssetType, string> = {
  avatar: 'アバター',
  avatar_wearable: '衣装/アクセサリ',
  world_object: 'ワールド',
  other: 'その他',
};
