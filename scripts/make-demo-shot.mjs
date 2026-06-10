// 公開用デモ素材の生成: 実レンダラ formatDiffHtmlPage に「サンプルの」DiffReport を渡し、
// 取り込み前チェック(ピンク化予防)の代表シーンをHTML出力する。
// 購入物名は一切使わず、汎用的な例データのみ(公開READMEに載せられる)。UIは製品そのもの。
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatDiffHtmlPage } from '../dist/diff.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'docs', 'screenshots');
mkdirSync(OUT, { recursive: true });

const g = (s) => s; // 例示用GUID(32hex)
// シナリオ: 新しい衣装パッケージを取り込む直前。
//  🔴 同梱lilToonが、VPMで入れた既存lilToonと衝突 →「同梱フォルダは外すのが安全」
//  🟣 この商品はPoiyomiが必要だが、対象プロジェクトに無い →「入れないとピンク」
//  🟠 共通テクスチャ/マテリアルの上書き
//  判定=危険。これを"取り込む前"に出す。
const dangerReport = {
  packageFile: 'C:/Downloads/BOOTH/Frill_Onepiece_for_Avatars_1.0.unitypackage',
  fileName: 'Frill_Onepiece_for_Avatars_1.0.unitypackage',
  projectRoot: 'C:/VRChat/Avatars/MyAvatarProject',
  metaCount: 2184,
  incomingCount: 286,
  newCount: 271,
  requires: { liltoon: true, poiyomi: true },
  sharedOverwrite: [
    { guid: g('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'), incomingPath: 'Assets/lilToon/Shader/lts.shader', kind: 'shader', existingPath: 'Packages/jp.lilxyzw.liltoon/Shader/lts.shader', shared: 'lilToon' },
    { guid: g('b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7'), incomingPath: 'Assets/lilToon/Shader/ltspass_opaque.shader', kind: 'shader', existingPath: 'Packages/jp.lilxyzw.liltoon/Shader/ltspass_opaque.shader', shared: 'lilToon' },
    { guid: g('c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8'), incomingPath: 'Assets/lilToon/Editor/lilToonInspector.cs', kind: 'script', existingPath: 'Packages/jp.lilxyzw.liltoon/Editor/lilToonInspector.cs', shared: 'lilToon' },
  ],
  missingShader: ['Poiyomi'],
  guidOverwrite: [
    { guid: g('d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9'), incomingPath: 'Assets/Frill/Textures/noise.png', kind: 'texture', existingPath: 'Assets/Shared/Textures/noise.png' },
    { guid: g('e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'), incomingPath: 'Assets/Frill/Materials/cloth_base.mat', kind: 'material', existingPath: 'Assets/Avatar/Materials/cloth_base.mat' },
  ],
  pathClash: [],
  uncheckFolders: ['Assets/lilToon'],
  looksLikeUpdateOf: undefined,
  benignReimport: false,
  verdict: 'danger',
};

const html = formatDiffHtmlPage([dangerReport]);
const htmlPath = join(OUT, '02-importcheck-demo.html');
writeFileSync(htmlPath, html, 'utf8');
console.log('WROTE ' + htmlPath);
