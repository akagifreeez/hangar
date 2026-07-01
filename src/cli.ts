// Hangar v0.1 CLI — scan / list / search / detect / installs / catalog
import { cpus } from 'node:os';
import { basename, join, dirname, relative } from 'node:path';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { guidSetHash } from './sig.js';
import { Catalog, type PackageRow, type Product, type CompareProduct, type BoothItemRow } from './db.js';
import { scanDir, canonical } from './scan.js';
import { parsePackage } from './unitypackage.js';
import { fetchBoothItem, downloadImage, BoothFetchError, ASSET_TYPE_LABEL, type AssetType } from './booth.js';
import { importAvatarExplorer, formatAeImportText, collectUnitypackages } from './avatarexplorer.js';
import { projectGuids, matchPackages, expandProjectRoots } from './detect.js';
import { diffImport, formatDiffText, formatDiffHtmlPage } from './diff.js';
import { saveTemplate, restoreTemplate, formatSaveText, formatRestoreText, readVpmTooling, type CatalogPkg } from './template.js';
import { renderPackage, findUnity, findLilToon, findPoiyomi } from './render.js';
import { categoryLabel } from './classify.js';

// 並列スキャン(gunzip=スレッドプール)用にプールを広げる。libuvは初回スレッドプール利用時に読むので、scan前のここで設定。
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = String(Math.max(4, Math.min(16, cpus().length || 4)));

type Proj = { name: string; path: string; pct: number };

const mb = (b: number) => `${(b / 1048576).toFixed(1)}MB`;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function appVersion(): string {
  try { return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version ?? '?'; }
  catch { return '?'; }
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const dbPath = process.env.HANGAR_DB ?? 'hangar.db';
  const cacheDir = process.env.HANGAR_CACHE ?? join(dirname(dbPath === ':memory:' ? '.' : dbPath), 'cache');
  const cat = new Catalog(dbPath);

  try {
    switch (cmd) {
      case 'scan': {
        const dir = args[0];
        if (!dir) return fail('usage: scan <libraryDir>');
        console.log(`scanning ${dir} (recursive, Library等は除外) ...`);
        const sum = await scanDir(dir, cat, cacheDir, (e) => {
          const name = basename(e.file);
          if (e.status === 'parsed') console.log(`  [${e.i}/${e.total}] ${name}  ${mb(e.pkg.sizeBytes)} files:${e.pkg.fileCount} prev:${e.pkg.fileCount ? Math.round(100 * e.pkg.previewCount / e.pkg.fileCount) : 0}%`);
          else if (e.status === 'skipped') console.log(`  [${e.i}/${e.total}] ${name}  (未変更スキップ)`);
          else { const msg = e.err instanceof Error ? e.err.message : String(e.err ?? ''); console.log(`  [${e.i}/${e.total}] ${name}  ⚠ parse失敗(スキップ): ${msg || '原因不明'}`); }
        });
        if (sum.failed) console.log(`⚠ ${sum.failed} 件が解析できませんでした（上の理由を確認）。書込先: ${dbPath} / cache: ${cacheDir}`);
        console.log(`scanned ${sum.total} package(s) into ${dbPath}. (${sum.parsed} 解析 / ${sum.skipped} 未変更スキップ${sum.failed ? ` / ${sum.failed} 失敗` : ''})`);
        break;
      }
      case 'list': {
        const rows = cat.allPackages();
        if (!rows.length) console.log('(catalog empty — run: scan <dir>)');
        for (const p of rows) console.log(`  ${p.file_name}  ${mb(p.size_bytes)}  files:${p.file_count}  preview:${p.preview_pct}%`);
        break;
      }
      case 'search': {
        const q = args[0] ?? '';
        const rows = cat.search(q);
        console.log(`search "${q}" -> ${rows.length} hit(s)`);
        for (const p of rows) console.log(`  ${p.file_name}`);
        break;
      }
      case 'detect': {
        const save = args.includes('--save');
        const selected = args.filter(a => a !== '--save');
        if (!selected.length) return fail('usage: detect [--save] <projectDir> [projectDir...]');
        // 上位フォルダ(複数プロジェクトをまとめた親)を選んでも、配下の各プロジェクトへ自動展開
        const projects = await expandProjectRoots(selected);
        if (projects.length !== selected.length || projects.some((p, i) => p !== selected[i]))
          console.log(`(選択フォルダから ${projects.length} プロジェクトを検出)`);
        const pkgs = cat.allPackageGuids();
        if (!pkgs.length) return fail('catalog empty — run scan first');
        for (const proj of projects) {
          const { guids, metaCount } = await projectGuids(proj);
          console.log(`\n=== ${proj}`);
          console.log(`    .meta:${metaCount}  guids:${guids.size}`);
          const hits = matchPackages(guids, pkgs).sort((a, b) => b.pct - a.pct);
          let projId: number | undefined;
          if (save) { projId = cat.upsertProject(proj, basename(proj)); cat.clearProjectInstalls(projId); }
          for (const h of hits) {
            const tag = h.installed ? '★ INSTALLED' : (h.matched > 0 ? '  partial  ' : '          ');
            console.log(`    ${tag}  ${h.fileName}: ${h.matched}/${h.total} = ${h.pct.toFixed(0)}%`);
            if (save && projId !== undefined && h.installed) cat.recordInstall(h.packageId, projId, h.matched, h.total, h.pct);
          }
        }
        if (save) console.log('\n(導入記録を保存しました — 確認: installs)');
        break;
      }
      case 'list-projects': {
        // 登録済み(detect --save 済み)Unityプロジェクトの一覧。GUIの比較/diffドロップダウンの権威ソース。
        const json = args.includes('--json');
        const projs = cat.allProjects().map(p => ({ path: p.path, name: p.name }));
        if (json) { console.log(JSON.stringify(projs)); break; }
        for (const p of projs) console.log(`  ${p.name}\t${p.path}`);
        break;
      }
      case 'prune-projects': {
        // 不正な登録を掃除: フォルダが存在しない / Assets を持たない(=実プロジェクトでない親フォルダ等)を削除。
        const json = args.includes('--json');
        const removed: { id: number; name: string; path: string; reason: string }[] = [];
        for (const p of cat.allProjects()) {
          const exists = existsSync(p.path);
          const hasAssets = exists && existsSync(join(p.path, 'Assets'));
          if (!exists || !hasAssets) { cat.removeProject(p.id); removed.push({ id: p.id, name: p.name, path: p.path, reason: !exists ? 'not-found' : 'no-assets' }); }
        }
        const remaining = cat.allProjects().length;
        if (json) { console.log(JSON.stringify({ removed, remaining })); break; }
        for (const r of removed) console.log(`  削除: ${r.name}  [${r.reason}]  ${r.path}`);
        console.log(`\n不正なプロジェクト登録 ${removed.length} 件を削除（残り ${remaining} 件）`);
        break;
      }
      case 'compare': {
        // プロジェクト横断比較: 登録済みプロジェクトの導入商品を突き合わせ(共通/Aのみ/Bのみ)。読み取り専用・.meta再走査なし。
        const json = args.includes('--json');
        const all = args.includes('--all');
        let paths = args.filter(a => !a.startsWith('--'));
        if (all || paths.length === 0) paths = cat.allProjects().map(p => p.path);
        const htmlCmpIdx = args.indexOf('--html');
        const htmlCmpOut = htmlCmpIdx >= 0 ? args[htmlCmpIdx + 1] : undefined;
        if (htmlCmpIdx >= 0 && (!htmlCmpOut || htmlCmpOut.startsWith('--'))) return fail('--html の値（出力HTMLパス）がありません');
        paths = paths.filter(p => p !== htmlCmpOut);   // --html の値は比較対象から除外
        if (paths.length < 2) return fail('usage: compare <projA> <projB> [projC...] [--all] [--json] [--html out.html]  （要: detect --save 済みプロジェクト2つ以上）');
        const result = cat.compareProjects(paths);
        // Phase2: 各登録プロジェクトのVPMツール(版数)を vpm-manifest.json から軽量読取(.meta走査なし)
        const tooling: Record<string, Record<string, string>> = {};
        for (const pr of result.projects) if (pr.registered) {
          tooling[pr.path] = Object.fromEntries(readVpmTooling(pr.path).tooling.map(t => [t.id, t.version ?? '']));
        }
        // Phase4: 移行ギャップ(2プロジェクト時)。「A のみ」商品にライブラリ現物(file_path)の有無を付与。
        let migrate: CompareResult['migrate'];
        const regp = result.projects.filter(p => p.registered);
        if (regp.length === 2) {
          const A = regp[0]!, B = regp[1]!;
          const pathById = new Map(cat.allPackages().map(r => [r.id, r.file_path]));
          migrate = result.products.filter(p => p.perProject[A.path] && !p.perProject[B.path]).map(p => {
            const fp = pathById.get(p.perProject[A.path]!.pkgId) ?? '';
            return { fileName: p.fileName, libAvailable: !!fp && existsSync(fp), requiresLil: p.requiresLil, requiresPoi: p.requiresPoi };
          });
        }
        const full: CompareResult = { ...result, tooling, migrate };
        if (htmlCmpOut) { writeFileSync(htmlCmpOut, formatCompareHtml(full), 'utf8'); console.log(`レポート(HTML): ${htmlCmpOut}`); }
        if (json) { console.log(JSON.stringify(full)); break; }
        console.log(formatCompareText(full));
        break;
      }
      case 'sprawl': {
        // 散らばり俯瞰: 全登録プロジェクト横断で「N個に導入された商品」を容量影響付きで一覧。読み取り専用。
        const json = args.includes('--json');
        const minIdx = args.indexOf('--min');
        const min = minIdx >= 0 ? Math.max(2, parseInt(args[minIdx + 1] ?? '2', 10) || 2) : 2;
        const prods = cat.dedupedProducts().filter(p => p.projects.length >= min)
          .sort((a, b) => b.projects.length - a.projects.length || b.rep.size_bytes - a.rep.size_bytes);
        if (json) {
          console.log(JSON.stringify(prods.map(p => ({ name: p.rep.file_name, projectCount: p.projects.length, projects: p.projects.map(x => x.name), sizeBytes: p.rep.size_bytes, copyCount: p.copyCount, wastedBytes: p.wastedBytes }))));
          break;
        }
        console.log(formatSprawlText(prods, min));
        break;
      }
      case 'diff': {
        // インポート前 競合diff: 取り込み前に「何を上書きするか/足りないシェーダ」を出す。読み取り専用。
        const json = args.includes('--json');
        const all = args.includes('--all');
        const projFlagIdx = args.indexOf('--project');
        const explicitProj = projFlagIdx >= 0 ? args[projFlagIdx + 1] : undefined;
        const htmlIdx = args.indexOf('--html');
        const htmlOut = htmlIdx >= 0 ? args[htmlIdx + 1] : undefined;
        if (projFlagIdx >= 0 && (!explicitProj || explicitProj.startsWith('--'))) return fail('--project の値（プロジェクトディレクトリ）がありません');
        if (htmlIdx >= 0 && (!htmlOut || htmlOut.startsWith('--'))) return fail('--html の値（出力HTMLパス）がありません');
        // 値を取るフラグ(--project/--html)の「次の引数」は位置引数(=パッケージ)から除外
        const skip = new Set<number>();
        for (const fi of [projFlagIdx, htmlIdx]) if (fi >= 0) skip.add(fi + 1);
        const packageFile = args.find((a, i) => !a.startsWith('--') && !skip.has(i));
        if (!packageFile) return fail('usage: diff <package.unitypackage> --project <projectDir> [--all] [--json]');
        if (!existsSync(packageFile)) return fail('パッケージが見つかりません: ' + packageFile);
        const products = cat.allPackageGuids();
        let targets: string[] = [];
        if (explicitProj) targets = [explicitProj];
        else {
          const regs = cat.allProjects().map(p => p.path);
          if (all) targets = regs;
          else if (regs.length === 1) targets = regs;
          else if (regs.length === 0) return fail('対象プロジェクト未指定。--project <dir> を渡すか、先に detect --save で登録してください');
          else {
            console.log('対象プロジェクトが複数あります。--project <dir> で指定するか --all を付けてください:');
            for (const p of regs) console.log('  ' + p);
            break;
          }
        }
        const reports = [];
        for (const proj of targets) {
          if (!existsSync(proj)) { console.error('プロジェクトが見つかりません(スキップ): ' + proj); continue; }
          reports.push(await diffImport(packageFile, proj, products));
        }
        if (!reports.length) return fail('対象プロジェクトがありません');
        if (json) console.log(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2));
        else reports.forEach((r, i) => { if (i) console.log(''); console.log(formatDiffText(r)); });
        if (htmlOut) { writeFileSync(htmlOut, formatDiffHtmlPage(reports), 'utf8'); console.log(`\nレポート(HTML): ${htmlOut}`); }
        break;
      }
      case 'save-template': {
        // 改変済みアバターのプロジェクトから「自作ファイルだけ」を保存し、依存購入物をマニフェスト化。
        // 購入物のバイトは一切同梱しない（GUID参照で名指すだけ）。読み取り専用（書き込みは --out のみ）。
        const json = args.includes('--json');
        const outIdx = args.indexOf('--out');
        const outDir = outIdx >= 0 ? args[outIdx + 1] : undefined;
        if (outIdx >= 0 && (!outDir || outDir.startsWith('--'))) return fail('--out の値（出力先ディレクトリ）がありません');
        const skip = new Set<number>(); if (outIdx >= 0) skip.add(outIdx + 1);
        const projectDir = args.find((a, i) => !a.startsWith('--') && !skip.has(i));
        if (!projectDir) return fail('usage: save-template <projectDir> --out <dir> [--json]');
        if (!outDir) return fail('--out <dir>（テンプレの出力先）を指定してください');
        if (!existsSync(projectDir)) return fail('プロジェクトが見つかりません: ' + projectDir);
        const res = await saveTemplate(projectDir, outDir, buildCatalogPkgs(cat));
        if (json) console.log(JSON.stringify(res.manifest, null, 2));
        else console.log(formatSaveText(res));
        break;
      }
      case 'restore-template': {
        // テンプレを まっさらなプロジェクトへ復元し、購入物の「持ってる/入れ直して/未所持」台帳を出す。
        // DLしない・ログインしない・.unitypackageを編集しない。書き込みは復元先プロジェクトのみ。
        const json = args.includes('--json');
        const force = args.includes('--force');
        const projFlagIdx = args.indexOf('--project');
        const projectDir = projFlagIdx >= 0 ? args[projFlagIdx + 1] : undefined;
        if (projFlagIdx >= 0 && (!projectDir || projectDir.startsWith('--'))) return fail('--project の値（復元先ディレクトリ）がありません');
        const skip = new Set<number>(); if (projFlagIdx >= 0) skip.add(projFlagIdx + 1);
        const templateDir = args.find((a, i) => !a.startsWith('--') && !skip.has(i));
        if (!templateDir) return fail('usage: restore-template <templateDir> --project <freshProjectDir> [--json] [--force]');
        if (!projectDir) return fail('--project <まっさらなプロジェクト> を指定してください');
        if (!existsSync(templateDir)) return fail('テンプレが見つかりません: ' + templateDir);
        if (!existsSync(projectDir)) return fail('復元先プロジェクトが見つかりません: ' + projectDir);
        const rep = await restoreTemplate(templateDir, projectDir, buildCatalogPkgs(cat), { force });
        if (json) console.log(JSON.stringify(rep, null, 2));
        else console.log(formatRestoreText(rep));
        break;
      }
      case 'installs': {
        const summary = cat.installsSummary();
        if (!summary.length) { console.log('(導入記録なし — まず: detect --save <proj...>)'); break; }
        for (const s of summary) {
          const dup = s.projects.length > 1 ? `   ⚠ 重複導入 x${s.projects.length}` : '';
          console.log(`\n${s.file_name}${dup}`);
          for (const pr of s.projects) console.log(`    → ${pr.name}  (${pr.pct}%)   ${pr.path}`);
        }
        break;
      }
      case 'catalog': {
        const out = args[0] ?? 'hangar-catalog.html';
        const products = cat.dedupedProducts();
        const outDir = dirname(out);
        // ファイルパス → BOOTHメタ のマップ。商品の物理コピーのいずれかにリンクがあれば拾う。通信はしない(保存済みメタのみ)。
        const boothItemsById = new Map(cat.allBoothItems().map(b => [b.booth_item_id, b]));
        const boothByPath = new Map<string, BoothItemRow>();
        for (const lk of cat.allBoothLinks()) { const bi = boothItemsById.get(lk.booth_item_id); if (bi) boothByPath.set(lk.file_path, bi); }
        const favSet = new Set(cat.favoriteSigs());
        // スキャン済みライブラリ根(GUIが記憶した保存先)。file_path をこの根に照合して「どのライブラリか」を表示する。
        // main.cjs が HANGAR_LIBRARY_DIRS(JSON配列)で渡す。未設定でも file_path の親フォルダにフォールバックするので必須ではない。
        let libraryDirs: string[] = [];
        try { libraryDirs = JSON.parse(process.env.HANGAR_LIBRARY_DIRS ?? '[]') as string[]; } catch { libraryDirs = []; }
        // 登録済みプロジェクト(detect --save 済み)。サイドバーに一覧表示＋クリックで「そのプロジェクトに導入済みの商品」に絞り込む。
        const regProjects = cat.allProjects();
        const projList = regProjects.map((p, i) => ({ key: `p${i}`, path: p.path, name: p.name || basename(p.path) || p.path, count: 0 }));
        const projKeyByPath = new Map(projList.map(p => [p.path, p.key]));
        // 版グループ: ファイル名から版サフィックス(_v1.2 / .1.0 等)を除いた基底名で束ね、中身(sig)が違うものを「別の版」とみなす
        const verBase = (name: string) => name.replace(/\.unitypackage$/i, '').replace(/[ _\-]*v?\d+([._]\d+)*$/i, '').toLowerCase().trim();
        const byBase = new Map<string, Product[]>();
        for (const prod of products) { const b = verBase(prod.rep.file_name); if (b) { if (!byBase.has(b)) byBase.set(b, []); byBase.get(b)!.push(prod); } }
        const data = products.map(prod => {
          const r = prod.rep;
          const cover = (r.cover_guid && r.preview_dir) ? dataUri(join(r.preview_dir, r.cover_guid + '.png')) : '';
          const gallery = readGallery(r.preview_dir, 12);
          const tree = buildTreeHtml(cat.packageFiles(r.id));
          // 方式A 忠実プレビュー成果物: cache/renders/<key>/{hero.png, viewer.html}。
          // 内容署名(sig・新)→各コピーのpreview_dir hash(旧式・後方互換)の順で探す（重複コピーで代表がズレても拾う）。
          let renderDir = '';
          for (const key of [prod.sig, ...prod.previewHashes]) {
            const d = join(cacheDir, 'renders', key);
            if (existsSync(join(d, 'hero.png'))) { renderDir = d; break; }
          }
          const heroPath = renderDir ? join(renderDir, 'hero.png') : '';
          const viewerPath = renderDir ? join(renderDir, 'viewer.html') : '';
          const heroUri = heroPath && existsSync(heroPath) ? dataUri(heroPath) : '';
          const viewerHref = viewerPath && existsSync(viewerPath) ? toFileUrl(outDir, viewerPath) : '';
          // 複数prefab: previews.json の各サムネ(preview{i}.png)を相対参照で拾う(dataURI化せずカタログ肥大を避ける)
          let prefabThumbs: string[] = [];
          if (renderDir) {
            const pj = join(renderDir, 'previews.json');
            if (existsSync(pj)) {
              try {
                const arr = JSON.parse(readFileSync(pj, 'utf8')) as { thumb?: string }[];
                prefabThumbs = arr.map(a => a.thumb ? toFileUrl(outDir, join(renderDir, a.thumb)) : '').filter(Boolean);
              } catch { /* previews.json壊れ等は無視 */ }
            }
          }
          // この商品にBOOTHメタが紐づくか(コピーのいずれか)
          const boothRow = prod.copies.map(c => boothByPath.get(c)).find(Boolean) ?? null;
          const bc = boothRow ? boothCardOf(boothRow) : null;
          const tags = [r.requires_poiyomi ? 'poiyomi' : '', r.requires_liltoon ? 'liltoon' : '', r.has_locked ? 'locked' : '', prod.projects.length ? 'installed' : 'notinstalled', prod.copyCount > 1 ? 'dup' : '', bc ? 'booth' : '', `cat-${prod.category}`].filter(Boolean).join(' ');
          // tags/category は固定語彙だが、data-tags 属性へ素で埋めるため念のためエスケープ(DOM注入の多層防御)。
          const sibs = (byBase.get(verBase(r.file_name)) || []).filter(o => o.sig !== prod.sig);
          const versions = sibs.map(o => ({ name: o.rep.file_name, installed: o.projects.length > 0 }));
          // カード画像のフォールバック: BOOTHサムネ(キャッシュfile://) → 忠実3D hero → preview → 種別プレースホルダ
          const boothImages = bc ? findCachedImages(cacheDir, outDir, bc.id) : [];
          const boothThumbRel = boothImages[0] ?? '';
          let cardImg = '', imgKind = '';
          if (boothThumbRel) { cardImg = boothThumbRel; imgKind = 'booth'; }
          else if (heroUri) { cardImg = heroUri; imgKind = 'local'; }
          else if (cover) { cardImg = cover; imgKind = 'local'; }
          // プレハブ数(.unitypackage内の.prefab数)。>1 なら「複数プレハブ入り」を表示し、3Dは切替可(方式Aで焼いてあれば)。
          let prefabCount = 0;
          try { prefabCount = (JSON.parse(r.kind_breakdown) as Record<string, number>).prefab ?? 0; } catch { /* 壊れ→0 */ }
          // 保管場所(ライブラリ): 各物理コピーのパスを、スキャン済みライブラリ根に照合してラベル化。
          const locations = prod.copies.map(c => libraryOf(c, libraryDirs));
          const libLabel = locations[0]?.label ?? '';
          const libFull = locations[0]?.full ?? r.file_path;
          // このカードが導入済みの登録プロジェクトのキー(絞り込み用)。prod.projects は unity_projects と同一パス。
          const projKeys = prod.projects.map(pp => projKeyByPath.get(pp.path)).filter((k): k is string => !!k);
          for (const k of projKeys) { const pl = projList.find(p => p.key === k); if (pl) pl.count++; }
          return { card: renderCard(prod, cardImg, imgKind, bc, prefabCount, libLabel, libFull), detail: renderDetail(prod, tree, gallery, { heroUri, viewerHref, prefabThumbs }, versions, bc, boothImages, locations, prefabCount), name: r.file_name + (bc ? ` ${bc.name} ${bc.creator}` : ''), tags: esc(tags), sig: prod.sig, category: esc(prod.category), sizeBytes: r.size_bytes, copyCount: prod.copyCount, filePath: r.file_path, fav: favSet.has(prod.sig), proj: projKeys.join(' ') };
        });
        writeFileSync(out, renderApp(data, products.length, projList), 'utf8');
        console.log(`catalog -> ${out}  (${products.length} unique products from ${cat.allPackages().length} files)`);
        break;
      }
      case 'products': {
        const ps = cat.dedupedProducts();
        let wasted = 0;
        for (const p of ps) {
          wasted += p.wastedBytes;
          const cp = p.copyCount > 1 ? ` [コピー×${p.copyCount} 無駄${mb(p.wastedBytes)}]` : '';
          const inst = p.projects.length ? ` 導入${p.projects.length}proj` : '';
          console.log(`  ${p.rep.file_name}${cp}${inst}`);
        }
        console.log(`\nユニーク商品: ${ps.length} / 物理ファイル ${cat.allPackages().length} ・ 重複の無駄 約${mb(wasted)}`);
        break;
      }
      case 'reclaim': {
        // 重複コピーを「1個残して quarantine へ移動」する“可逆”プランを生成。削除はしない。
        // 出力先/隔離先は実行マシン依存にせず CWD 相対を既定に（--quarantine <dir> で上書き可）。
        const scriptOut = args.find(a => a.toLowerCase().endsWith('.ps1')) ?? join(process.cwd(), 'reclaim_plan.ps1');
        const qFlagIdx = args.indexOf('--quarantine');
        const quarantine = (qFlagIdx >= 0 && args[qFlagIdx + 1] && !args[qFlagIdx + 1]!.startsWith('--'))
          ? args[qFlagIdx + 1]! : join(process.cwd(), '_hangar_quarantine');
        const products = cat.dedupedProducts().filter(p => p.copyCount > 1);
        if (args.includes('--json')) {
          // ドライラン: 書き出さずに重複整理の要約だけ返す(GUIのプレビュー用)
          const items = products.map(p => ({ name: p.rep.file_name, copyCount: p.copyCount, wastedBytes: p.wastedBytes }));
          const fileCount = products.reduce((n, p) => n + (p.copyCount - 1), 0);
          const freedBytes = products.reduce((n, p) => n + p.rep.size_bytes * (p.copyCount - 1), 0);
          console.log(JSON.stringify({ productCount: products.length, fileCount, freedBytes, items }));
          break;
        }
        const score = (pth: string) => (/\\trash\\/i.test(pth) ? 1000 : 0) + (/\\test\\/i.test(pth) ? 500 : 0) + pth.length;
        const q = (s: string) => "'" + s.replace(/'/g, "''") + "'";
        const L: string[] = [];
        const plan: string[] = [];
        let delCount = 0, freed = 0;
        L.push('# Hangar reclaim plan (REVERSIBLE): 重複コピーを quarantine へ「移動」します（削除ではない＝元に戻せます）。');
        L.push(`# 各商品を1個だけ残し、残りを ${quarantine} へ移動。実際に空けるには確認後 quarantine を削除。`);
        L.push('$ErrorActionPreference = "Stop"');
        L.push('$Quarantine = ' + q(quarantine));
        for (const p of products) {
          const sorted = [...p.copies].sort((a, b) => score(a) - score(b));
          const keep = sorted[0]!;
          plan.push('');
          plan.push(`# === ${p.rep.file_name}  (x${p.copyCount}, waste ${mb(p.wastedBytes)}) ===`);
          plan.push(`#   KEEP : ${keep}`);
          for (const d of sorted.slice(1)) {
            delCount++; freed += p.rep.size_bytes;
            const rel = d.replace(/^[A-Za-z]:[\\/]/, '');
            plan.push(`#   MOVE : ${d}`);
            plan.push(`$t = Join-Path $Quarantine ${q(rel)}; New-Item -ItemType Directory -Force (Split-Path $t) | Out-Null; Move-Item -LiteralPath ${q(d)} -Destination $t -Force; Write-Host ('moved: ' + ${q(d)})`);
          }
        }
        L.push(`Write-Host "${delCount} 個の重複ファイルを移動します（解放可能 約${mb(freed)}）。元に戻すには $Quarantine から戻してください。"`);
        L.push(`$ok = Read-Host "実行しますか? yes と入力で実行"`);
        L.push(`if ($ok -ne 'yes') { Write-Host 'キャンセルしました'; exit }`);
        L.push(...plan);
        L.push('');
        L.push(`Write-Host "完了。中身を確認後、$Quarantine フォルダを削除すると約${mb(freed)} 空きます。"`);
        writeFileSync(scriptOut, L.join('\r\n'), 'utf8');
        console.log(`重複商品 ${products.length} / 移動対象 ${delCount} ファイル / 解放可能 約${mb(freed)}`);
        console.log(`可逆プラン(quarantineへ移動)を書き出しました: ${scriptOut}`);
        console.log('※ このコマンドは何も削除/移動しません。スクリプトを確認 → ご自身で実行 → 確認後 quarantine 削除で実際に空きます。');
        break;
      }
      case 'dupes': {
        const rows = cat.allPackages();
        const groups = new Map<string, PackageRow[]>();
        for (const r of rows) {
          const sig = guidSetHash(JSON.parse(r.guids_json) as string[]);
          let arr = groups.get(sig);
          if (!arr) { arr = []; groups.set(sig, arr); }
          arr.push(r);
        }
        const out = [...groups.values()].filter(g => g.length > 1).sort((a, b) => b.length - a.length);
        let wasted = 0;
        for (const g of out) {
          const head = g[0]!;
          wasted += head.size_bytes * (g.length - 1);
          console.log(`\n${head.file_name}  ×${g.length}  (${mb(head.size_bytes)} each)`);
          for (const r of g) console.log(`    ${r.file_path}`);
        }
        console.log(`\n重複コピー: ${out.length}グループ / 無駄容量 約${mb(wasted)}`);
        break;
      }
      case 'render': {
        // --sig <内容署名> でGUID集合一致の厳密指定(GUI/カタログから)。無ければ名前の部分一致(従来)。
        const sigIdx = args.indexOf('--sig');
        const sigArg = sigIdx >= 0 ? args[sigIdx + 1] : undefined;
        const pkgSig = (row: PackageRow) => guidSetHash(JSON.parse(row.guids_json) as string[]);
        let r: PackageRow | undefined;
        if (sigArg) {
          r = cat.allPackages().find(row => pkgSig(row) === sigArg);
          if (!r) return fail('該当商品が見つかりません(sig): ' + sigArg);
        } else {
          const query = args.find(a => !a.startsWith('--'));
          if (!query) return fail('usage: render <package名の一部> | render --sig <hash>');
          const matches = cat.allPackages().filter(row => row.file_name.toLowerCase().includes(query.toLowerCase()));
          if (!matches.length) return fail('該当パッケージなし: ' + query);
          r = matches[0]!;
        }
        const projectRoots = cat.allProjects().map(p => p.path);
        const unity = findUnity();
        if (!unity) return fail('Unity(2022.3系)が見つかりません');
        const lil = findLilToon(projectRoots);
        if (!lil) return fail('lilToon が見つかりません。VCC/ALCOMでlilToonを入れたプロジェクトを「プロジェクト検出」で登録するか、環境変数 HANGAR_LILTOON にパッケージのパスを指定してください');
        const poi = findPoiyomi(projectRoots);
        if (!poi) console.log('  ⚠ Poiyomi未検出 → Poiyomi系アバターはピンクになります(hangar/_shaders/com.poiyomi.toon を用意)');
        // レンダ成果物のキーは内容署名(GUID集合のmd5)。重複コピーでも安定し、カタログ詳細と必ず一致する。
        const hash = guidSetHash(JSON.parse(r.guids_json) as string[]);
        const hangarRoot = dirname(cacheDir);
        console.log(`render: ${r.file_name}`);
        console.log(`  Unity: ${unity}  / lilToon:有 Poiyomi:${poi ? '有' : '無'}`);
        console.log('  ※ 裏でUnityバッチレンダ。数分かかります...');
        const res = await renderPackage({
          packageFile: r.file_path, hash, cacheDir,
          renderProjDir: join(hangarRoot, '_renderproj'),
          templateDir: join(hangarRoot, 'render-template'),
          lilToonSrc: lil, poiyomiSrc: poi ?? undefined, unityExe: unity,
          onLog: (m) => console.log(m),
        });
        if (res.ok) {
          console.log(`  OK hero:${res.hero} glb:${res.glb} prefab:${res.count} -> cache/renders/${hash}/`);
          console.log('  → catalog を再生成すると詳細に「忠実プレビュー＋3Dで回す」が出ます。');
        } else {
          console.log(`  失敗。ログ: ${res.logFile}`);
        }
        break;
      }
      case 'caps': {
        // 3D生成(方式A)の可否をJSONで返す(GUIがボタン活性を判定するのに使う)
        const projectRoots = cat.allProjects().map(p => p.path);
        const unity = findUnity();
        const lil = findLilToon(projectRoots);
        const poi = findPoiyomi(projectRoots);
        console.log(JSON.stringify({
          unity: !!unity, unityPath: unity ?? null,
          liltoon: !!lil, poiyomi: !!poi,
          canRender: !!(unity && lil),
        }));
        break;
      }
      case 'booth-enrich': {
        // BOOTH公開メタ(booth.pm/ja/items/<id>.json)を取得し booth_items に保存。鍵不要・読取専用・DLしない。
        // --all: 保存済みの全 booth_item を再取得(AvatarExplorer取込やプレースホルダを公開メタで上書き補完)。
        const all = args.includes('--all');
        let ids = args.filter(a => !a.startsWith('--')).map(a => parseInt(a, 10)).filter(n => Number.isFinite(n));
        if (all) ids = [...new Set([...ids, ...cat.allBoothItems().map(b => b.booth_item_id)])];
        if (!ids.length) {
          // --all で対象ゼロ(新規スキャン直後など。plain scan は BOOTH紐付けを作らない)はエラーにしない。
          if (all) { console.log('補完対象のBOOTH商品がありません。BOOTH紐付けは「他ツールから取込(AvatarExplorer/KonoAsset)」や hangar:// 受け口、取り込み前チェック経由で作られます。'); break; }
          return fail('usage: booth-enrich <itemId...> | booth-enrich --all   例: booth-enrich 8050793');
        }
        let ok = 0, ng = 0, thumbOk = 0;
        for (const id of ids) {
          try {
            const m = await fetchBoothItem(id);
            cat.upsertBoothItem(m, 'booth-api');
            ok++;
            // 商品画像をローカルへキャッシュ(カード＝image0 / 詳細カルーセル＝追加画像)。catalogは file:// 参照。
            {
              const urls = m.imageUrls.length ? m.imageUrls : (m.thumbnailUrl ? [m.thumbnailUrl] : []);
              if (urls.length && await cacheItemImages(cacheDir, id, urls) > 0) thumbOk++;
            }
            console.log(`  ✓ ${id}  ${m.name}  〔${ASSET_TYPE_LABEL[m.assetType]}〕  by ${m.creator || '?'}${m.adult ? '  (R-18)' : ''}`);
          } catch (e) {
            ng++;
            console.error(`  ✗ ${id}  ${e instanceof BoothFetchError ? e.message : (e instanceof Error ? e.message : String(e))}`);
          }
        }
        console.log(`\nBOOTHメタ: ${ok} 件保存${thumbOk ? ` / サムネ ${thumbOk} 件取得` : ''}${ng ? ` / ${ng} 件失敗` : ''}（DB: ${dbPath}）`);
        if (ng && !ok) process.exitCode = 1;
        break;
      }
      case 'booth-info': {
        // 保存済みBOOTHメタの表示(オフライン)。<id>指定で詳細、無指定で一覧。
        const json = args.includes('--json');
        const idArg = args.find(a => !a.startsWith('--'));
        if (idArg) {
          const row = cat.getBoothItem(parseInt(idArg, 10));
          if (!row) return fail(`未保存です (id=${idArg})。先に: booth-enrich ${idArg}`);
          if (json) { console.log(JSON.stringify(row)); break; }
          console.log(formatBoothInfo(row, cat));
          break;
        }
        const rows = cat.allBoothItems();
        if (json) { console.log(JSON.stringify(rows)); break; }
        if (!rows.length) { console.log('(BOOTHメタ未保存 — booth-enrich <id> / import-booth / import-ae で追加)'); break; }
        for (const r of rows) {
          const t = ASSET_TYPE_LABEL[(r.asset_type ?? 'other') as AssetType] ?? r.asset_type;
          console.log(`  ${r.booth_item_id}  ${r.name}  〔${t}〕  by ${r.creator ?? '?'}  [${r.source}]`);
        }
        console.log(`\n保存済み ${rows.length} 件`);
        break;
      }
      case 'booth-thumbs': {
        // 保存済みBOOTH商品のサムネをローカルへキャッシュ(skip-if-exists)。catalogが実画像を表示できる。鍵不要・公開CDN。
        const items = cat.allBoothItems().filter(b => b.thumbnail_url && /^https?:\/\//i.test(b.thumbnail_url));
        if (!items.length) { console.log('(サムネ対象なし — 先に booth-enrich でメタを取得してください)'); break; }
        console.log(`BOOTHサムネをキャッシュ中… (${items.length} 件対象)`);
        const r = await cacheBoothThumbs(items, cacheDir);
        console.log(`サムネ: ${r.ok} 取得(新規含む) / ${r.skip} 既存 → ${join(cacheDir, 'booth-thumbs')}`);
        break;
      }
      case 'fav': {
        // ♡ お気に入りのトグル/設定(sig=内容署名単位)。GUIは楽観更新後にこれで永続化(--on/--off明示、無指定はトグル)。
        const json = args.includes('--json');
        const sig = args.find(a => !a.startsWith('--'));
        if (!sig) return fail('usage: fav <sig> [--on|--off] [--json]');
        let fav: boolean;
        if (args.includes('--on')) { cat.setFavorite(sig, true); fav = true; }
        else if (args.includes('--off')) { cat.setFavorite(sig, false); fav = false; }
        else fav = cat.toggleFavorite(sig);
        if (json) console.log(JSON.stringify({ sig, fav }));
        else console.log(`♡ ${fav ? '追加' : '解除'}: ${sig}`);
        break;
      }
      case 'import-booth': {
        // ローカル実ファイル(ブラウザでDL済み) + BOOTH item_id を受け、カタログ取込＋メタ補完＋関連付け。
        // hangar:// ディープリンク(AssetConnect方式)受け口の実体。DLもログインもしない。
        const json = args.includes('--json');
        const noFetch = args.includes('--no-fetch');
        const idIdx = args.indexOf('--id');
        const idVal = idIdx >= 0 ? args[idIdx + 1] : undefined;
        const nameIdx = args.indexOf('--name');
        const nameVal = nameIdx >= 0 ? args[nameIdx + 1] : undefined;
        const skip = new Set<number>();
        for (const fi of [idIdx, nameIdx]) if (fi >= 0) skip.add(fi + 1);
        const pathArg = args.find((a, i) => !a.startsWith('--') && !skip.has(i));
        if (!pathArg) return fail('usage: import-booth <path(.unitypackage|dir)> --id <boothItemId> [--name <filename>] [--no-fetch]');
        const boothId = idVal ? parseInt(idVal, 10) : NaN;
        if (!Number.isFinite(boothId)) return fail('--id <boothItemId> を数値で指定してください');
        if (!existsSync(pathArg)) return fail('パスが見つかりません: ' + pathArg);

        // 1) メタ補完(公開API)。失敗してもオフライン/非公開のプレースホルダで続行(関連付けは残す)。
        if (!noFetch) {
          try { cat.upsertBoothItem(await fetchBoothItem(boothId), 'booth-api'); }
          catch (e) { console.error(`  ⚠ メタ取得スキップ: ${e instanceof Error ? e.message : String(e)}`); }
        }
        if (!cat.getBoothItem(boothId)) {
          cat.upsertBoothItem({ itemId: boothId, name: nameVal ?? `(BOOTH ${boothId})`, creator: '', shopSubdomain: null, categoryId: null, assetType: 'other', thumbnailUrl: null, imageUrls: [], publishedAt: null, adult: false, tags: [], description: '', itemUrl: `https://booth.pm/ja/items/${boothId}` }, 'manual');
        }

        // 2) ファイル取込 + 3) 関連付け
        const imported = await importLocalForBooth(cat, cacheDir, pathArg);
        const linkName = nameVal ?? basename(pathArg);
        if (imported.pkgPaths.length) for (const cf of imported.pkgPaths) cat.linkBooth(cf, boothId, linkName);
        else cat.linkBooth(canonical(pathArg), boothId, linkName);

        const stored = cat.getBoothItem(boothId);
        if (json) { console.log(JSON.stringify({ boothItemId: boothId, name: stored?.name, assetType: stored?.asset_type, scanned: imported.scanned, linked: imported.pkgPaths.length || 1 })); break; }
        console.log(`取込: ${stored?.name ?? '(' + boothId + ')'}  〔${ASSET_TYPE_LABEL[(stored?.asset_type ?? 'other') as AssetType] ?? '?'}〕`);
        console.log(imported.scanned ? `  カタログ解析: ${imported.scanned} パッケージ` : `  ※ .unitypackage でないため関連付けのみ（中身解析なし）`);
        console.log(`  関連付け: ${linkName} ↔ BOOTH ${boothId}`);
        console.log(`  → catalog 再生成でメタ付き表示。`);
        break;
      }
      case 'import-ae': {
        // AvatarExplorer エクスポート(ItemsData.json)取込。KonoAsset/AvatarExplorer互換の事実上標準フォーマット。
        const json = args.includes('--json');
        const doScan = args.includes('--scan');
        const dir = args.find(a => !a.startsWith('--'));
        if (!dir) return fail('usage: import-ae <AvatarExplorerExportDir> [--scan] [--json]   (ItemsData.json を含むフォルダ)');
        if (!existsSync(dir)) return fail('フォルダが見つかりません: ' + dir);
        const res = await importAvatarExplorer(dir, cat, { scan: doScan, cacheDir });
        if (json) { console.log(JSON.stringify(res)); break; }
        console.log(formatAeImportText(res));
        if (res.errors.length && !res.importedMeta) process.exitCode = 1;
        break;
      }
      case 'version': case '--version': case '-v':
        console.log('hangar ' + appVersion());
        break;
      default: {
        if (cmd) { console.error(`不明なコマンド: ${cmd}`); console.error(''); }
        console.log(`Hangar v${appVersion()} — commands:`);
        console.log('  render <package名の一部>          裏Unity+lilToonで忠実プレビュー画像+3D GLBを生成');
        console.log('  dupes                            同一内容パッケージの重複コピーを検出(容量無駄)');
        console.log('  products                         重複を束ねたユニーク商品一覧(無駄容量つき)');
        console.log('  reclaim [out.ps1]                重複コピー削減プラン(可逆=quarantine移動)を書出し ※削除はしない');
        console.log('  scan <libraryDir>                .unitypackage を解析しカタログ登録(+preview抽出)');
        console.log('  list / search <query>            一覧 / 検索');
        console.log('  diff <pkg> --project <dir>       取り込み前チェック: 何を上書き/足りないシェーダ(--json/--all/--html out.html)');
        console.log('  save-template <projectDir> --out <dir>      改変アバターの自作分を保存＋依存購入物をマニフェスト化(購入バイトは非同梱)');
        console.log('  restore-template <templateDir> --project <dir>  まっさらなプロジェクトへ復元＋「持ってる/入れ直して」台帳（既定は既存保護・上書きは --force）');
        console.log('  detect [--save] <projectDir...>  導入済みか逆引き（--saveで記録・上位フォルダ可）');
        console.log('  compare <projA> <projB> [..]     プロジェクト横断比較(共通/Aのみ/Bのみ・版差・移行ギャップ)(--all/--json/--html)');
        console.log('  sprawl [--min N]                 散らばり俯瞰(複数プロジェクトに散在する商品)');
        console.log('  list-projects / prune-projects   登録プロジェクト一覧 / 不正登録(不在・Assets無し)の掃除');
        console.log('  installs                         パッケージ→導入先一覧（重複導入警告）');
        console.log('  catalog [out.html]               カタログ(クリックで詳細: 中身/プレビュー/導入台帳)を生成');
        console.log('  booth-enrich <itemId...>         BOOTH公開メタ＋サムネを取得して保存(鍵不要・購入物はDLしない)');
        console.log('  booth-thumbs                     保存済みBOOTH商品のサムネをローカルにキャッシュ(catalogで実画像表示)');
        console.log('  booth-info [<itemId>]            保存済みBOOTHメタの表示(一覧/詳細)');
        console.log('  import-booth <path> --id <bid>   DL済みファイル+booth idを取込(hangar://受け口の実体)');
        console.log('  import-ae <dir> [--scan]         AvatarExplorer/KonoAsset書出(ItemsData.json)を取込');
        console.log('  version                          バージョンを表示');
        if (cmd) process.exitCode = 1;   // 不明コマンドは失敗扱い(typoが即発覚)
        break;
      }
    }
  } finally {
    cat.close();
  }
}

// ---------- BOOTH 取込ヘルパー ----------

// ローカルパスをカタログへ取り込み、関連付け対象の正規化パス(.unitypackage)を返す。
//  - .unitypackage  : 単体解析して upsert（scan と同じ previewDir スキーム）
//  - ディレクトリ   : scanDir で配下の .unitypackage を一括解析
//  - その他(zip等)  : v0 は解析せず関連付けのみ（pkgPaths 空で返す）
async function importLocalForBooth(cat: Catalog, cacheDir: string, inputPath: string): Promise<{ pkgPaths: string[]; scanned: number }> {
  const st = statSync(inputPath);
  if (st.isDirectory()) {
    const sum = await scanDir(inputPath, cat, cacheDir);
    return { pkgPaths: collectUnitypackages(inputPath), scanned: sum.parsed };
  }
  if (inputPath.toLowerCase().endsWith('.unitypackage')) {
    const cf = canonical(inputPath);
    const previewDir = join(cacheDir, 'previews', createHash('md5').update(cf).digest('hex').slice(0, 16));
    cat.upsert(await parsePackage(cf, { previewDir }));
    return { pkgPaths: [cf], scanned: 1 };
  }
  return { pkgPaths: [], scanned: 0 };
}

function formatBoothInfo(r: BoothItemRow, cat: Catalog): string {
  const L: string[] = [];
  const type = ASSET_TYPE_LABEL[(r.asset_type ?? 'other') as AssetType] ?? r.asset_type ?? '?';
  L.push(`BOOTH ${r.booth_item_id}  ${r.name}`);
  L.push(`  種別   : ${type}${r.adult ? '  (R-18)' : ''}`);
  L.push(`  作者   : ${r.creator ?? '?'}${r.shop_subdomain ? `  (${r.shop_subdomain})` : ''}`);
  if (r.published_at) L.push(`  公開   : ${new Date(r.published_at).toISOString().slice(0, 10)}`);
  let tags: string[] = [];
  try { tags = r.tags_json ? JSON.parse(r.tags_json) as string[] : []; } catch { /* 壊れ無視 */ }
  if (tags.length) L.push(`  タグ   : ${tags.join(', ')}`);
  if (r.item_url) L.push(`  URL    : ${r.item_url}`);
  L.push(`  取得元 : ${r.source}`);
  const files = cat.boothLinkedFiles(r.booth_item_id);
  if (files.length) {
    L.push(`  紐づくファイル (${files.length}):`);
    for (const f of files) L.push(`    ・${f.filename ?? f.file_path}`);
  }
  return L.join('\n');
}

// カタログ描画用に BOOTHメタを正規化。プレースホルダ(source=manual・名前が "(BOOTH …)")は薄く扱う。
export interface BoothCard {
  id: number; name: string; creator: string; typeLabel: string;
  itemUrl: string | null; tags: string[]; publishedAt: number | null; source: string; placeholder: boolean;
  thumbnailUrl: string | null; imageUrls: string[]; adult: boolean;
}
function boothCardOf(r: BoothItemRow): BoothCard {
  let tags: string[] = [];
  try { tags = r.tags_json ? JSON.parse(r.tags_json) as string[] : []; } catch { /* 壊れ無視 */ }
  let imageUrls: string[] = [];
  try { imageUrls = r.image_urls_json ? JSON.parse(r.image_urls_json) as string[] : []; } catch { /* 壊れ無視 */ }
  return {
    id: r.booth_item_id,
    name: r.name,
    creator: r.creator ?? '',
    typeLabel: ASSET_TYPE_LABEL[(r.asset_type ?? 'other') as AssetType] ?? (r.asset_type ?? '?'),
    itemUrl: r.item_url,
    tags,
    publishedAt: r.published_at,
    source: r.source ?? '',
    placeholder: (r.source === 'manual') || /^\(BOOTH \d+\)$/.test(r.name),
    thumbnailUrl: r.thumbnail_url,
    imageUrls,
    adult: !!r.adult,
  };
}

// BOOTHサムネのローカルキャッシュ: <cacheDir>/booth-thumbs/<id>.<ext>。catalog は file:// 相対参照する(CSP不要)。
function thumbExt(url: string): string {
  const m = /\.(jpe?g|png|webp|gif)(?:[?#]|$)/i.exec(url);
  const e = m?.[1];
  return e ? e.toLowerCase().replace('jpeg', 'jpg') : 'jpg';
}
// catalog(file://)から参照できるURLを返す。同一ドライブなら相対パス、別ドライブで relative() が
// 絶対パス(例 D:/...)を返した場合は file:/// 絶対URLに変換する(ドライブ文字をスキームと誤解させない)。
function toFileUrl(outDir: string, p: string): string {
  const rel = relative(outDir, p).replace(/\\/g, '/');
  return /^[a-zA-Z]:\//.test(rel) ? 'file:///' + rel : rel;
}
// 保管場所ラベル: file_path を「スキャン済みライブラリ根」に照合し、どのライブラリの何処かを求める。
//  - 最長一致するライブラリ根があれば label=根のフォルダ名 / sub=根からの相対 / root=根フルパス。
//  - 一致無し(取込物/ドロップ等)は直上フォルダ名にフォールバック。full は常に元のフルパス。
function libraryOf(filePath: string, libraryDirs: string[]): { label: string; sub: string; full: string; root: string } {
  const normP = filePath.replace(/\\/g, '/');
  const normPl = normP.toLowerCase();
  let best = '';
  for (const d of libraryDirs) {
    const nd = d.replace(/\\/g, '/').replace(/\/+$/, '');
    const ndl = nd.toLowerCase();
    if ((normPl === ndl || normPl.startsWith(ndl + '/')) && nd.length > best.length) best = nd;
  }
  if (best) {
    const sub = normP.slice(best.length).replace(/^\/+/, '');
    return { label: basename(best) || best, sub, full: normP, root: best };
  }
  const parent = dirname(normP);
  return { label: basename(parent) || parent, sub: basename(normP), full: normP, root: parent };
}

// 既にキャッシュ済みサムネ(画像0=カード用)があれば catalog 出力先からの参照URLを返す(無ければ空)。
function findCachedThumbRel(cacheDir: string, outDir: string, id: number): string {
  for (const ext of ['jpg', 'png', 'webp', 'gif']) {
    const p = join(cacheDir, 'booth-thumbs', `${id}.${ext}`);
    if (existsSync(p)) return toFileUrl(outDir, p);
  }
  return '';
}

// 詳細のカルーセル用: BOOTH商品画像を複数キャッシュ(image0=<id>.ext / image_k=<id>_k.ext)。上限MAX_IMGS。
const MAX_IMGS = 6;
function imgDestPath(cacheDir: string, id: number, idx: number, url: string): string {
  const ext = thumbExt(url);
  return join(cacheDir, 'booth-thumbs', idx === 0 ? `${id}.${ext}` : `${id}_${idx}.${ext}`);
}
async function cacheItemImages(cacheDir: string, id: number, urls: string[]): Promise<number> {
  const list = urls.filter(u => /^https?:\/\//i.test(u)).slice(0, MAX_IMGS);
  let got = 0;
  for (let i = 0; i < list.length; i++) {
    const dest = imgDestPath(cacheDir, id, i, list[i]!);
    if (existsSync(dest)) continue;
    if (await downloadImage(list[i]!, dest)) got++;
  }
  return got;
}
// キャッシュ済みのBOOTH画像URL群(詳細カルーセル用)。image0の次に穴があれば打ち切り。
function findCachedImages(cacheDir: string, outDir: string, id: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < MAX_IMGS; i++) {
    let found = '';
    for (const ext of ['jpg', 'png', 'webp', 'gif']) {
      const p = join(cacheDir, 'booth-thumbs', i === 0 ? `${id}.${ext}` : `${id}_${i}.${ext}`);
      if (existsSync(p)) { found = toFileUrl(outDir, p); break; }
    }
    if (found) out.push(found);
    else if (i > 0) break;
  }
  return out;
}
// 指定 booth_items のサムネを順次(=礼儀正しく)ダウンロード。skip-if-exists。
async function cacheBoothThumbs(items: BoothItemRow[], cacheDir: string): Promise<{ ok: number; skip: number; fail: number }> {
  let ok = 0, skip = 0;
  for (const b of items) {
    // http(s) の商品画像を取得(image0＋詳細カルーセル用の追加画像)。AvatarExplorer等のローカルパスは対象外。
    let urls: string[] = [];
    try { urls = b.image_urls_json ? JSON.parse(b.image_urls_json) as string[] : []; } catch { /* 壊れ無視 */ }
    if (!urls.length && b.thumbnail_url) urls = [b.thumbnail_url];
    urls = urls.filter(u => /^https?:\/\//i.test(u));
    if (!urls.length) continue;
    // 画像単位で skip-if-exists(cacheItemImages内)。旧スキームで image0 のみ持つ商品も追加画像を backfill する。
    if (await cacheItemImages(cacheDir, b.booth_item_id, urls)) ok++; else skip++;
  }
  return { ok, skip, fail: 0 };
}

// ---------- カタログ描画 ----------

function dataUri(pngPath: string): string {
  if (!existsSync(pngPath)) return '';
  try { return `data:image/png;base64,${readFileSync(pngPath).toString('base64')}`; } catch { return ''; }
}

function readGallery(previewDir: string | null, max: number): string[] {
  if (!previewDir || !existsSync(previewDir)) return [];
  let files: { p: string; size: number }[] = [];
  try {
    for (const fn of readdirSync(previewDir)) {
      if (fn.toLowerCase().endsWith('.png')) { const p = join(previewDir, fn); files.push({ p, size: statSync(p).size }); }
    }
  } catch { return []; }
  files.sort((a, b) => b.size - a.size);
  const out: string[] = [];
  for (const f of files.slice(0, max)) { const u = dataUri(f.p); if (u) out.push(u); }
  return out;
}

interface TreeNode { dirs: Map<string, TreeNode>; files: { name: string; kind: string }[]; }

function buildTreeHtml(files: { pathname: string; kind: string }[]): string {
  const root: TreeNode = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.pathname.split('/').filter(Boolean);
    if (!parts.length) continue;
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const d = parts[i]!;
      let nx = node.dirs.get(d);
      if (!nx) { nx = { dirs: new Map(), files: [] }; node.dirs.set(d, nx); }
      node = nx;
    }
    node.files.push({ name: parts[parts.length - 1]!, kind: f.kind ?? 'other' });
  }
  const count = (n: TreeNode): number => n.files.length + [...n.dirs.values()].reduce((s, c) => s + count(c), 0);
  const render = (n: TreeNode): string => {
    let h = '';
    for (const [name, child] of [...n.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      h += `<details><summary>📁 ${esc(name)} <span class="c">${count(child)}</span></summary><div class="tch">${render(child)}</div></details>`;
    }
    for (const f of n.files.sort((a, b) => a.name.localeCompare(b.name))) {
      h += `<div class="f"><span class="k k-${esc(f.kind)}">${esc(f.kind)}</span> ${esc(f.name)}</div>`;
    }
    return h;
  };
  return render(root);
}

function shaderBadges(r: PackageRow): string {
  const b: string[] = [];
  if (r.requires_poiyomi) b.push('<span class="sh poi">要Poiyomi</span>');
  if (r.requires_liltoon) b.push('<span class="sh lil">要lilToon</span>');
  if (r.has_locked) b.push('<span class="sh lock">ロック済</span>');
  return b.length ? `<div class="shbadges">${b.join('')}</div>` : '';
}

// パッケージ種別バッジ(3Dモデル/ツール/アニメ/マテリアル)。色は CSS .cat-<category>。
function catBadge(category: string): string {
  return `<span class="catb cat-${esc(category)}">${esc(categoryLabel(category as never))}</span>`;
}

type CompareResult = {
  projects: { path: string; name: string; registered: boolean }[];
  products: CompareProduct[];
  tooling?: Record<string, Record<string, string>>;   // path -> {vpm id: version}
  migrate?: { fileName: string; libAvailable: boolean; requiresLil: boolean; requiresPoi: boolean }[];  // A→B移行ギャップ(2proj時)
};

const PINK_TOOL_IDS = new Set(['jp.lilxyzw.liltoon', 'com.poiyomi.toon']);
const TOOL_LABEL: Record<string, string> = {
  'jp.lilxyzw.liltoon': 'lilToon', 'com.poiyomi.toon': 'Poiyomi',
  'com.vrchat.avatars': 'VRChat SDK Avatars', 'com.vrchat.base': 'VRChat SDK Base', 'nadena.dev.modular-avatar': 'Modular Avatar',
};

// 指定 path 群について、VPMツールの「版違い or 片方欠落」だけを行にして返す（pink関連を先頭に）。
function toolingRows(paths: string[], tooling?: Record<string, Record<string, string>>): { id: string; label: string; versions: (string | undefined)[]; pink: boolean }[] {
  if (!tooling) return [];
  const ids = new Set<string>();
  for (const p of paths) for (const id of Object.keys(tooling[p] ?? {})) ids.add(id);
  return [...ids].map(id => {
    const versions = paths.map(p => tooling[p]?.[id]);
    const differs = new Set(versions.map(v => v ?? '∅')).size > 1;
    return { id, label: TOOL_LABEL[id] ?? id, versions, pink: PINK_TOOL_IDS.has(id), differs };
  }).filter(r => r.differs).sort((a, b) => (b.pink ? 1 : 0) - (a.pink ? 1 : 0) || a.label.localeCompare(b.label));
}

function formatCompareText(r: CompareResult): string {
  const L: string[] = [];
  const unreg = r.projects.filter(p => !p.registered);
  if (unreg.length) L.push(`⚠ 未登録のため比較に含まれません（先に「プロジェクト検出」で登録）: ${unreg.map(p => p.name).join(' , ')}`);
  const ps = r.projects.filter(p => p.registered);
  if (ps.length < 2) return (L.join('\n') + '\n比較するには登録済みプロジェクトが2つ以上必要です。').trim();

  const has = (p: CompareProduct, path: string) => p.perProject[path];
  const pinkTag = (p: CompareProduct) => (p.requiresLil || p.requiresPoi)
    ? ` 〔要${[p.requiresLil ? 'lilToon' : '', p.requiresPoi ? 'Poiyomi' : ''].filter(Boolean).join('+')}〕` : '';

  if (ps.length === 2) {
    const [A, B] = ps as [CompareResult['projects'][0], CompareResult['projects'][0]];
    const inA = (p: CompareProduct) => has(p, A.path), inB = (p: CompareProduct) => has(p, B.path);
    const common = r.products.filter(p => inA(p) && inB(p));
    const onlyAraw = r.products.filter(p => inA(p) && !inB(p));
    const onlyBraw = r.products.filter(p => inB(p) && !inA(p));
    // 版違い: 「Aのみ」「Bのみ」に同名（中身=sig は別）の商品がいれば「別の版」とみなす
    const aByName = new Map(onlyAraw.map(p => [p.fileName, p]));
    const verNames = new Set(onlyBraw.filter(p => aByName.has(p.fileName)).map(p => p.fileName));
    const onlyA = onlyAraw.filter(p => !verNames.has(p.fileName));
    const onlyB = onlyBraw.filter(p => !verNames.has(p.fileName));

    L.push('=== プロジェクト比較');
    L.push(`   A = ${A.name}   (${A.path})`);
    L.push(`   B = ${B.name}   (${B.path})`);
    L.push(`\n● 共通 (${common.length})`);
    for (const p of common) {
      const a = Math.round(inA(p)!.pct), b = Math.round(inB(p)!.pct);
      const note = Math.abs(a - b) >= 10 ? (a > b ? `   ⚠ B は一部だけ(${b}%)` : `   ⚠ A は一部だけ(${a}%)`) : '';
      L.push(`   ・${p.fileName}   A${a}% / B${b}%${note}`);
    }
    L.push(`\n◀ A のみ (${onlyA.length})   ＝B へ移すなら追加導入`);
    for (const p of onlyA) L.push(`   ・${p.fileName}${pinkTag(p)}`);
    L.push(`\n▶ B のみ (${onlyB.length})`);
    for (const p of onlyB) L.push(`   ・${p.fileName}${pinkTag(p)}`);
    if (verNames.size) {
      L.push(`\n⚠ 版違いの可能性 (${verNames.size})   ＝同名だが中身(GUID集合)が異なる`);
      for (const name of verNames) L.push(`   ・${name}   A と B で別の版`);
    }
    const tRows = toolingRows([A.path, B.path], r.tooling);
    if (tRows.length) {
      L.push(`\n⚙ シェーダ/SDK差 (${tRows.length})   ＝VPM版違い/欠落（要シェーダ商品は移行時ピンク注意）`);
      for (const t of tRows) L.push(`   ${t.pink ? '⚠ ' : ''}${t.label}   A:${t.versions[0] ?? '無'} / B:${t.versions[1] ?? '無'}`);
    }
    if (r.migrate && r.migrate.length) {
      L.push(`\n🚚 移行ギャップ A→B (${r.migrate.length})   ＝B を A に揃えるなら追加導入`);
      for (const m of r.migrate) {
        const sh = (m.requiresLil || m.requiresPoi) ? ` ・要${[m.requiresLil ? 'lilToon' : '', m.requiresPoi ? 'Poiyomi' : ''].filter(Boolean).join('+')}` : '';
        L.push(`   ${m.libAvailable ? '⟳ 再インポート可      ' : '✗ 入手要(ライブラリに無) '}${m.fileName}${sh}`);
      }
    }
    return L.join('\n');
  }

  // 3プロジェクト以上: 全員/一部/単独 の3段階要約（生のN×Mグリッドは出さない）
  const n = ps.length;
  const cntOf = (p: CompareProduct) => ps.filter(pr => has(p, pr.path)).length;
  L.push(`=== プロジェクト比較 (${n} プロジェクト)`);
  ps.forEach((p, i) => L.push(`   ${i + 1}. ${p.name}`));
  const allN = r.products.filter(p => cntOf(p) === n);
  const some = r.products.filter(p => { const c = cntOf(p); return c > 1 && c < n; });
  const solo = r.products.filter(p => cntOf(p) === 1);
  L.push(`\n● 全員にある (${allN.length})`);
  for (const p of allN) L.push(`   ・${p.fileName}`);
  L.push(`\n◐ 一部にある (${some.length})`);
  for (const p of some) L.push(`   ・${p.fileName}   [${ps.map((pr, i) => has(p, pr.path) ? i + 1 : '').filter(x => x !== '').join(',')}]`);
  L.push(`\n○ 単独 (${solo.length})`);
  for (const p of solo) L.push(`   ・${p.fileName}   [${ps.findIndex(pr => has(p, pr.path)) + 1}]${pinkTag(p)}`);
  const tRowsN = toolingRows(ps.map(p => p.path), r.tooling);
  if (tRowsN.length) {
    L.push(`\n⚙ シェーダ/SDK差 (${tRowsN.length})`);
    for (const t of tRowsN) L.push(`   ${t.pink ? '⚠ ' : ''}${t.label}   ${t.versions.map((v, i) => `${i + 1}:${v ?? '無'}`).join(' / ')}`);
  }
  return L.join('\n');
}

function formatSprawlText(prods: Product[], min: number): string {
  const L: string[] = [];
  L.push(`=== 散らばり俯瞰: ${min}プロジェクト以上に導入された商品 (${prods.length})`);
  if (!prods.length) { L.push('   （該当なし）'); return L.join('\n'); }
  let logical = 0;
  for (const p of prods) {
    logical += p.rep.size_bytes * (p.projects.length - 1);
    const cp = p.copyCount > 1 ? ` ・物理コピー${p.copyCount}(無駄${mb(p.wastedBytes)})` : '';
    L.push(`   ${p.projects.length}proj  ${mb(p.rep.size_bytes)}${cp}  ${p.rep.file_name}`);
    L.push(`        → ${p.projects.map(x => x.name).join(' , ')}`);
  }
  L.push(`\n論理重複(同一商品が複数プロジェクトに導入)の概算: 約${mb(logical)}`);
  return L.join('\n');
}

function formatCompareHtml(r: CompareResult): string {
  const e = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const ps = r.projects.filter(p => p.registered);
  const has = (p: CompareProduct, path: string) => p.perProject[path];
  const pink = (p: CompareProduct) => (p.requiresLil || p.requiresPoi) ? ` <span class="pink">〔要${[p.requiresLil ? 'lilToon' : '', p.requiresPoi ? 'Poiyomi' : ''].filter(Boolean).join('+')}〕</span>` : '';
  const sec = (cls: string, title: string, items: string[]) => `<h2 class="${cls}">${title} (${items.length})</h2><div class="list">${items.length ? items.join('') : '<div class="muted">なし</div>'}</div>`;
  let body = '';
  if (ps.length === 2) {
    const [A, B] = ps as [CompareResult['projects'][0], CompareResult['projects'][0]];
    const inA = (p: CompareProduct) => has(p, A.path), inB = (p: CompareProduct) => has(p, B.path);
    const common = r.products.filter(p => inA(p) && inB(p));
    const oAraw = r.products.filter(p => inA(p) && !inB(p));
    const oBraw = r.products.filter(p => inB(p) && !inA(p));
    const aByName = new Map(oAraw.map(p => [p.fileName, p]));
    const verNames = new Set(oBraw.filter(p => aByName.has(p.fileName)).map(p => p.fileName));
    const oA = oAraw.filter(p => !verNames.has(p.fileName)), oB = oBraw.filter(p => !verNames.has(p.fileName));
    body += `<div class="head">A = <b>${e(A.name)}</b> ／ B = <b>${e(B.name)}</b></div>`;
    body += sec('g', '● 共通', common.map(p => { const a = Math.round(inA(p)!.pct), b = Math.round(inB(p)!.pct); const note = Math.abs(a - b) >= 10 ? ` <span class="o">⚠ ${a > b ? 'B' : 'A'} は一部だけ(${a > b ? b : a}%)</span>` : ''; return `<div class="row">${e(p.fileName)} <span class="muted">A${a}% / B${b}%</span>${note}</div>`; }));
    body += sec('o', '◀ A のみ（B へ移すなら追加導入）', oA.map(p => `<div class="row">${e(p.fileName)}${pink(p)}</div>`));
    body += sec('o', '▶ B のみ', oB.map(p => `<div class="row">${e(p.fileName)}${pink(p)}</div>`));
    if (verNames.size) body += sec('r', '⚠ 版違いの可能性', [...verNames].map(n => `<div class="row">${e(n)} <span class="muted">A と B で別の版</span></div>`));
    const tRows = toolingRows([A.path, B.path], r.tooling);
    if (tRows.length) body += sec('r', '⚙ シェーダ/SDK差', tRows.map(t => `<div class="row">${t.pink ? '⚠ ' : ''}${e(t.label)} <span class="muted">A:${e(t.versions[0] ?? '無')} / B:${e(t.versions[1] ?? '無')}</span></div>`));
    if (r.migrate && r.migrate.length) body += sec('o', '🚚 移行ギャップ A→B（B を A に揃えるなら追加導入）', r.migrate.map(m => `<div class="row">${m.libAvailable ? '⟳ <span class="muted">再インポート可</span>' : '✗ <span class="r">入手要</span>'} ${e(m.fileName)}${(m.requiresLil || m.requiresPoi) ? ` <span class="pink">〔要${[m.requiresLil ? 'lilToon' : '', m.requiresPoi ? 'Poiyomi' : ''].filter(Boolean).join('+')}〕</span>` : ''}</div>`));
  } else {
    body += `<div class="head">${ps.length} プロジェクト: ${ps.map((p, i) => `${i + 1}.${e(p.name)}`).join(' / ')}</div>`;
    const cntOf = (p: CompareProduct) => ps.filter(pr => has(p, pr.path)).length;
    body += sec('g', '● 全員にある', r.products.filter(p => cntOf(p) === ps.length).map(p => `<div class="row">${e(p.fileName)}</div>`));
    body += sec('o', '◐ 一部にある', r.products.filter(p => { const c = cntOf(p); return c > 1 && c < ps.length; }).map(p => `<div class="row">${e(p.fileName)} <span class="muted">[${ps.map((pr, i) => has(p, pr.path) ? i + 1 : '').filter(x => x !== '').join(',')}]</span></div>`));
    body += sec('o', '○ 単独', r.products.filter(p => cntOf(p) === 1).map(p => `<div class="row">${e(p.fileName)} <span class="muted">[${ps.findIndex(pr => has(p, pr.path)) + 1}]</span>${pink(p)}</div>`));
  }
  const style = 'body{margin:0;background:#16161a;color:#e8e8ea;font-family:system-ui,sans-serif;padding:24px;line-height:1.6}h1{font-size:18px}.head{color:#cfcfd6;margin:8px 0 16px}h2{font-size:14px;margin:18px 0 6px}.g{color:#9ae7c2}.o{color:#e7c89a}.r{color:#ff9aa8}.list{font-family:ui-monospace,Consolas,monospace;font-size:13px}.row{padding:3px 0;border-bottom:1px solid #222228}.muted{color:#9a9aa2}.pink{color:#c3b6ff}';
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>プロジェクト比較</title><style>${style}</style></head><body><h1>🔀 プロジェクト比較レポート</h1>${body}<footer style="margin-top:24px;color:#6a6a72;font-size:12px">Hangar — ローカル生成・パス/商品名を含みます（共有時は注意）。</footer></body></html>`;
}

// 画像: imgKind='booth'(キャッシュ済BOOTHサムネ・object-fit:cover) / 'local'(preview/忠実3D・contain) / ''(無=プレースホルダ)。
// フォールバック解決は呼び出し側(catalog data-map)。R-18(booth.adult)は blur＋タップ表示でポートフォリオ誤露出を防ぐ。
function renderCard(p: Product, imgSrc: string, imgKind: string, booth: BoothCard | null = null, prefabCount = 0, libLabel = '', libFull = ''): string {
  const r = p.rep;
  const dup = p.copyCount > 1 ? `<span class="dup">コピー×${p.copyCount}・無駄${mb(p.wastedBytes)}</span>` : '';
  const badge = p.projects.length ? `<div class="cb">導入 ${p.projects.length}プロジェクト</div>` : `<div class="cb none">未導入</div>`;
  const adult = !!(booth && booth.adult);
  const cls = [imgKind === 'booth' ? 'cover' : '', adult ? 'nsfw' : ''].filter(Boolean).join(' ');
  const thumb = imgSrc
    ? `<img src="${imgSrc}" loading="lazy"${cls ? ` class="${cls}"` : ''}>` +
      (adult ? `<button class="nsfwtag" title="R-18 — クリックで表示" onclick="event.stopPropagation();hangarReveal(this)">🔞 タップで表示</button>` : '')
    : `<div class="ph cat-${esc(p.category)}"><span class="phn">${esc(r.file_name.replace(/\.unitypackage$/i, '').slice(0, 2) || '?')}</span><span class="phl">画像準備中</span></div>`;
  const prefabTag = prefabCount > 1 ? ` ・ <span class="pfab" title="この商品には ${prefabCount} 個のプレハブが入っています（3D生成で切替可）">🧩${prefabCount}</span>` : '';
  const boothLine = booth
    ? `<div class="booth" title="BOOTH ${booth.id}${booth.placeholder ? '（メタ未取得）' : ''}">🛒 ${esc(booth.creator || 'BOOTH')}${booth.creator ? ' ・ ' : ''}${esc(booth.typeLabel)}</div>`
    : '';
  // 保管場所(どのライブラリから読み込んだか)を一目で。フル絵はホバーで。
  const libRow = libLabel ? `<div class="librow" title="${esc(libFull)}">📁 ${esc(libLabel)}</div>` : '';
  return `<div class="thumb">${catBadge(p.category)}${thumb}</div><div class="cbody"><div class="name">${esc(r.file_name)} ${dup}</div>` +
    `<div class="meta">${mb(r.size_bytes)} ・ ${r.file_count} files ・ prev ${r.preview_pct}%${prefabTag}</div>${shaderBadges(r)}${boothLine}${libRow}${badge}</div>`;
}

// 詳細(右スライドオーバー・2カラム)。左=BOOTH画像カルーセル+忠実3D、右=商品情報+導入台帳+重複/別版。
function renderDetail(p: Product, treeHtml: string, gallery: string[], render: { heroUri: string; viewerHref: string; prefabThumbs?: string[] }, versions: { name: string; installed: boolean }[] = [], booth: BoothCard | null = null, boothImages: string[] = [], locations: { label: string; sub: string; full: string; root: string }[] = [], prefabCount = 0): string {
  const r = p.rep;
  const kinds = JSON.parse(r.kind_breakdown) as Record<string, number>;
  const chips = Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span class="chip">${esc(k)} ${v}</span>`).join('');
  const dup = p.copyCount > 1 ? `<span class="dup">コピー×${p.copyCount}</span>` : '';
  const adult = !!(booth && booth.adult);

  // ヒーロー画像群: BOOTH商品画像(キャッシュ) → 忠実3D hero → preview。カルーセルで切替。
  const imgs: string[] = [...boothImages];
  if (render.heroUri) imgs.push(render.heroUri);
  for (const t of (render.prefabThumbs ?? [])) imgs.push(t);   // 複数prefab(方式A)のサムネもカルーセルに含める
  for (const g of gallery) imgs.push(g);
  const prefabN = render.prefabThumbs ? render.prefabThumbs.length : 0;
  const mainSrc = imgs[0] ?? '';
  const heroBox = mainSrc
    ? `<div class="dhero2"><img id="dmain" class="dmainimg${adult ? ' nsfw' : ''}" src="${mainSrc}">${adult ? '<button class="nsfwtag" onclick="event.stopPropagation();hangarRevealDetail()">🔞 タップで表示</button>' : ''}</div>`
    : `<div class="dhero2"><div class="ph cat-${esc(p.category)}"><span class="phl">画像なし</span></div></div>`;
  const strip = imgs.length > 1
    ? `<div class="dstrip">${imgs.map((u, idx) => `<img class="dsth${idx === 0 ? ' on' : ''}${adult ? ' nsfw' : ''}" data-full="${u}" src="${u}" onclick="hangarSwap(this)">`).join('')}</div>`
    : '';

  const genBtn = p.category === 'model'
    ? `<button class="genbtn-d" onclick="hangarRender(CUR)" title="裏でUnity+lilToonを起動し忠実プレビュー画像と3D(GLB)を生成(数分)">🎬 ${render.heroUri ? '3Dを再生成' : '3D生成'}</button>`
    : '';
  const view3d = render.viewerHref ? `<a class="btn3d" href="${render.viewerHref}" target="_blank" rel="noopener">▶ 3Dで回す${prefabN > 1 ? `（${prefabN}体・切替可）` : ''}</a>` : '';
  const preimport = `<button class="btnpre" onclick="hangarDiff(CUR)" title="この商品を取り込む前に既存プロジェクトとの衝突/ピンク危険をチェック">🛡 取り込み前チェック</button>`;

  const inst = p.projects.length
    ? `<table class="ledger"><tr><th>プロジェクト</th><th>一致</th><th>パス</th></tr>` +
      p.projects.map(pr => `<tr><td>${esc(pr.name)}</td><td class="pct">${pr.pct}%</td><td class="pth">${esc(pr.path)}</td></tr>`).join('') + `</table>`
    : `<div class="none">どのプロジェクトにも導入されていません</div>`;
  // 保管場所(どのライブラリから読み込んだか)。単一コピーでも常に表示＝「このファイルはどこに在るか」を必ず示す。
  //  重複コピーがある時は同じ枠で全コピー＋無駄バイトも見せる(旧「⧉ 重複コピー」節を統合)。
  const locHead = p.copyCount > 1 ? `📂 保管場所（コピー×${p.copyCount}・無駄 ${mb(p.wastedBytes)}）` : '📂 保管場所（ライブラリ内）';
  const locList = (locations.length ? locations : p.copies.map(c => ({ label: '', sub: '', full: c, root: '' })));
  const copies = `<h3>${locHead}</h3><div class="locs">` +
    locList.map(l => `<div class="loc">${l.label ? `<span class="libchip" title="ライブラリ根: ${esc(l.root)}">📁 ${esc(l.label)}</span>` : ''}<span class="locpath">${esc(l.full)}</span></div>`).join('') +
    `</div>`;
  const gal = gallery.length ? `<div class="gallery">${gallery.map(g => `<img src="${g}" loading="lazy">`).join('')}</div>` : `<div class="none">preview.png なし</div>`;
  const verSec = versions.length
    ? `<h3>🔀 別の版がライブラリにあります（${versions.length}）</h3><div class="copies">` +
      versions.map(v => `<div class="cp">${esc(v.name)}${v.installed ? ' <span class="chip">導入中</span>' : ''}</div>`).join('') +
      `<div class="none" style="margin-top:6px">同名/類似名で中身(GUID)が違う＝更新版や別バリエーションの可能性。</div></div>`
    : '';
  // BOOTH商品情報(紐付けがあれば)。保存済みメタのみ。「BOOTHで開く」は外部ブラウザへ(setWindowOpenHandler経由)。
  const boothSec = booth
    ? `<div class="boothinfo">` +
      `<div class="brow"><span class="bk">作者</span> ${esc(booth.creator || '?')}</div>` +
      `<div class="brow"><span class="bk">種別</span> ${esc(booth.typeLabel)}${adult ? ' ・ <span class="r18">R-18</span>' : ''}</div>` +
      (booth.publishedAt ? `<div class="brow"><span class="bk">公開</span> ${new Date(booth.publishedAt).toISOString().slice(0, 10)}</div>` : '') +
      (booth.tags.length ? `<div class="brow"><span class="bk">タグ</span> ${booth.tags.slice(0, 12).map(t => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : '') +
      (booth.itemUrl ? `<div class="brow"><a class="booth-open" href="${esc(booth.itemUrl)}" target="_blank" rel="noopener">BOOTHで開く ↗</a></div>` : '') +
      `<div class="bnote">取得元: ${esc(booth.source)}${booth.placeholder ? ' ・ メタ未取得（「🛒 BOOTHメタ補完」で公開情報を取得）' : ''}</div>` +
      `</div>`
    : '';

  return `<div class="dgrid">` +
    `<div class="dleft">${heroBox}${strip}<div class="dacts">${view3d}${genBtn}${preimport}</div></div>` +
    `<div class="dright">` +
      `<h2>${booth ? esc(booth.name) : esc(r.file_name)} ${dup}</h2>` +
      `<div class="meta">${catBadge(p.category)} ${mb(r.size_bytes)} ・ ${r.file_count} files ・ preview ${r.preview_pct}%${prefabCount > 1 ? ` ・ <span class="pfab" title="複数プレハブ入り。3Dを生成すると各プレハブを切り替えて見られます">🧩 プレハブ${prefabCount}個</span>` : ''}</div>${shaderBadges(r)}` +
      `<div class="dfn">${esc(r.file_name)}</div>` +
      boothSec +
      `<h3>🎯 導入先（取り込み後の追跡）</h3>${inst}` +
      copies + verSec +
    `</div>` +
  `</div>` +
  `<h3>中身（ファイル構成・100%表示）</h3><div class="tree">${treeHtml}</div>` +
  `<h3>プレビュー画像（${gallery.length}）</h3>${gal}` +
  `<div class="chips" style="margin-top:8px">${chips}</div>`;
}

function renderApp(data: { card: string; detail: string; name: string; tags: string; sig: string; category: string; sizeBytes: number; copyCount: number; filePath: string; fav: boolean; proj: string }[], count: number, projList: { key: string; path: string; name: string; count: number }[] = []): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const projectCount = projList.length;
  // サイドバー/インサイトの件数は生成時に data から集計(=正確・追加IPC/フレーム跨ぎ同期なし)。tags は空白区切りの素文字列。
  const hasTag = (t: string, tag: string) => (' ' + t + ' ').includes(' ' + tag + ' ');
  const catCount = (c: string) => data.filter(d => d.category === c).length;
  const sl = {
    dup: data.filter(d => hasTag(d.tags, 'dup')).length,
    installed: data.filter(d => hasTag(d.tags, 'installed')).length,
    notinstalled: data.filter(d => hasTag(d.tags, 'notinstalled')).length,
    shader: data.filter(d => hasTag(d.tags, 'poiyomi') || hasTag(d.tags, 'liltoon')).length,
    nobooth: data.filter(d => !hasTag(d.tags, 'booth')).length,
  };
  const favCount = data.filter(d => d.fav).length;
  const CATS: [string, string][] = [['model', '3Dモデル'], ['tool', 'ツール'], ['animation', 'アニメ'], ['material', 'マテリアル'], ['other', 'その他']];
  const scopeRows = `<button class="srow scope on" data-scope="">すべて<span class="c">${count}</span></button>` +
    CATS.map(([c, label]) => { const n = catCount(c); return n ? `<button class="srow scope" data-scope="cat-${c}">${label}<span class="c">${n}</span></button>` : ''; }).join('');
  const slRow = (key: string, label: string, n: number) => n ? `<button class="srow sl" data-sl="${key}">${label}<span class="c">${n}</span></button>` : '';
  const insight = `${count}商品` + (projectCount ? ` ・ 🎯 ${projectCount}プロジェクトに導入追跡` : '') + (sl.dup ? ` ・ ⧉ ${sl.dup}件の重複` : '') + (sl.shader ? ` ・ 🟣 ${sl.shader}件 要シェーダ` : '');
  return `<!doctype html><!--hangar-catalog v=2 feat=proj+lib+prefab--><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hangar カタログ</title><style>
:root{color-scheme:dark}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{background:#16161a;color:#e8e8ea;font-family:system-ui,'Segoe UI',sans-serif}
/* レイアウト: 左サイドバー(iframe内) + メイン(トップバー/インサイト/グリッド/詳細) */
#wrap{display:flex;height:100%}
#side{flex:0 0 232px;width:232px;background:#1b1b20;border-right:1px solid #2a2a32;overflow:auto;padding:8px 6px}
#main{flex:1 1 auto;min-width:0;overflow:auto;position:relative}
.srow{display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%;text-align:left;background:none;border:0;color:#cfcfd6;padding:6px 10px;border-radius:7px;cursor:pointer;font-size:13px;line-height:1.3}
.srow:hover{background:#23232b}
.srow.on{background:#4a6cf7;color:#fff}
.srow .c{font-size:11px;color:#888;flex:0 0 auto}
.srow.on .c{color:#dfe6ff}
.srow.act{color:#9fb0e8}
.srow.prim{background:#23314f;color:#cfe0ff;margin:2px 0 4px;font-weight:600}
.srow.prim:hover{background:#2c3e63}
.sgrp{font-size:11px;color:#777;padding:11px 10px 3px;margin-top:2px}
.srow.proj{color:#c7cdda;font-size:12px;padding:5px 10px 5px 14px}
.srow.proj .c{background:#2a2a32;border-radius:9px;padding:0 6px;min-width:18px;text-align:center;color:#9aa}
.srow.proj.on .c{background:#3a4c86;color:#dfe6ff}
.sempty{font-size:10.5px;color:#6a6a72;padding:4px 12px 6px;line-height:1.5}
.sfoot{font-size:10px;color:#6a6a72;padding:12px 10px;line-height:1.6;border-top:1px solid #2a2a32;margin-top:10px}
#topbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:11px 18px;border-bottom:1px solid #2a2a32;position:sticky;top:0;background:#16161a;z-index:6}
#topbar select{background:#23232b;border:1px solid #3a3a44;color:#ddd;border-radius:7px;padding:6px 8px;font-size:12px;cursor:pointer}
.pop{position:relative}
.popbtn{background:#23232b;border:1px solid #3a3a44;color:#ddd;border-radius:7px;padding:6px 10px;font-size:12px;cursor:pointer}
.popbtn.active{background:#4a6cf7;color:#fff;border-color:#4a6cf7}
.facetpop{position:absolute;top:112%;left:0;background:#1e1e24;border:1px solid #3a3a44;border-radius:8px;padding:6px 10px;display:none;z-index:9;min-width:150px;box-shadow:0 10px 28px #0008}
.facetpop.open{display:block}
.facetpop label{display:flex;gap:8px;align-items:center;font-size:12px;padding:4px 2px;cursor:pointer;color:#cfcfd6}
#insight{padding:8px 18px;color:#cfcfd6;font-size:12px;background:#1a1a20;border-bottom:1px solid #2a2a32}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px;padding:18px}
body.compact .grid{grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;padding:12px}
.card{position:relative;background:#1e1e24;border:1px solid #2a2a32;border-radius:10px;overflow:hidden;cursor:pointer;transition:border-color .1s}
.card:hover{border-color:#4a6cf7}
.genbtn{position:absolute;top:6px;right:70px;background:#4a6cf7e6;border:0;color:#fff;border-radius:7px;padding:4px 8px;font-size:13px;cursor:pointer;opacity:.5;transition:opacity .12s;z-index:2}
.card:hover .genbtn,.card:focus-within .genbtn,.genbtn:focus{opacity:1}
.genbtn:hover{background:#5a78ff}
.pcbtn{position:absolute;top:6px;right:38px;background:#3a2f23e6;border:0;color:#e7c89a;border-radius:7px;padding:4px 8px;font-size:13px;cursor:pointer;opacity:.5;transition:opacity .12s;z-index:2}
.card:hover .pcbtn,.card:focus-within .pcbtn,.pcbtn:focus{opacity:1}
.pcbtn:hover{background:#4a3d2c}
.favbtn{position:absolute;top:6px;right:6px;background:#00000066;border:0;color:#fff;border-radius:99px;width:26px;height:24px;font-size:14px;line-height:1;cursor:pointer;z-index:2;padding:0}
.favbtn.on{color:#ff6b8a}
.favbtn:hover{background:#000000aa}
.genbtn-d{background:#4a6cf7;color:#fff;border:0;border-radius:8px;padding:9px 16px;font-size:13px;cursor:pointer;margin-left:10px}
.genbtn-d:hover{background:#5a78ff}
body.no-render .genbtn{opacity:.32;filter:grayscale(1)}
body.no-render .genbtn-d{opacity:.6;filter:grayscale(.7)}
body.no-render .genbtn-d::after{content:'（要 Unity 2022.3 + lilToon）';font-size:11px;opacity:.95;margin-left:4px}
.thumb{aspect-ratio:1/1;background:#0e0e12;display:flex;align-items:center;justify-content:center;position:relative}
.catb{position:absolute;top:6px;left:6px;font-size:11px;padding:2px 7px;border-radius:6px;font-weight:600;z-index:2}
.cat-model{background:#234a3ae6;color:#9ae7c2}.cat-tool{background:#4a3a23e6;color:#e7c89a}
.cat-animation{background:#3a2a4ae6;color:#c3b6ff}.cat-material{background:#23354ae6;color:#9ac2e7}.cat-other{background:#2a2a32e6;color:#9a9aa2}
.thumb img{width:100%;height:100%;object-fit:contain}
.thumb img.cover{object-fit:cover}
.thumb img.nsfw{filter:blur(22px) brightness(.82)}
.thumb img.nsfw.revealed{filter:none}
.nsfwtag{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);background:#000000b0;color:#fff;border:1px solid #ffffff55;border-radius:8px;padding:6px 11px;font-size:12px;cursor:pointer;z-index:3}
.ph{width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px}
.ph .phn{font-size:30px;font-weight:800;opacity:.55;line-height:1}
.ph .phl{font-size:11px;opacity:.6}
.noimg{color:#555;font-size:12px}
.cbody{padding:10px 12px}
.name{font-size:13px;font-weight:600;line-height:1.3;word-break:break-all}
.meta{color:#9a9aa2;font-size:11px;margin:4px 0 6px}
.cb{font-size:11px;color:#7fb88a}.cb.none{color:#666}
.dup{background:#5a2330;color:#ff9aa8;font-size:10px;padding:1px 7px;border-radius:99px;white-space:nowrap}
.shbadges{margin:4px 0 2px;display:flex;flex-wrap:wrap;gap:4px}
.sh{font-size:10px;padding:1px 7px;border-radius:99px;font-weight:600}
.sh.poi{background:#2d2350;color:#c3b6ff}.sh.lil{background:#234a3a;color:#9ae7c2}.sh.lock{background:#4a3a23;color:#e7c89a}
.booth{margin-top:5px;font-size:11px;color:#d8b48a;background:#3a2f23;border:1px solid #4a3a28;border-radius:6px;padding:2px 8px;display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.boothinfo{background:#221c16;border:1px solid #3a2f23;border-radius:8px;padding:12px 14px;font-size:13px;max-width:560px}
.brow{padding:3px 0;border-bottom:1px solid #2a241c;line-height:1.7}
.bk{display:inline-block;min-width:54px;color:#9a8a72;font-size:12px}
.booth-open{display:inline-block;margin-top:8px;background:#d8884a;color:#fff;text-decoration:none;padding:7px 14px;border-radius:8px;font-size:12px}
.booth-open:hover{background:#e89a5a}
.bnote{margin-top:8px;color:#8a7a62;font-size:11px}
.searchwrap{display:flex;gap:10px;align-items:center;margin-top:8px}
#q{flex:0 0 320px;max-width:60%;background:#1e1e24;border:1px solid #3a3a44;color:#e8e8ea;border-radius:8px;padding:8px 12px;font-size:13px}
.filters{display:flex;gap:6px}
.filters button{background:#23232b;color:#bdbdc6;border:1px solid #2f2f39;border-radius:99px;padding:4px 12px;font-size:11px;cursor:pointer}
.filters button.on{background:#4a6cf7;color:#fff;border-color:#4a6cf7}
#count{color:#888;font-size:12px}
.chip{background:#2a2a34;color:#bdbdc6;font-size:10px;padding:1px 6px;border-radius:99px;margin:0 4px 4px 0;display:inline-block}
.chips{margin-top:4px}
/* Phase3: 詳細は右スライドオーバー(グリッドは背後に残る)・2カラム・BOOTH画像カルーセル */
#backdrop{position:fixed;inset:0;background:#0007;z-index:19;display:none}
#backdrop.open{display:block}
.detail{position:fixed;top:0;right:0;width:min(880px,96%);height:100%;overflow:auto;background:#16161a;border-left:1px solid #2a2a32;box-shadow:-14px 0 44px #0009;padding:16px 22px;z-index:20;transform:translateX(100%);transition:transform .18s ease}
.detail.open{transform:translateX(0)}
.dgrid{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);gap:20px;align-items:start;margin-top:8px}
.dleft{position:sticky;top:0}
.dhero2{aspect-ratio:1/1;background:#0e0e12;border-radius:10px;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center}
.dmainimg{width:100%;height:100%;object-fit:contain}
.dmainimg.nsfw{filter:blur(26px) brightness(.82)}
.dmainimg.nsfw.revealed{filter:none}
.dstrip{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.dsth{width:56px;height:56px;object-fit:cover;background:#0e0e12;border:1px solid #2a2a32;border-radius:6px;cursor:pointer;opacity:.7}
.dsth:hover{opacity:1}.dsth.on{border-color:#4a6cf7;opacity:1}
.dsth.nsfw{filter:blur(10px) brightness(.82)}.dsth.nsfw.revealed{filter:none}
.dacts{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.btnpre{background:#3a2f23;color:#e7c89a;border:1px solid #5a4a2a;border-radius:8px;padding:9px 14px;font-size:13px;cursor:pointer}
.btnpre:hover{background:#4a3d2c}
.dright .catb{position:static;display:inline-block}
.dfn{color:#8a8a92;font-size:11px;word-break:break-all;margin:2px 0 4px;font-family:ui-monospace,Consolas,monospace}
.r18{color:#ff9aa8;font-weight:600}
@media(max-width:720px){.dgrid{grid-template-columns:1fr}.dleft{position:static}}
.back{background:#2a2a34;color:#ddd;border:1px solid #3a3a44;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px;margin-bottom:14px}
.back:hover{background:#33333e}
.detail h2{margin:0 0 6px;font-size:18px;word-break:break-all}
.detail h3{margin:22px 0 8px;font-size:13px;color:#9aa;border-bottom:1px solid #2a2a32;padding-bottom:4px}
.none{color:#777;font-size:12px}
.ledger{border-collapse:collapse;width:100%;font-size:12px}
.ledger th{text-align:left;color:#888;font-weight:500;padding:4px 8px;border-bottom:1px solid #2a2a32}
.ledger td{padding:4px 8px;border-bottom:1px solid #222228}
.ledger .pct{color:#7fb88a}.ledger .pth{color:#888;font-size:11px;word-break:break-all}
.tree{font-size:12px;font-family:ui-monospace,Consolas,monospace;line-height:1.6;max-height:420px;overflow:auto;background:#121216;border:1px solid #2a2a32;border-radius:8px;padding:10px}
.tree details>summary{cursor:pointer;list-style:none}
.tree details>summary::-webkit-details-marker{display:none}
.tree details>summary:before{content:'▸ ';color:#777}
.tree details[open]>summary:before{content:'▾ '}
.tree .tch{padding-left:16px;border-left:1px solid #2a2a32;margin-left:4px}
.tree .c{color:#666;font-size:10px}
.tree .f{padding-left:16px;color:#cfcfd6}
.tree .k{font-size:9px;padding:0 5px;border-radius:99px;background:#2a2a34;color:#9aa;margin-right:4px}
.tree .k-model{background:#3a2d5a;color:#c9b6ff}.tree .k-texture{background:#2d4a3a;color:#a6e7c2}
.tree .k-material{background:#4a3a2d;color:#e7cba6}.tree .k-prefab{background:#2d3a4a;color:#a6c9e7}
.tree .k-script{background:#4a2d3a;color:#e7a6c2}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px}
.gallery img{width:100%;aspect-ratio:1/1;object-fit:contain;background:#0e0e12;border-radius:6px}
.btn3d{display:inline-block;background:#4a6cf7;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-size:13px}
.btn3d:hover{background:#5a78ff}
.copies{font-size:11px;font-family:ui-monospace,Consolas,monospace}
.cp{color:#cfcfd6;padding:2px 0;border-bottom:1px solid #222228;word-break:break-all}
/* カード: 保管場所(どのライブラリか)＋プレハブ数チップ */
.librow{font-size:11px;color:#8a93a6;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pfab{color:#c6a6e7}
/* 詳細: 保管場所リスト(ライブラリchip＋フルパス) */
.locs{display:flex;flex-direction:column;gap:5px}
.loc{display:flex;align-items:baseline;gap:8px;padding:3px 0;border-bottom:1px solid #222228}
.libchip{flex:0 0 auto;background:#25303f;color:#a6c9e7;border-radius:6px;padding:1px 7px;font-size:11px}
.locpath{color:#b9bcc6;font-size:11px;font-family:ui-monospace,Consolas,monospace;word-break:break-all}
footer{color:#666;font-size:11px;padding:10px 24px;border-top:1px solid #2a2a32}
</style></head><body>
<div id="wrap">
<aside id="side">
  <button class="srow act prim" data-act="scan">＋ ライブラリを取り込む</button>
  <div class="sgrp">ライブラリ（種類）</div>
  ${scopeRows}
  <div class="sgrp">気になるもの</div>
  ${slRow('dup', '⚠ 二重買いかも', sl.dup)}
  ${slRow('notinstalled', '🆕 まだ入れてない', sl.notinstalled)}
  ${slRow('installed', '✅ 導入済', sl.installed)}
  ${slRow('shader', '🟣 シェーダ要注意', sl.shader)}
  ${slRow('nobooth', '🛒 BOOTH情報なし', sl.nobooth)}
  <div class="sgrp">マイリスト</div>
  <button class="srow sl" data-sl="fav">♡ お気に入り<span class="c" id="favc">${favCount}</span></button>
  <button class="srow act" data-act="template-save">💾 セットアップを保存</button>
  <button class="srow act" data-act="template-restore">♻ テンプレを復元</button>
  <div class="sgrp">プロジェクト</div>
  <button class="srow act" data-act="detect">＋ プロジェクトを登録</button>
  ${projList.length
    ? projList.map(p => `<button class="srow proj" data-project="${esc(p.key)}" title="${esc(p.path)}">📁 ${esc(p.name)}<span class="c">${p.count}</span></button>`).join('')
    : `<div class="sempty">まだ登録なし — 「＋ プロジェクトを登録」で Unity プロジェクトを追加すると、ここに一覧が出て導入済み商品を絞り込めます。</div>`}
  <button class="srow act" data-act="compare">🔀 見くらべる・整理</button>
  <div class="sgrp">もっと</div>
  <button class="srow act" data-act="importAe">📥 他ツールから取込</button>
  <button class="srow act" data-act="enrich">🛒 BOOTHメタ補完</button>
  <button class="srow act" data-act="rescan">🔄 再スキャン</button>
  <div class="sfoot">🛒 公開BOOTHのサムネ・商品情報を取得して表示（ログイン不要）。購入ファイルは送信しません・ローカル読み取り専用。</div>
</aside>
<main id="main">
  <div id="topbar">
    <input id="q" type="search" placeholder="商品名・作者で検索…">
    <select id="sort" title="並び替え"><option value="name">名前順</option><option value="size">サイズが大きい順</option><option value="dup">重複が多い順</option></select>
    <select id="density" title="表示密度"><option value="comfortable">標準表示</option><option value="compact">密に表示</option></select>
    <div class="pop"><button id="facetbtn" class="popbtn" title="複数条件のAND絞り込み">絞り込み ▾</button>
      <div id="facetpop" class="facetpop">
        <label><input type="checkbox" data-facet="installed">導入済</label>
        <label><input type="checkbox" data-facet="notinstalled">未導入</label>
        <label><input type="checkbox" data-facet="dup">重複あり</label>
        <label><input type="checkbox" data-facet="poiyomi">要Poiyomi</label>
        <label><input type="checkbox" data-facet="liltoon">要lilToon</label>
        <label><input type="checkbox" data-facet="locked">ロック済</label>
        <label><input type="checkbox" data-facet="booth">BOOTH紐付</label>
      </div>
    </div>
    <span id="count"></span>
  </div>
  <div id="insight">${insight}</div>
  <div id="grid" class="grid"></div>
  <div id="backdrop"></div>
  <div id="detail" class="detail"></div>
  <footer>preview.png は作者環境で生成された参考画像。忠実プレビューは方式A（裏でUnity焼き）で別途生成。クリックで詳細。 ・ 🛒公開BOOTHのサムネ/情報を取得（購入ファイルは送信しません・読み取り専用）。</footer>
</main>
</div>
<script>
const DATA = ${json};
const grid = document.getElementById('grid'), detail = document.getElementById('detail');
const q = document.getElementById('q'), countEl = document.getElementById('count');
// ♡ お気に入り: sig集合を client で保持(トグルは楽観更新＝重い再生成なし、永続はhangar-favで親へ)。
const favSet = new Set(DATA.filter(function(d){return d.fav;}).map(function(d){return d.sig;}));
let scope = '', smart = '', sortKey = 'name', density = 'comfortable', facets = [], projFilter = '';
let CUR = -1;
const sortSel = document.getElementById('sort'), densSel = document.getElementById('density');
const facetbtn = document.getElementById('facetbtn'), facetpop = document.getElementById('facetpop');
const mainEl = document.getElementById('main');
// 状態保持: 再スキャン/検出/3D生成のたびに iframe が再読込されても 検索/絞り込み/並び/密度/詳細/スクロール を復元する。
const SKEY = 'hangar-cat-state';
var backdrop = document.getElementById('backdrop');
function saveState(){ try{ localStorage.setItem(SKEY, JSON.stringify({ q:q.value, scope:scope, smart:smart, proj:projFilter, sortKey:sortKey, density:density, facets:facets, open:(detail.classList.contains('open')&&CUR>=0&&DATA[CUR])?DATA[CUR].sig:null, scroll:(mainEl?mainEl.scrollTop:0)||0 })); }catch(e){} }
// Phase3: 詳細は右スライドオーバー。グリッドは背後に残す(隠さない)。
function showGrid(){ detail.classList.remove('open'); if(backdrop)backdrop.classList.remove('open'); CUR=-1; saveState(); }
function showDetail(i){ CUR=i; detail.innerHTML='<button class="back" onclick="showGrid()">✕ 閉じる</button>'+DATA[i].detail; detail.classList.add('open'); if(backdrop)backdrop.classList.add('open'); detail.scrollTop=0; saveState(); }
// 商品を指定して3D生成を親(Electronシェル)へ依頼（名前入力不要）。sig=内容署名で厳密に対象を同定。
function hangarRender(i){ if(i==null||i<0||!DATA[i])return; try{ (window.parent||window).postMessage({type:'hangar-render', sig:DATA[i].sig, name:DATA[i].name}, '*'); }catch(e){} }
function hangarReveal(b){ var img=b.parentElement&&b.parentElement.querySelector('img.nsfw'); if(img) img.classList.add('revealed'); b.remove(); }
// 詳細のR-18一括表示(ヒーロー＋サムネストリップの .nsfw を全解除)。
function hangarRevealDetail(){ var d=document.getElementById('detail'); if(d) d.querySelectorAll('.nsfw').forEach(function(x){x.classList.add('revealed');}); }
// サイドバーのアクション行(スキャン/検出/テンプレ/比較/取込/補完/再スキャン)を親(シェル)へ委譲。
function hangarAction(a){ try{ (window.parent||window).postMessage({type:'hangar-action', action:a}, '*'); }catch(e){} }
// 詳細カルーセル: サムネクリックでメイン画像を差替。
function hangarSwap(el){ var m=document.getElementById('dmain'); if(m&&el&&el.dataset.full){ m.src=el.dataset.full; } var s=el&&el.parentElement; if(s)s.querySelectorAll('.dsth').forEach(function(x){x.classList.remove('on');}); if(el)el.classList.add('on'); }
// 取り込み前チェックを親(シェル)へ委譲。対象商品の.unitypackageパスを渡す(カード🛡/詳細🛡)。
function hangarDiff(i){ if(i==null||i<0||!DATA[i]||!DATA[i].filePath)return; try{ (window.parent||window).postMessage({type:'hangar-diff', path:DATA[i].filePath, name:DATA[i].name}, '*'); }catch(e){} }
// ♡ お気に入りトグル: client の favSet を即更新(カードの♡＋件数)し、親へ永続を依頼(重い再生成なし)。
function hangarFav(i){ if(i==null||i<0||!DATA[i])return; var sig=DATA[i].sig; var nowFav=!favSet.has(sig); if(nowFav)favSet.add(sig); else favSet.delete(sig); DATA[i].fav=nowFav;
  var card=grid.querySelector('.card[data-sig="'+sig+'"]'); if(card){ var b=card.querySelector('.favbtn'); if(b){ b.classList.toggle('on',nowFav); b.textContent=nowFav?'♥':'♡'; } }
  var fc=document.getElementById('favc'); if(fc)fc.textContent=favSet.size;
  if(smart==='fav')applyFilter();
  try{ (window.parent||window).postMessage({type:'hangar-fav', sig:sig, fav:nowFav}, '*'); }catch(e){}
}
addEventListener('message',function(e){var m=e.data;if(m&&m.type==='hangar-caps'){document.body.classList.toggle('no-render', m.canRender===false);}});
grid.innerHTML = DATA.map((d,i)=>'<div class="card" data-name="'+d.name.toLowerCase().replace(/"/g,'&quot;')+'" data-tags="'+d.tags+'" data-proj="'+(d.proj||'')+'" data-sig="'+d.sig+'" onclick="showDetail('+i+')">'+d.card+'<button class="favbtn'+(d.fav?' on':'')+'" title="お気に入り" onclick="event.stopPropagation();hangarFav('+i+')">'+(d.fav?'♥':'♡')+'</button><button class="pcbtn" title="取り込み前チェック(既存プロジェクトとの衝突/ピンク危険)" onclick="event.stopPropagation();hangarDiff('+i+')">🛡</button>'+(d.category==='model'?'<button class="genbtn" title="この商品を3D生成（忠実プレビューを焼く）" onclick="event.stopPropagation();hangarRender('+i+')">🎬</button>':'')+'</div>').join('');
if(backdrop) backdrop.addEventListener('click', showGrid);
// カタログ(iframe)にフォーカスがある時の Ctrl+K を親のコマンドパレットへ転送(shell側は自frameしか拾えないため)。
document.addEventListener('keydown',function(e){ if(e.ctrlKey&&!e.shiftKey&&!e.altKey&&(e.key==='k'||e.key==='K')){ e.preventDefault(); hangarAction('palette'); } });
const cards = [...grid.children];
function matchSmart(c){
  if(!smart) return true;
  if(smart==='fav') return favSet.has(c.dataset.sig);
  var t=' '+c.dataset.tags+' ';
  if(smart==='shader') return t.includes(' poiyomi ')||t.includes(' liltoon ');
  if(smart==='nobooth') return !t.includes(' booth ');
  return t.includes(' '+smart+' ');
}
function applyFilter(){
  var term=q.value.trim().toLowerCase(); var shown=0;
  for(const c of cards){
    var okText=!term||c.dataset.name.includes(term);
    var okScope=!scope||(' '+c.dataset.tags+' ').includes(' '+scope+' ');
    var okProj=!projFilter||(' '+(c.dataset.proj||'')+' ').includes(' '+projFilter+' ');
    var vis=okText&&okScope&&okProj&&matchSmart(c);
    if(vis&&facets.length){ var ft=' '+c.dataset.tags+' '; for(var fi=0;fi<facets.length;fi++){ if(ft.indexOf(' '+facets[fi]+' ')<0){ vis=false; break; } } }
    c.style.display=vis?'':'none'; if(vis)shown++;
  }
  countEl.textContent=shown+' / '+cards.length+' 件';
}
function applySort(){
  var order=cards.map(function(_c,i){return i;});
  order.sort(function(a,b){
    var A=DATA[a],B=DATA[b];
    if(sortKey==='size') return (B.sizeBytes||0)-(A.sizeBytes||0)||A.name.localeCompare(B.name);
    if(sortKey==='dup') return (B.copyCount||0)-(A.copyCount||0)||A.name.localeCompare(B.name);
    return A.name.localeCompare(B.name);
  });
  order.forEach(function(i){ grid.appendChild(cards[i]); });
}
function setScope(s){ scope=s||''; document.querySelectorAll('.srow.scope').forEach(function(x){x.classList.toggle('on',x.dataset.scope===scope);}); }
function setSmart(s){ smart=(smart===s)?'':s; document.querySelectorAll('.srow.sl').forEach(function(x){x.classList.toggle('on',x.dataset.sl===smart);}); }
// プロジェクト絞り込み(トグル): そのプロジェクトに導入済みの商品だけ表示。もう一度押すと解除。
function setProj(k){ projFilter=(projFilter===k)?'':k; document.querySelectorAll('.srow.proj').forEach(function(x){x.classList.toggle('on',x.dataset.project===projFilter);}); }
document.querySelectorAll('.srow.scope').forEach(function(b){ b.addEventListener('click',function(){ setScope(b.dataset.scope); applyFilter(); saveState(); }); });
document.querySelectorAll('.srow.sl').forEach(function(b){ b.addEventListener('click',function(){ setSmart(b.dataset.sl); applyFilter(); saveState(); }); });
document.querySelectorAll('.srow.proj').forEach(function(b){ b.addEventListener('click',function(){ setProj(b.dataset.project); applyFilter(); saveState(); }); });
document.querySelectorAll('.srow.act').forEach(function(b){ b.addEventListener('click',function(){ hangarAction(b.dataset.act); }); });
q.addEventListener('input',function(){ applyFilter(); saveState(); });
if(sortSel) sortSel.addEventListener('change',function(){ sortKey=sortSel.value; applySort(); saveState(); });
if(densSel) densSel.addEventListener('change',function(){ density=densSel.value; document.body.classList.toggle('compact',density==='compact'); saveState(); });
// AND絞り込みpopover(上級・初期非表示)。scope/smart/検索とANDで重ねる。
function syncFacets(){ facets=[]; if(facetpop) facetpop.querySelectorAll('input[type=checkbox]').forEach(function(x){ if(x.checked) facets.push(x.dataset.facet); }); if(facetbtn){ facetbtn.classList.toggle('active',facets.length>0); facetbtn.textContent=facets.length?('絞り込み '+facets.length):'絞り込み ▾'; } }
if(facetbtn) facetbtn.addEventListener('click',function(e){ e.stopPropagation(); if(facetpop) facetpop.classList.toggle('open'); });
if(facetpop) facetpop.querySelectorAll('input[type=checkbox]').forEach(function(x){ x.addEventListener('change',function(){ syncFacets(); applyFilter(); saveState(); }); });
document.addEventListener('click',function(e){ if(facetpop&&facetpop.classList.contains('open')&&!facetpop.contains(e.target)&&e.target!==facetbtn){ facetpop.classList.remove('open'); } });
var _scrollT; if(mainEl) mainEl.addEventListener('scroll',function(){ clearTimeout(_scrollT); _scrollT=setTimeout(saveState,200); });
// 読込時の復元: 検索/絞り込み/並び/密度を当て、#open=sig(3D生成後の復帰)を最優先、無ければ前回の詳細/スクロール。
(function restore(){
  var st=null; try{ st=JSON.parse(localStorage.getItem(SKEY)||'null'); }catch(e){}
  if(st){
    if(st.q)q.value=st.q;
    // scope/smart は対応するサイドバー行が今も存在する時だけ復元する。件数が0になって行が消えた状態に
    // 固着するとグリッドが全消え(=ライブラリが消えたように見える)ため、行が無ければ解除にフォールバック。
    if(st.scope!=null){ var sb=document.querySelector('.srow.scope[data-scope="'+st.scope+'"]'); setScope(sb?st.scope:''); }
    if(st.smart){ var sm=document.querySelector('.srow.sl[data-sl="'+st.smart+'"]'); if(sm){ smart=st.smart; document.querySelectorAll('.srow.sl').forEach(function(x){x.classList.toggle('on',x.dataset.sl===smart);}); } else { smart=''; } }
    // プロジェクト絞り込みは、そのプロジェクト行が今も在る時だけ復元(登録解除/再スキャンで消えたら固着させない)。
    if(st.proj){ var pj=document.querySelector('.srow.proj[data-project="'+st.proj+'"]'); if(pj){ projFilter=st.proj; pj.classList.add('on'); } else { projFilter=''; } }
    if(st.sortKey){ sortKey=st.sortKey; if(sortSel)sortSel.value=sortKey; }
    if(st.density){ density=st.density; if(densSel)densSel.value=density; document.body.classList.toggle('compact',density==='compact'); }
    if(st.facets&&st.facets.length&&facetpop){ st.facets.forEach(function(f){ var cb=facetpop.querySelector('input[data-facet="'+f+'"]'); if(cb)cb.checked=true; }); syncFacets(); }
  }
  applySort(); applyFilter();
  // スライドオーバーはグリッドを隠さないので、詳細を開く前に背後グリッドのスクロールを先に復元する。
  if(st&&st.scroll&&mainEl){ mainEl.scrollTop=st.scroll; }
  var hm=/^#open=(.+)$/.exec(location.hash||''); var hs=hm?decodeURIComponent(hm[1]):null;
  if(hs){ var i=DATA.findIndex(function(d){return d.sig===hs;}); if(i>=0){ showDetail(i); return; } }
  if(st&&st.open){ var j=DATA.findIndex(function(d){return d.sig===st.open;}); if(j>=0){ showDetail(j); } }
})();
</script></body></html>`;
}

// テンプレ機能が要る形にカタログ行を整形（id/名前/パス/GUID集合/シェーダ要件）。
function buildCatalogPkgs(cat: Catalog): CatalogPkg[] {
  return cat.allPackages().map(r => ({
    id: r.id, file_name: r.file_name, file_path: r.file_path,
    guids: JSON.parse(r.guids_json) as string[],
    requires_liltoon: r.requires_liltoon, requires_poiyomi: r.requires_poiyomi, has_locked: r.has_locked,
    category: r.category,
  }));
}

function fail(msg: string): void {
  console.error(msg);
  process.exitCode = 1;
}

main().catch(err => { console.error(err); process.exitCode = 1; });
