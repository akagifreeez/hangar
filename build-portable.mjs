// 配布用ポータブルビルドの組み立て(electron-builder無しでも動く実体を作る)。
// 構成: <out>/Hangar.exe(=electron.exe) + Electronランタイム + resources/app/(コンパイル済みアプリ + 本番依存)
// 使い方: node build-portable.mjs   → release/Hangar-win-x64/ を生成
import { existsSync, rmSync, mkdirSync, cpSync, renameSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, 'release', 'Hangar-win-x64');
const ELECTRON_DIST = join(ROOT, 'node_modules', 'electron', 'dist');
const NODE_MODULES = join(ROOT, 'node_modules');

// 本番依存ツリーを package.json の dependencies から再帰算出(ハードコードを廃止)。
// tar-stream 等の依存が増減しても自動追従し、欠落(=壊れた配布物になる)はビルド中断で防ぐ。
function resolveRuntimeTree(rootDeps) {
  const found = new Set(), missing = new Set(), seen = new Set();
  const queue = [...rootDeps];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const pj = join(NODE_MODULES, name, 'package.json');
    if (!existsSync(pj)) { missing.add(name); continue; }
    found.add(name);
    try { for (const d of Object.keys(JSON.parse(readFileSync(pj, 'utf8')).dependencies || {})) queue.push(d); } catch { /* ignore */ }
  }
  return { found: [...found], missing: [...missing] };
}
const rootDeps = Object.keys(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).dependencies || {});
const { found: PROD_DEPS, missing: MISSING_DEPS } = resolveRuntimeTree(rootDeps);

const APP_FILES = ['package.json', 'LICENSE', 'README.md', 'PRIVACY.md', 'THIRD_PARTY_NOTICES.md'];
const APP_DIRS = ['render-template'];                          // dist は .js のみ別途コピー、app/ も個別に絞る

function dirSize(p) {
  let n = 0;
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const fp = join(p, e.name);
    if (e.isDirectory()) n += dirSize(fp); else n += statSync(fp).size;
  }
  return n;
}

if (!existsSync(ELECTRON_DIST)) { console.error('Electron dist が無い。npm install してください: ' + ELECTRON_DIST); process.exit(1); }
if (!existsSync(join(ROOT, 'dist', 'cli.js'))) { console.error('dist/cli.js が無い。先に npm run build を実行してください'); process.exit(1); }
// 本番依存の欠落は「起動時クラッシュの壊れた配布物」になるので、警告で素通りさせずビルド中断する。
if (MISSING_DEPS.length) { console.error('✗ 本番依存が node_modules に欠落: ' + MISSING_DEPS.join(', ') + '\n  → npm install してから再試行。配布を中断します。'); process.exit(1); }
console.log(`本番依存ツリー: ${PROD_DEPS.length} パッケージ (package.json dependencies から動的算出)`);

// dist 完全性チェック: cli.js 等がimportする相対モジュールが全て dist/ に在るか。
// （以前 diff.js/template.js が欠けた版を配布してしまった事故を再発させない配布前ゲート）
function verifyDistComplete(distDir) {
  const jsFiles = readdirSync(distDir).filter(f => f.endsWith('.js'));
  const present = new Set(jsFiles);
  const missing = [];
  for (const f of jsFiles) {
    const src = readFileSync(join(distDir, f), 'utf8');
    const re = /(?:from|import)\s+['"]\.\/([\w.\-/]+\.js)['"]/g;
    let m;
    while ((m = re.exec(src))) { if (!present.has(m[1])) missing.push(`${f} → ./${m[1]}`); }
  }
  if (missing.length) {
    console.error('✗ dist 不完全: 次の相対import先が dist/ に存在しません（npm run build が古い/失敗の可能性）:');
    for (const x of missing) console.error('   ' + x);
    console.error('  → `npm run build` を実行してから再試行してください。配布を中断します。');
    process.exit(1);
  }
  console.log(`dist 完全性チェック OK (${jsFiles.length} モジュール)`);
}
verifyDistComplete(join(ROOT, 'dist'));

console.log('clean ' + OUT);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

console.log('copy Electron runtime ...');
cpSync(ELECTRON_DIST, OUT, { recursive: true });
// default アプリを除去して resources/app/ を確実に使わせる
rmSync(join(OUT, 'resources', 'default_app.asar'), { force: true });
// ブランディング: electron.exe → Hangar.exe
if (existsSync(join(OUT, 'electron.exe'))) renameSync(join(OUT, 'electron.exe'), join(OUT, 'Hangar.exe'));

const APP = join(OUT, 'resources', 'app');
mkdirSync(APP, { recursive: true });

// app/ は cjs と html のみ(開発用 probe は除外)
mkdirSync(join(APP, 'app'), { recursive: true });
for (const f of readdirSync(join(ROOT, 'app'))) {
  if (/^probe/.test(f)) continue;
  if (/\.(cjs|html)$/.test(f)) cpSync(join(ROOT, 'app', f), join(APP, 'app', f));
}
// dist は .js のみコピー(electron-builder の win-unpacked 等の混入防止。source map は配布不要)
mkdirSync(join(APP, 'dist'), { recursive: true });
for (const f of readdirSync(join(ROOT, 'dist'))) {
  if (f.endsWith('.js')) cpSync(join(ROOT, 'dist', f), join(APP, 'dist', f));
}
for (const d of APP_DIRS) cpSync(join(ROOT, d), join(APP, d), { recursive: true });
for (const f of APP_FILES) if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(APP, f));
// アイコン(ウィンドウ/タスクバー用)
if (existsSync(join(ROOT, 'build', 'icon.ico'))) { mkdirSync(join(APP, 'build'), { recursive: true }); cpSync(join(ROOT, 'build', 'icon.ico'), join(APP, 'build', 'icon.ico')); }

// 本番 node_modules
const NM = join(APP, 'node_modules');
mkdirSync(NM, { recursive: true });
for (const dep of PROD_DEPS) {
  const src = join(ROOT, 'node_modules', dep);
  // 欠落は上の MISSING_DEPS チェックで既に中断済み。ここに来るものは存在が保証されている。
  cpSync(src, join(NM, dep), { recursive: true });
}

// 起動補助(ELECTRON_RUN_AS_NODE が環境に残っていても確実にGUI起動させる)
writeFileSync(join(OUT, 'Hangar.cmd'),
  '@echo off\r\nset "ELECTRON_RUN_AS_NODE="\r\nstart "" "%~dp0Hangar.exe"\r\n', 'utf8');

const mb = (b) => (b / 1048576).toFixed(0) + 'MB';
console.log('done -> ' + OUT);
console.log('  size: ' + mb(dirSize(OUT)) + '  (resources/app: ' + mb(dirSize(APP)) + ')');
console.log('  起動: ' + join(OUT, 'Hangar.exe') + ' (または Hangar.cmd)');
