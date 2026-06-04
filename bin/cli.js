#!/usr/bin/env node
import { startServer } from '../src/server.js'

const USAGE = `
web-markdown-preview — ローカル Markdown プレビュー（標準 / marp 対応）

  ブラウザの「フォルダを開く」でプレビュー対象を選択します（File System Access API）。
  ※ Chrome / Edge など Chromium 系ブラウザが必要です。

使い方:
  web-markdown-preview [オプション]

オプション:
  -p, --port <番号>      待ち受けポート（既定: 4321、環境変数 PORT でも可）
  -w, --watch            src/client の変更を監視して自動リビルド（開発用）
  -h, --help             ヘルプ
`

const args = process.argv.slice(2)
// 明示指定が無ければ null のまま渡し、startServer 側で config.json → 既定 へフォールバック
let port = process.env.PORT ? Number(process.env.PORT) : null
let watch = false

for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '-h' || a === '--help') {
    console.log(USAGE)
    process.exit(0)
  } else if (a === '-p' || a === '--port') {
    port = Number(args[++i])
  } else if (a === '-w' || a === '--watch') {
    watch = true
  }
  // 位置引数（旧ルート指定）は無視: フォルダはブラウザ側で選択する
}

startServer({ port, watch })
