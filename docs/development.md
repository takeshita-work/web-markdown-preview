# 開発ガイド

## 起動

```bash
cd tools/web-markdown-preview
npm install            # 初回のみ
npm start              # http://localhost:4321
npm start -- --port 5000
npm run dev            # = cli.js --watch（src/client の変更を監視して自動リビルド）
```

起動スクリプト（依存導入＋ブラウザ自動オープン付き）：

| OS | スクリプト | 例 |
|---|---|---|
| Windows | `scripts/start.cmd` | ダブルクリック / `start.cmd 5000` |
| Windows | `scripts/start.ps1` | `./start.ps1 -Port 5000` |
| macOS / Linux | `scripts/start.sh` | `./start.sh 5000` |

> `start.ps1` は **UTF-8 (BOM 付き)** で保存すること。BOM 無しだと日本語版 Windows PowerShell 5.1 が Shift-JIS と誤認し、日本語コメントで構文エラーになる。

## CLI

```
web-markdown-preview [オプション]
  -p, --port <番号>   待ち受けポート（既定 4321、環境変数 PORT でも可）
  -w, --watch         src/client を監視して自動リビルド
  -h, --help          ヘルプ
```

フォルダはブラウザ側で選択するため、ルートパスの引数は無い。

## ディレクトリ構成

```
web-markdown-preview/
├── bin/cli.js          CLI エントリ（引数パース → startServer）
├── src/
│   ├── server.js       Express 静的配信 + 起動時に esbuild でクライアントをバンドル
│   └── client/main.js  クライアント本体（FS Access API + 描画 + UI のすべて）
├── public/
│   ├── index.html      画面レイアウト（ヘッダー / 本文 / 右サイドバー / フッター）
│   ├── app.css         スタイル
│   └── bundle.js       esbuild 生成物（.gitignore 済み・コミットしない）
├── scripts/            起動スクリプト（cmd / ps1 / sh）
├── docs/               本ドキュメント
└── package.json
```

## ビルドの仕組み

- `src/server.js` の `startServer()` が起動時に esbuild で `src/client/main.js` を `public/bundle.js` にバンドル（`format: esm`, `platform: browser`, `minify`）。
- `--watch` 時は `esbuild.context().watch()` で監視し、`src/client` を編集すると自動リビルド。ブラウザはハードリロード（Ctrl+Shift+R）で反映。
- `public/bundle.js` は生成物なので Git 管理しない（`.gitignore`）。

## 依存

| パッケージ | 用途 |
|---|---|
| express | 静的配信 |
| esbuild | クライアントのバンドル |
| markdown-it | 標準 Markdown 描画 |
| @marp-team/marp-core | marp 描画 |
| turndown / turndown-plugin-gfm | 選択範囲のソースコピー（HTML→Markdown、テーブル対応） |

## クライアント実装の要点（`src/client/main.js`）

- **状態** … `fileMap`（path→FileSystemFileHandle）、`themeList` / `styleList`（CSS 分類）、`tabs`（開いているタブ）、`activePath` / `previewPath`。
- **タブ** … `{ iframe, path, handle, view, defaultView, source, zoom:{rendered,source}, preview, prevSrc, ... }`。
- **レンダリング** … `renderTab()` → `buildDocument()`。.md は markdown-it / marp-core、.pdf は blob URL。`onIframeLoad()` でズーム適用・見出し抽出・スクロール同期・リンク/右クリック購読。
- **行番号同期** … markdown-it の core ルール `mdp_line_numbers` で `data-line` を付与（`env.mdpLineOffset` で frontmatter 補正）。
- **ズーム** … `ZOOM_LEVELS` 段階、`applyZoomToTab()`（標準=body zoom / marp=SVG 寸法）。
- **ドラッグ** … `makeDrag()` が Pointer Events + `setPointerCapture` で開閉（クリック）とリサイズ（ドラッグ）を判別。

## 動作要件

- **Chrome / Edge（Chromium 系）**。File System Access API 必須。
- `localhost` 経由でアクセスすること（secure context）。

## 既知の制約

- marp のレンダリング表示は SVG のため、変更箇所スクロールの行番号同期は対象外（ソース表示では可）。
- 印刷の保存先フォルダはブラウザ任せ（Web から指定不可）。
- marp の `![bg]`（背景画像）は未対応。通常のインライン画像 `![](...)` は解決。

## 別リポジトリ化のメモ

このツールは `tools/` 配下に隔離してあり（`node_modules` / `bundle.js` は `.gitignore` 済み）、`bin` / `src` / `public` / `scripts` で自己完結している。独立リポジトリへ切り出す場合は当ディレクトリをそのまま移動し、`npm install` → `npm link`（または `npm i -g .`）で `web-markdown-preview` コマンドとして利用できる。
