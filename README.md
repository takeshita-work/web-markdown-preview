# web-markdown-preview

ローカルの Markdown / PDF プレビューツール。ブラウザの **File System Access API**（vscode.dev と同じ方式）でディレクトリを選び、配下の `.md` / `.pdf` をタブでプレビューする。標準 Markdown（markdown-it）と marp の両フォーマットに対応した**完全クライアントサイド**構成。

> ⚠️ **Chrome / Edge など Chromium 系ブラウザ専用**（File System Access API のため）。`localhost` 経由で動作する。

## 起動

```bash
npm install      # 初回のみ
npm start        # http://localhost:4321
npm start -- --port 5000
npm run dev      # src/client を監視して自動リビルド
```

Chrome / Edge で `http://localhost:4321` を開き、左上の **📂（フォルダを選択）** で対象ディレクトリを選ぶ。

起動スクリプト（依存導入＋ブラウザ自動オープン）:

| OS | スクリプト | 使い方 |
|---|---|---|
| Windows | `scripts/start.cmd` | ダブルクリック、または `start.cmd 5000` |
| Windows | `scripts/start.ps1` | `./start.ps1 -Port 5000` |
| macOS/Linux | `scripts/start.sh` | `./start.sh 5000` |

## 主な機能

- フォルダ選択（📂）／相対パスでファイルを開く（📄）、`.md`・`.pdf` の再帰探索
- 標準 Markdown / marp の自動判定とテーマ・CSS 選択（タブごとに保持）
- 仮選択／確定タブ、同名ファイルは `親フォルダ/名前` で区別
- ソース表示切替、見出しアウトライン（折りたたみ・スクロール追従）
- ズーム（タブ×表示モード別、Ctrl+ホイール、`[−][＋]`、Ctrl+Shift+`+`/`-`/`0`）
- ライブリロード（変更箇所へ自動スクロール＋ハイライト）
- 印刷 / PDF 出力（🖨・Ctrl+P）、コピー（相対パス／ソース全体・選択範囲）
- サイドバー開閉（スプリッタのハンドル）・リサイズ・状態記憶

機能の詳細は **[docs/features.md](docs/features.md)** を参照。

## 構成

```
web-markdown-preview/
├── bin/cli.js          # CLI エントリ（--port / --watch）
├── src/
│   ├── server.js       # 静的配信 + 起動時に esbuild でクライアントをバンドル
│   └── client/main.js  # クライアント本体（File System Access API + 描画 + UI）
├── public/
│   ├── index.html
│   ├── app.css
│   └── bundle.js       # esbuild 生成物（.gitignore 済み）
├── scripts/            # 起動スクリプト（cmd / ps1 / sh）
├── docs/               # ドキュメント
└── package.json
```

## ドキュメント

- [docs/architecture.md](docs/architecture.md) — 設計・全体構成
- [docs/features.md](docs/features.md) — 機能一覧
- [docs/development.md](docs/development.md) — 起動・ビルド・拡張
