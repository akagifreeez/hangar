// Hangar GUI シェル(Electron)。
// 配布形態: Electron 単体で完結（system Node 不要）。重い処理(scan/detect/render/catalog生成)は
// Electron バイナリを node モード(ELECTRON_RUN_AS_NODE=1)で起動した子プロセスに委譲し、UIスレッドを止めない。
// node:sqlite は Electron 42(Node 24) の内蔵で動作するため追加ランタイム不要。
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

app.setName('Hangar');                                    // userData = %APPDATA%\Hangar に固定

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

// Electron 自身を node モードで起動してコンパイル済みCLIを実行(system Node 不要)
function runCli(args) {
  return new Promise((resolve) => {
    const env = { ...process.env, HANGAR_DB: DB, HANGAR_CACHE: CACHE, ELECTRON_RUN_AS_NODE: '1' };
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env });
    let buf = '';
    const onData = (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.trim() && !/ExperimentalWarning|trace-warnings/.test(line)) send('status', line.trim());
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => resolve(code));
    child.on('error', (e) => { send('status', 'CLI起動失敗: ' + e.message); resolve(-1); });
  });
}

async function regen() { await runCli(['catalog', CATALOG]); send('catalog-url', catalogUrl()); }

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
  const r = await dialog.showOpenDialog(win, { properties: props });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('scan', async (_e, folder) => { remember('libraryDirs', [folder]); await runCli(['scan', folder]); await regen(); return true; });
ipcMain.handle('detect', async (_e, folders) => { remember('projectDirs', folders); await runCli(['detect', '--save', ...folders]); await regen(); return true; });
ipcMain.handle('regen', async () => { await regen(); return true; });
ipcMain.handle('get-config', () => loadConfig());
// 記憶済みライブラリ/プロジェクトを全部やり直して差分を取り込む
ipcMain.handle('rescan', async () => {
  const c = loadConfig();
  for (const d of c.libraryDirs || []) { send('status', '再スキャン: ' + d); await runCli(['scan', d]); }
  if ((c.projectDirs || []).length) { send('status', 'プロジェクト再検出...'); await runCli(['detect', '--save', ...c.projectDirs]); }
  await regen();
  return c;
});
ipcMain.handle('render', async (_e, name) => { await runCli(['render', name]); await regen(); return true; });
ipcMain.handle('catalog-exists', () => fs.existsSync(CATALOG));
ipcMain.handle('catalog-url', () => fs.existsSync(CATALOG) ? catalogUrl() : '');
ipcMain.handle('open-external', (_e, url) => { shell.openExternal(url); });
// 3D生成(方式A)が使えるか= Unity + lilToン が見つかるか
ipcMain.handle('render-capabilities', async () => {
  const out = await new Promise((resolve) => {
    const env = { ...process.env, HANGAR_DB: DB, HANGAR_CACHE: CACHE, ELECTRON_RUN_AS_NODE: '1' };
    const child = spawn(process.execPath, [CLI, 'caps'], { cwd: ROOT, env });
    let buf = '';
    child.stdout.on('data', (d) => buf += d.toString());
    child.on('close', () => resolve(buf));
    child.on('error', () => resolve(''));
  });
  try { return JSON.parse((out.match(/\{[\s\S]*\}/) || ['{}'])[0]); } catch { return {}; }
});

app.whenReady().then(() => {
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
