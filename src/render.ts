// 方式A 自動化: パッケージ → 素プロジェクト＋lilToon → Unityバッチで多角度PNG+GLB → cache/renders/<hash>/ へ配置。
import { createReadStream, createWriteStream, mkdirSync, writeFileSync, rmSync, existsSync, cpSync, readFileSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));     // dist/ (ESMで__dirname代替)
import zlib from 'node:zlib';
import * as tar from 'tar-stream';
import { classify, importerOf } from './classify.js';

// shader/text も抽出: ロック済みPoiyomiの同梱シェーダ(OptimizedShaders)やshadergraph/インクルードを拾う。
// ※ script(.cs)は入れない(VRCSDK欠落でコンパイルエラーになり全体が壊れるため)
const RENDER_KINDS = new Set(['model', 'texture', 'material', 'prefab', 'shader', 'text']);
const GUID_RE = /^[0-9a-f]{32}$/;

function streamTar(file: string, onEntry: (guid: string, fname: string, stream: NodeJS.ReadableStream, header: any, next: () => void) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const ex = tar.extract();
    ex.on('entry', (h, s, n) => {
      const name = String(h.name).replace(/\\/g, '/');
      const i = name.indexOf('/');
      const guid = i < 0 ? '' : name.slice(0, i);
      const fname = i < 0 ? '' : name.slice(i + 1);
      if (!GUID_RE.test(guid) || !fname) { s.on('end', n); s.resume(); return; }
      onEntry(guid, fname, s, h, n);
    });
    ex.on('finish', () => resolve());
    ex.on('error', reject);
    createReadStream(file).on('error', reject).pipe(zlib.createGunzip()).on('error', reject).pipe(ex);
  });
}

// レンダに必要な種別だけをGUID保持でプロジェクトへ展開
export async function extractForRender(file: string, projDir: string): Promise<number> {
  const info = new Map<string, { path?: string; meta?: Buffer; importer?: string }>();
  await streamTar(file, (guid, fname, stream, _h, next) => {
    let d = info.get(guid); if (!d) { d = {}; info.set(guid, d); }
    if (fname === 'pathname' || fname === 'asset.meta') {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (fname === 'pathname') d!.path = (buf.toString('utf8').split('\n')[0] ?? '').trim().replace(/\\/g, '/');
        else { d!.meta = buf; d!.importer = importerOf(buf.toString('utf8')); }
        next();
      });
    } else { stream.on('end', next); stream.resume(); }
  });
  const want = new Map<string, string>();
  for (const [guid, d] of info) {
    if (!d.path) continue;
    const kind = classify(extname(d.path).toLowerCase(), d.importer);
    if (RENDER_KINDS.has(kind)) {
      want.set(guid, d.path);
      const dst = join(projDir, d.path);
      mkdirSync(dirname(dst), { recursive: true });
      if (d.meta) writeFileSync(dst + '.meta', d.meta);
    }
  }
  let count = 0;
  await streamTar(file, (guid, fname, stream, _h, next) => {
    if (fname === 'asset' && want.has(guid)) {
      const ws = createWriteStream(join(projDir, want.get(guid)!));
      stream.pipe(ws);
      ws.on('finish', () => { count++; next(); });
      ws.on('error', () => next());
    } else { stream.on('end', next); stream.resume(); }
  });
  return count;
}

export function findUnity(): string | null {
  const hubDir = 'C:\\Program Files\\Unity\\Hub\\Editor';
  const preferred = join(hubDir, '2022.3.22f1', 'Editor', 'Unity.exe');
  if (existsSync(preferred)) return preferred;
  try {
    for (const v of readdirSync(hubDir)) {
      const exe = join(hubDir, v, 'Editor', 'Unity.exe');
      if (v.startsWith('2022.3') && existsSync(exe)) return exe;
    }
    for (const v of readdirSync(hubDir)) {
      const exe = join(hubDir, v, 'Editor', 'Unity.exe');
      if (existsSync(exe)) return exe;
    }
  } catch { /* no hub */ }
  return null;
}

// ユーザー環境から lilToon/Poiyomi のパッケージ実体を探す。
// 配布版はシェーダを同梱しない(再配布回避)ため、ユーザーが持つUnityプロジェクトのPackages/から借用する。
// 優先: 環境変数 → 検出済みプロジェクト(projectRoots) → アプリ同梱のローカル(_shaders, 開発時のみ)
function findPackageFolder(pkgId: string, envVar: string, projectRoots: string[]): string | null {
  const cands: string[] = [];
  const env = process.env[envVar];
  if (env) cands.push(env);
  for (const root of projectRoots) cands.push(join(root, 'Packages', pkgId));
  cands.push(join(HERE, '..', '_shaders', pkgId));            // 開発時ローカル(配布物には含めない)
  for (const p of cands) if (existsSync(join(p, 'package.json'))) return p;
  return null;
}

export function findLilToon(projectRoots: string[] = []): string | null {
  return findPackageFolder('jp.lilxyzw.liltoon', 'HANGAR_LILTOON', projectRoots);
}

export function findPoiyomi(projectRoots: string[] = []): string | null {
  return findPackageFolder('com.poiyomi.toon', 'HANGAR_POIYOMI', projectRoots);
}

export interface RenderResult { ok: boolean; hero: boolean; glb: boolean; logFile: string; count: number; }

export async function renderPackage(opts: {
  packageFile: string; hash: string; cacheDir: string;
  renderProjDir: string; templateDir: string; lilToonSrc: string; poiyomiSrc?: string; unityExe: string;
  onLog?: (m: string) => void;
}): Promise<RenderResult> {
  const { packageFile, hash, cacheDir, renderProjDir, templateDir, lilToonSrc, poiyomiSrc, unityExe } = opts;
  const log = opts.onLog ?? (() => {});

  // プロジェクト骨組み + lilToon(初回のみコピー)
  mkdirSync(join(renderProjDir, 'Packages'), { recursive: true });
  mkdirSync(join(renderProjDir, 'ProjectSettings'), { recursive: true });
  if (!existsSync(join(renderProjDir, 'ProjectSettings', 'ProjectVersion.txt')))
    writeFileSync(join(renderProjDir, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 2022.3.22f1\nm_EditorVersionWithRevision: 2022.3.22f1 (887be4894c44)');
  if (!existsSync(join(renderProjDir, 'Packages', 'manifest.json')))
    writeFileSync(join(renderProjDir, 'Packages', 'manifest.json'), '{ "dependencies": {} }');
  const lil = join(renderProjDir, 'Packages', 'jp.lilxyzw.liltoon');
  if (!existsSync(lil) && existsSync(lilToonSrc)) cpSync(lilToonSrc, lil, { recursive: true });
  const poi = join(renderProjDir, 'Packages', 'com.poiyomi.toon');
  if (poiyomiSrc && !existsSync(poi) && existsSync(poiyomiSrc)) { log('  Poiyomi導入中(初回・約166MB)...'); cpSync(poiyomiSrc, poi, { recursive: true }); }

  // AssetsをクリアしてテンプレEditorスクリプト + パッケージ展開
  rmSync(join(renderProjDir, 'Assets'), { recursive: true, force: true });
  mkdirSync(join(renderProjDir, 'Assets', 'Editor'), { recursive: true });
  copyFileSync(join(templateDir, 'RenderPreview.cs'), join(renderProjDir, 'Assets', 'Editor', 'RenderPreview.cs'));
  copyFileSync(join(templateDir, 'GlbExport.cs'), join(renderProjDir, 'Assets', 'Editor', 'GlbExport.cs'));
  log('  抽出中...');
  const n = await extractForRender(packageFile, renderProjDir);
  log(`  ${n} アセット抽出 → Unity起動(数分)`);

  const renderDir = join(cacheDir, 'renders', hash);
  const unityOut = join(renderDir, '_unity');
  rmSync(unityOut, { recursive: true, force: true });   // 前回/別実行の残骸を消し「今回生成された出力」だけで成否判定
  mkdirSync(unityOut, { recursive: true });
  const logFile = join(renderDir, 'unity.log');
  const env = { ...process.env } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  // spawnSync は非0終了/タイムアウトでも throw しない。戻り値で起動失敗/SIGTERM/異常終了を判定する。
  const res = spawnSync(unityExe, ['-batchmode', '-projectPath', renderProjDir, '-executeMethod', 'RenderPreview.Run', '-logFile', logFile, '--out', unityOut, '-quit'],
    { env, stdio: 'ignore', timeout: 12 * 60 * 1000 });

  // unityOut は直前に消してあるので、ここに在る出力は必ず「今回の実行」が生成したもの。
  // 複数prefab対応: Unityは model{i}_{front|34|side|back}.png と model{i}.glb を i=0.. で出力し、
  // previews.txt(index\t名前\tレンダラ数) を添える。index0 が代表(=hero)。
  let hero = false, glb = false, count = 0;
  const heroAngles = (i: number) => [`model${i}_34.png`, `model${i}_front.png`, `model${i}_side.png`, `model${i}_back.png`]
    .map(f => join(unityOut, f)).find(p => existsSync(p));

  const names = new Map<number, string>();
  const manifestFile = join(unityOut, 'previews.txt');
  if (existsSync(manifestFile)) {
    for (const line of readFileSync(manifestFile, 'utf8').split('\n')) {
      const tab = line.split('\t');
      if (tab[0] !== undefined && tab[0] !== '') names.set(Number(tab[0]), (tab[1] ?? '').trim());
    }
  }

  const indices: number[] = [];
  for (let i = 0; i < 64; i++) if (existsSync(join(unityOut, `model${i}.glb`)) || heroAngles(i)) indices.push(i);

  if (indices.length) {
    const rep = indices[0]!;
    const repHero = heroAngles(rep);
    if (repHero) { copyFileSync(repHero, join(renderDir, 'hero.png')); hero = true; }
    const prefabs: { name: string; glbPath: string }[] = [];
    const manifest: { index: number; name: string; thumb: string }[] = [];
    for (const i of indices) {
      const th = heroAngles(i);
      let thumb = '';
      if (th) { copyFileSync(th, join(renderDir, `preview${i}.png`)); thumb = `preview${i}.png`; }
      const name = names.get(i) || `プレハブ ${i + 1}`;
      const g = join(unityOut, `model${i}.glb`);
      if (existsSync(g)) prefabs.push({ name, glbPath: g });
      manifest.push({ index: i, name, thumb });
    }
    if (prefabs.length) { writeViewerHtmlMulti(prefabs, join(renderDir, 'viewer.html')); glb = true; }
    writeFileSync(join(renderDir, 'previews.json'), JSON.stringify(manifest));
    count = manifest.length;
  } else {
    // 後方互換: 旧形式(model_*.png / model.glb)を1個として拾う
    const legacyHero = ['model_34.png', 'model_front.png', 'model_side.png'].map(f => join(unityOut, f)).find(p => existsSync(p));
    if (legacyHero) { copyFileSync(legacyHero, join(renderDir, 'hero.png')); copyFileSync(legacyHero, join(renderDir, 'preview0.png')); hero = true; }
    const legacyGlb = join(unityOut, 'model.glb');
    if (existsSync(legacyGlb)) { writeViewerHtmlMulti([{ name: '', glbPath: legacyGlb }], join(renderDir, 'viewer.html')); glb = true; }
    if (hero || glb) { writeFileSync(join(renderDir, 'previews.json'), JSON.stringify([{ index: 0, name: '', thumb: 'preview0.png' }])); count = 1; }
  }
  if (!hero && !glb) {
    // 成果物ゼロ＝失敗。Unityの終了コードは警告等で不安定なので、出力が在れば成功扱い・無ければ理由を添えて失敗。
    const reason = res.error ? ('Unity起動に失敗しました: ' + res.error.message)
      : res.signal ? (`Unityがタイムアウト/強制終了されました(${res.signal})`)
      : (res.status != null && res.status !== 0) ? (`Unityが異常終了しました(code ${res.status})`)
      : 'Unityが画像/GLBを生成しませんでした(シェーダ未検出・ライセンス等)';
    log('  ⚠ ' + reason + ' → ログ: ' + logFile);
    return { ok: false, hero, glb, logFile, count };
  }
  if (count > 1) log(`  ${count} 体のプレハブを個別生成 → 3Dビューアで切替可`);
  return { ok: true, hero, glb, logFile, count };
}

// 複数prefab対応の3Dビューア: 各GLBをbase64で隠し持ち、上部タブで切替(選択時に遅延parse)。
function writeViewerHtmlMulti(items: { name: string; glbPath: string }[], outHtml: string): void {
  const safe = items.filter(it => existsSync(it.glbPath));
  if (safe.length === 0) return;
  const escHtml = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const tabs = safe.map((it, i) => `<button class="tab" data-i="${i}" onclick="show(${i})">${escHtml(it.name || ('プレハブ ' + (i + 1)))}</button>`).join('');
  const glbTags = safe.map((it, i) => '<script id="glb' + i + '" type="text/plain">' + readFileSync(it.glbPath).toString('base64') + '</' + 'script>').join('');
  const head = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>3D preview</title><style>html,body{margin:0;height:100%;background:#202024;overflow:hidden;font-family:sans-serif}'
    + '#info{position:fixed;left:10px;bottom:8px;color:#bbb;font-size:12px;z-index:2}#err{position:fixed;left:10px;top:48px;color:#f88;font-size:13px;white-space:pre;z-index:2}'
    + '#bar{position:fixed;left:0;right:0;top:0;display:flex;gap:6px;padding:8px 10px;background:rgba(20,20,24,.82);z-index:3;flex-wrap:wrap;align-items:center}'
    + '#bar .lbl{color:#8a8a92;font-size:12px;margin-right:4px}.tab{background:#2a2a34;color:#ddd;border:0;border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer}.tab.on{background:#4a6cf7;color:#fff}</style>'
    + '<script type="importmap">{ "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js", "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/" }}</' + 'script></head><body>'
    + (safe.length > 1 ? ('<div id="bar"><span class="lbl">プレハブ ' + safe.length + '体 →</span>' + tabs + '</div>') : '')
    + '<div id="info">ドラッグ=回転 / ホイール=ズーム (Unity不要・three.jsで描画)</div><div id="err"></div>'
    + glbTags
    + '<script type="module">'
    + "import * as THREE from 'three';"
    + "import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';"
    + "import { OrbitControls } from 'three/addons/controls/OrbitControls.js';"
    + "const errEl=document.getElementById('err');let renderer,scene,camera,controls,current;"
    + "function init(){renderer=new THREE.WebGLRenderer({antialias:true});renderer.setSize(innerWidth,innerHeight);renderer.setPixelRatio(devicePixelRatio);document.body.appendChild(renderer.domElement);"
    + "scene=new THREE.Scene();scene.background=new THREE.Color(0x202024);scene.add(new THREE.HemisphereLight(0xffffff,0x444455,1.2));const dl=new THREE.DirectionalLight(0xffffff,1.0);dl.position.set(1,2,2);scene.add(dl);"
    + "camera=new THREE.PerspectiveCamera(35,innerWidth/innerHeight,0.01,100);controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;"
    + "addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});"
    + "(function loop(){requestAnimationFrame(loop);controls.update();renderer.render(scene,camera);})();}"
    + "function show(i){errEl.textContent='';try{document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('on',(+t.dataset.i)===i));"
    + "if(current){scene.remove(current);current=null;}const el=document.getElementById('glb'+i);if(!el)return;"
    + "const b=atob(el.textContent.trim());const u8=new Uint8Array(b.length);for(let k=0;k<b.length;k++)u8[k]=b.charCodeAt(k);"
    + "new GLTFLoader().parse(u8.buffer,'',(g)=>{current=g.scene;scene.add(current);const box=new THREE.Box3().setFromObject(current);const c=box.getCenter(new THREE.Vector3());const s=box.getSize(new THREE.Vector3());const r=Math.max(s.x,s.y,s.z)||1;controls.target.copy(c);camera.position.set(c.x,c.y+r*0.05,c.z-r*1.6);camera.near=r/100;camera.far=r*100;camera.updateProjectionMatrix();},(e)=>{errEl.textContent='parse error: '+e;});"
    + "}catch(e){errEl.textContent='init error: '+e+' (three.jsをCDNから読みます。ネット接続が必要)';}}"
    + "window.show=show;init();show(0);"
    + '</' + 'script></body></html>';
  writeFileSync(outHtml, head, 'utf8');
}
