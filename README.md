# Hangar — VRChat .unitypackage カタログ & 導入追跡

> **VRChat 非公式ツール** ／ すべて **ローカルのみ・読み取り専用** で動作します。外部送信・自動ログイン・スクレイピング・ファイル改変は一切行いません。

BOOTH などで買い集めた VRChat 向けの `.unitypackage`（アバター・衣装・小物・ギミック）を、**Unity で開かずに** 棚卸し・プレビュー・検索し、**どの購入物がどの Unity プロジェクトに導入済みか** を GUID 突合で逆引きするデスクトップアプリです。

「買ったはずなのにどれか分からない」「同じものを二重に買った／コピーが散らばって容量を食っている」「このアバターはどのプロジェクトに入れたっけ」を解決します。

## 主な機能

- **カタログ化** — フォルダを指定すると中の `.unitypackage` を**展開せず**に解析し、サムネ付きグリッドで一覧。中身（ファイル構成・プレビュー画像）も閲覧。
- **重複検出** — 中身が同一のコピーを束ねて「ユニーク商品」化し、無駄な重複容量を可視化。可逆の整理プラン（quarantine へ移動、削除はしない）も生成。
- **導入追跡（GUID 遡及検出）** — Unity プロジェクトの `.meta` GUID と購入物の GUID を突合し、「導入済み / 未導入 / 部分導入(%)」を判定。重複導入も警告。
- **忠実プレビュー（任意）** — Unity と lilToon / Poiyomi が手元にあれば、本物のシェーダで多角度プレビュー画像 + ブラウザで回せる 3D(GLB) を生成。**無ければカタログ機能はそのまま使えます**。

## はじめかた（配布版）

1. `Hangar.exe`（または同梱の起動ファイル）を実行。
2. 「📁 ライブラリをスキャン」で `.unitypackage` の保存フォルダ（BOOTH のダウンロード先など）を選択。
3. グリッドに並んだ商品をクリックすると詳細（中身・プレビュー・導入台帳）が開きます。
4. 「🎯 プロジェクト検出」で Unity プロジェクトを選ぶと、どこに何が導入済みかが分かります。
5. （任意）「🎬 3D生成」で忠実プレビューを生成（Unity + lilToon/Poiyomi が必要。詳細は下記）。

データ（カタログDB・キャッシュ・生成カタログ）はアプリのユーザーデータフォルダに保存され、購入物そのものには触れません。

## 忠実プレビュー（3D生成）について

- **必須**: Unity Hub に Unity 2022.3 系、および lilToon（Poiyomi 利用アバターなら Poiyomi も）。
- 本アプリは **シェーダを同梱しません**（再配布を避けるため）。あなたの環境にある lilToon / Poiyomi を一時利用します。「🎯 プロジェクト検出」で lilToon/Poiyomi を入れたプロジェクトを登録しておくと自動で見つかります（環境変数 `HANGAR_LILTOON` / `HANGAR_POIYOMI` で明示指定も可）。
- 生成物は**ベイク済み・リグ無しの GLB**で、アバターとしては使えません（プレビュー専用＝安全側）。

## プライバシー / 安全性

[PRIVACY.md](PRIVACY.md) を参照。要点:
- **ネットワーク送信なし**（3D ビューアの three.js を CDN から読む時だけ通信。オフラインでもカタログは動作）。
- **読み取り専用**。購入物の**変換も再配布もしません**。BOOTH 等への**自動ログイン・スクレイピングをしません**。
- 解析時に読むのは `.meta` の GUID 行とパッケージのメンバ情報のみ。

## ライセンス

本体は MIT ライセンス（[LICENSE](LICENSE)）。同梱・利用するサードパーティは [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照。
**VRChat / BOOTH / lilToon / Poiyomi とは無関係の非公式ツールです。**

---

## 開発（ソースから動かす）

要件: Node 24 系（`node:sqlite` 利用）。

```bash
npm install
npm run build           # TypeScript → dist/
npm run cli -- scan <ライブラリフォルダ>     # 解析してカタログ登録
npm run cli -- list                         # 一覧
npm run cli -- detect [--save] <Unityプロジェクト...>   # 導入逆引き(--saveで記録)
npm run cli -- catalog out.html             # カタログHTML生成
npm run cli -- render <商品名の一部>         # 忠実プレビュー生成(Unity必要)
npm run gui             # Electron GUI（system Node 不要・Electron内蔵Nodeで動作）
```
（`HANGAR_DB` / `HANGAR_CACHE` / `HANGAR_DATA` 環境変数でパス指定可）

| `src/` | 役割 |
|---|---|
| `unitypackage.ts` | .unitypackage を展開せずストリーム解析 → guid/pathname/種別/preview |
| `classify.ts` | 拡張子 + asset.meta Importer でアセット分類 |
| `db.ts` | カタログDB（node:sqlite。packages/files/unity_projects/install_records） |
| `scan.ts` | ライブラリ走査 → 解析 → 登録 |
| `detect.ts` | プロジェクト GUID × パッケージ GUID 突合（遡及検出） |
| `render.ts` | 方式A: 抽出 → lilToon/Poiyomi 入り素プロジェクト → Unity バッチで PNG+GLB |
| `cli.ts` | scan / list / search / detect / installs / catalog / dupes / products / reclaim / render / caps |
| `app/` | Electron シェル（窓 + フォルダ選択。重い処理は dist/cli.js を Electron-as-node で実行） |
