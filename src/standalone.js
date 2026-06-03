#!/usr/bin/env node
// ============================================================
//  配布用スタンドアロンエントリ
//   - Node SEA で単一実行ファイル化（実行に Node / esbuild 不要）
//   - 静的アセット(index.html / app.css / bundle.js)を SEA アセットとして埋め込み
//   - サブコマンドで自己デーモン化:
//       (既定) / start … バックグラウンド起動 + ブラウザ自動オープン（二重起動ガード）
//       stop          … PID ファイルからプロセスを停止
//       status        … 起動状態を表示
//       run           … フォアグラウンドでサーバ実行（start が内部的に使う）
//  ※ dev では `node src/standalone.js <cmd>` でそのまま動く（アセットは public/ から読む）
// ============================================================

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as sea from 'node:sea'

const APP = 'web-markdown-preview'
const isSea = (() => {
  try {
    return sea.isSea()
  } catch {
    return false
  }
})()

// 起動情報（pid / port）の保存先。stop / status / 二重起動ガードで共有する
const STATE_FILE = path.join(os.tmpdir(), `${APP}.json`)

// ---- アセット ---------------------------------------------------------------

// dev（非 SEA）時は public/ から読む。SEA 時は exe に埋め込んだアセットから読む
let DEV_PUBLIC = ''
if (!isSea) {
  try {
    DEV_PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
  } catch {}
}
const TYPES = {
  'index.html': 'text/html; charset=utf-8',
  'app.css': 'text/css; charset=utf-8',
  'bundle.js': 'text/javascript; charset=utf-8',
  'favicon.svg': 'image/svg+xml; charset=utf-8',
}
function readAsset(name) {
  if (isSea) return Buffer.from(sea.getAsset(name)) // ArrayBuffer → Buffer
  return fs.readFileSync(path.join(DEV_PUBLIC, name))
}

// ---- ユーティリティ ---------------------------------------------------------

function parsePort(args, def = 4321) {
  const i = args.findIndex((a) => a === '-p' || a === '--port')
  if (i >= 0 && args[i + 1]) return Number(args[i + 1])
  if (process.env.PORT) return Number(process.env.PORT)
  return def
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return null
  }
}

// pid が生存しているか（シグナル 0 は存在確認のみ）
function alive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32')
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
  } catch {}
}

// 自分自身（exe / スクリプト）を子プロセスとして起動するための引数
function selfArgs(extra) {
  // SEA は exe を直接、dev は node + スクリプトパスを使う
  return isSea ? extra : [fileURLToPath(import.meta.url), ...extra]
}

// ---- サーバ（フォアグラウンド） ----------------------------------------------

function serve(port) {
  const server = http.createServer((req, res) => {
    let p = (req.url || '/').split('?')[0]
    // アプリ画面からの終了要求: 応答を返してからプロセスを終了
    if (p === '/__shutdown') {
      res.setHeader('Content-Type', 'application/json')
      res.end('{"ok":true}')
      setTimeout(() => {
        try {
          fs.unlinkSync(STATE_FILE)
        } catch {}
        try {
          server.close()
        } catch {}
        process.exit(0)
      }, 150)
      return
    }
    if (p === '/' || p === '') p = '/index.html'
    const name = p.replace(/^\/+/, '')
    if (!Object.prototype.hasOwnProperty.call(TYPES, name)) {
      res.statusCode = 404
      res.end('Not Found')
      return
    }
    try {
      const buf = readAsset(name)
      res.setHeader('Content-Type', TYPES[name])
      res.setHeader('Cache-Control', 'no-store') // ローカルツールなのでキャッシュさせない
      res.end(buf)
    } catch (e) {
      res.statusCode = 500
      res.end(String((e && e.message) || e))
    }
  })
  server.on('error', (e) => {
    console.error(`[${APP}] サーバ起動に失敗しました: ${e.message}`)
    process.exit(1)
  })
  server.listen(port, () => {
    console.log(`\n  ${APP}: http://localhost:${port}`)
    console.log('  ブラウザの「フォルダを開く」からプレビュー対象を選択してください。\n')
  })
  const shutdown = () => {
    try {
      server.close()
    } catch {}
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

// ---- コマンド ---------------------------------------------------------------

function cmdStart(args) {
  const port = parsePort(args)
  const st = readState()
  if (st && alive(st.pid)) {
    // 既に起動中なら二重起動せず、ブラウザだけ開く
    const url = `http://localhost:${st.port}`
    console.log(`[${APP}] 既に起動しています (pid ${st.pid}, ${url})。ブラウザを開きます。`)
    openBrowser(url)
    return
  }
  const url = `http://localhost:${port}`
  const child = spawn(process.execPath, selfArgs(['run', '--port', String(port)]), {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  fs.writeFileSync(STATE_FILE, JSON.stringify({ pid: child.pid, port }))
  console.log(`[${APP}] 起動しました (pid ${child.pid}, ${url})`)
  setTimeout(() => openBrowser(url), 800) // サーバ待ち受けを少し待ってから開く
}

function cmdStop() {
  const st = readState()
  if (!st || !alive(st.pid)) {
    console.log(`[${APP}] 起動していません。`)
    try {
      fs.unlinkSync(STATE_FILE)
    } catch {}
    return
  }
  try {
    process.kill(st.pid)
  } catch {}
  try {
    fs.unlinkSync(STATE_FILE)
  } catch {}
  console.log(`[${APP}] 停止しました (pid ${st.pid})`)
}

function cmdStatus() {
  const st = readState()
  if (st && alive(st.pid)) console.log(`[${APP}] 起動中 (pid ${st.pid}, http://localhost:${st.port})`)
  else console.log(`[${APP}] 停止中`)
}

function cmdHelp() {
  console.log(`${APP} — ローカル Markdown / PDF プレビュー

使い方:
  ${APP} [start]           バックグラウンド起動 + ブラウザを開く（既定）
  ${APP} stop              停止
  ${APP} status            起動状態を表示
  ${APP} run [--port N]    フォアグラウンドで実行
オプション:
  -p, --port <番号>        待ち受けポート（既定 4321、環境変数 PORT でも可）`)
}

// ---- ディスパッチ -----------------------------------------------------------

const argv = process.argv.slice(2)
const hasCmd = argv[0] && !argv[0].startsWith('-')
const cmd = hasCmd ? argv[0] : 'start'
const rest = hasCmd ? argv.slice(1) : argv

switch (cmd) {
  case 'run':
    serve(parsePort(rest))
    break
  case 'start':
    cmdStart(rest)
    break
  case 'stop':
    cmdStop()
    break
  case 'status':
    cmdStatus()
    break
  case 'help':
  case '--help':
  case '-h':
    cmdHelp()
    break
  default:
    cmdStart(argv)
}
