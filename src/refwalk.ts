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

// ツール/SDK商品(無償シェーダ/SDK)判定。プラットフォーム一般語('vrchat' 等)はBOOTHの購入アバター名に
// 頻出する(例 ManukaForVRChat / Selestia_VRChat_Avatar)ため素の部分一致に使わない。配布物として
// 識別性の高いツール名/パッケージID のみに限定する(購入物の誤ツール化＝派生握りつぶしを防ぐ)。
const TOOL_PRODUCT_RE = /liltoon|lilxyzw|poiyomi|thry|vrcsdk|com\.vrchat|nadena|modular ?avatar|vrcfury|dynamic ?bone/i;
export function isToolProduct(fileName: string): boolean { return TOOL_PRODUCT_RE.test(fileName); }

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
// 旧API互換（全参照のみ）。
export function extractGuidRefs(yamlText: string): string[] { return extractRefs(yamlText).refs; }

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
 * ツール商品(isToolProduct)・組み込み/既知ツールGUIDは依存・派生・未解決いずれにも数えない。
 */
export function buildDerivativeInfo(
  nodes: AuthoredNode[],
  allProductGuids: Set<string>,
  guidToProduct: Map<string, string>,
): DerivativeResult {
  const byGuid = new Map<string, AuthoredNode>();
  for (const n of nodes) if (n.guid && !byGuid.has(n.guid)) byGuid.set(n.guid, n);

  const referencedProductGuids = new Set<string>();
  const perFile = new Map<string, FileDerivative>();

  for (const n of nodes) {
    const seen = new Set<string>();
    const products = new Set<string>();
    const typeSet = new Set(n.typeGuids ?? []);          // シェーダ/スクリプト参照は未識別に数えない
    let unresolved = 0;
    const stack = [...n.refs];
    while (stack.length) {
      const g = stack.pop()!;
      if (seen.has(g)) continue;
      seen.add(g);
      if (g === n.guid) continue;                       // 自分自身は無視
      if (allProductGuids.has(g)) {
        const pn = guidToProduct.get(g);
        if (pn && !isToolProduct(pn)) { products.add(pn); referencedProductGuids.add(g); }
        continue;                                       // 購入物GUIDの先は辿らない(中身は持っていない)
      }
      const child = byGuid.get(g);
      if (child) { for (const r of child.refs) if (!seen.has(r)) stack.push(r); continue; }
      // 未解決: 購入カタログにも自作にも無い。組み込み/既知ツール/型(シェーダ・スクリプト)参照は無害、
      // それ以外（テクスチャ等のコンテンツ参照）は未識別＝未scan購入物の疑い。
      if (!isBuiltinGuid(g) && !KNOWN_TOOL_GUIDS.has(g) && !typeSet.has(g)) unresolved++;
    }
    perFile.set(n.relPath, { referencesPurchased: products.size > 0, products: [...products], unresolved });
  }
  return { perFile, referencedProductGuids };
}
