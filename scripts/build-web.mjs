// GitHub Pages 用の静的ビルド。
//   public/ をそのまま公開できる状態にする（bundle.js は gitignore なのでここで生成する）。
//   __HOSTED__ = true でビルドし、ローカルサーバ前提の機能（ポート設定 / アプリ終了）を出さない。
import esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

await esbuild.build({
  entryPoints: [path.join(root, 'src/client/main.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: path.join(root, 'public/bundle.js'),
  minify: true,
  logLevel: 'warning',
  define: { __APP_VERSION__: JSON.stringify(pkg.version), __HOSTED__: 'true' },
})

const out = path.join(root, 'public/bundle.js')
console.log(`public/bundle.js を生成しました (${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB) / version ${pkg.version}`)
