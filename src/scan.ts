// ライブラリフォルダを再帰走査して .unitypackage を解析・カタログ登録する。
// Unityの Library/PackageCache 等のノイズは除外。
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
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

export type ScanProgress = (i: number, total: number, p: ParsedPackage | null, file: string, err?: unknown) => void;

// 同一ファイルの二重登録を防ぐ正規化: ドライブ文字を大文字・区切りを / に統一。
function canonical(p: string): string {
  return p.replace(/\\/g, '/').replace(/^([a-z]):/, (_m, d) => d.toUpperCase() + ':');
}

export async function scanDir(dir: string, cat: Catalog, cacheDir: string, onProgress?: ScanProgress): Promise<ParsedPackage[]> {
  const paths: string[] = [];
  await collectPackages(dir, paths);
  const out: ParsedPackage[] = [];
  for (let i = 0; i < paths.length; i++) {
    const file = canonical(paths[i]!);
    const previewDir = join(cacheDir, 'previews', createHash('md5').update(file).digest('hex').slice(0, 16));
    try {
      const parsed = await parsePackage(file, { previewDir });
      cat.upsert(parsed);
      out.push(parsed);
      onProgress?.(i + 1, paths.length, parsed, file);
    } catch (err) {
      onProgress?.(i + 1, paths.length, null, file, err);
    }
  }
  return out;
}
