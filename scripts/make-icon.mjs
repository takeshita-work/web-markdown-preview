// ============================================================
//  public/favicon.svg から exe 用の build/icon.ico を生成する。
//  生成物（build/icon.ico）はコミットして配布ビルドで使い回す。
//  使い方:  node scripts/make-icon.mjs
//  依存:    sharp（SVG→PNG ラスタライズ）, png-to-ico（PNG→ICO）
// ============================================================

import sharp from 'sharp'
import pngToIco from 'png-to-ico'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const svg = path.join(root, 'public/favicon.svg')
const outDir = path.join(root, 'build')
fs.mkdirSync(outDir, { recursive: true })

const sizes = [256, 64, 48, 32, 16] // .ico に収める各サイズ
const svgBuf = fs.readFileSync(svg)
const pngBufs = []
for (const s of sizes) {
  pngBufs.push(await sharp(svgBuf, { density: 384 }).resize(s, s).png().toBuffer())
}

const ico = await pngToIco(pngBufs)
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico)
console.log('生成: build/icon.ico (', sizes.join('/'), 'px )')
