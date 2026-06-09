// ライブラリフォルダを再帰走査して .unitypackage を解析・カタログ登録する。
// Unityの Library/PackageCache 等のノイズは除外。
import { readdir, stat } from 'node:fs/promises';
import { realpathSync, existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parsePackage, type ParsedPackage } from './unitypackage.js';
import type { Catalog } from './db.js';

const SKIP_DIRS = new Set(['Library', 'PackageCache', 'Temp', 'obj', '.git', 'node_modules', 'Backups', '.vs', 'Logs']);

async function collectPackages(dir: string, acc: string[]): Promise<void> {
  let ents;
  try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await collectPackages(join(dir, e.name), acc);
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.unitypackage')) {
      acc.push(join(dir, e.name));
    }
  }
}

export type ScanEvent =
  | { i: number; total: number; file: string; status: 'parsed'; pkg: ParsedPackage }
  | { i: number; total: number; file: string; status: 'skipped' }            // 未変更(size+mtime一致)で再解析せず
  | { i: number; total: number; file: string; status: 'failed'; err: unknown };
export type ScanProgress = (e: ScanEvent) => void;
export interface ScanSummary { total: number; parsed: number; skipped: number; failed: number }

// 並列度: gunzip は libuv スレッドプールで走るので、コア数(2〜8)で束ねて解析を並走させる。
const CONCURRENCY = Math.max(2, Math.min(8, cpus().length || 4));

// 同時実行数を制限して各 item に fn を適用(順不同・例外は fn 内で処理)。
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { for (let i = next++; i < items.length; i = next++) await fn(items[i]!); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// 同一ファイルの二重登録を防ぐ正規化: 実パス(symlink/8.3短縮名/実ケースを解決)→ドライブ文字大文字+区切り /。
// realpath が失敗(存在しない等)なら resolve で ./.. を畳んでから文字列正規化にフォールバック。
function canonical(p: string): string {
  let real: string;
  try { real = realpathSync.native(p); } catch { real = resolve(p); }
  return real.replace(/\\/g, '/').replace(/^([a-z]):/, (_m, d) => d.toUpperCase() + ':');
}

export async function scanDir(dir: string, cat: Catalog, cacheDir: string, onProgress?: ScanProgress): Promise<ScanSummary> {
  const paths: string[] = [];
  await collectPackages(dir, paths);
  const total = paths.length;
  let done = 0, parsed = 0, skipped = 0, failed = 0;

  await mapLimit(paths, CONCURRENCY, async (raw) => {
    const file = canonical(raw);
    const previewDir = join(cacheDir, 'previews', createHash('md5').update(file).digest('hex').slice(0, 16));
    try {
      // 差分スキャン: 同じ file_path で size+mtime 一致 かつ preview がキャッシュに残っていれば再解析しない。
      const st = await stat(file);
      const meta = cat.packageMeta(file);
      if (meta && meta.size_bytes === st.size && meta.mtime_ms === Math.round(st.mtimeMs) && existsSync(previewDir)) {
        skipped++; onProgress?.({ i: ++done, total, file, status: 'skipped' });
        return;
      }
      // parse は並列(gunzipはスレッドプール)。upsert は同期なので JSスレッドで自然に直列化される(DB競合なし)。
      const pkg = await parsePackage(file, { previewDir });
      cat.upsert(pkg);
      parsed++; onProgress?.({ i: ++done, total, file, status: 'parsed', pkg });
    } catch (err) {
      failed++; onProgress?.({ i: ++done, total, file, status: 'failed', err });
    }
  });

  return { total, parsed, skipped, failed };
}
