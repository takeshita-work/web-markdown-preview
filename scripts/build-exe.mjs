// ============================================================
//  スタンドアロン実行ファイル(.exe)のビルドスクリプト
//   1. クライアントを esbuild でバンドル → public/bundle.js
//   2. 配布用エントリ(src/standalone.js)を CJS にバンドル → dist/app.cjs
//   3. Node SEA の blob を生成 → dist/sea-prep.blob
//   4. node 実行バイナリを dist/ にコピー
//   5. postject で blob を注入して単一実行ファイル化
//   6. ダブルクリック用の start / stop ラッパー(.cmd)を dist/ に出力
//
//  使い方:  node scripts/build-exe.mjs
//  生成物:  dist/web-markdown-preview(.exe)
// ============================================================

import esbuild from 'esbuild'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')
const isWin = process.platform === 'win32'
fs.mkdirSync(dist, { recursive: true })

console.log('[1/6] クライアントをバンドル (public/bundle.js) ...')
await esbuild.build({
  entryPoints: [path.join(root, 'src/client/main.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: path.join(root, 'public/bundle.js'),
  minify: true,
  logLevel: 'warning',
})

console.log('[2/6] 配布用エントリをバンドル (dist/app.cjs) ...')
await esbuild.build({
  entryPoints: [path.join(root, 'src/standalone.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: path.join(dist, 'app.cjs'),
  minify: true,
  logLevel: 'warning',
})

console.log('[3/6] SEA blob を生成 (dist/sea-prep.blob) ...')
execFileSync(process.execPath, ['--experimental-sea-config', path.join(root, 'sea-config.json')], {
  cwd: root,
  stdio: 'inherit',
})

console.log('[4/6] node バイナリをコピー ...')
const exe = path.join(dist, isWin ? 'web-markdown-preview.exe' : 'web-markdown-preview')
fs.copyFileSync(process.execPath, exe)
if (!isWin) fs.chmodSync(exe, 0o755)

console.log('[5/6] blob を注入 (postject) ...')
const fuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
const pjArgs = [exe, 'NODE_SEA_BLOB', path.join(dist, 'sea-prep.blob'), '--sentinel-fuse', fuse]
if (process.platform === 'darwin') pjArgs.push('--macho-segment-name', 'NODE_SEA')
// Windows の npx.cmd は shell 経由でないと spawn できない（Node 18+ の仕様）
const npx = isWin ? 'npx.cmd' : 'npx'
const r = spawnSync(npx, ['--yes', 'postject', ...pjArgs], { cwd: root, stdio: 'inherit', shell: isWin })
if (r.status !== 0) {
  console.error('postject に失敗しました。`npm i -g postject` 後に再実行してください。')
  process.exit(r.status || 1)
}

if (isWin) {
  console.log('[6/6] ダブルクリック用ラッパーを出力 ...')
  fs.writeFileSync(
    path.join(dist, '起動.cmd'),
    '@echo off\r\n"%~dp0web-markdown-preview.exe" start\r\n'
  )
  fs.writeFileSync(
    path.join(dist, '停止.cmd'),
    '@echo off\r\n"%~dp0web-markdown-preview.exe" stop\r\npause\r\n'
  )
}

console.log(`\n完成: ${exe}`)
console.log('配布物: dist/ ごと配布、または exe + 起動.cmd / 停止.cmd を配布してください。')
