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
