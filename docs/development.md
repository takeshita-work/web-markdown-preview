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

## 設定ファイル（ポート）

待ち受けポートは設定ファイルで永続化できる。

- 配置: スタンドアロン exe は **exe と同じフォルダの `config.json`**、dev は**プロジェクト直下の `config.json`**。
- 形式: `{ "port": 5000 }`
- 解決順: **`--port` 引数 > `config.json` > 環境変数 `PORT` > 既定 4321**
- アプリ画面の **⚙設定**（フッター左）からも変更可能。**保存**で `config.json` に書き込み（次回起動時に反映）。スタンドアロン版は **「保存して再起動」**で新ポートへ即時切替（自動でブラウザが新 URL へ移動）。
- 関連 API: `GET /__config`（現在値）/ `POST /__config {port}`（保存）/ `POST /__restart`（新ポートで起動し直し・standalone のみ）。
- `config.json` は実行時に生成されるため Git 管理しない（`.gitignore`）。

## ディレクトリ構成

```
web-markdown-preview/
├── bin/cli.js          CLI エントリ（引数パース → startServer）
├── src/
│   ├── server.js       Express 静的配信 + 起動時に esbuild でクライアントをバンドル（dev 用）
│   ├── standalone.js   配布用エントリ（SEA 埋め込みアセット配信 + start/stop/status/run）
│   └── client/main.js  クライアント本体（FS Access API + 描画 + UI のすべて）
├── public/
│   ├── index.html      画面レイアウト（ヘッダー / 本文 / 右サイドバー / フッター）
│   ├── app.css         スタイル
│   └── bundle.js       esbuild 生成物（.gitignore 済み・コミットしない）
├── scripts/
│   ├── start.{cmd,ps1,sh}  dev 起動スクリプト
│   └── build-exe.mjs        スタンドアロン exe のビルド
├── sea-config.json     Node SEA 設定（埋め込みアセット定義）
├── dist/               exe ビルド生成物（.gitignore 済み）
├── docs/               本ドキュメント
└── package.json
```

## 配布（スタンドアロン実行ファイル）

Node / esbuild 不要の**単一実行ファイル**を作る。Node 標準の **SEA（Single Executable Application）** を使い、静的アセット（index.html / app.css / bundle.js）を exe に埋め込む。

```bash
npm run build:exe        # → dist/web-markdown-preview.exe（+ 起動.cmd / 停止.cmd）
```

ビルド手順（`scripts/build-exe.mjs`）:

1. クライアントを esbuild でバンドル → `public/bundle.js`
2. 配布用エントリ `src/standalone.js` を CJS にバンドル → `dist/app.cjs`
3. `node --experimental-sea-config sea-config.json` で SEA blob を生成
4. `node` 実行バイナリを `dist/` にコピー
5. `postject` で blob を注入して単一実行ファイル化（要 `npx postject`／初回はネット取得）

> ⚠️ exe サイズは約 90MB（Node ランタイム同梱のため）。Windows では署名が無効化される警告が出るが、ローカル実行は可能（配布時に SmartScreen 警告が出る場合あり）。

### 起動 / 停止

用途で 2 モードを使い分ける。

| 用途 | 起動 | 停止 |
|---|---|---|
| ターミナルに居座らせる（ログを見る） | `web-markdown-preview.exe run` | **Ctrl+C** |
| 裏で動かす（ターミナルを閉じてもよい） | `web-markdown-preview.exe start` | `web-markdown-preview.exe stop` |

```
web-markdown-preview.exe [start]   バックグラウンド起動 + ブラウザを開く（二重起動ガード付き）
web-markdown-preview.exe stop      停止（pid ファイル経由）
web-markdown-preview.exe status    起動状態
web-markdown-preview.exe run       フォアグラウンド実行（Ctrl+C で停止）
  -p, --port <番号>                ポート（既定 4321、環境変数 PORT でも可）
```

- `run` … フォアグラウンド。pid ファイルは使わず、`Ctrl+C`（SIGINT）で `server.close()` → 終了。
- `start` / `stop` … バックグラウンド。起動情報（pid / port）を OS 一時ディレクトリの `web-markdown-preview.json` に記録し、`stop` がそれを読んでプロセスを終了・ファイル削除。`status` で起動状態を確認できる。
- ダブルクリック運用には `dist/起動.cmd`（= `start`）/ `dist/停止.cmd`（= `stop`）を同梱。
- dev 時は `npm run standalone -- <cmd>`（= `node src/standalone.js`、アセットは `public/` から読む）で同じ動作を確認できる。

### GitHub Releases への自動公開（CI）

`.github/workflows/release.yml` が **`v*` タグの push** をトリガーに windows-latest で `npm run build:exe` を実行し、`dist/web-markdown-preview.exe` と zip をリリースに添付する。

```bash
git tag v0.1.0
git push origin v0.1.0      # → Actions が走り Releases に exe が公開される
```

- 手動実行（Actions タブの **Run workflow**）でもビルド可能。その場合はリリースには添付せず **Artifacts** に保存。
- Windows exe には Windows ランナーが必要（SEA は実行中の `node` を同梱するため）。mac / Linux 版も配る場合は `runs-on` を `macos-latest` / `ubuntu-latest` にしたジョブを matrix で追加する（`build-exe.mjs` は OS を判定して対応済み）。
- 生成 exe は未署名のため、ダウンロード時に SmartScreen 警告が出る場合がある（コード署名証明書があれば署名ステップを追加可能）。

## バージョン表示

画面にビルドのバージョンを出す。**古い exe を実行していることに気付けるようにするため**（配布先の exe とリポジトリの版がズレやすい）。

- 定義元は `package.json` の `version` のみ。esbuild の `define` で `__APP_VERSION__` としてバンドルに埋め込む（`src/server.js` の `buildOptions` と `scripts/build-exe.mjs` の両方）。
- クライアントは `APP_VERSION` として参照し、以下の 3 箇所に表示する。
  - ヘッダー右端の **☰ メニュー末尾**（クリック不可の情報行 `.mi-static`）
  - **設定ダイアログ**の冒頭（`version x.y.z / 現在のポート: N`）
  - ☰ ボタンの **tooltip**
- `define` されない経路でバンドルした場合は `'dev'` にフォールバックする。

## ビルドの仕組み

- `src/server.js` の `startServer()` が起動時に esbuild で `src/client/main.js` を `public/bundle.js` にバンドル（`format: esm`, `platform: browser`, `minify`, `define` でバージョン埋め込み）。
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
- **ズーム** … `ZOOM_LEVELS` 段階、`applyZoomToTab(tab, anchor)`（標準 / ソース=`applyScaleToBody()` の `transform: scale()` / marp=SVG 寸法）。`anchor`（iframe 内クライアント座標。既定は表示領域の中央）を渡すと `captureZoomAnchor()` / `restoreZoomAnchor()` でその点の内容が動かないようスクロール位置を補正する。初回ロード時は `anchor` を渡さない。
  - `zoom` ではなく `transform` を使うのは、`zoom` では倍率ごとに折り返しが変わり「カーソル位置を中心に拡大」ができないため。レイアウト幅を `documentElement.clientWidth`（100% 時の幅）に固定し、縮小時は `translateX` で中央寄せする。
  - `transform` はレイアウト高さを変えないため、スクロール量は `documentElement.style.height = 実寸 × 倍率` で合わせる（これが無いと縮小時に文書末尾に空白が残る）。
  - プレビュー枠のリサイズは `paneObserver`（ResizeObserver）で検知し、レイアウト幅を測り直す。印刷時は生成ドキュメント側の `@media print` で `transform` / 固定幅を打ち消す。
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
