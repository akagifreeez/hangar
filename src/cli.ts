// Hangar v0.1 CLI — scan / list / search / detect / installs / catalog
import { cpus } from 'node:os';
import { basename, join, dirname, relative } from 'node:path';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { guidSetHash } from './sig.js';
import { Catalog, type PackageRow, type Product, type CompareProduct } from './db.js';
import { scanDir } from './scan.js';
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
          const viewerHref = viewerPath && existsSync(viewerPath) ? relative(outDir, viewerPath).replace(/\\/g, '/') : '';
          // 複数prefab: previews.json の各サムネ(preview{i}.png)を相対参照で拾う(dataURI化せずカタログ肥大を避ける)
          let prefabThumbs: string[] = [];
          if (renderDir) {
            const pj = join(renderDir, 'previews.json');
            if (existsSync(pj)) {
              try {
                const arr = JSON.parse(readFileSync(pj, 'utf8')) as { thumb?: string }[];
                prefabThumbs = arr.map(a => a.thumb ? relative(outDir, join(renderDir, a.thumb)).replace(/\\/g, '/') : '').filter(Boolean);
              } catch { /* previews.json壊れ等は無視 */ }
            }
          }
          const tags = [r.requires_poiyomi ? 'poiyomi' : '', r.requires_liltoon ? 'liltoon' : '', r.has_locked ? 'locked' : '', prod.projects.length ? 'installed' : 'notinstalled', prod.copyCount > 1 ? 'dup' : '', `cat-${prod.category}`].filter(Boolean).join(' ');
          // tags/category は固定語彙だが、data-tags 属性へ素で埋めるため念のためエスケープ(DOM注入の多層防御)。
          return { card: renderCard(prod, cover), detail: renderDetail(prod, tree, gallery, { heroUri, viewerHref, prefabThumbs }), name: r.file_name, tags: esc(tags), sig: prod.sig, category: esc(prod.category) };
        });
        writeFileSync(out, renderApp(data, products.length), 'utf8');
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
        console.log('  detect [--save] <projectDir...>  導入済みか逆引き（--saveで記録）');
        console.log('  installs                         パッケージ→導入先一覧（重複導入警告）');
        console.log('  catalog [out.html]               カタログ(クリックで詳細: 中身/プレビュー/導入台帳)を生成');
        console.log('  version                          バージョンを表示');
        if (cmd) process.exitCode = 1;   // 不明コマンドは失敗扱い(typoが即発覚)
        break;
      }
    }
  } finally {
    cat.close();
  }
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

function renderCard(p: Product, cover: string): string {
  const r = p.rep;
  const dup = p.copyCount > 1 ? `<span class="dup">コピー×${p.copyCount}・無駄${mb(p.wastedBytes)}</span>` : '';
  const badge = p.projects.length ? `<div class="cb">導入 ${p.projects.length}プロジェクト</div>` : `<div class="cb none">未導入</div>`;
  const thumb = cover ? `<img src="${cover}" loading="lazy">` : `<div class="noimg">no preview</div>`;
  return `<div class="thumb">${catBadge(p.category)}${thumb}</div><div class="cbody"><div class="name">${esc(r.file_name)} ${dup}</div>` +
    `<div class="meta">${mb(r.size_bytes)} ・ ${r.file_count} files ・ prev ${r.preview_pct}%</div>${shaderBadges(r)}${badge}</div>`;
}

function renderDetail(p: Product, treeHtml: string, gallery: string[], render: { heroUri: string; viewerHref: string; prefabThumbs?: string[] }): string {
  const r = p.rep;
  const kinds = JSON.parse(r.kind_breakdown) as Record<string, number>;
  const chips = Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span class="chip">${esc(k)} ${v}</span>`).join('');
  const hero = gallery[0] ?? '';
  const dup = p.copyCount > 1 ? `<span class="dup">コピー×${p.copyCount}</span>` : '';
  // 🎬 生成ボタン/忠実プレビュー欄は「3Dモデル」のみ(シェーダ/SDK/アニメは3Dプレビュー対象外)。
  // ただし既に焼いた成果物があるならカテゴリに関わらず表示する。
  const genBtn = p.category === 'model'
    ? `<button class="genbtn-d" onclick="hangarRender(CUR)" title="裏でUnity+lilToonを起動し、忠実プレビュー画像と3D(GLB)を生成します（数分）">🎬 ${render.heroUri ? '3Dを再生成' : 'この商品を3D生成'}</button>`
    : '';
  const thumbN = render.prefabThumbs ? render.prefabThumbs.length : 0;
  const ffthumbs = thumbN > 1
    ? `<div class="ffthumbs">${render.prefabThumbs!.map((t, i) => `<img class="ffth" src="${t}" loading="lazy" title="プレハブ ${i + 1}">`).join('')}</div>`
    : '';
  const countBadge = thumbN > 1 ? ` <span class="ffcount">プレハブ ${thumbN}体</span>` : '';
  const viewerLabel = thumbN > 1 ? `▶ 3Dで回す（${thumbN}体・切替可）` : '▶ 3Dで回す（GLB・Unity不要）';
  const faithful = render.heroUri
    ? `<h3>忠実プレビュー（方式A：本物のlilToonでUnity焼き）${countBadge}</h3><div class="faithful"><img class="ffimg" src="${render.heroUri}">` + ffthumbs +
      (render.viewerHref ? `<a class="btn3d" href="${render.viewerHref}" target="_blank" rel="noopener">${viewerLabel}</a>` : '') + genBtn + `</div>`
    : (p.category === 'model'
      ? `<h3>忠実プレビュー（方式A：本物のlilToonでUnity焼き）</h3><div class="faithful"><div class="none">まだ生成していません（Unity + lilToon があれば本物のシェーダで焼けます）。</div>${genBtn}</div>`
      : '');
  const inst = p.projects.length
    ? `<table class="ledger"><tr><th>プロジェクト</th><th>一致</th><th>パス</th></tr>` +
      p.projects.map(pr => `<tr><td>${esc(pr.name)}</td><td class="pct">${pr.pct}%</td><td class="pth">${esc(pr.path)}</td></tr>`).join('') + `</table>`
    : `<div class="none">どのプロジェクトにも導入されていません</div>`;
  const copies = p.copyCount > 1
    ? `<h3>重複コピー（${p.copyCount}個・無駄 ${mb(p.wastedBytes)} ＝1個残して削除可）</h3><div class="copies">` +
      p.copies.map(c => `<div class="cp">${esc(c)}</div>`).join('') + `</div>`
    : '';
  const gal = gallery.length ? `<div class="gallery">${gallery.map(g => `<img src="${g}" loading="lazy">`).join('')}</div>` : `<div class="none">preview.png なし</div>`;
  return `<div class="dhead">${hero ? `<img class="dhero" src="${hero}">` : ''}<div><h2>${esc(r.file_name)} ${dup}</h2>` +
    `<div class="meta">${catBadge(p.category)} ${mb(r.size_bytes)} ・ ${r.file_count} files ・ preview ${r.preview_pct}%</div>${shaderBadges(r)}<div class="chips">${chips}</div></div></div>` +
    faithful +
    `<h3>導入先（取り込み後の追跡）</h3>${inst}` +
    copies +
    `<h3>中身（ファイル構成・100%表示）</h3><div class="tree">${treeHtml}</div>` +
    `<h3>プレビュー画像（${gallery.length}）</h3>${gal}`;
}

function renderApp(data: { card: string; detail: string; name: string; tags: string; sig: string; category: string }[], count: number): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hangar カタログ</title><style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#16161a;color:#e8e8ea;font-family:system-ui,'Segoe UI',sans-serif}
header{padding:14px 20px;border-bottom:1px solid #2a2a32}
header h1{font-size:16px;margin:0 0 2px;font-weight:600}
header .sub{color:#888;font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;padding:18px}
.card{position:relative;background:#1e1e24;border:1px solid #2a2a32;border-radius:10px;overflow:hidden;cursor:pointer;transition:border-color .1s}
.card:hover{border-color:#4a6cf7}
.genbtn{position:absolute;top:6px;right:6px;background:#4a6cf7e6;border:0;color:#fff;border-radius:7px;padding:4px 8px;font-size:13px;cursor:pointer;opacity:.5;transition:opacity .12s;z-index:2}
.card:hover .genbtn,.card:focus-within .genbtn,.genbtn:focus{opacity:1}
.genbtn:hover{background:#5a78ff}
.genbtn-d{background:#4a6cf7;color:#fff;border:0;border-radius:8px;padding:9px 16px;font-size:13px;cursor:pointer;margin-left:10px}
.genbtn-d:hover{background:#5a78ff}
body.no-render .genbtn{opacity:.32;filter:grayscale(1)}
body.no-render .genbtn-d{opacity:.6;filter:grayscale(.7)}
body.no-render .genbtn-d::after{content:'（要 Unity 2022.3 + lilToon）';font-size:11px;opacity:.95;margin-left:4px}
.thumb{aspect-ratio:1/1;background:#0e0e12;display:flex;align-items:center;justify-content:center;position:relative}
.catb{position:absolute;top:6px;left:6px;font-size:11px;padding:2px 7px;border-radius:6px;font-weight:600;z-index:2}
.cat-model{background:#234a3ae6;color:#9ae7c2}.cat-tool{background:#4a3a23e6;color:#e7c89a}
.cat-animation{background:#3a2a4ae6;color:#c3b6ff}.cat-material{background:#23354ae6;color:#9ac2e7}.cat-other{background:#2a2a32e6;color:#9a9aa2}
.dhead .catb{position:static;display:inline-block}
.thumb img{width:100%;height:100%;object-fit:contain}
.noimg{color:#555;font-size:12px}
.cbody{padding:10px 12px}
.name{font-size:13px;font-weight:600;line-height:1.3;word-break:break-all}
.meta{color:#9a9aa2;font-size:11px;margin:4px 0 6px}
.cb{font-size:11px;color:#7fb88a}.cb.none{color:#666}
.dup{background:#5a2330;color:#ff9aa8;font-size:10px;padding:1px 7px;border-radius:99px;white-space:nowrap}
.shbadges{margin:4px 0 2px;display:flex;flex-wrap:wrap;gap:4px}
.sh{font-size:10px;padding:1px 7px;border-radius:99px;font-weight:600}
.sh.poi{background:#2d2350;color:#c3b6ff}.sh.lil{background:#234a3a;color:#9ae7c2}.sh.lock{background:#4a3a23;color:#e7c89a}
.searchwrap{display:flex;gap:10px;align-items:center;margin-top:8px}
#q{flex:0 0 320px;max-width:60%;background:#1e1e24;border:1px solid #3a3a44;color:#e8e8ea;border-radius:8px;padding:8px 12px;font-size:13px}
.filters{display:flex;gap:6px}
.filters button{background:#23232b;color:#bdbdc6;border:1px solid #2f2f39;border-radius:99px;padding:4px 12px;font-size:11px;cursor:pointer}
.filters button.on{background:#4a6cf7;color:#fff;border-color:#4a6cf7}
#count{color:#888;font-size:12px}
.chip{background:#2a2a34;color:#bdbdc6;font-size:10px;padding:1px 6px;border-radius:99px;margin:0 4px 4px 0;display:inline-block}
.chips{margin-top:4px}
.detail{padding:18px 24px;max-width:1100px}
.back{background:#2a2a34;color:#ddd;border:1px solid #3a3a44;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px;margin-bottom:14px}
.back:hover{background:#33333e}
.dhead{display:flex;gap:18px;align-items:flex-start;margin-bottom:6px}
.dhero{width:180px;height:180px;object-fit:contain;background:#0e0e12;border-radius:8px;flex:0 0 auto}
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
.faithful{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:4px}
.ffimg{width:260px;max-width:100%;border-radius:8px;background:#0e0e12}
.ffcount{font-size:12px;color:#9ae7c2;background:#234a3a;border-radius:99px;padding:1px 9px;margin-left:6px;vertical-align:middle}
.ffthumbs{display:flex;gap:6px;flex-wrap:wrap;align-items:center;width:100%;margin-top:4px}
.ffthumbs .ffth{width:72px;height:72px;object-fit:contain;background:#0e0e12;border:1px solid #2a2a32;border-radius:6px}
.btn3d{display:inline-block;background:#4a6cf7;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-size:13px}
.btn3d:hover{background:#5a78ff}
.copies{font-size:11px;font-family:ui-monospace,Consolas,monospace}
.cp{color:#cfcfd6;padding:2px 0;border-bottom:1px solid #222228;word-break:break-all}
footer{color:#666;font-size:11px;padding:10px 24px;border-top:1px solid #2a2a32}
</style></head><body>
<header><h1>Hangar</h1><div class="sub">VRChat .unitypackage カタログ ・ ${count} packages ・ VRChat非公式 / ローカル限定・再配布なし・変換やスクレイピングなし</div>
<div class="searchwrap">
  <input id="q" type="search" placeholder="名前で検索…">
  <div class="filters">
    <button data-f="all" class="on">すべて</button>
    <button data-f="cat-model">3Dモデル</button>
    <button data-f="cat-tool">ツール</button>
    <button data-f="cat-animation">アニメ</button>
    <button data-f="cat-material">マテリアル</button>
    <button data-f="installed">導入済</button>
    <button data-f="notinstalled">未導入</button>
    <button data-f="dup">重複あり</button>
    <button data-f="poiyomi">要Poiyomi</button>
    <button data-f="liltoon">要lilToon</button>
  </div>
  <span id="count"></span>
</div></header>
<div id="grid" class="grid"></div>
<div id="detail" class="detail" style="display:none"></div>
<footer>preview.png は作者環境で生成された参考画像。忠実プレビューは方式A（裏でUnity焼き）で別途生成。クリックで詳細（中身/プレビュー/導入台帳）。</footer>
<script>
const DATA = ${json};
const grid = document.getElementById('grid'), detail = document.getElementById('detail');
const q = document.getElementById('q'), countEl = document.getElementById('count');
let curFilter = 'all';
let CUR = -1;
// 状態保持: 再スキャン/検出/3D生成のたびに iframe が再読込されても 検索/フィルタ/開いてた詳細/スクロール を復元する。
const SKEY = 'hangar-cat-state';
function saveState(){ try{ localStorage.setItem(SKEY, JSON.stringify({ q: q.value, filter: curFilter, open: (detail.style.display!=='none' && CUR>=0 && DATA[CUR]) ? DATA[CUR].sig : null, scroll: window.scrollY||0 })); }catch(e){} }
function showGrid(){ detail.style.display='none'; grid.style.display='grid'; CUR=-1; saveState(); }
function showDetail(i){ CUR = i; detail.innerHTML = '<button class="back" onclick="showGrid()">← 一覧へ</button>' + DATA[i].detail; grid.style.display='none'; detail.style.display='block'; scrollTo(0,0); saveState(); }
// 商品を指定して3D生成を親(Electronシェル)へ依頼（名前入力不要）。sig=内容署名で厳密に対象を同定。
function hangarRender(i){ if(i==null||i<0||!DATA[i])return; try{ (window.parent||window).postMessage({type:'hangar-render', sig: DATA[i].sig, name: DATA[i].name}, '*'); }catch(e){} }
addEventListener('message',function(e){var m=e.data;if(m&&m.type==='hangar-caps'){document.body.classList.toggle('no-render', m.canRender===false);}});
grid.innerHTML =DATA.map((d,i)=>'<div class="card" data-name="'+d.name.toLowerCase().replace(/"/g,'&quot;')+'" data-tags="'+d.tags+'" onclick="showDetail('+i+')">'+d.card+(d.category==='model'?'<button class="genbtn" title="この商品を3D生成（忠実プレビューを焼く）" onclick="event.stopPropagation();hangarRender('+i+')">🎬</button>':'')+'</div>').join('');
const cards = [...grid.children];
function applyFilter(){
  const term = q.value.trim().toLowerCase();
  let shown = 0;
  for (const c of cards){
    const okText = !term || c.dataset.name.includes(term);
    const okTag = curFilter==='all' || (' '+c.dataset.tags+' ').includes(' '+curFilter+' ');
    const vis = okText && okTag;
    c.style.display = vis ? '' : 'none';
    if (vis) shown++;
  }
  countEl.textContent = shown + ' / ' + cards.length + ' 件';
}
q.addEventListener('input', ()=>{ applyFilter(); saveState(); });
for (const b of document.querySelectorAll('.filters button')){
  b.addEventListener('click', ()=>{
    document.querySelectorAll('.filters button').forEach(x=>x.classList.remove('on'));
    b.classList.add('on'); curFilter = b.dataset.f; applyFilter(); saveState();
  });
}
let _scrollT; addEventListener('scroll', ()=>{ clearTimeout(_scrollT); _scrollT=setTimeout(saveState, 200); });
// 読込時の復元: 保存していた検索/フィルタを当て、#open=sig(3D生成の結果復帰)を最優先、無ければ前回の詳細/スクロール。
(function restore(){
  let st=null; try{ st=JSON.parse(localStorage.getItem(SKEY)||'null'); }catch(e){}
  if (st){
    if (st.q) q.value = st.q;
    if (st.filter){ curFilter = st.filter; document.querySelectorAll('.filters button').forEach(x=>x.classList.toggle('on', x.dataset.f===curFilter)); }
  }
  applyFilter();
  var hm=/^#open=(.+)$/.exec(location.hash||''); var hs=hm?decodeURIComponent(hm[1]):null;
  if (hs){ var i=DATA.findIndex(function(d){return d.sig===hs;}); if(i>=0){ showDetail(i); return; } }
  if (st && st.open){ var j=DATA.findIndex(function(d){return d.sig===st.open;}); if(j>=0){ showDetail(j); return; } }
  if (st && st.scroll){ scrollTo(0, st.scroll); }
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
