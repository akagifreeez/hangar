// インポート前 競合diff: これから取り込む .unitypackage を、対象UnityプロジェクトのGUIDと突き合わせ、
// 「取り込むと既存の何が上書き(=ダウングレード)されるか」「逆に足りないシェーダは何か」を取り込む前に出す。
// Unityは同一GUIDの「書込み可能アセット」を警告なく置き換える(不変のPackages/やパス衝突は警告は出るが見落としやすい)。その競合を取り込み前に出す。
// 完全ローカル・読み取り専用・ファイルは一切変更しない。
import { parsePackage } from './unitypackage.js';
import { projectIndex } from './detect.js';
import type { AssetKind } from './classify.js';

// 共有ライブラリ判定表。これらのGUID衝突は「ピンク化/全アバター巻き添え」の高危険。
// isShader=true(Poiyomi/lilToon)が最も危険(シェーダ降格)。
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

  // 共有lib衝突のうち「別の場所」に既存があるもの = 二重定義/競合の真の危険(例: VPMのlilToon × 同梱lilToon)。
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

// 共有lib衝突の「結果」説明。Packages/(不変)は上書きでなく無視される＝文言を分岐。テキスト/HTML両方で共用。
function conseq(c: Conflict): string {
  if (c.existingPath?.startsWith('Packages/'))
    return `VPMで導入済み(${c.existingPath})。同梱版はGUID重複扱い→参照ずれ/コンソールエラーの恐れ。同梱フォルダは外すのが安全`;
  if (c.existingPath && c.existingPath !== c.incomingPath)
    return `別の場所に既存(${c.existingPath})＝GUID二重定義の恐れ`;
  return `あなたの ${c.existingPath} を上書き(版が違えばダウングレード)`;
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
      L.push(`        → ${conseq(c)}`);
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
    const need = [r.requires.liltoon ? 'lilToon' : '', r.requires.poiyomi ? 'Poiyomi' : ''].filter(Boolean).join('+');
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

// ---------- 自己完結HTMLレポート(共有用・--html) ----------
const HTML_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
function esc(s: string): string { return String(s).replace(/[&<>"]/g, m => HTML_ESC[m]!); }

function diffHtmlBody(r: DiffReport): string {
  const vt = r.verdict === 'danger' ? '⚠ 危険 — 取り込み前に確認を' : r.verdict === 'review' ? '△ レビュー推奨' : '✓ 衝突なし — 安全に取り込めます';
  let h = `<div class="rep"><div class="rhead"><b>${esc(r.fileName)}</b><span class="proj">→ ${esc(r.projectRoot)}</span></div>`;
  h += `<div><span class="dv ${r.verdict}">${vt}</span></div>`;
  h += `<div class="dinfo">取り込み ${r.incomingCount} アセット → 新規 ${r.newCount} / 上書き ${r.sharedOverwrite.length + r.guidOverwrite.length}${r.pathClash.length ? ` / パス衝突 ${r.pathClash.length}` : ''}</div>`;
  if (r.looksLikeUpdateOf?.installedHere)
    h += `<div class="dinfo">ℹ 既知商品「${esc(r.looksLikeUpdateOf.product)}」と一致(${r.looksLikeUpdateOf.overlapPct}%)${r.benignReimport ? ' → 同じ場所への再取込＝想定内' : ' だが下記の競合あり'}</div>`;
  if (r.sharedOverwrite.length) {
    h += `<div class="dsec"><h4 class="red">🔴 共有シェーダ/ライブラリの衝突 (${r.sharedOverwrite.length})</h4>`;
    h += r.sharedOverwrite.slice(0, 20).map(c => `<div class="dconf">[${esc(c.shared ?? '')}] ${esc(c.incomingPath)}<span class="sub">→ ${esc(conseq(c))}</span></div>`).join('');
    if (r.sharedOverwrite.length > 20) h += `<div class="dinfo">… 他 ${r.sharedOverwrite.length - 20} 件</div>`;
    h += '</div>';
  }
  if (r.missingShader.length) {
    h += `<div class="dsec"><h4 class="purple">🟣 必要シェーダの欠落 (${r.missingShader.length}) ＝入れないとピンク</h4>`;
    h += r.missingShader.map(s => `<div class="dconf">この商品は ${esc(s)} が必要ですが、対象プロジェクトに見当たりません → 先に ${esc(s)} を導入</div>`).join('');
    h += '</div>';
  } else if (r.requires.liltoon || r.requires.poiyomi) {
    const need = [r.requires.liltoon ? 'lilToon' : '', r.requires.poiyomi ? 'Poiyomi' : ''].filter(Boolean).join('+');
    h += `<div class="dsec"><h4 class="green">🟣 必要シェーダ: OK</h4><div class="dinfo">${esc(need)} は対象プロジェクトに存在</div></div>`;
  }
  if (r.guidOverwrite.length) {
    h += `<div class="dsec"><h4 class="orange">🟠 その他の上書き (${r.guidOverwrite.length})${r.benignReimport ? ' （更新版＝想定内）' : ''}</h4>`;
    h += r.guidOverwrite.slice(0, 15).map(c => `<div class="dconf">${esc(c.incomingPath)}<span class="sub">→ ${esc(c.existingPath ?? '')}</span></div>`).join('');
    if (r.guidOverwrite.length > 15) h += `<div class="dinfo">… 他 ${r.guidOverwrite.length - 15} 件</div>`;
    h += '</div>';
  }
  if (r.pathClash.length) {
    h += `<div class="dsec"><h4 class="yellow">🟡 パス衝突(別GUIDが同じ場所へ) (${r.pathClash.length}) ＝参照切れの恐れ</h4>`;
    h += r.pathClash.slice(0, 15).map(c => `<div class="dconf">${esc(c.incomingPath)}</div>`).join('');
    h += '</div>';
  }
  if (r.uncheckFolders.length && !r.benignReimport)
    h += `<div class="duncheck"><b>推奨アンチェック</b>（Unityのインポート窓で外すと安全）:<br>${r.uncheckFolders.slice(0, 8).map(esc).join(' ， ')}</div>`;
  h += '</div>';
  return h;
}

export function formatDiffHtmlPage(reports: DiffReport[]): string {
  const body = reports.map(diffHtmlBody).join('\n');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hangar 取り込み前チェック</title><style>
:root{color-scheme:dark}body{margin:0;background:#16161a;color:#e8e8ea;font-family:system-ui,'Segoe UI',sans-serif;font-size:13px;line-height:1.6}
header{padding:14px 20px;border-bottom:1px solid #2a2a32}header h1{font-size:15px;margin:0}header .sub{color:#888;font-size:12px}
.wrap{padding:18px 20px;max-width:980px}
.rep{background:#1b1b20;border:1px solid #2a2a32;border-radius:12px;padding:14px 18px;margin-bottom:16px}
.rhead{margin-bottom:8px}.rhead b{font-size:14px;word-break:break-all}.rhead .proj{color:#9a9aa2;font-size:12px;margin-left:8px;word-break:break-all}
.dv{display:inline-block;padding:3px 12px;border-radius:99px;font-weight:700}
.dv.danger{background:#5a2330;color:#ff9aa8}.dv.review{background:#4a3a23;color:#e7c89a}.dv.clean{background:#234a3a;color:#9ae7c2}
.dsec{margin-top:14px}.dsec h4{margin:0 0 6px;font-size:13px}
.dconf{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:#cfcfd6;padding:3px 0;border-bottom:1px solid #222228;word-break:break-all}
.dconf .sub{color:#9a9aa2;display:block;padding-left:14px}
.dinfo{color:#9aa;font-size:12px;margin:5px 0}
.duncheck{margin-top:14px;background:#23232b;border:1px solid #2f2f39;border-radius:8px;padding:10px 12px;font-size:12px;color:#cfcfd6}
.red{color:#ff9aa8}.purple{color:#c3b6ff}.orange{color:#e7c89a}.yellow{color:#e7e0a6}.green{color:#9ae7c2}
</style></head><body>
<header><h1>Hangar — 取り込み前チェック</h1><div class="sub">VRChat .unitypackage を取り込む前の競合レポート ・ ローカル生成・読み取り専用</div></header>
<div class="wrap">${body}</div>
</body></html>`;
}
