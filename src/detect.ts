// GUID遡及検出: プロジェクトの Assets/*.meta のGUID群 × ライブラリ各パッケージのGUID群を突合。
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const GUID_LINE = /guid: ([0-9a-f]{32})/;

export async function projectGuids(projectRoot: string): Promise<{ guids: Set<string>; metaCount: number }> {
  const guids = new Set<string>();
  let metaCount = 0;
  const assets = join(projectRoot, 'Assets');
  if (!existsSync(assets)) return { guids, metaCount };
  await walk(assets, async (file) => {
    if (!file.endsWith('.meta')) return;
    metaCount++;
    try {
      const head = (await readFile(file)).subarray(0, 400).toString('utf8');
      const m = GUID_LINE.exec(head);
      if (m && m[1]) guids.add(m[1]);
    } catch { /* unreadable meta は無視 */ }
  });
  return { guids, metaCount };
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
