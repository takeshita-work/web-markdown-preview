# アーキテクチャ

## 基本方針：完全クライアントサイド

当初はサーバ（Node）がディスクを読み、markdown-it / marp でレンダリングして HTML を返す構成だったが、以下の理由で **完全クライアントサイド**へ移行した。

- 「出力先フォルダの指定」「ネイティブなフォルダ選択」を安定して実現するため、ブラウザの **File System Access API** を採用。
- File System Access API は **絶対パスを返さない**（セキュリティ上ブラウザが隠す）。代わりにディレクトリ／ファイルのハンドルを受け取り、ブラウザがファイル内容を直接読む。
- そのため「サーバがディスクを絶対パスで読む」設計と噛み合わず、レンダリングをブラウザ側へ寄せた。

結果として：

- **サーバ（`src/server.js`）** … 静的配信のみ。起動時に esbuild でクライアントをバンドル（`--watch` で監視リビルド）。
- **クライアント（`src/client/main.js`）** … フォルダ選択・走査・読み込み・レンダリング・画像解決・UI のすべて。

## 処理の流れ

```
ブラウザ
  └ showDirectoryPicker() でディレクトリハンドル取得
     └ ディレクトリを再帰走査して .md/.pdf/.css を収集（fileMap, themeList, styleList）
        └ ツリー描画 / 「表示」セレクト構築
           └ ファイル選択
              ├ .md  → 内容を読み、marp 判定 → markdown-it or marp-core で HTML 化
              │        → 相対画像をハンドル経由で blob URL に解決
              │        → iframe(srcdoc) に流し込み
              └ .pdf → ファイルを blob URL 化し iframe(src) でブラウザ標準ビューア表示
```

各プレビューは **iframe（srcdoc）** に独立した HTML ドキュメントとして描画する。これにより：

- 選択した CSS / marp テーマがアプリ本体の UI に漏れない（スタイル分離）。
- タブごとに別ドキュメントとして保持できる。

## 技術スタック

| 役割 | 採用 |
|---|---|
| サーバ（静的配信） | Express |
| クライアントのバンドル | esbuild（起動時にビルド、`--watch` 対応） |
| 標準 Markdown 描画 | markdown-it |
| marp 描画 | @marp-team/marp-core |
| 選択範囲を Markdown ソース化（コピー用） | turndown + turndown-plugin-gfm（テーブル等） |

バンドルは約 4MB（minify 済み）。ローカルツールのため許容。

## File System Access API まわりの要点

- **Chromium 系専用**（Chrome / Edge）。Firefox / Safari は未対応。
- `localhost` は secure context のため動作する。
- バックグラウンドタブでは `getFile()` が `NotAllowedError` になり得るため、ライブリロードのポーリングは `document.hidden` の間は停止する。
- アクセス許可が失効すると `getFile()` が `NotAllowedError` を投げる。検出して「フォルダを開き直してください」と案内する。

## ディレクトリツリーの再走査（自動更新）

`buildTree` でルートを再帰走査し `fileMap` とツリーを構築する処理を、`refreshTree()` として定期的（2.5 秒間隔）／操作時（ディレクトリ展開・ファイルクリック）に呼び出す。

- `treeSignature()` で全 dir/file パスを 1 文字列に畳み、**前回と一致すれば再描画しない**（ちらつき・無駄な DOM 再構築を回避。`fileMap` のハンドルだけ最新化して終了）。
- 再描画時は `getExpandedDirPaths()` で**展開中ディレクトリのパス集合**を退避し、`renderTree(tree, expanded)` で復元。`$tree.scrollTop` とアクティブ表示（`revealInTree`）も保持する。
- 多重実行は `refreshingTree` フラグでガード。`document.hidden` の間は走らせない。
- 構成変化時は `classifyCss()` も呼び、CSS / marp テーマファイルの増減を「表示」セレクトへ反映する。

## CSS の扱い

選択ディレクトリ配下の `.css` を再帰収集し、`/* @theme 名前 */` の有無で分類する。

- `@theme` あり → **marp テーマ**（`themeList`）。frontmatter またはセレクトで選択。
- `@theme` なし → **標準 CSS**（`styleList`）。`markdown-preview` 系を既定として優先選択。

`.vscode/` のようなドット始まりディレクトリはツリー（.md 一覧）には出さないが、CSS の収集対象には含める。

## 行番号同期（ライブリロードの変更箇所スクロール）

- markdown-it のブロック要素に `data-line`（ソース行番号）を付与（VS Code のスクロール同期と同方式）。
- frontmatter を除去してから markdown-it に渡すため、`env.mdpLineOffset` で frontmatter 行数ぶん補正し、**元ソースの行番号**に揃える。
- ソース表示時は各行を `data-line` 付き `<span>` で出力。
- リロード時に直前ソースと差分（最初の変更行）を取り、対応する要素へスクロール＆ハイライト。

## レイアウト構造（DOM）

```
#app (縦)
├─ #workspace (横)
│   ├─ #sidebar         左サイドバー（📂 + ファイルツリー）
│   ├─ .splitter#split-left   ハンドルで開閉 / ドラッグでリサイズ
│   ├─ #main (縦)
│   │   ├─ #toolbar     ヘッダー（← → ⟳ 📄 / 分割 / ☰）
│   │   └─ #content-row (横)
│   │       ├─ #panes (横)     2 分割ペイン
│   │       │   ├─ .pane[data-pane=a]  .pane-tabs + .pane-view（iframe）
│   │       │   ├─ .splitter#split-pane
│   │       │   └─ .pane[data-pane=b]  同上（分割時のみ表示）
│   │       ├─ .splitter#split-right
│   │       └─ #sidebar-right  見出しアウトライン
│   └─（右スプリッタ/右サイドバーは content-row 内）
（フッターは無し。開いているファイルのパスはタブの tooltip と右クリックメニューで確認する）

ヘッダー（#toolbar）は左に 戻る/進む/再読み込み/ファイル選択/</> ソース/印刷/ズーム/分割、
右に 表示（CSS）セレクト / メニュー（CSS の設定・アプリ設定・終了・バージョン）。
サイドバーを閉じているときは、その開閉ボタンもヘッダーの端に入る。

サーバは静的配信とローカル運用の API（`/__config` `/__shutdown` `/__restart`）だけなので、
`public/` を静的ホスティング（GitHub Pages）に置いても動く。その場合はビルドフラグ
`__HOSTED__ = true` でサーバ依存のメニューを出さない（docs/development.md 参照）。
```

- サイドバーの開閉はスプリッタ中央の**ハンドル**で行う（クリック＝開閉、ドラッグ＝リサイズ）。閉じるとスプリッタが細いレールとして残り、ハンドルで再展開。
- ドラッグは **Pointer Events + setPointerCapture** を使用。iframe 上やウィンドウ外で離してもイベントが確実に届き、状態が固まらない。
- サイドバー幅・開閉状態・選択中ペイン廃止などのレイアウト状態は `localStorage` に保存（`mdpreview.*`）。
