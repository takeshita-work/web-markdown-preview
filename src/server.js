import express from 'express'
import path from 'node:path'
import http from 'node:http'
import esbuild from 'esbuild'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public')
const CLIENT_ENTRY = path.resolve(__dirname, 'client', 'main.js')
const BUNDLE_OUT = path.join(PUBLIC_DIR, 'bundle.js')

/**
 * 完全クライアント側構成。
 * サーバは静的配信のみで、ファイルの探索・読み込み・レンダリングは
 * すべてブラウザ（File System Access API + バンドルした markdown-it/marp-core）が行う。
 */
export async function startServer({ port = 4321, watch = false } = {}) {
  const buildOptions = {
    entryPoints: [CLIENT_ENTRY],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    outfile: BUNDLE_OUT,
    minify: true,
    sourcemap: false,
    logLevel: 'info',
  }

  if (watch) {
    const ctx = await esbuild.context(buildOptions)
    await ctx.rebuild()
    await ctx.watch()
    console.log('  [esbuild] watch mode: src/client を監視中')
  } else {
    await esbuild.build(buildOptions)
  }

  const app = express()
  // 開発用ツールなので静的アセットはキャッシュさせない
  app.use(
    express.static(PUBLIC_DIR, {
      etag: false,
      lastModified: false,
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
    })
  )

  const server = http.createServer(app)
  server.listen(port, () => {
    console.log(`\n  Markdown プレビュー: http://localhost:${port}`)
    console.log('  ブラウザで「フォルダを開く」からプレビュー対象を選択してください。\n')
  })
  return server
}
