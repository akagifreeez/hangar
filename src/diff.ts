// インポート前 競合diff: これから取り込む .unitypackage を、対象UnityプロジェクトのGUIDと突き合わせ、
// 「取り込むと既存の何が上書き(=ダウングレード)されるか」「逆に足りないシェーダは何か」を取り込む前に出す。
// Unityは同一GUIDの「書込み可能アセット」を警告なく置き換える(不変のPackages/やパス衝突は警告は出るが見落としやすい)。その競合を取り込み前に出す。
// 完全ローカル・読み取り専用・ファイルは一切変更しない。
import { parsePackage } from './unitypackage.js';
import { projectIndex } from './detect.js';
import type { AssetKind } from './classify.js';

// 共有ライブラリ判定表。これらのGUID衝突は「ピンク化/全アバター巻き添え」の高危険。
// isShader=true(Poiyomi/lilToン)が最も危険(シェーダ降格)。
const SHARED: { label: string; re: RegExp; isShader: boolean }[] = [
  { label: 'Poiyomi', re: /(^|\/)_?PoiyomiShaders(\/|$)/i, isShader: true },
  { label: 'Poiyomi', re: /(^|\/)com\.poiyomi/i, isShader: true },
  { label: 'lilToon', re: /(^|\/)lilToon(\/|$)/i, isShader: true },
  { label: 'lilToon', re: /(^|\/)jp\.lilxyzw/i, isShader: true },
  { label: 'VRCSDK', re: /(^|\/)(VRCSDK|com\.vrchat)/i, isShader: false },
  { label: 'ModularAvatar', re: /(^|\/)(nadena\.dev|ModularAvatar)/i, isShader: false },
  { label: 'VRCFury', re: /(^|\/)(VRCFury|com\.vrcfury)/i, isShader: false },
  { label: 'DynamicBone', re: /(^|\/)Dynamic ?Bone/i, isShader: false },
  { label: 'Thry', re: /(^|\/)_?ThryEditor/i, isShader: false },
];

function sharedOf(pathname: string): { label: string; isShader: boolean } | undefined {
  for (const s of SHARED) if (s.re.test(pathname)) return { label: s.label, isShader: s.isShader };
  return undefined;
}

export type Verdict = 'clean' | 'review' | 'danger';

export interface Conflict {
  guid: string;
  incomingPath: string;        // 取り込む側のパス
  kind: AssetKind;
  existingPath?: string;       // GUID衝突: プロジェクト側の現パス
  pathClashGuid?: string;      // パス衝突: 同パスにある別GUID
  shared?: string;             // 共有ライブラリ名(Poiyomi/lilToon/VRCSDK...)
}

export interface UpdateMatch { product: string; overlapPct: number; installedHere: boolean; }

export interface DiffReport {
  packageFile: string;
  fileName: string;
  projectRoot: string;
  metaCount: number;
  incomingCount: number;       // 取り込む実アセット数(フォルダ除く)
  newCount: number;
  requires: { liltoon: boolean; poiyomi: boolean }; // 取り込み側が要求するシェーダ
  sharedOverwrite: Conflict[]; // 🔴 共有シェーダ/lib 上書き
  missingShader: ('lilToon' | 'Poiyomi')[]; // 🟣 依存欠落
  guidOverwrite: Conflict[];   // 🟠 その他の上書き
  pathClash: Conflict[];       // 🟡 別GUIDの同パス
  uncheckFolders: string[];    // Unityインポート窓で外すと安全なフォルダ
  looksLikeUpdateOf?: UpdateMatch;
  benignReimport: boolean;     // 既導入商品を同じ場所へ再取込(=良性)。共有libの別場所重複がある時はfalse
  verdict: Verdict;
}

export interface CatalogProduct { id: number; file_name: string; guids: string[]; }

// トップ階層フォルダを取り出す(Assets/_PoiyomiShaders/... → Assets/_PoiyomiShaders)
function topFolder(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.slice(0, 2).join('/');
}

function findUpdateMatch(incoming: Set<string>, projectG: Set<string>, products: CatalogProduct[]): UpdateMatch | undefined {
  let best: UpdateMatch | undefined;
  for (const p of products) {
    if (p.guids.length < 20) continue;                   // 小さすぎる断片商品は誤一致(100%)で良性/危険を歪めるため除外
    let inter = 0;
    for (const g of p.guids) if (incoming.has(g)) inter++;
    const overlapPct = (100 * inter) / p.guids.length;
    if (overlapPct < 70) continue;                       // 取り込みが既知商品と高一致
    let instMatch = 0;
    for (const g of p.guids) if (projectG.has(g)) instMatch++;
    const installedHere = (100 * instMatch) / p.guids.length >= 30; // その商品がこのプロジェクトに導入済み
    if (!best || overlapPct > best.overlapPct) {
      best = { product: p.file_name, overlapPct: Math.round(overlapPct), installedHere };
    }
  }
  return best;
}

export async function diffImport(packageFile: string, projectRoot: string, products: CatalogProduct[] = []): Promise<DiffReport> {
  const pkg = await parsePackage(packageFile);          // 未登録の新規DLでもOK(展開しない)
  const idx = await projectIndex(projectRoot, { includePackages: true }); // VPMシェーダとの衝突も見る
  const projectG = new Set(idx.guidToPath.keys());

  const sharedOverwrite: Conflict[] = [];
  const guidOverwrite: Conflict[] = [];
  const pathClash: Conflict[] = [];
  let incomingCount = 0;
  let newCount = 0;
  const uncheck = new Set<string>();

  for (const e of pkg.entries) {
    if (e.kind === 'folder' || !e.pathname) continue;   // フォルダ/パス無しは無視
    incomingCount++;
    const existingPath = idx.guidToPath.get(e.guid);
    if (existingPath !== undefined) {
      // GUID衝突 = 取り込む側で既存アセットの中身が置き換わる(incoming wins)
      const sh = sharedOf(e.pathname);
      if (sh || e.kind === 'shader') {
        sharedOverwrite.push({ guid: e.guid, incomingPath: e.pathname, kind: e.kind, existingPath, shared: sh?.label ?? 'shader' });
        uncheck.add(topFolder(e.pathname));
      } else {
        guidOverwrite.push({ guid: e.guid, incomingPath: e.pathname, kind: e.kind, existingPath });
        uncheck.add(topFolder(e.pathname));
      }
    } else {
      const otherGuid = idx.pathToGuid.get(e.pathname);
      if (otherGuid !== undefined && otherGuid !== e.guid) {
        pathClash.push({ guid: e.guid, incomingPath: e.pathname, kind: e.kind, pathClashGuid: otherGuid });
      } else {
        newCount++;
      }
    }
  }

  // 🟣 依存欠落: この商品が要求するシェーダを対象プロジェクトが持っていない
  const missingShader: ('lilToon' | 'Poiyomi')[] = [];
  if (pkg.shaders.liltoon && !idx.hasLilToon) missingShader.push('lilToon');
  if (pkg.shaders.poiyomi && !idx.hasPoiyomi) missingShader.push('Poiyomi');

  const looksLikeUpdateOf = findUpdateMatch(new Set(pkg.guids), projectG, products);

  // 共有lib衝突のうち「別の場所」に既存があるもの = 二重定義/競合の真の危険(例: VPMのlilToン × 同梱lilToン)。
  // 「同じ場所」への上書きは(同一商品の再取込なら)良性。
  const crossLocShared = sharedOverwrite.filter(c => c.existingPath && c.incomingPath !== c.existingPath);
  // 良性の再取込: 既導入商品と高一致 かつ 別場所の共有lib重複が無い
  const benignReimport = !!looksLikeUpdateOf?.installedHere && crossLocShared.length === 0;

  // verdict: 依存欠落/別場所の共有lib重複/(良性再取込でない)共有上書き → danger / その他上書き・パス衝突 → review
  let verdict: Verdict = 'clean';
  if (sharedOverwrite.length || guidOverwrite.length || pathClash.length) verdict = 'review';
  if (missingShader.length || crossLocShared.length || (sharedOverwrite.length && !benignReimport)) verdict = 'danger';

  // アンチェック推奨: 共有libを優先して並べる
  const uncheckFolders = [...uncheck].sort((a, b) => {
    const sa = sharedOf(a) ? 0 : 1, sb = sharedOf(b) ? 0 : 1;
    return sa - sb || a.localeCompare(b);
  });

  return {
    packageFile, fileName: pkg.fileName, projectRoot,
    metaCount: idx.metaCount, incomingCount, newCount,
    requires: { liltoon: pkg.shaders.liltoon, poiyomi: pkg.shaders.poiyomi },
    sharedOverwrite, missingShader, guidOverwrite, pathClash,
    uncheckFolders, looksLikeUpdateOf, benignReimport, verdict,
  };
}

// ---------- テキスト整形(CLI) ----------
export function formatDiffText(r: DiffReport): string {
  const L: string[] = [];
  const upd = r.looksLikeUpdateOf;
  L.push(`=== インポート前チェック: ${r.fileName}`);
  L.push(`    対象: ${r.projectRoot}  (.meta ${r.metaCount} / 既存GUID ${r.metaCount ? '索引済' : '0'})`);
  L.push(`    取り込み ${r.incomingCount} アセット → 新規 ${r.newCount} / 上書き ${r.sharedOverwrite.length + r.guidOverwrite.length}` +
    (r.pathClash.length ? ` / パス衝突 ${r.pathClash.length}` : ''));
  if (upd && upd.installedHere) {
    L.push(`    ℹ 既知商品「${upd.product}」と一致(${upd.overlapPct}%)` + (r.benignReimport ? ' → 同じ場所への再取込＝上書きは想定内' : ' だが下記の競合あり'));
  }

  if (r.sharedOverwrite.length) {
    const shaders = r.sharedOverwrite.filter(c => sharedOf(c.incomingPath)?.isShader || c.kind === 'shader');
    L.push('');
    L.push(`🔴 共有シェーダ/ライブラリの衝突 (${r.sharedOverwrite.length})${shaders.length ? '  ＝シェーダ競合/ピンク化の恐れ' : ''}`);
    for (const c of r.sharedOverwrite.slice(0, 12)) {
      L.push(`    [${c.shared}] ${c.incomingPath}`);
      if (c.existingPath?.startsWith('Packages/')) {
        // Packages/ は不変。Unityは同梱版を取り込まず無視し、VPM版が残る。だが同梱マテリアル等がGUID重複で参照ずれ/エラーを起こしうる。
        L.push(`        → VPMで導入済み(${c.existingPath})。同梱版はGUID重複扱い→参照ずれ/コンソールエラーの恐れ。同梱フォルダは外すのが安全`);
      } else if (c.existingPath && c.existingPath !== c.incomingPath) {
        L.push(`        → 別の場所に既存(${c.existingPath})＝GUID二重定義の恐れ`);
      } else {
        L.push(`        → あなたの ${c.existingPath} を上書き(版が違えばダウングレード)`);
      }
    }
    if (r.sharedOverwrite.length > 12) L.push(`    … 他 ${r.sharedOverwrite.length - 12} 件`);
    if (!r.benignReimport) L.push(`    対策: Unityのインポート窓で該当フォルダのチェックを外す(互換版を既に所持の場合)`);
  }

  if (r.missingShader.length) {
    L.push('');
    L.push(`🟣 必要シェーダの欠落 (${r.missingShader.length})  ＝入れないとピンク`);
    for (const s of r.missingShader) L.push(`    この商品は ${s} が必要ですが、対象プロジェクトに見当たりません → 先に ${s} を導入を`);
  } else if (r.requires.liltoon || r.requires.poiyomi) {
    L.push('');
    const need = [r.requires.liltoon ? 'lilToン' : '', r.requires.poiyomi ? 'Poiyomi' : ''].filter(Boolean).join('+');
    L.push(`🟣 必要シェーダ: OK (${need} は対象プロジェクトに存在)`);
  }

  if (r.guidOverwrite.length) {
    L.push('');
    const tag = r.benignReimport ? '（更新版＝想定内）' : '';
    L.push(`🟠 その他の上書き (${r.guidOverwrite.length}) ${tag}`);
    for (const c of r.guidOverwrite.slice(0, 8)) L.push(`    ${c.incomingPath}  →  ${c.existingPath}`);
    if (r.guidOverwrite.length > 8) L.push(`    … 他 ${r.guidOverwrite.length - 8} 件`);
  }

  if (r.pathClash.length) {
    L.push('');
    L.push(`🟡 パス衝突(別GUIDが同じ場所へ) (${r.pathClash.length})  ＝参照切れの恐れ`);
    for (const c of r.pathClash.slice(0, 8)) L.push(`    ${c.incomingPath}`);
    if (r.pathClash.length > 8) L.push(`    … 他 ${r.pathClash.length - 8} 件`);
  }

  L.push('');
  const verdictLine = r.verdict === 'danger' ? '⚠ 危険 — 取り込み前に確認を'
    : r.verdict === 'review' ? '△ レビュー推奨'
    : '✓ 衝突なし — 安全に取り込めます';
  L.push(`判定: ${verdictLine}`);
  if (r.uncheckFolders.length && !r.benignReimport) {
    L.push(`推奨アンチェック: ${r.uncheckFolders.slice(0, 6).join(' , ')}`);
  }
  return L.join('\n');
}
