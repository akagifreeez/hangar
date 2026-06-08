// Hangar GUI シェル(Electron)。
// 配布形態: Electron 単体で完結（system Node 不要）。重い処理(scan/detect/render/catalog生成)は
// Electron バイナリを node モード(ELECTRON_RUN_AS_NODE=1)で起動した子プロセスに委譲し、UIスレッドを止めない。
// node:sqlite は Electron 42(Node 24) の内蔵で動作するため追加ランタイム不要。
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

app.setName('Hangar');                                    // userData = %APPDATA%\Hangar に固定

// 多重起動防止: 2プロセスが同じ hangar.db / config.json / gui-catalog.html を同時書き込みして壊すのを防ぐ。
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
}

const ROOT = path.join(__dirname, '..');                  // hangar アプリ本体(読み取り専用になりうる)
const CLI = path.join(ROOT, 'dist', 'cli.js');            // コンパイル済みCLI(tsx不要)

// 書き込み先: 配布版は userData、開発時(env or 非packaged)は ROOT。env で上書き可。
const DATA = process.env.HANGAR_DATA || (app.isPackaged ? app.getPath('userData') : ROOT);
fs.mkdirSync(DATA, { recursive: true });
const DB = process.env.HANGAR_DB || path.join(DATA, 'hangar.db');
const CACHE = process.env.HANGAR_CACHE || path.join(DATA, 'cache');
const CATALOG = path.join(DATA, 'gui-catalog.html');
const CONFIG = path.join(DATA, 'config.json');
const SMOKE = process.argv.includes('--smoke');

// 設定(スキャンしたライブラリ/検出したプロジェクトを記憶 → 差分の再スキャンを1クリックに)
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return { libraryDirs: [], projectDirs: [] }; }
}
function saveConfig(c) { try { fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2)); } catch { /* ignore */ } }
function remember(key, dirs) {
  const c = loadConfig(); const set = new Set(c[key] || []);
  for (const d of dirs) set.add(d);
  c[key] = [...set]; saveConfig(c); return c;
}

let win;

function send(channel, msg) { if (win && !win.isDestroyed()) win.webContents.send(channel, msg); }
function catalogUrl() { return 'file:///' + CATALOG.replace(/\\/g, '/'); }

// Electron 自身を node モードで起動してコンパイル済みCLIを実行(system Node 不要)。
// 戻り値 {code, tail}: 終了コード(0=成功)と末尾ログ行(失敗時の原因表示用)。onLine で全行を観測可。
function runCli(args, onLine) {
  return new Promise((resolve) => {
    const env = { ...process.env, HANGAR_DB: DB, HANGAR_CACHE: CACHE, ELECTRON_RUN_AS_NODE: '1' };
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env });
    let buf = '';
    const tail = [];
    const onData = (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const t = line.trim();
        if (t && !/ExperimentalWarning|trace-warnings/.test(t)) {
          send('status', t);
          if (onLine) onLine(t);
          tail.push(t); if (tail.length > 10) tail.shift();
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => { const t = buf.trim(); if (t) tail.push(t); resolve({ code: code == null ? 0 : code, tail }); });
    child.on('error', (e) => { send('status', 'CLI起動失敗: ' + e.message); resolve({ code: -1, tail: ['CLI起動失敗: ' + e.message] }); });
  });
}

// stdout から JSON 値を頑健に取り出す: まず各行を末尾から JSON.parse(--json は1値を出す約束)、
// だめなら貪欲抽出(pretty複数行JSON)にフォールバック。ログ行に括弧が混じっても壊れにくい。
function parseJsonLoose(out) {
  const lines = String(out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/^[[{]/.test(lines[i])) continue;
    try { return JSON.parse(lines[i]); } catch { /* try earlier line */ }
  }
  try { return JSON.parse((out.match(/[[{][\s\S]*[}\]]/) || ['null'])[0]); } catch { return null; }
}

// CLIをJSONモードで実行し最初のJSON値を返す(diff/template/caps 用)。{ok, code, report, tail}。
function runCliJson(args) {
  return new Promise((resolve) => {
    const env = { ...process.env, HANGAR_DB: DB, HANGAR_CACHE: CACHE, ELECTRON_RUN_AS_NODE: '1' };
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env });
    let out = '';
    const err = [];
    child.stdout.on('data', (d) => out += d.toString());
    child.stderr.on('data', (d) => { const t = d.toString().trim(); if (t && !/ExperimentalWarning|trace-warnings/.test(t)) err.push(t); });
    child.on('close', (code) => {
      const report = parseJsonLoose(out);
      resolve({ ok: code === 0 && report != null, code: code == null ? 0 : code, report, tail: err.slice(-6) });
    });
    child.on('error', (e) => resolve({ ok: false, code: -1, report: null, tail: ['CLI起動失敗: ' + e.message] }));
  });
}

async function regen() { await runCli(['catalog', CATALOG]); send('catalog-url', catalogUrl()); }

// 重い書き込み系(scan/detect/rescan/render/regen)を直列化し、DB/カタログHTML/configの同時書込破損を防ぐ。
// renderer 側 BUSY フラグの抜け(IPC直叩き・連打・将来のD&D)に対する main 側の最終防壁。
let jobChain = Promise.resolve();
function withJob(fn) { const run = jobChain.then(fn, fn); jobChain = run.then(() => {}, () => {}); return run; }

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 840, backgroundColor: '#16161a',
    title: 'Hangar',
    icon: path.join(ROOT, 'build', 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs') },
  });
  if (win.removeMenu) win.removeMenu();
  // カタログ内のリンク: ローカルの3Dビューア(viewer.html)は別窓、http(s)は既定ブラウザへ
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('file://')) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 960, height: 720, backgroundColor: '#202024', title: 'Hangar 3D preview' } };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadFile(path.join(__dirname, 'shell.html'));
}

ipcMain.handle('pick-folder', async (_e, opts) => {
  const props = ['openDirectory'];
  if (opts && opts.multi) props.push('multiSelections');
  const r = await dialog.showOpenDialog(win, { properties: props, title: (opts && opts.title) || undefined });
  return r.canceled ? [] : r.filePaths;
});
// スキャン: 登録件数/解析失敗件数を返し、0件は呼び出し側で「無言成功」にしない。0件ならカタログに切り替えない。
ipcMain.handle('scan', (_e, folder) => withJob(async () => {
  remember('libraryDirs', [folder]);
  let count = null, failed = 0;
  const { code, tail } = await runCli(['scan', folder], (l) => {
    const m = l.match(/scanned (\d+) package/); if (m) count = +m[1];
    if (/parse失敗/.test(l)) failed++;
  });
  if (code === 0 && (count == null || count > 0)) await regen();
  return { ok: code === 0, code, count: count == null ? 0 : count, failed, tail };
}));
// 検出: .meta総数と導入済み商品数を集計して返す(metaTotal=0 は「Assets違い」を疑える)。失敗時は regen しない(有効カタログ保護)。
ipcMain.handle('detect', (_e, folders) => withJob(async () => {
  remember('projectDirs', folders);
  let metaTotal = 0, installed = 0;
  const { code, tail } = await runCli(['detect', '--save', ...folders], (l) => {
    const m = l.match(/\.meta:(\d+)/); if (m) metaTotal += +m[1];
    if (/INSTALLED/.test(l)) installed++;
  });
  if (code === 0) await regen();
  return { ok: code === 0, code, metaTotal, installed, tail };
}));
ipcMain.handle('regen', () => withJob(async () => { await regen(); return true; }));
ipcMain.handle('get-config', () => loadConfig());
// 記憶済みライブラリ/プロジェクトを全部やり直して差分を取り込む
ipcMain.handle('rescan', (_e) => withJob(async () => {
  const c = loadConfig();
  let ok = true;
  for (const d of c.libraryDirs || []) { send('status', '再スキャン: ' + d); const r = await runCli(['scan', d]); if (r.code !== 0) ok = false; }
  if ((c.projectDirs || []).length) { send('status', 'プロジェクト再検出...'); const r = await runCli(['detect', '--save', ...c.projectDirs]); if (r.code !== 0) ok = false; }
  if (ok || fs.existsSync(CATALOG)) await regen();
  return { ok, libraryDirs: c.libraryDirs || [], projectDirs: c.projectDirs || [] };
}));
// render: 文字列(名前の部分一致・従来) または {sig,name}(カタログから・内容署名で厳密指定) を受ける。失敗時は regen しない。
ipcMain.handle('render', (_e, target) => withJob(async () => {
  const opts = typeof target === 'string' ? { name: target } : (target || {});
  const args = opts.sig ? ['render', '--sig', opts.sig] : ['render', opts.name || ''];
  const { code, tail } = await runCli(args);
  if (code === 0) await regen();
  return { ok: code === 0, code, tail };
}));
ipcMain.handle('catalog-exists', () => fs.existsSync(CATALOG));
ipcMain.handle('catalog-url', () => fs.existsSync(CATALOG) ? catalogUrl() : '');
ipcMain.handle('open-external', (_e, url) => { shell.openExternal(url); });
// 取り込み前チェック: .unitypackage を選ぶ → 対象プロジェクトとの競合を JSON で返す
ipcMain.handle('pick-file', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Unity Package', extensions: ['unitypackage'] }],
  });
  return r.canceled || !r.filePaths.length ? '' : r.filePaths[0];
});
ipcMain.handle('diff', async (_e, pkg, project) => {
  const r = await runCliJson(['diff', pkg, '--project', project, '--json']);
  return r.report;   // 失敗時 null（UI 側で原因表示）
});
// 再現テンプレ: 保存（自作分→テンプレ）/ 復元（テンプレ→まっさらなプロジェクト）。{ok, report, tail} を返す。
ipcMain.handle('save-template', async (_e, projectDir, outDir) => {
  return await runCliJson(['save-template', projectDir, '--out', outDir, '--json']);
});
ipcMain.handle('restore-template', async (_e, templateDir, projectDir, force) => {
  const args = ['restore-template', templateDir, '--project', projectDir, '--json'];
  if (force) args.push('--force');
  return await runCliJson(args);
});
// 3D生成(方式A)が使えるか= Unity + lilToon が見つかるか
ipcMain.handle('render-capabilities', async () => {
  const r = await runCliJson(['caps']);
  return r.report || {};
});

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;   // 2つ目のインスタンスは窓を作らず終了
  createWindow();
  if (SMOKE) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(path.join(DATA, 'gui_smoke.png'), img.toPNG());
        } catch (e) { console.error('capture fail', e); }
        app.quit();
      }, 5000);
    });
  }
});
app.on('window-all-closed', () => app.quit());
