// 個人用 再現テンプレ: 改変済みアバターのプロジェクトから「自分が作ったファイル」だけを保存し、
// 「どの購入物に依存しているか」をマニフェスト化する。復元時はまっさらなプロジェクトに自作分を戻し、
// 「この購入物は持ってる/これは未所持＝入れ直して」を案内する。
//
// 不変条件（ぷまちゃん事件の地雷を踏まない）:
//   読み取り専用（書き込みは復元先の fresh プロジェクトと --out テンプレフォルダだけ）・
//   購入資産のバイトは一切同梱しない（GUID参照で名指すだけ）・外部通信なし・BOOTHログイン無し。
//
// v0スコープ: 私的再現のみ・単一ベース・派生は「フラグ(警告)」のみ（推移ウォークは v0.5）。
import { readFile, readdir } from 'node:fs/promises';
import { existsSync, mkdirSync, copyFileSync, statSync, writeFileSync, readFileSync, readdirSync, rmSync, lstatSync } from 'node:fs';
import { join, relative, dirname, basename, extname } from 'node:path';
import { guidSetHash } from './sig.js';
import { projectGuids, matchPackages } from './detect.js';
import { classify, type AssetKind } from './classify.js';
import { extractRefs, buildDerivativeInfo, type AuthoredNode } from './refwalk.js';

// YAML本文に他アセットのGUID参照が住む種別（派生ウォークで本文を読む対象）。
const YAML_REF_KINDS = new Set<AssetKind>(['material', 'prefab', 'scene', 'anim', 'asset']);

const TOOL_VERSION = '0.1.0';
const SCHEMA_VERSION = 1 as const;
const GUID_LINE = /guid: ([0-9a-f]{32})/;
// 小規模商品(GUID数が少ない)の偶然一致を「導入済み」と誤判定しないための最小一致数。
// diff.ts の findUpdateMatch が `guids.length < 20` を弾くのと同系統のガード。
const MIN_MATCH = 3;
// 出所不明のまま payload に同梱すると危険な「重いバイナリ」の閾値（テクスチャ）。
const HEAVY_TEX_BYTES = 2 * 1024 * 1024;

// ② ツール/SDK 判定（Assets内に非VPMで入っているツールを「自作」と誤判定してコピーしないため）。
// diff.ts の SHARED 表と同系統だが、こちらの目的は「コピーしない／VPMで復元」の振り分け。
const TOOL_PATHS: { label: string; re: RegExp }[] = [
  { label: 'lilToon', re: /(^|\/)(lilToon|jp\.lilxyzw)/i },
  { label: 'Poiyomi', re: /(^|\/)_?(PoiyomiShaders|com\.poiyomi)/i },
  { label: 'VRCSDK', re: /(^|\/)(VRCSDK|com\.vrchat)/i },
  { label: 'ModularAvatar', re: /(^|\/)(nadena\.dev|ModularAvatar)/i },
  { label: 'VRCFury', re: /(^|\/)(VRCFury|com\.vrcfury)/i },
  { label: 'Thry', re: /(^|\/)_?ThryEditor/i },
  { label: 'DynamicBone', re: /(^|\/)Dynamic ?Bone/i },
];
function toolOf(rel: string): string | undefined {
  for (const t of TOOL_PATHS) if (t.re.test(rel)) return t.label;
  return undefined;
}

// 除外（再生成される / ノイズ / ビルド時生成物）。購入バイトの直接同梱を避ける意味も。
// ※実プロジェクト(new main)での検証で判明: NDMF VRM Exporter の .vrm(182MB)や ZZZ_GeneratedAssets の
//   (Clone)ベイク物(34MB)が「自作」に混ざる＝再生成物かつ購入物の派生＝必ず除外。
const EXCLUDE_RE: { re: RegExp; reason: string }[] = [
  { re: /(^|\/)_VRCFury(\/|$)/i, reason: 'vrcfury-generated' },
  { re: /(^|\/)OptimizedShaders(\/|$)/i, reason: 'poiyomi-locked-generated' },
  { re: /(^|\/)[^/]*Generated ?Assets(\/|$)/i, reason: 'generated-assets' }, // ZZZ_GeneratedAssets 等
  { re: /(^|\/)Generated(\/|$)/i, reason: 'generated' },
  { re: /\(Clone\)(\/|$)/i, reason: 'baked-clone' },                          // ベイク済みクローン
  { re: /(^|\/)NDMF[^/]*Exporter(\/|$)/i, reason: 'ndmf-export-output' },      // NDMF VRM Exporter 出力
  { re: /\.vrm$/i, reason: 'vrm-export' },                                     // .vrmは常にエクスポート物(=再生成・最大派生)
  { re: /(^|\/)VRChatSDKAvatarThumbnails(\/|$)/i, reason: 'sdk-thumbnails' },  // SDK生成サムネ
  { re: /(^|\/)(AvatarOptimizer|Trace ?And ?Optimize)[^/]*\//i, reason: 'optimizer-output' },
  { re: /\.(csproj|sln)$/i, reason: 'ide-noise' },
];
// 走査時に降りないディレクトリ（Unityノイズ + 生成物の親）。scan.ts の SKIP_DIRS と整合。
const SKIP_DIRS = new Set(['Library', 'Temp', 'obj', 'Logs', '.vs', '.git', 'PackageCache', '_VRCFury', 'OptimizedShaders']);

export type Bucket = 'purchased' | 'tool' | 'authored' | 'uncertain' | 'excluded';

export interface TemplateProduct {
  kind: 'booth';
  fileName: string;
  guidSetHash: string;   // 商品GUID集合の md5（版の指紋。復元時に「同じ版か」を検証）
  matched: number;
  total: number;
  pct: number;
  requiresLilToon: boolean;
  requiresPoiyomi: boolean;
  hasLocked: boolean;
  transitive?: boolean;  // GUID一致(導入)では未検出だが、自作物の参照ウォークで判明した依存(v0.5)
}
export interface TemplateTooling { kind: 'vpm'; id: string; version?: string; source: string; }
// derivative: content型(mat/texture)が購入データを参照=派生(v0.5)。共有不可だが private 再現はコピー。
export interface AuthoredFile { relPath: string; kind: AssetKind; guid: string; bytes: number; derivative?: boolean; derivativeOf?: string[]; }
export interface ExcludedFile { relPath: string; reason: string; }
// 出所不明の重いバイナリ（未scanの購入物の可能性）= payload に入れず名指しだけ残す
export interface UncertainFile { relPath: string; kind: AssetKind; guid: string; bytes: number; }

export interface TemplateManifest {
  schemaVersion: typeof SCHEMA_VERSION;
  tool: 'hangar';
  toolVersion: string;
  createdAt: string;
  sourceProject: { name: string; path: string };
  products: TemplateProduct[];
  tooling: TemplateTooling[];
  authored: AuthoredFile[];
  uncertain: UncertainFile[];
  excluded: ExcludedFile[];
  warnings: string[];
  shareSafe: boolean;
}

export interface CatalogPkg { id: number; file_name: string; file_path: string; guids: string[]; requires_liltoon: number; requires_poiyomi: number; has_locked: number; category?: string; }

export interface SaveResult { manifest: TemplateManifest; outDir: string; copiedBytes: number; purchasedSkipped: number; }

// .meta から GUID を読む（先頭だけ）。
async function metaGuid(metaAbs: string): Promise<string | undefined> {
  try {
    const head = (await readFile(metaAbs)).subarray(0, 400).toString('utf8');
    return GUID_LINE.exec(head)?.[1];
  } catch { return undefined; }
}

// 出所不明(=購入物として証明できない)アセットのうち、payload同梱が危険な「重いバイナリ」か。
// 生FBX/メッシュ(model)・音声は事実上常に購入物。テクスチャは大サイズのみ(自作デカール等の小物は通す)。
// ※ .mesh 編集物は classify→'other' なので対象外(=自作の編集物として通す)。
function isHeavyBinary(kind: AssetKind, bytes: number): boolean {
  if (kind === 'model' || kind === 'audio') return true;
  if (kind === 'texture' && bytes > HEAVY_TEX_BYTES) return true;
  return false;
}

// Assets/ 配下を歩いて「アセット本体ファイル(.meta除く・対応する.metaを持つもの)」を列挙。
// symlink は isDirectory/isFile が偽になり黙って落ちる→ onSkip で可視化(silent欠落を防ぐ)。
async function walkAssets(
  root: string,
  onAsset: (abs: string, metaAbs: string) => Promise<void>,
  onSkip: (abs: string, reason: string) => void,
): Promise<void> {
  let ents;
  try { ents = await readdir(root, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(root, e.name);
    if (e.isSymbolicLink()) { onSkip(p, 'symlink-skipped'); continue; }
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walkAssets(p, onAsset, onSkip);
    } else if (e.isFile() && !e.name.endsWith('.meta')) {
      const meta = p + '.meta';
      if (existsSync(meta)) await onAsset(p, meta);
    }
  }
}

// authored ファイルの祖先フォルダの .meta を payload に運ぶ（フォルダGUIDを保存＝フォルダ参照が切れない）。
// 既処理フォルダは done で重複コピーを防ぐ。
function copyAncestorFolderMetas(projectDir: string, payloadRoot: string, rel: string, done: Set<string>): void {
  const parts = rel.split('/');
  // parts[0]='Assets'(.meta無し)、parts[len-1]=ファイル名 → 中間フォルダ Assets/A, Assets/A/B …
  for (let i = 1; i < parts.length - 1; i++) {
    const dirRel = parts.slice(0, i + 1).join('/');
    if (done.has(dirRel)) continue;
    done.add(dirRel);
    const srcMeta = join(projectDir, dirRel) + '.meta';
    if (existsSync(srcMeta)) {
      const dstMeta = join(payloadRoot, dirRel) + '.meta';
      mkdirSync(dirname(dstMeta), { recursive: true });
      copyFileSync(srcMeta, dstMeta);
    }
  }
}

// vpm-manifest.json（あれば）から VPM ツール依存を収穫。dependencies / locked の両方を見る。
// parse失敗は parseError で報告（黙ってツール依存が消える silent wrong を防ぐ）。
function readVpmTooling(projectRoot: string): { tooling: TemplateTooling[]; manifestPath?: string; parseError: boolean } {
  const manifestPath = join(projectRoot, 'Packages', 'vpm-manifest.json');
  if (!existsSync(manifestPath)) return { tooling: [], parseError: false };
  try {
    const j = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, { version?: string } | string>;
      locked?: Record<string, { version?: string } | string>;
    };
    const out = new Map<string, TemplateTooling>();
    const harvest = (obj: Record<string, { version?: string } | string> | undefined, source: string) => {
      for (const [id, v] of Object.entries(obj ?? {})) {
        const version = typeof v === 'string' ? v : v?.version;
        if (!out.has(id)) out.set(id, { kind: 'vpm', id, version, source });
      }
    };
    harvest(j.dependencies, 'vpm-manifest:dependencies');
    harvest(j.locked, 'vpm-manifest:locked');
    return { tooling: [...out.values()], manifestPath, parseError: false };
  } catch { return { tooling: [], manifestPath, parseError: true }; }
}

/**
 * テンプレ保存: projectDir から自作ファイルだけを outDir/payload にコピーし、manifest.json を書く。
 * 購入物のバイトは絶対にコピーしない（products[] に1行記録するだけ）。
 * 安全装置: カタログが空（=scan未実行）だと購入物を区別できない→中断（購入バイトの誤同梱を防ぐ）。
 */
export async function saveTemplate(projectDir: string, outDir: string, catalog: CatalogPkg[]): Promise<SaveResult> {
  if (!existsSync(join(projectDir, 'Assets'))) throw new Error('Unityプロジェクトに見えません(Assets/ が無い): ' + projectDir);

  // 購入物GUID（全カタログ商品のGUID和集合）。アセットのGUIDがここに在れば「購入物＝コピーしない」。
  const allProductGuids = new Set<string>();
  for (const p of catalog) for (const g of p.guids) allProductGuids.add(g);
  // 【安全装置・最重要】カタログが空だと購入物を1つも識別できず、購入アバター本体まで authored 扱いで
  // payload にコピーしてしまう（不変条件＝購入バイト非同梱の崩壊）。よって明示エラーで中断する。
  if (allProductGuids.size === 0) {
    throw new Error('カタログが空です（scan 未実行）。購入物を識別できず安全に自作分を切り出せないため中断しました。先に `hangar scan <ライブラリ>` でライブラリ全体を登録してから再実行してください。');
  }

  // 出力先 payload を作り直す（前回の残骸＝幽霊ファイルが混ざるのを防ぎ payload↔manifest を 1:1 に保つ）。
  const payloadRoot = join(outDir, 'payload');
  if (existsSync(payloadRoot)) rmSync(payloadRoot, { recursive: true, force: true });
  mkdirSync(payloadRoot, { recursive: true });

  const authored: AuthoredFile[] = [];
  const authoredNodes: AuthoredNode[] = [];   // v0.5 派生ウォーク用（本文の guid 参照）
  const uncertain: UncertainFile[] = [];
  const excluded: ExcludedFile[] = [];
  const folderMetaDone = new Set<string>();
  let copiedBytes = 0;
  let purchasedSkipped = 0;

  const assetsRoot = join(projectDir, 'Assets');
  await walkAssets(assetsRoot, async (abs, metaAbs) => {
    const rel = relative(projectDir, abs).replace(/\\/g, '/'); // 例: Assets/Foo/bar.mat
    // 除外（生成物 / ノイズ）
    const ex = EXCLUDE_RE.find(x => x.re.test(rel));
    if (ex) { excluded.push({ relPath: rel, reason: ex.reason }); return; }
    const guid = await metaGuid(metaAbs);
    if (!guid) { excluded.push({ relPath: rel, reason: 'no-guid' }); return; }
    // ① 購入物（GUIDがカタログ商品に存在）→ コピーせず、products[] で名指す
    if (allProductGuids.has(guid)) { purchasedSkipped++; return; }
    // ② ツール/SDK（Assets内に非VPMで入っているもの）→ コピーせず（VPM/再インポートで復元）
    if (toolOf(rel)) { excluded.push({ relPath: rel, reason: 'tool/sdk' }); return; }
    const ext = extname(rel).toLowerCase();          // パス中ドット誤検出を避け basename ベースで取得
    const kind = classify(ext);
    let bytes = 0;
    try { bytes = statSync(abs).size; } catch { /* ignore */ }
    // ③' 出所不明の重いバイナリ（未scanの購入物の可能性）→ payloadに入れず uncertain に隔離（不変条件B保護）
    if (isHeavyBinary(kind, bytes)) { uncertain.push({ relPath: rel, kind, guid, bytes }); return; }
    // ③ プロジェクト固有 → コピー候補（.metaペアで）
    const dst = join(payloadRoot, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(abs, dst);
    copyFileSync(metaAbs, dst + '.meta'); // ⭐ GUIDは.metaに住む＝必ずペアでコピー
    copyAncestorFolderMetas(projectDir, payloadRoot, rel, folderMetaDone); // フォルダGUIDも保存
    copiedBytes += bytes;
    authored.push({ relPath: rel, kind, guid, bytes });
    // v0.5: YAML型は本文の guid 参照を集める（後で推移的に辿り派生/依存を判定）。型(シェーダ/スクリプト)参照は別管理。
    let refs: string[] = [];
    let typeGuids: string[] = [];
    if (YAML_REF_KINDS.has(kind)) { try { const r = extractRefs(await readFile(abs, 'utf8')); refs = r.refs; typeGuids = r.typeGuids; } catch { /* unreadable */ } }
    authoredNodes.push({ relPath: rel, guid, refs, typeGuids });
  }, (abs, reason) => {
    excluded.push({ relPath: relative(projectDir, abs).replace(/\\/g, '/'), reason });
  });

  // 購入物の products[] 行（このプロジェクトに「導入済み」と判定できた商品）。
  // カタログに同一内容の重複コピーがあると matchPackages は物理ファイル毎に1行返す→
  // guidSetHash で1商品に束ねる（最高一致率の行を代表に）。小規模商品の偶然一致は MIN_MATCH で除外。
  const { guids: projGuidSet } = await projectGuids(projectDir);
  const hits = matchPackages(projGuidSet, catalog.map(c => ({ id: c.id, file_name: c.file_name, guids: c.guids })));
  const catById = new Map(catalog.map(c => [c.id, c]));
  const byHash = new Map<string, TemplateProduct>();
  for (const h of hits) {
    if (!h.installed || h.matched < MIN_MATCH) continue;
    const c = catById.get(h.packageId)!;
    const hash = guidSetHash(c.guids);
    const row: TemplateProduct = {
      kind: 'booth',
      fileName: h.fileName,
      guidSetHash: hash,
      matched: h.matched, total: h.total, pct: Math.round(h.pct),
      requiresLilToon: !!c.requires_liltoon,
      requiresPoiyomi: !!c.requires_poiyomi,
      hasLocked: !!c.has_locked,
    };
    const ex = byHash.get(hash);
    if (!ex || row.pct > ex.pct) byHash.set(hash, row);
  }
  const products: TemplateProduct[] = [...byHash.values()].sort((a, b) => b.pct - a.pct);

  // v0.5 派生ウォーク: 自作物の本文 guid 参照を推移的に辿り、購入商品への依存/派生/未解決参照を判定。
  const guidToProduct = new Map<string, string>();   // guid → 商品名（表示用）
  const guidToRow = new Map<string, CatalogPkg>();    // guid → 正確なカタログ行（版突合・同名別版対策）
  for (const c of catalog) for (const g of c.guids) { if (!guidToProduct.has(g)) guidToProduct.set(g, c.file_name); if (!guidToRow.has(g)) guidToRow.set(g, c); }
  const { perFile, referencedProductGuids } = buildDerivativeInfo(authoredNodes, allProductGuids, guidToProduct);
  // 派生フラグ: content型(material/asset)が購入物を参照 = 派生(共有不可)。
  //   - texture は本文に guid 参照を持たない（バイナリ・参照は.meta側）ため検出不能 → ゲートに入れない。
  //   - prefab/scene が購入物を参照するのは“正常な依存”（構造であり中身でない）。購入baseの prefab variant は
  //     厳密には派生だが、通常の「購入物を子に持つ prefab」と本文上の区別が難しいため v0.5 では依存として収穫し、
  //     未解決参照ベースの shareSafe で安全側に倒す（共有時は人間確認を促す）。
  for (const a of authored) {
    const info = perFile.get(a.relPath);
    if (info?.referencesPurchased && (a.kind === 'material' || a.kind === 'asset')) {
      a.derivative = true;
      a.derivativeOf = info.products;
    }
  }
  // 推移的依存: 参照ウォークで判明したがGUID一致(導入)では未検出の購入商品を products[] に追加。
  // file_name でなく解決された guid から正確なカタログ行を引く（同名別版の取り違え=guidSetHash不整合を防ぐ）。
  const presentNames = new Set(products.map(p => p.fileName));
  for (const g of referencedProductGuids) {
    const c = guidToRow.get(g);
    if (!c || presentNames.has(c.file_name)) continue;
    products.push({
      kind: 'booth', fileName: c.file_name, guidSetHash: guidSetHash(c.guids),
      matched: 0, total: c.guids.length, pct: 0,
      requiresLilToon: !!c.requires_liltoon, requiresPoiyomi: !!c.requires_poiyomi, hasLocked: !!c.has_locked,
      transitive: true,
    });
    presentNames.add(c.file_name);
  }
  const derivatives = authored.filter(a => a.derivative);
  // 未識別参照(未scan購入物の疑い): マテリアルが、シェーダ(型)以外で購入カタログにも自作にも組み込みにも
  //   解決できない guid（＝テクスチャ等のコンテンツ参照）を持つ件数。1つでもあれば「共有安全」を主張しない(fail-safe)。
  //   ※ .asset はXR設定等の“プロジェクト構成”でUnityパッケージGUIDを参照しがち→ノイズが多いので未識別ゲートはmaterial限定。
  //     .asset が購入カタログを参照する明確な派生は上の derivative ゲート(material||asset)で拾う。
  let unverifiable = 0;
  const unverifiableSamples: string[] = [];
  for (const a of authored) {
    if (a.kind !== 'material') continue;
    const info = perFile.get(a.relPath);
    if (info && info.unresolved > 0) { unverifiable++; if (unverifiableSamples.length < 5) unverifiableSamples.push(a.relPath); }
  }
  // 自作アニメが購入物を参照 → 文字列パス束縛の依存は自動検出が限定的なので注意喚起する。
  const authoredAnimRefsPurchased = authored.some(a => a.kind === 'anim' && perFile.get(a.relPath)?.referencesPurchased);

  // ② ツール（VPM）
  const { tooling, manifestPath, parseError } = readVpmTooling(projectDir);

  // 任意の付随物: ProjectSettings/ と vpm-manifest.json をテンプレに同梱（再現の助け・購入バイトでない）。
  // vpm-manifest は復元時に projectDir/Packages/ に着地するよう payload/Packages/ に置く（VCC/ALCOMが読む位置）。
  copyDirInto(join(projectDir, 'ProjectSettings'), join(payloadRoot, 'ProjectSettings'));
  if (manifestPath && existsSync(manifestPath)) {
    const dstManifest = join(payloadRoot, 'Packages', 'vpm-manifest.json');
    mkdirSync(dirname(dstManifest), { recursive: true });
    copyFileSync(manifestPath, dstManifest);
  }

  // 警告
  const warnings: string[] = [];
  if (!products.length) warnings.push('カタログに一致する購入物が見つかりません（このプロジェクトの購入物が未scanの可能性）。ライブラリ全体を scan してから再実行すると依存を正確に名指しできます。');
  if (uncertain.length) warnings.push(`${uncertain.length} 個の出所不明の重いバイナリ（FBX/音声/大テクスチャ）を payload に入れませんでした（未scanの購入物の可能性＝誤同梱回避）。manifest.uncertain に列挙。ライブラリ全体を scan して再実行すると正しく購入物として名指しできます。`);
  if (derivatives.length) {
    const ex = derivatives.slice(0, 5).map(d => `${d.relPath}→[${(d.derivativeOf ?? []).join(', ')}]`);
    warnings.push(`${derivatives.length} 個の自作マテリアル/asset が購入データ（テクスチャ等）を参照する派生物です（共有・配布すると派生物の再配布になり得ます＝private再現のみに使用してください）。例: ${ex.join(' / ')}`);
  }
  if (unverifiable) {
    warnings.push(`${unverifiable} 個の自作マテリアル/asset が未識別のアセット（購入カタログにも自作にもツールにも解決できないGUID）を参照しています＝未scanの購入物の可能性。共有前にライブラリ全体を scan して再確認してください。例: ${unverifiableSamples.join(' , ')}`);
  }
  if (authoredAnimRefsPurchased) {
    warnings.push('自作アニメ(.anim/.controller)が購入物を参照しています。アニメは購入メッシュ/階層に文字列パスでも束縛され得るため依存の自動検出は限定的です（対象アバター未所持だと再生対象が解決できません）。');
  }
  if (parseError) warnings.push('Packages/vpm-manifest.json を解析できませんでした（VPMツール依存を収集できていません）。復元時のツール一覧が不完全な可能性があります。');
  // shareSafe(fail-safe): 派生・出所不明バイナリ・未識別参照が無く、かつ購入物が実際に検出できている時のみ true。
  // 「未scanの購入物への参照は検出できない」ため、判定は scan 済みライブラリへの依存であることを文言で必ず開示する。
  const shareSafe = derivatives.length === 0 && uncertain.length === 0 && unverifiable === 0 && products.length > 0;
  warnings.push(shareSafe
    ? 'このテンプレは（scan済みライブラリに基づき）派生物・出所不明物・未識別参照を検出しませんでした＝購入物を持つ相手との共有も比較的安全です。※ライブラリ全体を scan 済みである前提で、未scanの購入物への参照は検出できません。自動DL・厳密な版固定は未対応。'
    : 'このテンプレは「私的再現」専用です（派生物/出所不明物/未識別参照を含む、または購入物が未検出のため、共有・配布は避けてください）。');

  const manifest: TemplateManifest = {
    schemaVersion: SCHEMA_VERSION,
    tool: 'hangar',
    toolVersion: TOOL_VERSION,
    createdAt: new Date().toISOString(),
    sourceProject: { name: basename(projectDir.replace(/[\\/]+$/, '')) || projectDir, path: projectDir },
    products, tooling, authored, uncertain, excluded, warnings,
    shareSafe,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return { manifest, outDir, copiedBytes, purchasedSkipped };
}

// ---------- 復元 ----------

export type RestoreStatus = 'present' | 'reimport' | 'missing';
export interface RestoreProductRow {
  fileName: string;
  status: RestoreStatus;            // present=再インポート済 / reimport=ライブラリに有・入れ直して / missing=ライブラリに無い
  libraryPath?: string;             // 所持していれば再インポート元のパス
  versionMatch?: boolean;           // true=guidSetHash一致 / false=別版疑い / undefined=名前一致のみ(不明)
  requires: { liltoon: boolean; poiyomi: boolean };
}
export interface RestoreReport {
  templateDir: string;
  projectDir: string;
  copiedFiles: number;
  overwrittenFiles: number;
  skippedFiles: number;             // 既存のため上書きせず保護した数（--force無し時）
  products: RestoreProductRow[];
  tooling: TemplateTooling[];
  warnings: string[];
}

/**
 * テンプレ復元: payload を fresh プロジェクトへコピーし、購入物の「持ってる/入れ直して/未所持」台帳を作る。
 * hangar は DLしない・BOOTHにログインしない・.unitypackageを編集しない。所持品のどれを再インポートすべきか告げるだけ。
 * 既定では既存ファイルを上書きしない（元プロジェクト破壊を防ぐ）。force=true で明示的に上書き。
 */
export async function restoreTemplate(templateDir: string, projectDir: string, catalog: CatalogPkg[], opts: { force?: boolean } = {}): Promise<RestoreReport> {
  const manifestPath = join(templateDir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error('テンプレに manifest.json がありません: ' + templateDir);
  let manifest: TemplateManifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as TemplateManifest; }
  catch { throw new Error('manifest.json を解析できません（壊れている可能性）: ' + manifestPath); }
  // スキーマ検証（将来版/別ツール/破損を黙って読まない）
  if (manifest.tool !== 'hangar') throw new Error('hangar のテンプレではありません（tool=' + String(manifest.tool) + '）');
  if (manifest.schemaVersion !== SCHEMA_VERSION) throw new Error(`対応していないテンプレ版です（schemaVersion=${String(manifest.schemaVersion)} / このhangarは ${SCHEMA_VERSION}）`);
  if (!Array.isArray(manifest.products)) throw new Error('テンプレが壊れています（products が配列でない）');
  if (!existsSync(join(projectDir, 'Assets'))) throw new Error('復元先がUnityプロジェクトに見えません(Assets/ が無い): ' + projectDir);

  // 1. payload を fresh プロジェクトへコピー（書き込みはこの projectDir のみ）。
  //    自作アセット(payload/Assets)だけを Assets へ復元。ProjectSettings/Packages は復元先プロジェクトの設定を
  //    尊重し「既存があれば触らない」(--force 時のみ上書き)＝他人のプロジェクト設定/VPM構成を汚染しない。
  const payloadRoot = join(templateDir, 'payload');
  let copied = 0, overwritten = 0, skipped = 0;
  const payAssets = join(payloadRoot, 'Assets');
  if (existsSync(payAssets)) {
    const res = copyTreeCounting(payAssets, join(projectDir, 'Assets'), { force: !!opts.force });
    copied = res.copied; overwritten = res.overwritten; skipped = res.skipped;   // 件数は自作ファイルのみ
  }
  for (const name of ['ProjectSettings', 'Packages']) {
    const src = join(payloadRoot, name);
    if (!existsSync(src)) continue;
    const dst = join(projectDir, name);
    if (existsSync(dst) && !opts.force) continue;   // 復元先の既存設定/VPM構成は保護
    copyTreeCounting(src, dst, { force: !!opts.force });
  }

  // 2. 照合台帳。復元後の fresh プロジェクトGUIDで「もう再インポート済みか」を判定。
  const { guids: freshGuids } = await projectGuids(projectDir);
  // カタログを guidSetHash と file_name で引けるように。
  const catByHash = new Map<string, CatalogPkg>();
  const catByName = new Map<string, CatalogPkg>();
  for (const c of catalog) {
    catByHash.set(guidSetHash(c.guids), c);
    if (!catByName.has(c.file_name)) catByName.set(c.file_name, c);
  }
  const products: RestoreProductRow[] = manifest.products.map(p => {
    const byHashOwned = catByHash.get(p.guidSetHash);
    const owned = byHashOwned ?? catByName.get(p.fileName);
    const requires = { liltoon: p.requiresLilToon, poiyomi: p.requiresPoiyomi };
    // hash一致=版一致と判定 / 名前のみ一致=版は不明(undefined)。誤った版ドリフト警告を出さない。
    const versionMatch: boolean | undefined = byHashOwned ? true : undefined;
    if (owned) {
      // 既に fresh プロジェクトへ再インポートされたか？（GUID集合の重なりで判定・小商品偶然一致は除外）
      const hit = matchPackages(freshGuids, [{ id: owned.id, file_name: owned.file_name, guids: owned.guids }])[0]!;
      const present = hit.installed && hit.matched >= MIN_MATCH;
      return { fileName: p.fileName, status: present ? 'present' : 'reimport', libraryPath: owned.file_path, versionMatch, requires };
    }
    return { fileName: p.fileName, status: 'missing', requires };
  });

  const warnings = [...(Array.isArray(manifest.warnings) ? manifest.warnings : [])];
  const drifted = products.filter(p => p.status !== 'missing' && p.versionMatch === false);
  if (drifted.length) warnings.push(`${drifted.length} 件の購入物がライブラリと別の版の可能性（GUID指紋が不一致）。作者の作り直し等で参照がずれることがあります。`);
  if (skipped) warnings.push(`${skipped} 個の既存ファイルを上書きせず保護しました（復元先が空ではありません）。上書きして復元するには --force を付けてください。`);
  const authoredCount = Array.isArray(manifest.authored) ? manifest.authored.length : 0;
  if (authoredCount > 0 && copied === 0 && overwritten === 0 && skipped === 0) warnings.push('payload が見つからない/空でした。テンプレが壊れている可能性があります（自作ファイルが復元されていません）。');

  return { templateDir, projectDir, copiedFiles: copied, overwrittenFiles: overwritten, skippedFiles: skipped, products, tooling: Array.isArray(manifest.tooling) ? manifest.tooling : [], warnings };
}

// ---------- 小物 ----------

// dir を dst へ丸ごとコピー（.meta 等もそのまま）。存在しなければ何もしない。既定 no-overwrite。
function copyDirInto(srcDir: string, dstDir: string): void {
  if (!existsSync(srcDir)) return;
  copyTreeCounting(srcDir, dstDir, { force: false });
}

// src ツリーを dst へコピー。既定では既存ファイルを上書きしない(force=trueで上書き)。件数を返す。
function copyTreeCounting(src: string, dst: string, opts: { force: boolean }): { copied: number; overwritten: number; skipped: number } {
  let copied = 0, overwritten = 0, skipped = 0;
  const stack: { s: string; d: string }[] = [{ s: src, d: dst }];
  while (stack.length) {
    const { s, d } = stack.pop()!;
    let ents;
    try { ents = readdirSync(s, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const sp = join(s, e.name), dp = join(d, e.name);
      if (e.isSymbolicLink()) continue;            // テンプレ内のsymlinkは追わない
      if (e.isDirectory()) stack.push({ s: sp, d: dp });
      else if (e.isFile()) {
        const exists = existsSync(dp);
        if (exists && !opts.force) { skipped++; continue; } // no-overwrite: 既存を保護
        mkdirSync(dirname(dp), { recursive: true });
        copyFileSync(sp, dp);
        if (exists) overwritten++; else copied++;
      }
    }
  }
  return { copied, overwritten, skipped };
}

// ---------- テキスト整形(CLI) ----------

export function formatSaveText(r: SaveResult): string {
  const m = r.manifest;
  const L: string[] = [];
  L.push(`=== テンプレ保存: ${m.sourceProject.name}`);
  L.push(`    出力: ${r.outDir}  (payload/ ＋ manifest.json)`);
  L.push(`    自作ファイル ${m.authored.length} 個コピー (${(r.copiedBytes / 1048576).toFixed(1)}MB) / 除外 ${m.excluded.length} / 購入物スキップ ${r.purchasedSkipped}`);
  L.push(`    共有安全(shareSafe): ${m.shareSafe ? '✓ はい（派生物・出所不明物なし）' : '✗ いいえ（private再現専用）'}`);
  L.push('');
  L.push(`📦 依存する購入物 (${m.products.length})  ＝バイトは同梱せず名指しのみ（復元時に再インポート）`);
  for (const p of m.products.slice(0, 30)) {
    const need = [p.requiresLilToon ? 'lil' : '', p.requiresPoiyomi ? 'Poi' : '', p.hasLocked ? 'locked' : ''].filter(Boolean).join('/');
    const tag = p.transitive ? ' 〔参照のみ〕' : ` (${p.pct}% 一致)`;
    L.push(`    ・${p.fileName} ${tag}${need ? ' ・要' + need : ''}`);
  }
  if (m.products.length > 30) L.push(`    … 他 ${m.products.length - 30} 件`);
  const derivs = m.authored.filter(a => a.derivative);
  if (derivs.length) {
    L.push('');
    L.push(`⚠ 派生物 (${derivs.length})  ＝購入データを参照する自作マテリアル/asset（共有不可・private再現のみ）`);
    for (const d of derivs.slice(0, 10)) L.push(`    ・${d.relPath}  → 参照: ${(d.derivativeOf ?? []).join(', ')}`);
    if (derivs.length > 10) L.push(`    … 他 ${derivs.length - 10} 件`);
  }
  if (m.uncertain.length) {
    L.push('');
    L.push(`❓ 出所不明の重いバイナリ (${m.uncertain.length})  ＝payload非同梱（未scanの購入物の可能性）`);
    for (const u of m.uncertain.slice(0, 10)) L.push(`    ・${u.relPath}  (${(u.bytes / 1048576).toFixed(1)}MB)`);
    if (m.uncertain.length > 10) L.push(`    … 他 ${m.uncertain.length - 10} 件`);
  }
  if (m.tooling.length) {
    L.push('');
    L.push(`⚙ ツール/SDK (VPM) (${m.tooling.length})  ＝VCC/ALCOMで復元`);
    for (const t of m.tooling.slice(0, 20)) L.push(`    ・${t.id}${t.version ? ' @' + t.version : ''}`);
  }
  if (m.warnings.length) {
    L.push('');
    L.push('⚠ 注意:');
    for (const w of m.warnings) L.push(`    - ${w}`);
  }
  L.push('');
  L.push('復元: hangar restore-template ' + r.outDir + ' --project <まっさらなプロジェクト>');
  return L.join('\n');
}

export function formatRestoreText(r: RestoreReport): string {
  const L: string[] = [];
  L.push(`=== テンプレ復元: → ${r.projectDir}`);
  L.push(`    自作ファイル ${r.copiedFiles} 個を配置` +
    (r.overwrittenFiles ? `（うち上書き ${r.overwrittenFiles}）` : '') +
    (r.skippedFiles ? `（既存保護のためスキップ ${r.skippedFiles}・上書きは --force）` : ''));
  L.push('');
  const present = r.products.filter(p => p.status === 'present');
  const reimport = r.products.filter(p => p.status === 'reimport');
  const missing = r.products.filter(p => p.status === 'missing');
  L.push(`購入物の照合台帳 (${r.products.length}): ✓所持済${present.length} / ⟳要再インポート${reimport.length} / ✗未所持${missing.length}`);
  if (reimport.length) {
    L.push('');
    L.push('⟳ 持っています → Unityでこの .unitypackage を再インポート（GUID保存で参照が戻ります）:');
    for (const p of reimport) {
      L.push(`    ・${p.fileName}${p.versionMatch === false ? '  ⚠別の版かも' : ''}`);
      if (p.libraryPath) L.push(`        ${p.libraryPath}`);
    }
  }
  if (missing.length) {
    L.push('');
    L.push('✗ ライブラリに見当たりません → 入手して再インポートしてください:');
    for (const p of missing) L.push(`    ・${p.fileName}`);
  }
  if (present.length) {
    L.push('');
    L.push(`✓ 再インポート済み (${present.length}): ` + present.map(p => p.fileName).join(' , '));
  }
  if (r.tooling.length) {
    L.push('');
    L.push(`⚙ ツール/SDK は VCC/ALCOM で導入 (${r.tooling.length}):`);
    for (const t of r.tooling.slice(0, 20)) L.push(`    ・${t.id}${t.version ? ' @' + t.version : ''}`);
  }
  if (r.warnings.length) {
    L.push('');
    L.push('⚠ 注意:');
    for (const w of r.warnings) L.push(`    - ${w}`);
  }
  L.push('');
  L.push('→ 未所持/要再インポートを入れ直す → prefab を開く＝非破壊で再構築。入れ直したら restore-template を再実行すると ✓ に変わります。');
  return L.join('\n');
}
