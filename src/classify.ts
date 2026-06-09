// アセット種別の分類（拡張子 + asset.meta の Importer 種別）
export type AssetKind =
  | 'model' | 'texture' | 'material' | 'prefab' | 'shader'
  | 'anim' | 'script' | 'audio' | 'scene' | 'asset' | 'vrm'
  | 'plugin' | 'text' | 'folder' | 'other';

const IMPORTER_KEYS = [
  'ModelImporter', 'TextureImporter', 'NativeFormatImporter', 'MonoImporter',
  'ShaderImporter', 'AudioImporter', 'DefaultImporter', 'PluginImporter',
  'PrefabImporter', 'SpeedTreeImporter', 'TrueTypeFontImporter', 'VideoClipImporter',
];

export function importerOf(metaText: string): string | undefined {
  for (const k of IMPORTER_KEYS) {
    if (metaText.startsWith(k + ':') || metaText.includes('\n' + k + ':')) return k;
  }
  return undefined;
}

// パッケージ全体の分類: 3Dモデル(アバター/衣装/小物) か ツール(シェーダ/SDK/エディタ拡張) か等。
// 実ライブラリ実測の分離: ツールは asmdef / 大量shader / 高script比 / Editor配下 が点灯し、
// 3Dコンテンツはこれらが軒並みゼロ。しきい値はその実測に基づく。
export type PackageCategory = 'tool' | 'model' | 'animation' | 'material' | 'other';

export interface CategorySignals {
  script: number; shader: number; model: number; prefab: number;
  texture: number; material: number; anim: number;
  asmdef: number; editor: number; fileCount: number;
}

export function classifyPackage(s: CategorySignals): PackageCategory {
  const hasMesh = s.model >= 1 || s.prefab >= 2;
  // ツール度(コード/シェーダ/エディタ) と コンテンツ度(メッシュ/テクスチャ/マテリアル/アニメ) を比較。
  // アバター実体はコンテンツ度が圧倒するので、Poiyomi等のシェーダや ModularAvatar(asmdef) を同梱していても
  // 'model' のまま＝購入アバターをツールに誤分類しない(派生検出の握りつぶしを構造的に防ぐ安全側)。
  const toolScore = s.script + s.shader + s.asmdef * 10 + s.editor;
  const contentScore = s.model * 10 + s.prefab * 5 + s.texture + s.material + s.anim;
  const toolFingerprint = s.asmdef >= 1 || s.shader >= 10 || s.script >= 8 || s.editor >= 5;
  if (toolFingerprint && toolScore > contentScore) return 'tool';
  // 3Dモデル: メッシュ/アバター実体(fbx/prefab)を持つ。アバター本体・衣装・小物。
  if (hasMesh) return 'model';
  // アニメ/モーション: anim主体でメッシュを持たない。
  if (s.anim >= 5 && s.script === 0 && s.shader === 0) return 'animation';
  // マテリアル/テクスチャ パック: メッシュ無しでmat/texが主体。
  if ((s.material + s.texture) >= 3 && (s.material + s.texture) >= s.fileCount * 0.5) return 'material';
  return 'other';
}

export function categoryLabel(c: PackageCategory): string {
  return c === 'tool' ? 'ツール' : c === 'model' ? '3Dモデル' : c === 'animation' ? 'アニメ' : c === 'material' ? 'マテリアル' : 'その他';
}

export function classify(ext: string, importer?: string): AssetKind {
  ext = ext.toLowerCase();
  if (importer === 'ModelImporter' || ['.fbx', '.obj', '.dae', '.blend'].includes(ext)) return 'model';
  if (importer === 'TextureImporter' || ['.png', '.jpg', '.jpeg', '.tga', '.psd', '.tif', '.exr', '.gif'].includes(ext)) return 'texture';
  if (ext === '.mat') return 'material';
  if (ext === '.prefab') return 'prefab';
  if (ext === '.shader' || importer === 'ShaderImporter') return 'shader';
  if (['.anim', '.controller', '.overridecontroller'].includes(ext)) return 'anim';
  if (ext === '.cs' || importer === 'MonoImporter') return 'script';
  if (['.wav', '.mp3', '.ogg', '.aiff'].includes(ext) || importer === 'AudioImporter') return 'audio';
  if (ext === '.unity') return 'scene';
  if (ext === '.vrm') return 'vrm';
  if (ext === '.dll' || importer === 'PluginImporter') return 'plugin';
  if (ext === '.asset') return 'asset';
  if (['.json', '.txt', '.md', '.shadergraph', '.hlsl', '.cginc', '.ttf', '.otf'].includes(ext)) return 'text';
  return ext ? 'other' : 'folder';
}
