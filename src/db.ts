// カタログDB（Node内蔵 node:sqlite）。製品スキーマの最小サブセット。
import { DatabaseSync } from 'node:sqlite';
import { guidSetHash } from './sig.js';
import type { ParsedPackage } from './unitypackage.js';

export interface PackageRow {
  id: number;
  file_path: string;
  file_name: string;
  size_bytes: number;
  file_count: number;
  preview_count: number;
  preview_pct: number;
  kind_breakdown: string;
  guids_json: string;
  cover_guid: string | null;
  preview_dir: string | null;
  requires_liltoon: number;
  requires_poiyomi: number;
  has_locked: number;
  mtime_ms: number;
}

// 同一内容(GUID集合一致)のパッケージを1商品に束ねた単位
export interface Product {
  rep: PackageRow;
  copies: string[];
  copyCount: number;
  wastedBytes: number;
  projects: { name: string; path: string; pct: number }[];
  sig: string;              // 内容署名(GUID集合のmd5)。3Dレンダ成果物の安定キー
  previewHashes: string[];  // この商品の各物理コピーの preview_dir basename。旧式レンダ(パスhashキー)の後方互換探索用
}

export class Catalog {
  private db: DatabaseSync;

  constructor(path = 'hangar.db') {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS packages (
        id            INTEGER PRIMARY KEY,
        file_path     TEXT NOT NULL UNIQUE,
        file_name     TEXT NOT NULL,
        size_bytes    INTEGER NOT NULL,
        file_count    INTEGER NOT NULL,
        preview_count INTEGER NOT NULL,
        preview_pct   REAL NOT NULL,
        kind_breakdown TEXT NOT NULL,
        guids_json    TEXT NOT NULL,
        cover_guid    TEXT,
        preview_dir   TEXT,
        requires_liltoon INTEGER NOT NULL DEFAULT 0,
        requires_poiyomi INTEGER NOT NULL DEFAULT 0,
        has_locked       INTEGER NOT NULL DEFAULT 0,
        mtime_ms      INTEGER NOT NULL DEFAULT 0,
        scanned_at    INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS files (
        package_id  INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
        guid        TEXT NOT NULL,
        pathname    TEXT NOT NULL,
        ext         TEXT,
        kind        TEXT,
        importer    TEXT,
        has_asset   INTEGER NOT NULL,
        has_preview INTEGER NOT NULL,
        asset_size  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_files_pkg  ON files(package_id);
      CREATE INDEX IF NOT EXISTS idx_files_guid ON files(guid);
      CREATE INDEX IF NOT EXISTS idx_files_kind ON files(package_id, kind);

      CREATE TABLE IF NOT EXISTS unity_projects (
        id           INTEGER PRIMARY KEY,
        path         TEXT NOT NULL UNIQUE,
        name         TEXT,
        last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS install_records (
        package_id  INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
        project_id  INTEGER NOT NULL REFERENCES unity_projects(id) ON DELETE CASCADE,
        matched     INTEGER NOT NULL,
        total       INTEGER NOT NULL,
        pct         REAL NOT NULL,
        detected_at INTEGER NOT NULL,
        PRIMARY KEY (package_id, project_id)
      );
      CREATE INDEX IF NOT EXISTS idx_install_project ON install_records(project_id);
    `);
    // 既存DB(列追加前)への後付けマイグレーション。
    // ※ cover_guid/preview_dir が抜けると upsert が「no column named cover_guid」で全件失敗するので必須。
    const migrations: [string, string][] = [
      ['cover_guid', 'TEXT'],
      ['preview_dir', 'TEXT'],
      ['requires_liltoon', 'INTEGER NOT NULL DEFAULT 0'],
      ['requires_poiyomi', 'INTEGER NOT NULL DEFAULT 0'],
      ['has_locked', 'INTEGER NOT NULL DEFAULT 0'],
      ['mtime_ms', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [col, type] of migrations) {
      try { this.db.exec(`ALTER TABLE packages ADD COLUMN ${col} ${type}`); } catch { /* 既にある */ }
    }
  }

  upsert(pkg: ParsedPackage): number {
    this.db.exec('BEGIN');
    try {
      const existing = this.db.prepare('SELECT id FROM packages WHERE file_path = ?').get(pkg.file) as { id: number } | undefined;
      if (existing) this.db.prepare('DELETE FROM packages WHERE id = ?').run(existing.id);

      const previewPct = pkg.fileCount ? Math.round((1000 * pkg.previewCount) / pkg.fileCount) / 10 : 0;
      const info = this.db.prepare(
        `INSERT INTO packages (file_path, file_name, size_bytes, file_count, preview_count, preview_pct, kind_breakdown, guids_json, cover_guid, preview_dir, requires_liltoon, requires_poiyomi, has_locked, mtime_ms, scanned_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(pkg.file, pkg.fileName, pkg.sizeBytes, pkg.fileCount, pkg.previewCount, previewPct,
            JSON.stringify(pkg.kindBreakdown), JSON.stringify(pkg.guids), pkg.coverGuid ?? null, pkg.previewDir ?? null,
            pkg.shaders.liltoon ? 1 : 0, pkg.shaders.poiyomi ? 1 : 0, pkg.shaders.locked ? 1 : 0, pkg.mtimeMs, Date.now());

      const pid = Number(info.lastInsertRowid);
      const ins = this.db.prepare(
        `INSERT INTO files (package_id, guid, pathname, ext, kind, importer, has_asset, has_preview, asset_size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const e of pkg.entries) {
        ins.run(pid, e.guid, e.pathname, e.ext, e.kind, e.importer ?? null, e.hasAsset ? 1 : 0, e.hasPreview ? 1 : 0, e.assetSize);
      }
      this.db.exec('COMMIT');
      return pid;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  allPackages(): PackageRow[] {
    return this.db.prepare('SELECT * FROM packages ORDER BY file_name').all() as unknown as PackageRow[];
  }

  // 差分スキャン用: 登録済みなら size/mtime を返す。スキャン時に未変更なら再解析をスキップする。
  packageMeta(filePath: string): { size_bytes: number; mtime_ms: number } | undefined {
    return this.db.prepare('SELECT size_bytes, mtime_ms FROM packages WHERE file_path = ?')
      .get(filePath) as { size_bytes: number; mtime_ms: number } | undefined;
  }

  search(q: string): PackageRow[] {
    const like = `%${q}%`;
    return this.db.prepare(
      `SELECT DISTINCT p.* FROM packages p
       LEFT JOIN files f ON f.package_id = p.id
       WHERE p.file_name LIKE ? OR f.pathname LIKE ?
       ORDER BY p.file_name`
    ).all(like, like) as unknown as PackageRow[];
  }

  allPackageGuids(): { id: number; file_name: string; guids: string[] }[] {
    return this.allPackages().map(r => ({ id: r.id, file_name: r.file_name, guids: JSON.parse(r.guids_json) as string[] }));
  }

  packageFiles(packageId: number): { pathname: string; kind: string; has_preview: number }[] {
    return this.db.prepare(
      'SELECT pathname, kind, has_preview FROM files WHERE package_id = ? ORDER BY pathname'
    ).all(packageId) as unknown as { pathname: string; kind: string; has_preview: number }[];
  }

  allProjects(): { id: number; path: string; name: string }[] {
    return this.db.prepare('SELECT id, path, name FROM unity_projects ORDER BY last_seen_at DESC')
      .all() as unknown as { id: number; path: string; name: string }[];
  }

  upsertProject(path: string, name: string): number {
    this.db.prepare(
      `INSERT INTO unity_projects (path, name, last_seen_at) VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET name = excluded.name, last_seen_at = excluded.last_seen_at`
    ).run(path, name, Date.now());
    const row = this.db.prepare('SELECT id FROM unity_projects WHERE path = ?').get(path) as { id: number };
    return row.id;
  }

  clearProjectInstalls(projectId: number): void {
    this.db.prepare('DELETE FROM install_records WHERE project_id = ?').run(projectId);
  }

  recordInstall(packageId: number, projectId: number, matched: number, total: number, pct: number): void {
    this.db.prepare(
      `INSERT INTO install_records (package_id, project_id, matched, total, pct, detected_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(package_id, project_id) DO UPDATE SET
         matched = excluded.matched, total = excluded.total, pct = excluded.pct, detected_at = excluded.detected_at`
    ).run(packageId, projectId, matched, total, Math.round(pct * 10) / 10, Date.now());
  }

  // 各パッケージが「どのプロジェクトに導入済みか」(重複導入の検出に使う)
  installsSummary(): { file_name: string; projects: { name: string; path: string; pct: number }[] }[] {
    const rows = this.db.prepare(
      `SELECT p.file_name AS file_name, up.name AS pname, up.path AS ppath, ir.pct AS pct
       FROM install_records ir
       JOIN packages p        ON p.id  = ir.package_id
       JOIN unity_projects up ON up.id = ir.project_id
       ORDER BY p.file_name, ir.pct DESC`
    ).all() as unknown as { file_name: string; pname: string; ppath: string; pct: number }[];
    const map = new Map<string, { name: string; path: string; pct: number }[]>();
    for (const r of rows) {
      const arr = map.get(r.file_name) ?? [];
      arr.push({ name: r.pname, path: r.ppath, pct: r.pct });
      map.set(r.file_name, arr);
    }
    return [...map.entries()].map(([file_name, projects]) => ({ file_name, projects }));
  }

  // 同一内容(GUID集合)のパッケージを1商品に束ねる（重複コピーをまとめ、導入先を統合）
  dedupedProducts(): Product[] {
    const rows = this.allPackages();
    const installRows = this.db.prepare(
      `SELECT ir.package_id AS pid, up.name AS pname, up.path AS ppath, ir.pct AS pct
       FROM install_records ir JOIN unity_projects up ON up.id = ir.project_id`
    ).all() as unknown as { pid: number; pname: string; ppath: string; pct: number }[];
    const instByPkg = new Map<number, { pname: string; ppath: string; pct: number }[]>();
    for (const ir of installRows) {
      let a = instByPkg.get(ir.pid);
      if (!a) { a = []; instByPkg.set(ir.pid, a); }
      a.push({ pname: ir.pname, ppath: ir.ppath, pct: ir.pct });
    }
    const groups = new Map<string, PackageRow[]>();
    for (const r of rows) {
      const sig = guidSetHash(JSON.parse(r.guids_json) as string[]);
      let g = groups.get(sig);
      if (!g) { g = []; groups.set(sig, g); }
      g.push(r);
    }
    const products: Product[] = [];
    for (const [sig, g] of groups.entries()) {
      const rep = g.find(r => r.cover_guid) ?? g[0]!;
      const wasted = rep.size_bytes * (g.length - 1);
      const projMap = new Map<string, { name: string; path: string; pct: number }>();
      for (const r of g) for (const ins of instByPkg.get(r.id) ?? []) {
        const ex = projMap.get(ins.ppath);
        if (!ex || ins.pct > ex.pct) projMap.set(ins.ppath, { name: ins.pname, path: ins.ppath, pct: ins.pct });
      }
      // 各物理コピーの preview_dir basename（旧式レンダはこのいずれかのキーで保存されている）
      const previewHashes = g.map(r => (r.preview_dir ? r.preview_dir.split(/[\\/]/).filter(Boolean).pop() ?? '' : '')).filter(Boolean);
      products.push({ rep, copies: g.map(r => r.file_path), copyCount: g.length, wastedBytes: wasted, projects: [...projMap.values()].sort((a, b) => b.pct - a.pct), sig, previewHashes });
    }
    products.sort((a, b) => a.rep.file_name.localeCompare(b.rep.file_name));
    return products;
  }

  close(): void { this.db.close(); }
}
