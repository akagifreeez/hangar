// 推移的GUID参照ウォーク = 派生(DERIVATIVE)検出。テンプレ機能 v0.5 の核心。
//
// 最大の地雷(設計書): 「カタログに無いGUID＝自作」は誤り。購入マテリアルを複製・改変したコピーは
// 新しいローカルGUIDを持つが、本文(YAML)は元ベンダーのテクスチャ等を guid で参照している。これを
// 「クリーンな自作」として共有・配布すると派生物の誤出荷＝法的ハザード。
//
// 方針: 自作アセットのYAML本文から `guid: <32hex>` 参照を抽出し、ローカル(自作)アセット間を推移的に辿る。
//   - 参照先が「購入商品のGUID」に解決されたら、その商品を依存として収穫。content型なら派生。
//   - prefab/scene が購入物を参照するのは“正常な依存”であって派生ではない(構造であり中身でない)。
//   - 参照先が購入カタログにも自作にも無い「未解決」= 未scanの購入物かもしれない → 安全側に倒す材料にする。
//   - ツール(lilToon/Poiyomi/VRCSDK 等)への参照は派生・依存いずれからも除外(誤検出回避)。

const GUID_REF = /guid:\s*([0-9a-f]{32})/g;

// Unity組み込みGUID(全0、または1文字だけ非0: 例 0000000000000000f000000000000000)。解決済み(無害)扱い。
export function isBuiltinGuid(g: string): boolean { let n = 0; for (const c of g) if (c !== '0') n++; return n <= 1; }
// 既知の無償ツールのアセットGUID(VPM導入でカタログに載らないがツール=無害)。マテリアルのシェーダ参照等。
export const KNOWN_TOOL_GUIDS = new Set<string>([
  'df12117ecd77c31469c224178886498e', // lilToon (lts) シェーダ
]);

// m_Shader / m_Script の guid = そのアセットの「型」参照（シェーダ/スクリプト＝ツール/SDK）。
// これらはVPM導入でカタログに載らず未解決になりがちだが“中身の派生”ではない → 未識別カウントから除外する。
const TYPE_LINE = /m_(?:Shader|Script):\s*\{[^}]*guid:\s*([0-9a-f]{32})/g;

// YAML本文から参照GUIDを抽出。refs=全参照、typeGuids=シェーダ/スクリプト（型）参照。
export function extractRefs(yamlText: string): { refs: string[]; typeGuids: string[] } {
  const refs = new Set<string>();
  const typeGuids = new Set<string>();
  GUID_REF.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GUID_REF.exec(yamlText))) refs.add(m[1]!);
  TYPE_LINE.lastIndex = 0;
  let t: RegExpExecArray | null;
  while ((t = TYPE_LINE.exec(yamlText))) typeGuids.add(t[1]!);
  return { refs: [...refs], typeGuids: [...typeGuids] };
}

export interface AuthoredNode { relPath: string; guid: string; refs: string[]; typeGuids?: string[] }
export interface FileDerivative {
  referencesPurchased: boolean;
  products: string[];     // 参照した購入商品名（表示用）
  unresolved: number;     // 購入カタログにも自作にも無く、組み込み/既知ツールでもない参照数（未scan購入物の疑い）
}
export interface DerivativeResult {
  perFile: Map<string, FileDerivative>;
  referencedProductGuids: Set<string>;   // 派生/依存が解決した購入物GUID（版を正確に突合するために名でなくguidで返す）
}

/**
 * 自作ノード群の参照を推移的に辿り、各ファイルがどの購入商品を参照するか・未解決参照がいくつあるかを算出。
 * - allProductGuids: 全カタログ商品GUID(購入物判定)。
 * - guidToProduct: guid → 商品ファイル名(表示用)。
 * 型参照(シェーダ/スクリプト)・組み込み/既知ツールGUIDは依存・派生・未解決いずれにも数えない。
 * ※パッケージ分類(category=tool)は商品単位で全guidを除外してしまい1個の誤分類で派生を握りつぶす危険があるため
 *   ここでは使わない。ツール参照の除外は構造的に安全な typeGuids(m_Shader/m_Script)で行う。
 */
export function buildDerivativeInfo(
  nodes: AuthoredNode[],
  allProductGuids: Set<string>,
  guidToProduct: Map<string, string>,
): DerivativeResult {
  const byGuid = new Map<string, AuthoredNode>();
  for (const n of nodes) if (n.guid && !byGuid.has(n.guid)) byGuid.set(n.guid, n);

  // 全ノードのシェーダ/スクリプト(型)参照を集約。型参照GUID = ツール/SDK扱い(派生でも未識別でもない)。
  // これを「ファイル名で isToolProduct 判定」の代わりに使うことで、(a)推移先の子マテリアルのシェーダ参照を
  // 未識別に誤カウントしない、(b)商品名にツール名(poiyomi等)を含む“購入アバター”を握りつぶさない、を両立する。
  const typeGuidsGlobal = new Set<string>();
  for (const n of nodes) for (const t of (n.typeGuids ?? [])) typeGuidsGlobal.add(t);

  const referencedProductGuids = new Set<string>();
  const perFile = new Map<string, FileDerivative>();

  for (const n of nodes) {
    const seen = new Set<string>();
    const products = new Set<string>();
    let unresolved = 0;
    const stack = [...n.refs];
    while (stack.length) {
      const g = stack.pop()!;
      if (seen.has(g)) continue;
      seen.add(g);
      if (g === n.guid) continue;                       // 自分自身は無視
      if (allProductGuids.has(g)) {
        // 型参照(シェーダ/スクリプト)として使われる購入物GUIDはツール扱い→収穫しない(無償シェーダ等)。
        // それ以外(テクスチャ/メッシュ等のコンテンツ参照)は購入コンテンツ＝依存/派生として収穫。
        if (!typeGuidsGlobal.has(g)) { const pn = guidToProduct.get(g); if (pn) { products.add(pn); referencedProductGuids.add(g); } }
        continue;                                       // 購入物GUIDの先は辿らない(中身は持っていない)
      }
      const child = byGuid.get(g);
      if (child) { for (const r of child.refs) if (!seen.has(r)) stack.push(r); continue; }
      // 未解決: 購入カタログにも自作にも無い。組み込み/既知ツール/型(シェーダ・スクリプト)参照は無害、
      // それ以外（テクスチャ等のコンテンツ参照）は未識別＝未scan購入物の疑い。
      if (!isBuiltinGuid(g) && !KNOWN_TOOL_GUIDS.has(g) && !typeGuidsGlobal.has(g)) unresolved++;
    }
    perFile.set(n.relPath, { referencesPurchased: products.size > 0, products: [...products], unresolved });
  }
  return { perFile, referencedProductGuids };
}
