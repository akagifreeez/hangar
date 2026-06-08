import { createHash } from 'node:crypto';

// 商品の内容署名: GUID集合のmd5。重複コピーの束ね(dedup)・3Dレンダ成果物の安定キー・テンプレの版突合に
// 使う唯一の同定キー。算出を1関数に集約し、ソート有無の差で同定がズレるのを防ぐ。
export function guidSetHash(guids: string[]): string {
  return createHash('md5').update(guids.slice().sort().join(',')).digest('hex');
}
