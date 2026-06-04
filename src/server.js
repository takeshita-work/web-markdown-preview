import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import esbuild from 'esbuild'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public')
const CLIENT_ENTRY = path.resolve(__dirname, 'client', 'main.js')
const BUNDLE_OUT = path.join(PUBLIC_DIR, 'bundle.js')
const CONFIG_FILE = path.resolve(__dirname, '..', 'config.json')

const validPort = (n) => Number.isInteger(n) && n >= 1 && n <= 65535
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    return {}
  }
}
function writeConfig(obj) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(obj, null, 2) + '\n')
}

/**
 * 完全クライアント側構成。
 * サーバは静的配信のみで、ファイルの探索・読み込み・レンダリングは
 * すべてブラウザ（File System Access API + バンドルした markdown-it/marp-core）が行う。
 */
export async function startServer({ port = null, watch = false } = {}) {
  // ポート解決順: 明示指定(--port/PORT) > config.json > 既定 4321
  const cfgPort = Number(readConfig().port)
  const resolved = port != null ? port : validPort(cfgPort) ? cfgPort : 4321
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
  app.use(express.json())
  // アプリ画面からの終了要求: 応答を返してからプロセスを終了（dev/standalone で共通の挙動）
  app.post('/__shutdown', (req, res) => {
    res.json({ ok: true })
    setTimeout(() => process.exit(0), 150)
  })
  // 設定（ポート）の取得 / 保存。dev は即時再起動には未対応（canRestart:false）
  app.get('/__config', (req, res) => {
    const cfg = readConfig()
    res.json({
      port: validPort(Number(cfg.port)) ? Number(cfg.port) : resolved,
      running: resolved,
      canRestart: false,
      configFile: CONFIG_FILE,
    })
  })
  app.post('/__config', (req, res) => {
    const np = Number(req.body && req.body.port)
    if (!validPort(np)) return res.status(400).json({ ok: false, error: 'invalid port' })
    const cfg = readConfig()
    cfg.port = np
    try {
      writeConfig(cfg)
    } catch (e) {
      return res.status(500).json({ ok: false, error: String((e && e.message) || e) })
    }
    res.json({ ok: true })
  })
  app.post('/__restart', (req, res) => res.json({ ok: false, reason: 'dev' }))
  // 開発用ツールなので静的アセットはキャッシュさせない
  app.use(
    express.static(PUBLIC_DIR, {
      etag: false,
      lastModified: false,
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
    })
  )

  const server = http.createServer(app)
  server.listen(resolved, () => {
    console.log(`\n  Markdown プレビュー: http://localhost:${resolved}`)
    console.log('  ブラウザで「フォルダを開く」からプレビュー対象を選択してください。\n')
  })
  return server
}
