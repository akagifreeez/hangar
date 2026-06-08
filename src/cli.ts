// Hangar v0.1 CLI — scan / list / search / detect / installs / catalog
import { basename, join, dirname, relative } from 'node:path';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Catalog, type PackageRow, type Product } from './db.js';
import { scanDir } from './scan.js';
import { projectGuids, matchPackages } from './detect.js';
import { diffImport, formatDiffText, formatDiffHtmlPage } from './diff.js';
import { saveTemplate, restoreTemplate, formatSaveText, formatRestoreText, type CatalogPkg } from './template.js';
import { renderPackage, findUnity, findLilToon, findPoiyomi } from './render.js';

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
        let failCount = 0;
        const res = await scanDir(dir, cat, cacheDir, (i, total, p, file, err) => {
          const name = basename(file);
          if (p) console.log(`  [${i}/${total}] ${name}  ${mb(p.sizeBytes)} files:${p.fileCount} prev:${p.fileCount ? Math.round(100 * p.previewCount / p.fileCount) : 0}%`);
          else {
            failCount++;
            const msg = err instanceof Error ? err.message : String(err ?? '');
            console.log(`  [${i}/${total}] ${name}  ⚠ parse失敗(スキップ): ${msg || '原因不明'}`);
          }
        });
        if (failCount) console.log(`⚠ ${failCount} 件が解析できませんでした（上の理由を確認）。書込先: ${dbPath} / cache: ${cacheDir}`);
        console.log(`scanned ${res.length} package(s) into ${dbPath}.`);
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
        const projects = args.filter(a => a !== '--save');
        if (!projects.length) return fail('usage: detect [--save] <projectDir> [projectDir...]');
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
          const tags = [r.requires_poiyomi ? 'poiyomi' : '', r.requires_liltoon ? 'liltoon' : '', r.has_locked ? 'locked' : '', prod.projects.length ? 'installed' : 'notinstalled', prod.copyCount > 1 ? 'dup' : ''].filter(Boolean).join(' ');
          return { card: renderCard(prod, cover), detail: renderDetail(prod, tree, gallery, { heroUri, viewerHref }), name: r.file_name, tags };
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
          const guids = (JSON.parse(r.guids_json) as string[]).slice().sort();
          const sig = createHash('md5').update(guids.join(',')).digest('hex');
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
        const query = args[0];
        if (!query) return fail('usage: render <package名の一部>');
        const matches = cat.allPackages().filter(r => r.file_name.toLowerCase().includes(query.toLowerCase()));
        if (!matches.length) return fail('該当パッケージなし: ' + query);
        const r = matches[0]!;
        const projectRoots = cat.allProjects().map(p => p.path);
        const unity = findUnity();
        if (!unity) return fail('Unity(2022.3系)が見つかりません');
        const lil = findLilToon(projectRoots);
        if (!lil) return fail('lilToon が見つかりません。VCC/ALCOMでlilToonを入れたプロジェクトを「プロジェクト検出」で登録するか、環境変数 HANGAR_LILTOON にパッケージのパスを指定してください');
        const poi = findPoiyomi(projectRoots);
        if (!poi) console.log('  ⚠ Poiyomi未検出 → Poiyomi系アバターはピンクになります(hangar/_shaders/com.poiyomi.toon を用意)');
        // レンダ成果物のキーは内容署名(GUID集合のmd5)。重複コピーでも安定し、カタログ詳細と必ず一致する。
        const hash = createHash('md5').update((JSON.parse(r.guids_json) as string[]).slice().sort().join(',')).digest('hex');
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
          console.log(`  OK hero:${res.hero} glb:${res.glb} -> cache/renders/${hash}/`);
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

function renderCard(p: Product, cover: string): string {
  const r = p.rep;
  const dup = p.copyCount > 1 ? `<span class="dup">コピー×${p.copyCount}・無駄${mb(p.wastedBytes)}</span>` : '';
  const badge = p.projects.length ? `<div class="cb">導入 ${p.projects.length}プロジェクト</div>` : `<div class="cb none">未導入</div>`;
  const thumb = cover ? `<img src="${cover}" loading="lazy">` : `<div class="noimg">no preview</div>`;
  return `<div class="thumb">${thumb}</div><div class="cbody"><div class="name">${esc(r.file_name)} ${dup}</div>` +
    `<div class="meta">${mb(r.size_bytes)} ・ ${r.file_count} files ・ prev ${r.preview_pct}%</div>${shaderBadges(r)}${badge}</div>`;
}

function renderDetail(p: Product, treeHtml: string, gallery: string[], render: { heroUri: string; viewerHref: string }): string {
  const r = p.rep;
  const kinds = JSON.parse(r.kind_breakdown) as Record<string, number>;
  const chips = Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span class="chip">${esc(k)} ${v}</span>`).join('');
  const hero = gallery[0] ?? '';
  const dup = p.copyCount > 1 ? `<span class="dup">コピー×${p.copyCount}</span>` : '';
  const faithful = render.heroUri
    ? `<h3>忠実プレビュー（方式A：本物のlilToonでUnity焼き）</h3><div class="faithful"><img class="ffimg" src="${render.heroUri}">` +
      (render.viewerHref ? `<a class="btn3d" href="${render.viewerHref}" target="_blank" rel="noopener">▶ 3Dで回す（GLB・Unity不要）</a>` : '') + `</div>`
    : '';
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
    `<div class="meta">${mb(r.size_bytes)} ・ ${r.file_count} files ・ preview ${r.preview_pct}%</div>${shaderBadges(r)}<div class="chips">${chips}</div></div></div>` +
    faithful +
    `<h3>導入先（取り込み後の追跡）</h3>${inst}` +
    copies +
    `<h3>中身（ファイル構成・100%表示）</h3><div class="tree">${treeHtml}</div>` +
    `<h3>プレビュー画像（${gallery.length}）</h3>${gal}`;
}

function renderApp(data: { card: string; detail: string; name: string; tags: string }[], count: number): string {
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
.card{background:#1e1e24;border:1px solid #2a2a32;border-radius:10px;overflow:hidden;cursor:pointer;transition:border-color .1s}
.card:hover{border-color:#4a6cf7}
.thumb{aspect-ratio:1/1;background:#0e0e12;display:flex;align-items:center;justify-content:center}
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
function showGrid(){ detail.style.display='none'; grid.style.display='grid'; }
function showDetail(i){ detail.innerHTML = '<button class="back" onclick="showGrid()">← 一覧へ</button>' + DATA[i].detail; grid.style.display='none'; detail.style.display='block'; scrollTo(0,0); }
grid.innerHTML = DATA.map((d,i)=>'<div class="card" data-name="'+d.name.toLowerCase().replace(/"/g,'&quot;')+'" data-tags="'+d.tags+'" onclick="showDetail('+i+')">'+d.card+'</div>').join('');
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
q.addEventListener('input', applyFilter);
for (const b of document.querySelectorAll('.filters button')){
  b.addEventListener('click', ()=>{
    document.querySelectorAll('.filters button').forEach(x=>x.classList.remove('on'));
    b.classList.add('on'); curFilter = b.dataset.f; applyFilter();
  });
}
applyFilter();
showGrid();
</script></body></html>`;
}

// テンプレ機能が要る形にカタログ行を整形（id/名前/パス/GUID集合/シェーダ要件）。
function buildCatalogPkgs(cat: Catalog): CatalogPkg[] {
  return cat.allPackages().map(r => ({
    id: r.id, file_name: r.file_name, file_path: r.file_path,
    guids: JSON.parse(r.guids_json) as string[],
    requires_liltoon: r.requires_liltoon, requires_poiyomi: r.requires_poiyomi, has_locked: r.has_locked,
  }));
}

function fail(msg: string): void {
  console.error(msg);
  process.exitCode = 1;
}

main().catch(err => { console.error(err); process.exitCode = 1; });
