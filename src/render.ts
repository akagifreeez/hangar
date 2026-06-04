// 方式A 自動化: パッケージ → 素プロジェクト＋lilToン → Unityバッチで多角度PNG+GLB → cache/renders/<hash>/ へ配置。
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

// ユーザー環境から lilToン/Poiyomi のパッケージ実体を探す。
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

export interface RenderResult { ok: boolean; hero: boolean; glb: boolean; logFile: string; }

export async function renderPackage(opts: {
  packageFile: string; hash: string; cacheDir: string;
  renderProjDir: string; templateDir: string; lilToonSrc: string; poiyomiSrc?: string; unityExe: string;
  onLog?: (m: string) => void;
}): Promise<RenderResult> {
  const { packageFile, hash, cacheDir, renderProjDir, templateDir, lilToonSrc, poiyomiSrc, unityExe } = opts;
  const log = opts.onLog ?? (() => {});

  // プロジェクト骨組み + lilToン(初回のみコピー)
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
  mkdirSync(unityOut, { recursive: true });
  const logFile = join(renderDir, 'unity.log');
  const env = { ...process.env } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  spawnSync(unityExe, ['-batchmode', '-projectPath', renderProjDir, '-executeMethod', 'RenderPreview.Run', '-logFile', logFile, '--out', unityOut, '-quit'],
    { env, stdio: 'ignore', timeout: 12 * 60 * 1000 });

  const heroSrc = ['model_34.png', 'model_front.png', 'model_side.png'].map(f => join(unityOut, f)).find(p => existsSync(p));
  let hero = false, glb = false;
  if (heroSrc) { copyFileSync(heroSrc, join(renderDir, 'hero.png')); hero = true; }
  const glbSrc = join(unityOut, 'model.glb');
  if (existsSync(glbSrc)) { writeViewerHtml(glbSrc, join(renderDir, 'viewer.html')); glb = true; }
  return { ok: hero || glb, hero, glb, logFile };
}

function writeViewerHtml(glbPath: string, outHtml: string): void {
  const b64 = readFileSync(glbPath).toString('base64');
  const head = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>3D preview</title><style>html,body{margin:0;height:100%;background:#202024;overflow:hidden;font-family:sans-serif}'
    + '#info{position:fixed;left:10px;top:8px;color:#bbb;font-size:12px;z-index:2}#err{position:fixed;left:10px;top:30px;color:#f88;font-size:13px;white-space:pre;z-index:2}</style>'
    + '<script type="importmap">{ "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js", "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/" }}</' + 'script></head><body>'
    + '<div id="info">ドラッグ=回転 / ホイール=ズーム (Unity不要・three.jsで描画)</div><div id="err"></div>'
    + '<script id="glb" type="text/plain">' + b64 + '</' + 'script>'
    + '<script type="module">'
    + "import * as THREE from 'three';"
    + "import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';"
    + "import { OrbitControls } from 'three/addons/controls/OrbitControls.js';"
    + "const errEl=document.getElementById('err');"
    + "try{const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setSize(innerWidth,innerHeight);renderer.setPixelRatio(devicePixelRatio);document.body.appendChild(renderer.domElement);"
    + "const scene=new THREE.Scene();scene.background=new THREE.Color(0x202024);scene.add(new THREE.HemisphereLight(0xffffff,0x444455,1.2));const dl=new THREE.DirectionalLight(0xffffff,1.0);dl.position.set(1,2,2);scene.add(dl);"
    + "const camera=new THREE.PerspectiveCamera(35,innerWidth/innerHeight,0.01,100);const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;"
    + "const b=atob(document.getElementById('glb').textContent.trim());const u8=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u8[i]=b.charCodeAt(i);"
    + "new GLTFLoader().parse(u8.buffer,'',(g)=>{scene.add(g.scene);const box=new THREE.Box3().setFromObject(g.scene);const c=box.getCenter(new THREE.Vector3());const s=box.getSize(new THREE.Vector3());const r=Math.max(s.x,s.y,s.z)||1;controls.target.copy(c);camera.position.set(c.x,c.y+r*0.05,c.z-r*1.6);camera.near=r/100;camera.far=r*100;camera.updateProjectionMatrix();},(e)=>{errEl.textContent='parse error: '+e;});"
    + "addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});"
    + "(function loop(){requestAnimationFrame(loop);controls.update();renderer.render(scene,camera);})();"
    + "}catch(e){errEl.textContent='init error: '+e+' (three.jsをCDNから読みます。ネット接続が必要)';}"
    + '</' + 'script></body></html>';
  writeFileSync(outHtml, head, 'utf8');
}
