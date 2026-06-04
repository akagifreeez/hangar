# サードパーティ表記 (Third-Party Notices)

Hangar は以下のソフトウェアを利用しています。各ライセンスの全文は配布元を参照してください。

## 同梱（配布物に含まれる）

| ソフトウェア | 用途 | ライセンス |
|---|---|---|
| [Electron](https://www.electronjs.org/) | デスクトップ実行環境（Node 24 / Chromium を内蔵） | MIT |
| [tar-stream](https://github.com/mafintosh/tar-stream) ほか依存 | `.unitypackage`(=gzip(tar)) のストリーム解析 | MIT |

Node.js 標準の `node:sqlite` を利用しますが、これは Electron / Node.js ランタイムの一部です。

## 実行時に外部から読み込む（配布物に含めない）

| ソフトウェア | 用途 | 備考 |
|---|---|---|
| [three.js](https://threejs.org/) | 3D プレビュー(GLB)の表示 | MIT。viewer 表示時に CDN(jsDelivr) から読み込み |

## 利用者の環境にあるものを一時利用（配布物に含めない）

忠実プレビュー（任意機能）を使うときのみ、利用者が自分でインストールした以下を一時的に参照します。**Hangar はこれらを同梱・再配布しません。**

| ソフトウェア | 用途 | 備考 |
|---|---|---|
| [Unity](https://unity.com/) (2022.3 系) | バッチモードでプレビューを焼く | 各自の Unity ライセンスに従う |
| [lilToon](https://github.com/lilxyzw/lilToon) | アバター/衣装のシェーダ描画 | 利用者環境から借用。lilToon のライセンスに従う |
| [Poiyomi Toon Shader](https://github.com/poiyomi/PoiyomiToonShader)（無料版） | Poiyomi 利用アセットの描画 | MIT。利用者環境から借用。Poiyomi Pro は対象外 |

> Poiyomi 公式は `_PoiyomiShaders` の再配布を推奨していません。Hangar は配布物にシェーダを含めず、描画時に利用者環境のものを参照する方式を採っています。

## 商標 / 関連性

VRChat, BOOTH, Unity, lilToon, Poiyomi は各権利者の商標です。Hangar はいずれとも提携・承認関係にない**非公式**ツールです。
