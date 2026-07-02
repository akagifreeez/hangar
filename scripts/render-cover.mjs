// BOOTHカバー用: docs/screenshots/booth/ 内の *.cover.html を 1200x1200 PNG にラスタライズする。
// 各HTMLは 600x600 CSS px 設計 → force-device-scale-factor=2 で 1200x1200 出力(正方形=BOOTHサムネ)。
// __ICON_DATA_URI__ プレースホルダは build/icon.png の data URI に置換してから描画する。
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DIR = join(ROOT, 'docs', 'screenshots', 'booth');
mkdirSync(DIR, { recursive: true });

const CHROME = process.env.CHROME_PATH ||
  'C:/Program Files/Google/Chrome/Application/chrome.exe';

const iconB64 = 'data:image/png;base64,' +
  readFileSync(join(ROOT, 'build', 'icon.png')).toString('base64');

const targets = process.argv.slice(2);
const htmls = (targets.length ? targets : readdirSync(DIR).filter((f) => f.endsWith('.cover.html')).map((f) => join(DIR, f)));

for (const htmlPath of htmls) {
  const raw = readFileSync(htmlPath, 'utf8');
  // プレースホルダ置換版を一時HTMLに書き出し(元のテンプレHTMLはプレースホルダのまま残す)
  const filled = raw.replaceAll('__ICON_DATA_URI__', iconB64);
  const fillPath = htmlPath.replace(/\.cover\.html$/, '.filled.html');
  writeFileSync(fillPath, filled, 'utf8');
  const out = htmlPath.replace(/\.cover\.html$/, '.png');
  const fileUrl = 'file:///' + fillPath.replace(/\\/g, '/');
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=2',
    '--window-size=600,600',
    '--default-background-color=16161aff',
    '--screenshot=' + out,
    fileUrl,
  ], { stdio: 'inherit' });
  console.log('WROTE ' + out);
}
