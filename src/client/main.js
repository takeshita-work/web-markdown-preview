import MarkdownIt from 'markdown-it'
import { Marp } from '@marp-team/marp-core'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

// ============================================================
//  完全クライアント側 Markdown プレビュー
//   - File System Access API でフォルダ選択（vscode.dev と同じ方式）
//   - .md / .css をブラウザが読み込み、markdown-it / marp-core で描画
//   - 相対画像はディレクトリハンドル経由で blob URL に解決
//   - 可変サイドバー / 選択中一覧 / 見出しアウトライン / Ctrl+ホイール拡大縮小
// ============================================================

const md = new MarkdownIt({ html: true, linkify: true, typographer: true })
// ブロック要素にソース行番号(data-line)を付与（リロード時の変更箇所スクロール用）
// env.mdpLineOffset で frontmatter 除去分のズレを補正し、元ソースの行番号に揃える
md.core.ruler.push('mdp_line_numbers', (state) => {
  const off = (state.env && state.env.mdpLineOffset) || 0
  for (const t of state.tokens) {
    if (t.map && t.nesting !== -1) t.attrSet('data-line', String(t.map[0] + off))
  }
})
// レンダリング表示での選択範囲を Markdown ソースに戻すための変換器
const turndown = new TurndownService({ codeBlockStyle: 'fenced', headingStyle: 'atx', bulletListMarker: '-' })
turndown.use(gfm) // テーブル / 打ち消し線 / タスクリストに対応

const LS = {
  leftWidth: 'mdpreview.leftWidth',
  rightWidth: 'mdpreview.rightWidth',
  leftHidden: 'mdpreview.leftHidden',
  rightHidden: 'mdpreview.rightHidden',
}

// ---- 状態 -------------------------------------------------------------------

let rootHandle = null
const fileMap = new Map() // posixPath -> FileSystemFileHandle
let themeList = [] // [{ path, theme, css }]
let styleList = [] // [{ path, css }]
let defaultStdCss = '' // 既定 CSS のテキスト
let defaultStdPath = '' // 既定 CSS のパス
let lastTreeSig = '' // 直近に描画したツリー構成のシグネチャ（差分検知でちらつき防止）
let refreshingTree = false // ツリー再走査の多重実行ガード

// 開いているタブ: path -> { iframe, label, path, handle, lastModified, blobUrls, headings, preview }
const tabs = new Map()
let activePath = null
let previewPath = null // 仮選択タブ（最大1つ。別ファイルの仮選択で置き換わる）

// プレビュー対象の拡張子
const PREVIEWABLE = /\.(md|pdf)$/i
const isPdfPath = (p) => /\.pdf$/i.test(p)

// ズームはタブごと・表示モード（rendered/source）ごとに保持（各既定 100%）

// ---- DOM --------------------------------------------------------------------

const $tree = document.getElementById('tree')
const $outline = document.getElementById('outline')
const $tabs = document.getElementById('tabs')
const $preview = document.getElementById('preview')
const $empty = document.getElementById('empty')
const $view = document.getElementById('view')
const $openBtn = document.getElementById('open-folder')
const $rootName = document.getElementById('root-name')
const $openPathBtn = document.getElementById('open-path')
const $zoomSelect = document.getElementById('zoom-select')
const $zoomIn = document.getElementById('zoom-in')
const $zoomOut = document.getElementById('zoom-out')
const $sidebar = document.getElementById('sidebar')
const $sidebarRight = document.getElementById('sidebar-right')
const $splitLeft = document.getElementById('split-left')
const $splitRight = document.getElementById('split-right')
const $collapseLeft = document.getElementById('collapse-left')
const $collapseRight = document.getElementById('collapse-right')
const $btnSource = document.getElementById('btn-source')
const $btnPrint = document.getElementById('btn-print')

// 既定（ファイル未選択時）のタブタイトル。index.html の <title> を初期値に使う
const DEFAULT_TITLE = document.title || 'web markdown preview'

// ---- パスユーティリティ ------------------------------------------------------

const posixDirname = (p) => {
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

function resolvePath(baseDir, src) {
  const parts = (baseDir ? baseDir.split('/') : []).concat(src.split('/'))
  const stack = []
  for (const p of parts) {
    if (p === '' || p === '.') continue
    if (p === '..') stack.pop()
    else stack.push(p)
  }
  return stack.join('/')
}

const cssEsc = (s) => s.replace(/["\\]/g, '\\$&')

// ---- アイコン（シンプルな SVG。currentColor で文字色／配色に追従）-----------
const ICONS = {
  // 一般的なファイル: 角折れの書類 + 本文行
  file: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"><path d="M3.5 1.5h5L12.5 5v9a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5z"/><path d="M8.5 1.5V5h4"/><path d="M5.6 8.5h4.8M5.6 11h4.8"/></svg>`,
  // Markdown: 青の角丸バッジ + 白の「M」と下向き矢印
  markdown: `<svg viewBox="0 0 16 16" width="14" height="14"><rect x="1" y="3.5" width="14" height="9" rx="2" fill="#2563eb"/><path d="M3.7 10V6l2 2.4L7.7 6v4M11 6v3.3M9.6 8.1 11 9.7 12.4 8.1" fill="none" stroke="#fff" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`,
  // PDF: 赤の角丸バッジ + 白の「PDF」表記
  pdf: `<svg viewBox="0 0 16 16" width="14" height="14"><rect x="1" y="3.5" width="14" height="9" rx="2" fill="#e0392b"/><text x="8" y="10.35" font-size="5.2" font-weight="700" text-anchor="middle" fill="#fff" font-family="Segoe UI, Arial, sans-serif" letter-spacing="-.3">PDF</text></svg>`,
  // フォルダ: タブ付きの閉じたフォルダ
  folder: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"><path d="M1.5 4.5a1 1 0 0 1 1-1h3.1a1 1 0 0 1 .72.3l.86.9a1 1 0 0 0 .72.3h5.6a1 1 0 0 1 1 1v6.2a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/></svg>`,
  // プリンター
  printer: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"><path d="M4.5 6.5v-4h7v4"/><path d="M4.5 12.5h-2a1 1 0 0 1-1-1V8a1.5 1.5 0 0 1 1.5-1.5h10A1.5 1.5 0 0 1 14.5 8v3.5a1 1 0 0 1-1 1h-2"/><rect x="4.5" y="10" width="7" height="4.5" rx=".5"/><circle cx="12" cy="8.6" r=".55" fill="currentColor" stroke="none"/></svg>`,
}
// 拡張子に応じたファイルアイコン（SVG マークアップを返す）
const fileIcon = (name) => (isPdfPath(name) ? ICONS.pdf : /\.md$/i.test(name) ? ICONS.markdown : ICONS.file)

// ---- フォルダ選択 & 走査 -----------------------------------------------------

async function openFolder() {
  if (!window.showDirectoryPicker) {
    alert('このブラウザは File System Access API に未対応です。Chrome / Edge をお使いください。')
    return
  }
  try {
    rootHandle = await window.showDirectoryPicker({ mode: 'read' })
  } catch {
    return
  }
  await loadRoot()
}

async function loadRoot() {
  $rootName.textContent = rootHandle.name
  $openPathBtn.disabled = false // フォルダ選択後は相対パス指定を有効化
  fileMap.clear()
  for (const p of [...tabs.keys()]) closeTab(p)
  const tree = await buildTree(rootHandle, rootHandle.name, '')
  lastTreeSig = treeSignature(tree)
  renderTree(tree) // 初期はすべて折りたたみ
  await classifyCss()
}

// ツリー構成（dir/file の一覧）を1本の文字列に畳んだシグネチャ。
// ファイルの追加 / 削除 / リネームがあると変化するので差分検知に使う
function treeSignature(node) {
  const acc = []
  const walk = (n) => {
    acc.push((n.type === 'dir' ? 'D:' : 'F:') + n.path)
    if (n.children) for (const c of n.children) walk(c)
  }
  walk(node)
  return acc.join('\n')
}

// 現在展開中（collapsed でない）のディレクトリの相対パス集合
function getExpandedDirPaths() {
  const set = new Set()
  for (const lbl of $tree.querySelectorAll('.dir-label')) {
    const node = lbl.parentElement
    if (node && !node.classList.contains('collapsed')) set.add(lbl.dataset.path)
  }
  return set
}

// ルートを再走査してツリーを最新化する。
// 構成に変化がなければ再描画しない（ちらつき防止）。
// 変化時は展開状態・スクロール位置・アクティブ表示を保持したまま描き直す。
async function refreshTree() {
  if (!rootHandle || refreshingTree) return
  refreshingTree = true
  try {
    fileMap.clear()
    const tree = await buildTree(rootHandle, rootHandle.name, '')
    const sig = treeSignature(tree)
    if (sig === lastTreeSig) return // 構成に変化なし（fileMap のハンドルだけ新しくして終了）
    lastTreeSig = sig
    const expanded = getExpandedDirPaths()
    const scrollTop = $tree.scrollTop
    renderTree(tree, expanded)
    $tree.scrollTop = scrollTop
    if (activePath) {
      document
        .querySelectorAll('.file-label')
        .forEach((el) => el.classList.toggle('active', el.dataset.path === activePath))
      revealInTree(activePath)
    }
    await classifyCss() // CSS / marp テーマファイルの増減も反映
    syncPreview() // 「表示」セレクトをアクティブタブへ再同期
  } finally {
    refreshingTree = false
  }
}

// 相対パス入力からファイルを開く（確定タブとして）
function openByPath(raw) {
  if (!rootHandle) {
    toast('先にフォルダを開いてください')
    return
  }
  let p = (raw || '').trim().replace(/\\/g, '/')
  if (!p) return
  try {
    p = decodeURI(p)
  } catch {}
  const resolved = resolvePath('', p.startsWith('/') ? p.slice(1) : p)
  const h = fileMap.get(resolved)
  if (!h) {
    toast('見つかりません: ' + resolved)
    return
  }
  if (!PREVIEWABLE.test(resolved)) {
    toast('プレビュー対象外: ' + resolved)
    return
  }
  pinFile({ type: 'file', name: resolved.split('/').pop(), path: resolved, handle: h })
}

// 相対パス入力用のモーダルダイアログを開く
function openPathDialog() {
  if (!rootHandle) return
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  const box = document.createElement('div')
  box.className = 'modal-box'
  const title = document.createElement('div')
  title.className = 'modal-title'
  title.textContent = 'ファイルを選択（相対パスで指定）'
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'modal-input'
  const btns = document.createElement('div')
  btns.className = 'modal-btns'
  const cancel = document.createElement('button')
  cancel.className = 'tbtn'
  cancel.textContent = 'キャンセル'
  const ok = document.createElement('button')
  ok.className = 'tbtn'
  ok.textContent = '開く'
  btns.append(cancel, ok)
  box.append(title, input, btns)
  overlay.append(box)
  document.body.append(overlay)
  const close = () => overlay.remove()
  const submit = () => {
    const v = input.value
    close()
    openByPath(v)
  }
  ok.addEventListener('click', submit)
  cancel.addEventListener('click', close)
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close()
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit()
    else if (e.key === 'Escape') close()
  })
  input.focus()
}

async function buildTree(dirHandle, name, relPath) {
  const node = { type: 'dir', name, path: relPath, children: [] }
  const entries = []
  for await (const [childName, h] of dirHandle.entries()) entries.push([childName, h])
  entries.sort((a, b) => {
    const ad = a[1].kind === 'directory'
    const bd = b[1].kind === 'directory'
    if (ad !== bd) return ad ? -1 : 1
    return a[0].localeCompare(b[0], 'ja')
  })
  for (const [childName, h] of entries) {
    const childRel = relPath ? relPath + '/' + childName : childName
    if (h.kind === 'directory') {
      if (childName === 'node_modules' || childName === '.git') continue
      node.children.push(await buildTree(h, childName, childRel))
    } else {
      fileMap.set(childRel, h)
      node.children.push({ type: 'file', name: childName, path: childRel, handle: h })
    }
  }
  return node
}

async function classifyCss() {
  themeList = []
  styleList = []
  for (const [p, h] of fileMap) {
    if (!p.toLowerCase().endsWith('.css')) continue
    let css = ''
    try {
      css = await (await h.getFile()).text()
    } catch {
      continue
    }
    const m = css.match(/@theme\s+([\w-]+)/)
    if (m) themeList.push({ path: p, theme: m[1], css })
    else styleList.push({ path: p, css })
  }
  // 既定の標準 CSS（自動判別が標準のとき・初期選択に使用）
  const guess = styleList.find((s) => /markdown.*preview|preview.*markdown|github/i.test(s.path))
  const defStyle = guess || styleList[0] || null
  defaultStdCss = defStyle ? defStyle.css : ''
  defaultStdPath = defStyle ? defStyle.path : ''

  // 単一セレクトを構築: 標準CSS(optgroup) / marpテーマ(optgroup)。「自動判定」は出さない
  const prev = $view.value
  $view.innerHTML = ''
  if (styleList.length) {
    const g = document.createElement('optgroup')
    g.label = '標準CSS'
    for (const s of styleList) {
      const o = document.createElement('option')
      o.value = 'std:' + s.path
      o.textContent = s.path
      o.dataset.base = s.path // (default) マーカー再付与用の元ラベル
      g.appendChild(o)
    }
    $view.appendChild(g)
  }
  // marp は常にグループを用意（marp ファイルが必ず選べるよう汎用項目を先頭に）
  {
    const g = document.createElement('optgroup')
    g.label = 'marpテーマ'
    const o0 = document.createElement('option')
    o0.value = 'marp:'
    o0.textContent = 'marp（frontmatter / 既定）'
    o0.dataset.base = o0.textContent
    g.appendChild(o0)
    for (const t of themeList) {
      const o = document.createElement('option')
      o.value = 'marp:' + t.theme
      o.textContent = `${t.theme} (${t.path})`
      o.dataset.base = o.textContent
      g.appendChild(o)
    }
    $view.appendChild(g)
  }
  // 以前の選択を維持（無ければ既定 CSS）
  $view.value = [...$view.options].some((o) => o.value === prev) ? prev : defaultViewValue()
}

// アクティブタブの既定 view に該当する選択肢へ (default) を付与
function updateDefaultMarker() {
  const at = tabs.get(activePath)
  const def = at ? at.defaultView : ''
  for (const o of $view.options) {
    const base = o.dataset.base || o.textContent
    o.textContent = o.value === def ? `${base} (default)` : base
  }
}

// 初期選択に使う view 値（既定 CSS → 無ければ先頭の選択肢）
function defaultViewValue() {
  if (defaultStdPath) return 'std:' + defaultStdPath
  return $view.options[0] ? $view.options[0].value : ''
}

// ファイル内容から初期 view を決定（marp は frontmatter テーマ、標準は既定 CSS）
function initialView(src) {
  if (detectMarp(src)) {
    const fm = src.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    let th = ''
    if (fm) {
      const m = fm[1].match(/(^|\n)theme\s*:\s*([\w-]+)/)
      if (m) th = m[2]
    }
    if (th && themeList.some((t) => t.theme === th)) return 'marp:' + th
    return 'marp:' // frontmatter のテーマ準拠（未登録なら marp-core 既定）
  }
  return 'std:' + defaultStdPath // 標準モード（既定 CSS、無ければ CSS なし）
}

// ---- ツリー描画 -------------------------------------------------------------

function hasPreviewable(node) {
  if (node.type === 'file') return PREVIEWABLE.test(node.name)
  return node.children.some(hasPreviewable)
}

// ディレクトリの子が「単一のサブフォルダのみ」なら、その中も連鎖的に自動展開
function autoExpandSingle(nodeEl) {
  const children = nodeEl.querySelector(':scope > .children')
  if (!children) return
  const childNodes = [...children.children].filter((c) => c.classList && c.classList.contains('node'))
  if (childNodes.length !== 1) return
  const only = childNodes[0]
  if (!only.querySelector(':scope > .dir-label')) return // 単一の子がフォルダのときだけ
  only.classList.remove('collapsed')
  autoExpandSingle(only)
}

// ツリーで指定パスの祖先ディレクトリを展開し、その行を表示する
function revealInTree(path) {
  const label = $tree.querySelector(`.file-label[data-path="${cssEsc(path)}"]`)
  if (!label) return
  let el = label.parentElement
  while (el && el !== $tree) {
    if (el.classList && el.classList.contains('node')) el.classList.remove('collapsed')
    el = el.parentElement
  }
  label.scrollIntoView({ block: 'nearest' })
}

function renderTree(tree, expanded = null) {
  $tree.innerHTML = ''
  for (const child of tree.children) {
    if (child.type === 'dir' && child.name.startsWith('.')) continue
    if (!hasPreviewable(child)) continue
    const el = renderNode(child, expanded)
    if (el) $tree.appendChild(el)
  }
  if (!$tree.children.length) {
    $tree.innerHTML = '<div class="tree-hint">.md / .pdf ファイルが見つかりませんでした。</div>'
  }
}

// expanded: 再描画時に展開状態を引き継ぐためのパス集合（null なら全て折りたたみ）
function renderNode(node, expanded = null) {
  if (node.type === 'file') {
    if (!PREVIEWABLE.test(node.name)) return null
    const div = document.createElement('div')
    div.className = 'node'
    const label = document.createElement('div')
    label.className = 'file-label'
    label.dataset.path = node.path
    const icon = document.createElement('span')
    icon.className = 'ficon'
    icon.innerHTML = fileIcon(node.name)
    const span = document.createElement('span')
    span.textContent = node.name
    label.appendChild(icon)
    label.appendChild(span)
    // シングルクリック = 仮選択（preview）、ダブルクリック = 確定（pin）
    label.addEventListener('click', (e) => {
      e.preventDefault()
      previewFile(node)
      refreshTree() // 開く操作のたびに最新のディレクトリ内容へ更新（変化が無ければ再描画しない）
    })
    label.addEventListener('dblclick', (e) => {
      e.preventDefault()
      pinFile(node)
    })
    label.addEventListener('contextmenu', (e) => pathMenu(e, node.path))
    div.appendChild(label)
    return div
  }
  if (node.name.startsWith('.') || !hasPreviewable(node)) return null
  const div = document.createElement('div')
  // 再描画時は以前の展開状態を引き継ぐ（新規ディレクトリは折りたたみ）
  div.className = 'node' + (expanded && expanded.has(node.path) ? '' : ' collapsed')
  const label = document.createElement('div')
  label.className = 'dir-label'
  label.dataset.path = node.path // 展開状態の保存・復元用
  label.innerHTML = '<span class="caret">▾</span>'
  const name = document.createElement('span')
  name.textContent = node.name
  label.appendChild(name)
  label.addEventListener('click', () => {
    div.classList.toggle('collapsed')
    if (!div.classList.contains('collapsed')) {
      autoExpandSingle(div) // 子が単一フォルダのみなら連鎖展開
      refreshTree() // 展開時に最新のディレクトリ内容へ更新
    }
  })
  const children = document.createElement('div')
  children.className = 'children'
  for (const c of node.children) {
    const el = renderNode(c, expanded)
    if (el) children.appendChild(el)
  }
  div.appendChild(label)
  div.appendChild(children)
  return div
}

// ---- レンダリング ------------------------------------------------------------

const detectMarp = (src) => {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  return !!(m && /(^|\n)marp\s*:\s*true/.test(m[1]))
}

function overrideMarpTheme(src, theme) {
  if (!theme) return src
  const fm = src.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return src
  let body = fm[1]
  if (/(^|\n)theme\s*:/.test(body)) body = body.replace(/(^|\n)theme\s*:[^\n]*/, `$1theme: ${theme}`)
  else body = `theme: ${theme}\n` + body
  return src.replace(fm[0], `---\n${body}\n---`)
}

const stripFrontmatter = (src) => src.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
// frontmatter が消費する行数（レンダリングの data-line を元ソース行に揃えるオフセット）
function frontmatterLineCount(src) {
  const m = src.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return m ? m[0].split(/\r?\n/).length - 1 : 0
}

async function toBlobUrl(src, baseDir, store) {
  if (!src || /^(https?:|data:|blob:|#|\/)/i.test(src)) return null
  let decoded = src
  try {
    decoded = decodeURI(src)
  } catch {}
  const resolved = resolvePath(baseDir, decoded)
  const h = fileMap.get(resolved)
  if (!h) return null
  try {
    const url = URL.createObjectURL(await h.getFile())
    store.push(url)
    return url
  } catch {
    return null
  }
}

async function resolveImages(htmlString, baseDir, store) {
  const doc = new DOMParser().parseFromString(htmlString, 'text/html')
  for (const img of doc.querySelectorAll('img[src]')) {
    const url = await toBlobUrl(img.getAttribute('src'), baseDir, store)
    if (url) img.setAttribute('src', url)
  }
  for (const el of doc.querySelectorAll('[style*="url("]')) {
    const s = el.getAttribute('style')
    const m = s.match(/url\((['"]?)([^'")]+)\1\)/)
    if (m) {
      const url = await toBlobUrl(m[2], baseDir, store)
      if (url) el.setAttribute('style', s.replace(m[0], `url("${url}")`))
    }
  }
  return '<!doctype html>' + doc.documentElement.outerHTML
}

async function buildDocument(tab, src) {
  const baseDir = posixDirname(tab.path)

  // ソース表示モード（見出し行にアンカーを付与してアウトラインを有効化）
  if (tab.source) {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    let inFence = false
    let hi = 0
    const body = src
      .split(/\r?\n/)
      .map((line, i) => {
        let attrs = `data-line="${i}"`
        if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
        else if (!inFence) {
          const m = line.match(/^(#{1,6})\s+.*$/)
          if (m) attrs += ` id="mdp-src-h-${hi++}" data-mdp-level="${m[1].length}"`
        }
        return `<span ${attrs}>${esc(line)}</span>`
      })
      .join('\n')
    return `<!doctype html><html><head><meta charset="utf-8">
<style>body{margin:0;} pre{margin:0;padding:16px;font-family:ui-monospace,SFMono-Regular,Consolas,"Courier New",monospace;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word;}</style>
</head><body><pre>${body}</pre></body></html>`
  }

  // タブごとに保持した表示設定から モード / marpテーマ / 標準CSS を解決
  const v = tab.view || ''
  let mode = 'auto'
  let theme = '' // marp テーマ上書き（auto は frontmatter 準拠）
  let stdCssText = ''
  if (v.startsWith('std:')) {
    mode = 'standard'
    const sel = styleList.find((s) => s.path === v.slice(4))
    stdCssText = sel ? sel.css : ''
  } else if (v.startsWith('marp:')) {
    mode = 'marp'
    theme = v.slice(5)
  }
  const isMarp = mode === 'marp' || (mode === 'auto' && detectMarp(src))

  for (const u of tab.blobUrls) URL.revokeObjectURL(u)
  tab.blobUrls = []

  let html
  if (isMarp) {
    const marp = new Marp({ html: true, math: true })
    for (const t of themeList) {
      try {
        marp.themeSet.add(t.css)
      } catch {}
    }
    const out = marp.render(overrideMarpTheme(src, theme))
    html = `<!doctype html><html><head><meta charset="utf-8">
<style>${out.css}</style>
<style>
  html,body{margin:0;background:#525659;}
  div.marpit{
    display:flex; flex-wrap:wrap; justify-content:center; align-content:flex-start;
    gap:16px; padding:16px; box-sizing:border-box;
  }
  div.marpit > svg{ flex:0 0 auto; }
  @media print {
    @page { margin: 0; }
    html,body{ background:#fff !important; margin:0 !important; }
    div.marpit{ display:block !important; gap:0 !important; padding:0 !important; }
    div.marpit > svg{
      display:block !important;
      width:100% !important; height:auto !important; max-height:100vh !important;
      margin:0 auto !important;
      break-after:page; page-break-after:always;
    }
    div.marpit > svg:last-of-type{ break-after:auto; page-break-after:auto; }
  }
</style>
</head><body>${out.html}</body></html>`
  } else {
    // 標準モードは選択 CSS、自動判定(標準)は既定 CSS
    const css = mode === 'standard' ? stdCssText : defaultStdCss
    const body = md.render(stripFrontmatter(src), { mdpLineOffset: frontmatterLineCount(src) })
    html = `<!doctype html><html><head><meta charset="utf-8">
<style>${css}</style>
<style>
  html{background:#525659 !important;}
  body{margin:0 !important; padding:24px 0 !important; min-height:100vh; box-sizing:border-box; background:#525659 !important;}
  .markdown-body{
    box-sizing:border-box; max-width:980px; margin:0 auto !important; padding:32px 40px;
    background:#fff !important; border-radius:4px; box-shadow:0 2px 14px rgba(0,0,0,.3);
  }
  @media print {
    /* 上下はページ余白（ダイアログ Default 時に有効）、左右はコンテンツ padding で常に確保 */
    @page { margin: 14mm 0; }
    /* 選択 CSS の背景色（h1 帯・コード背景など）を印刷でも出す */
    * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    html,body{ background:#fff !important; padding:0 !important; min-height:0 !important; }
    .markdown-body{ max-width:none !important; margin:0 !important; box-shadow:none !important; border-radius:0 !important; padding:0 16mm !important; }
  }
</style>
</head><body><article class="markdown-body">${body}</article></body></html>`
  }
  return resolveImages(html, baseDir, tab.blobUrls)
}

// 2つのソース(a=変更前, b=変更後)を比較し、最初に異なる行番号(0始まり)を返す（差分なしは -1）
function firstChangedLine(a, b) {
  const al = a.split(/\r?\n/)
  const bl = b.split(/\r?\n/)
  const n = Math.min(al.length, bl.length)
  for (let i = 0; i < n; i++) if (al[i] !== bl[i]) return i
  if (bl.length > al.length) return n // 末尾に追記 → 最初の新規行
  if (al.length > bl.length) return Math.max(0, bl.length - 1) // 末尾削除 → 変更後の最終行
  return -1
}

async function renderTab(tab, autoScroll) {
  try {
    const file = await tab.handle.getFile()
    tab.lastModified = file.lastModified
    if (isPdfPath(tab.path)) {
      // PDF はブラウザ標準ビューアで表示（blob URL）
      for (const u of tab.blobUrls) URL.revokeObjectURL(u)
      tab.blobUrls = []
      const url = URL.createObjectURL(file)
      tab.blobUrls.push(url)
      tab.headings = []
      tab.iframe.removeAttribute('srcdoc')
      tab.iframe.src = url + '#toolbar=1'
      if (tab.path === activePath) renderOutline(tab)
    } else {
      const src = await file.text()
      const dv = initialView(src) // 内容から決まる既定 view
      tab.defaultView = dv
      if (!tab.view) tab.view = dv // 初回は既定を採用
      // 自動リロード時は変更行を特定して、その要素へスクロール
      if (autoScroll && tab.prevSrc != null) {
        const line = firstChangedLine(tab.prevSrc, src)
        tab.scrollToLine = line >= 0 ? line : null
        // 内容が減った（削除）変更はハイライトしない（文字数で判定）
        tab.scrollHighlight = src.length >= tab.prevSrc.length
      } else {
        tab.scrollToLine = null
      }
      tab.prevSrc = src
      tab.iframe.removeAttribute('src')
      tab.iframe.srcdoc = await buildDocument(tab, src)
      if (tab.path === activePath) syncPreview() // セレクトを初期 view に同期
      // srcdoc 反映後の処理は iframe の load イベント（onIframeLoad）で行う
    }
  } catch (e) {
    tab.iframe.removeAttribute('src')
    if (e && e.name === 'NotAllowedError') {
      // フォルダへのアクセス許可が失効。再選択を促す
      tab.iframe.srcdoc =
        '<div style="padding:24px;font-family:sans-serif;color:#555">フォルダへのアクセス許可が切れました。<br>左上の「📂 フォルダを開く」から選び直してください。</div>'
      toast('アクセス許可が切れました。フォルダを開き直してください')
    } else {
      tab.iframe.srcdoc = `<pre style="color:red;padding:16px">${String((e && e.stack) || e)}</pre>`
    }
  }
}

// iframe ロード完了時: ズーム適用 + Ctrl ホイール購読 + アウトライン構築
function onIframeLoad(tab) {
  if (isPdfPath(tab.path)) return // PDF はネイティブビューアに委ねる（ズーム/見出しは扱わない）
  const doc = tab.iframe.contentDocument
  if (!doc) return
  applyZoomToTab(tab)
  // Ctrl + ホイールで拡大縮小（iframe 内で発生するため iframe 文書側で購読）
  doc.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      stepZoom(e.deltaY < 0 ? 1 : -1) // 切りのいい段階で拡大縮小
    },
    { passive: false }
  )
  doc.addEventListener('keydown', handleZoomKey) // iframe 内フォーカス時のショートカット
  doc.addEventListener('keydown', handlePrintKey) // iframe 内で Ctrl+P
  // リンク: 外部 → ブラウザ別タブ / 内部 → アプリ内タブ
  doc.addEventListener('click', (e) => handleLinkClick(e, tab))
  // メインコンテンツ右クリック: ソース切替/コピー等のメニュー
  doc.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    const rect = tab.iframe.getBoundingClientRect()
    showContentMenu(rect.left + e.clientX, rect.top + e.clientY, tab)
  })
  doc.addEventListener('click', hideCtx) // iframe 内クリックでメニューを閉じる
  // 見出し抽出（レンダリング: h1-h6 / ソース: data-mdp-level 付きアンカー）
  const heads = [...doc.querySelectorAll('h1,h2,h3,h4,h5,h6,[data-mdp-level]')]
  tab.headings = heads.map((h, i) => {
    if (!h.id) h.id = 'mdp-h-' + i
    const level = h.dataset.mdpLevel ? Number(h.dataset.mdpLevel) : Number(h.tagName[1])
    let text = (h.textContent || '').trim()
    if (h.dataset.mdpLevel) text = text.replace(/^#{1,6}\s+/, '') // ソースは先頭の # を除去
    return { level, text, id: h.id }
  })
  // スクロール追従ハイライト（iframe 文書のスクロールを購読）
  const onScroll = () => {
    if (tab.path === activePath) updateActiveHeading(tab)
  }
  doc.addEventListener('scroll', onScroll, { passive: true, capture: true })
  if (tab.iframe.contentWindow) tab.iframe.contentWindow.addEventListener('scroll', onScroll, { passive: true })
  if (tab.path === activePath) {
    renderOutline(tab)
    updateActiveHeading(tab)
  }
  // 自動リロード時: 変更行に対応する要素へスクロール
  if (tab.scrollToLine != null) {
    scrollToLine(doc, tab.scrollToLine, tab.scrollHighlight !== false)
    tab.scrollToLine = null
  }
}

// data-line を持つ要素のうち、指定行に最も近い箇所へスクロール
function scrollToLine(doc, line, highlight) {
  const win = doc.defaultView
  const sc = doc.scrollingElement || doc.documentElement
  const doScroll = (smooth) => {
    const els = [...doc.querySelectorAll('[data-line]')]
    if (!els.length) return
    let target = null
    for (const el of els) {
      const ln = Number(el.getAttribute('data-line'))
      if (ln <= line) target = el
      else {
        if (!target) target = el
        break
      }
    }
    if (!target) return
    // 対象行を画面の少し下（上から約20%）に表示。先頭付近は最上部へ
    const margin = Math.round((win ? win.innerHeight : 600) * 0.2)
    const top = target === els[0] ? 0 : Math.max(0, target.getBoundingClientRect().top + sc.scrollTop - margin)
    sc.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' })
    if (smooth && highlight) highlightEl(target) // ハイライトは初回のみ・削除時は無し
  }
  // レイアウト確定後にスムーズスクロール
  if (win && win.requestAnimationFrame) win.requestAnimationFrame(() => win.requestAnimationFrame(() => doScroll(true)))
  else doScroll(true)
  // 画像読み込み等で位置がずれた場合に再補正（瞬時）
  if (win) win.addEventListener('load', () => doScroll(false), { once: true })
}

// 変更箇所を一時的に黄色背景でハイライト
function highlightEl(el) {
  const win = el.ownerDocument.defaultView
  const prev = el.style.backgroundColor
  el.style.transition = 'background-color .3s'
  el.style.backgroundColor = 'rgba(255, 229, 100, 0.75)'
  win.setTimeout(() => {
    el.style.backgroundColor = prev // 元の背景へ戻す（CSS 由来は '' で復帰）
    win.setTimeout(() => {
      el.style.transition = ''
    }, 400)
  }, 1400)
}

// ---- リンク処理 --------------------------------------------------------------

const isExternalHref = (href) => /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')

function handleLinkClick(e, tab) {
  // iframe 内要素は親レルムの Element ではないため instanceof は使わない
  let el = e.target
  if (el && el.nodeType === 3) el = el.parentElement // テキストノード → 親要素
  const a = el && el.closest ? el.closest('a[href]') : null
  if (!a) return
  const href = a.getAttribute('href')
  if (!href || href.startsWith('#')) return // 同一文書内アンカーは既定動作（スクロール）
  e.preventDefault()

  if (isExternalHref(href)) {
    window.open(href, '_blank', 'noopener') // 外部 → ブラウザ別タブ
    return
  }

  // 内部相対リンク → フォルダ内ファイルを解決
  let clean = href.split('#')[0].split('?')[0]
  if (!clean) return
  try {
    clean = decodeURI(clean) // 日本語・空白は percent-encode されているためデコード
  } catch {}
  const resolved = clean.startsWith('/')
    ? resolvePath('', clean)
    : resolvePath(posixDirname(tab.path), clean)
  const h = fileMap.get(resolved)
  if (!h) return // フォルダ外 / 未検出は無視
  const node = { type: 'file', name: resolved.split('/').pop(), path: resolved, handle: h }
  if (PREVIEWABLE.test(resolved)) {
    // 元タブが仮選択なら確定にしてから、リンク先を仮選択で開く
    if (tab.preview) pinTabByPath(tab.path)
    previewFile(node)
  } else {
    // 画像など非対応ファイルはブラウザ別タブで
    h.getFile()
      .then((f) => window.open(URL.createObjectURL(f), '_blank', 'noopener'))
      .catch(() => toast('ファイルを開けませんでした'))
  }
}

// ---- クリップボード / トースト / コンテキストメニュー ------------------------

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {}
    ta.remove()
    return ok
  }
}

let toastTimer = null
function toast(msg) {
  let el = document.getElementById('mdp-toast')
  if (!el) {
    el = document.createElement('div')
    el.id = 'mdp-toast'
    el.className = 'toast'
    document.body.appendChild(el)
  }
  el.textContent = msg
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), 1400)
}

const ctxEl = (() => {
  const d = document.createElement('div')
  d.className = 'ctxmenu'
  d.style.display = 'none'
  document.body.appendChild(d)
  return d
})()
const hideCtx = () => (ctxEl.style.display = 'none')
function showCtx(x, y, items) {
  ctxEl.innerHTML = ''
  for (const it of items) {
    const mi = document.createElement('div')
    mi.className = 'mi'
    mi.textContent = it.label
    mi.addEventListener('click', () => {
      hideCtx()
      it.action()
    })
    ctxEl.appendChild(mi)
  }
  ctxEl.style.display = 'block'
  ctxEl.style.left = x + 'px'
  ctxEl.style.top = y + 'px'
  const r = ctxEl.getBoundingClientRect()
  if (r.right > innerWidth) ctxEl.style.left = innerWidth - r.width - 4 + 'px'
  if (r.bottom > innerHeight) ctxEl.style.top = innerHeight - r.height - 4 + 'px'
}
document.addEventListener('click', hideCtx)
document.addEventListener('scroll', hideCtx, true)
window.addEventListener('blur', hideCtx)

function copyPathItems(path) {
  const name = path.split('/').pop()
  return [
    { label: '相対パスをコピー', action: () => copyText(path).then((ok) => toast(ok ? 'パスをコピーしました' : 'コピーに失敗しました')) },
    { label: 'ファイル名をコピー', action: () => copyText(name).then((ok) => toast(ok ? 'ファイル名をコピーしました' : 'コピーに失敗しました')) },
  ]
}

function pathMenu(e, path) {
  e.preventDefault()
  showCtx(e.clientX, e.clientY, copyPathItems(path))
}

// メインコンテンツ（プレビュー）右クリックメニュー
function showContentMenu(x, y, tab) {
  const items = []
  if (!isPdfPath(tab.path)) {
    items.push({
      label: tab.source ? 'レンダリング表示に切替' : 'ソース表示に切替',
      action: () => {
        tab.source = !tab.source
        $btnSource.classList.toggle('on', tab.source)
        updateZoomUI()
        renderTab(tab)
      },
    })
    items.push({ label: 'ソースをコピー（全体）', action: () => copyFullSource(tab) })
    items.push({ label: 'ソースをコピー（選択範囲）', action: () => copySelectionSource(tab) })
  }
  items.push({ label: '印刷 / PDF 出力', action: printActiveTab })
  items.push(...copyPathItems(tab.path))
  showCtx(x, y, items)
}

// アクティブタブのコンテンツのみ印刷（ブラウザのダイアログで PDF 保存可）
function printActiveTab() {
  const t = tabs.get(activePath)
  if (!t || !t.iframe.contentWindow) return
  t.iframe.contentWindow.focus()
  t.iframe.contentWindow.print()
}

// Ctrl+P / Cmd+P でアプリ全体ではなくアクティブコンテンツを印刷
function handlePrintKey(e) {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'p' || e.key === 'P')) {
    if (!tabs.size) return // 開いていなければブラウザ既定に任せる
    e.preventDefault()
    printActiveTab()
  }
}

// ソース全体をコピー
async function copyFullSource(tab) {
  if (!tab || isPdfPath(tab.path)) return
  try {
    const text = await (await tab.handle.getFile()).text()
    const ok = await copyText(text)
    toast(ok ? 'ソース全体をコピーしました' : 'コピーに失敗しました')
  } catch {
    toast('読み込みに失敗しました')
  }
}

// 現在の選択範囲を Markdown ソースとして取得（レンダリング表示は HTML→Markdown 変換）
function getSelectionMarkdown(tab) {
  const win = tab.iframe.contentWindow
  const winSel = win && win.getSelection ? win.getSelection() : null
  const selStr = winSel ? String(winSel) : ''
  if (!selStr || !selStr.trim()) return ''
  if (tab.source) return selStr // ソース表示は生テキストそのまま
  if (winSel.rangeCount) {
    try {
      const idoc = tab.iframe.contentDocument
      const div = idoc.createElement('div')
      for (let i = 0; i < winSel.rangeCount; i++) div.appendChild(winSel.getRangeAt(i).cloneContents())
      const html = div.innerHTML
      if (html.trim()) return turndown.turndown(html)
    } catch {}
  }
  return selStr
}

// 選択範囲のソースをコピー
async function copySelectionSource(tab) {
  if (!tab || isPdfPath(tab.path)) return
  const out = getSelectionMarkdown(tab)
  if (!out || !out.trim()) {
    toast('選択範囲がありません')
    return
  }
  const ok = await copyText(out)
  toast(ok ? '選択範囲をコピーしました' : 'コピーに失敗しました')
}

// ---- ズーム（タブごと・表示モードごと） -------------------------------------

// 切りのいいズーム段階（100% を含む）
const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]
const nearestZoomIndex = (z) => {
  let bi = 0
  let bd = Infinity
  ZOOM_LEVELS.forEach((l, i) => {
    const d = Math.abs(l - z)
    if (d < bd) {
      bd = d
      bi = i
    }
  })
  return bi
}

const zoomKey = (t) => (t.source ? 'source' : 'rendered')
const getZoom = (t) => (t ? t.zoom[zoomKey(t)] : 1)

// タブの現在モードのズームを iframe に適用
function applyZoomToTab(t) {
  if (!t || isPdfPath(t.path)) return
  const doc = t.iframe.contentDocument
  if (!doc || !doc.body) return
  const z = getZoom(t)
  const marpit = doc.querySelector('div.marpit')
  if (marpit) {
    // marp は SVG スライド。Chromium は zoom を SVG/foreignObject に効かせられないため
    // 各スライドの SVG 表示サイズ（viewBox × 倍率）を直接指定してスケールする
    doc.body.style.zoom = ''
    for (const svg of marpit.querySelectorAll(':scope > svg')) {
      const vb = svg.viewBox && svg.viewBox.baseVal
      const w = (vb && vb.width) || parseFloat(svg.getAttribute('width')) || 1280
      const h = (vb && vb.height) || parseFloat(svg.getAttribute('height')) || 720
      svg.style.width = w * z + 'px'
      svg.style.height = h * z + 'px'
    }
  } else {
    doc.body.style.zoom = z
  }
}

// ズーム UI（セレクト/ボタン）をアクティブタブの現在モードに同期
function updateZoomUI() {
  const t = tabs.get(activePath)
  const disabled = !t || isPdfPath(t.path)
  $zoomSelect.value = String(ZOOM_LEVELS[nearestZoomIndex(getZoom(t))])
  $zoomSelect.disabled = disabled
  $zoomIn.disabled = disabled
  $zoomOut.disabled = disabled
}

// アクティブタブの現在モードのズームを設定
function setActiveZoom(z) {
  const t = tabs.get(activePath)
  if (!t || isPdfPath(t.path)) return
  t.zoom[zoomKey(t)] = ZOOM_LEVELS[nearestZoomIndex(z)]
  applyZoomToTab(t)
  updateZoomUI()
}

// dir: +1 拡大 / -1 縮小（段階を1つ移動）
function stepZoom(dir) {
  const t = tabs.get(activePath)
  if (!t || isPdfPath(t.path)) return
  const i = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, nearestZoomIndex(getZoom(t)) + dir))
  setActiveZoom(ZOOM_LEVELS[i])
}

function handleZoomKey(e) {
  if (!(e.ctrlKey && e.shiftKey)) return
  if (e.key === '+' || e.key === '=') {
    e.preventDefault()
    stepZoom(1)
  } else if (e.key === '-' || e.key === '_') {
    e.preventDefault()
    stepZoom(-1)
  } else if (e.key === '0') {
    e.preventDefault()
    setActiveZoom(1)
  }
}

// ---- タブ / プレビュー -------------------------------------------------------

function openTab(node, preview) {
  const iframe = document.createElement('iframe')
  iframe.className = 'hidden'
  const tab = { iframe, label: node.name, path: node.path, handle: node.handle, lastModified: 0, blobUrls: [], headings: [], preview: !!preview, view: '', defaultView: '', source: false, zoom: { rendered: 1, source: 1 } }
  iframe.addEventListener('load', () => onIframeLoad(tab))
  $preview.appendChild(iframe)
  tabs.set(node.path, tab)
  renderTabs()
  activateTab(node.path)
  renderTab(tab)
}

// 仮選択: シングルクリック。既存の仮選択タブを置き換える
function previewFile(node) {
  if (tabs.has(node.path)) return activateTab(node.path) // 既に開いていれば切替のみ
  if (previewPath && previewPath !== node.path && tabs.has(previewPath)) closeTab(previewPath)
  previewPath = node.path
  openTab(node, true)
}

// 確定選択: ダブルクリック or チェックボックス。閉じられない（× で閉じる）
function pinFile(node) {
  if (!tabs.has(node.path)) {
    openTab(node, false)
  } else {
    const t = tabs.get(node.path)
    t.preview = false
    activateTab(node.path)
  }
  if (previewPath === node.path) previewPath = null
  setChecked(node.path, true)
  renderTabs()
}

function setChecked(path, checked) {
  const cb = document.querySelector(`.file-label[data-path="${cssEsc(path)}"] input`)
  if (cb) cb.checked = checked
}

function closeTab(path) {
  const t = tabs.get(path)
  if (!t) return
  for (const u of t.blobUrls) URL.revokeObjectURL(u)
  t.iframe.remove()
  tabs.delete(path)
  if (previewPath === path) previewPath = null
  setChecked(path, false)
  if (activePath === path) activePath = tabs.size ? [...tabs.keys()][tabs.size - 1] : null
  renderTabs()
  syncPreview()
}

function activateTab(path) {
  activePath = path
  renderTabs()
  syncPreview()
  const t = tabs.get(path)
  if (t) renderOutline(t) // 「表示」セレクトの同期は syncPreview() が担当
}

function syncPreview() {
  $empty.style.display = tabs.size ? 'none' : 'flex'
  for (const [p, t] of tabs) t.iframe.classList.toggle('hidden', p !== activePath)
  document.querySelectorAll('.file-label').forEach((el) =>
    el.classList.toggle('active', el.dataset.path === activePath)
  )
  if (activePath) revealInTree(activePath) // ツリーで該当ファイルまで展開・表示
  // 「表示」セレクトをアクティブタブの設定に同期（無い選択肢なら既定 CSS）
  const at = tabs.get(activePath)
  // タブタイトルをプレビュー中のファイル名に追従（未選択時は既定へ戻す）
  document.title = at ? tabDisplayLabel(activePath) : DEFAULT_TITLE
  $view.value = at && [...$view.options].some((o) => o.value === at.view) ? at.view : defaultViewValue()
  updateDefaultMarker() // アクティブタブの既定に (default) を付与
  // ソース/コピー系ボタンの状態
  const isMd = !!at && !isPdfPath(at.path)
  $btnSource.classList.toggle('on', !!(at && at.source))
  $btnSource.disabled = !isMd
  updateZoomUI() // ズーム UI をアクティブタブの現在モードに同期
  if (!tabs.size) $outline.innerHTML = '<div class="tree-hint">見出しがありません。</div>'
}

// 同名ファイルが複数開かれているタブは親ディレクトリ名を付けて区別
function tabDisplayLabel(path) {
  const name = path.split('/').pop()
  let dup = 0
  for (const p of tabs.keys()) if (p.split('/').pop() === name) dup++
  if (dup <= 1) return name
  const dir = posixDirname(path)
  const parent = dir ? dir.split('/').pop() : ''
  return parent ? `${parent}/${name}` : name
}

function renderTabs() {
  $tabs.innerHTML = ''
  for (const [path, t] of tabs) {
    const tab = document.createElement('div')
    tab.className = 'tab' + (path === activePath ? ' active' : '') + (t.preview ? ' preview' : '')
    // 中クリックで閉じる
    tab.addEventListener('mousedown', (e) => {
      if (e.button === 1) {
        e.preventDefault()
        closeTab(path)
      }
    })
    tab.addEventListener('contextmenu', (e) => pathMenu(e, path))
    const icon = document.createElement('span')
    icon.className = 'ficon'
    icon.innerHTML = fileIcon(t.label)
    tab.appendChild(icon)
    const title = document.createElement('span')
    title.textContent = tabDisplayLabel(path)
    title.title = path
    title.addEventListener('click', () => activateTab(path))
    title.addEventListener('dblclick', () => pinTabByPath(path))
    const close = document.createElement('span')
    close.className = 'close'
    close.textContent = '×'
    close.addEventListener('click', (e) => {
      e.stopPropagation()
      closeTab(path)
    })
    tab.appendChild(title)
    tab.appendChild(close)
    $tabs.appendChild(tab)
  }
}

// タブ/一覧のダブルクリックで仮選択 → 確定
function pinTabByPath(path) {
  const t = tabs.get(path)
  if (!t) return
  t.preview = false
  if (previewPath === path) previewPath = null
  setChecked(path, true)
  renderTabs()
}

// ---- 見出しアウトライン（右） ------------------------------------------------

// フラットな見出し列を level に基づき入れ子ツリーへ
function buildHeadingTree(heads) {
  const root = { children: [] }
  const stack = [{ level: 0, node: root }]
  for (const h of heads) {
    const node = { ...h, children: [] }
    while (stack.length > 1 && stack[stack.length - 1].level >= h.level) stack.pop()
    stack[stack.length - 1].node.children.push(node)
    stack.push({ level: h.level, node })
  }
  return root.children
}

function renderOutline(tab) {
  $outline.innerHTML = ''
  tab.rowById = new Map()
  const heads = tab.headings || []
  if (!heads.length) {
    $outline.innerHTML = '<div class="tree-hint">見出しがありません。</div>'
    return
  }
  const tree = buildHeadingTree(heads)
  for (const n of tree) $outline.appendChild(renderOutlineNode(n, tab))
  updateActiveHeading(tab)
}

function renderOutlineNode(node, tab) {
  const wrap = document.createElement('div')
  wrap.className = 'outline-node'

  const row = document.createElement('div')
  row.className = 'outline-item lv' + node.level
  tab.rowById.set(node.id, row)

  const caret = document.createElement('span')
  caret.className = 'o-caret'
  caret.textContent = node.children.length ? '▾' : ''
  if (node.children.length) {
    caret.addEventListener('click', (e) => {
      e.stopPropagation()
      wrap.classList.toggle('collapsed')
    })
  }

  const text = document.createElement('span')
  text.className = 'o-text'
  text.textContent = node.text || '(無題)'
  text.title = node.text
  text.addEventListener('click', () => {
    const doc = tab.iframe.contentDocument
    const el = doc && doc.getElementById(node.id)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })

  row.appendChild(caret)
  row.appendChild(text)
  wrap.appendChild(row)

  if (node.children.length) {
    const children = document.createElement('div')
    children.className = 'o-children'
    for (const c of node.children) children.appendChild(renderOutlineNode(c, tab))
    wrap.appendChild(children)
  }
  return wrap
}

// 現在スクロール位置にある見出しを算出してハイライト
function updateActiveHeading(tab) {
  const doc = tab.iframe.contentDocument
  if (!doc || !tab.rowById) return
  let currentId = null
  for (const h of tab.headings) {
    const el = doc.getElementById(h.id)
    if (!el) continue
    const top = el.getBoundingClientRect().top
    if (top <= 100) currentId = h.id
    else break // 見出しは文書順なので閾値を超えたら打ち切り
  }
  if (!currentId && tab.headings.length) currentId = tab.headings[0].id
  if (tab.activeHeadingId === currentId) return
  tab.activeHeadingId = currentId
  for (const [id, row] of tab.rowById) row.classList.toggle('active', id === currentId)
  const activeRow = tab.rowById.get(currentId)
  if (activeRow) activeRow.scrollIntoView({ block: 'nearest' })
}

// ---- ライブリロード（ポーリング） --------------------------------------------

setInterval(async () => {
  // バックグラウンド時は File System Access の getFile が NotAllowedError になるため監視しない
  if (document.hidden) return
  for (const t of tabs.values()) {
    try {
      const lm = (await t.handle.getFile()).lastModified
      if (t.lastModified && lm !== t.lastModified) {
        t.lastModified = lm
        renderTab(t, true) // 変更箇所へ自動スクロール
      }
    } catch {}
  }
}, 500)

// ---- ディレクトリツリーの定期更新（ファイルの追加 / 削除 / リネームを反映）----
// バックグラウンド時は File System Access の走査が失敗するので動かさない。
// 構成に変化が無ければ refreshTree 内で再描画をスキップする（ちらつき・負荷を回避）。
setInterval(() => {
  if (document.hidden) return
  refreshTree()
}, 2500)

// ---- サイズ可変サイドバー（localStorage 永続化） -----------------------------

function setLeftHidden(hidden) {
  $sidebar.style.display = hidden ? 'none' : '' // スプリッタはレールとして残す
  $splitLeft.classList.toggle('collapsed', hidden)
  $collapseLeft.textContent = hidden ? '›' : '‹'
  $collapseLeft.title = hidden ? 'フォルダを表示' : 'フォルダを非表示'
  localStorage.setItem(LS.leftHidden, hidden ? '1' : '')
}

function setRightHidden(hidden) {
  $sidebarRight.style.display = hidden ? 'none' : ''
  $splitRight.classList.toggle('collapsed', hidden)
  $collapseRight.textContent = hidden ? '‹' : '›'
  $collapseRight.title = hidden ? '見出しを表示' : '見出しを非表示'
  localStorage.setItem(LS.rightHidden, hidden ? '1' : '')
}

function restoreLayout() {
  const lw = parseInt(localStorage.getItem(LS.leftWidth), 10)
  if (lw) $sidebar.style.width = lw + 'px'
  const rw = parseInt(localStorage.getItem(LS.rightWidth), 10)
  if (rw) $sidebarRight.style.width = rw + 'px'
  setLeftHidden(localStorage.getItem(LS.leftHidden) === '1')
  setRightHidden(localStorage.getItem(LS.rightHidden) === '1')
  // ズームのセレクトを構築（各段階の % 表示）
  $zoomSelect.innerHTML = ''
  for (const l of ZOOM_LEVELS) {
    const o = document.createElement('option')
    o.value = String(l)
    o.textContent = Math.round(l * 100) + '%'
    $zoomSelect.appendChild(o)
  }
  updateZoomUI()
}

function makeDrag(handle, onMove, onEnd, axis, onToggle) {
  // Pointer Events + setPointerCapture により、iframe 上やウィンドウ外で離しても
  // 必ず pointerup が届き、resizing(=iframe の pointer-events:none) が解除される
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const onHandleBtn = !!(e.target.closest && e.target.closest('.split-handle'))
    const collapsed = handle.classList.contains('collapsed')
    const start = axis === 'x' ? e.clientX : e.clientY
    let moved = false
    try {
      handle.setPointerCapture(e.pointerId)
    } catch {}
    if (!collapsed) {
      document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'
      document.body.style.userSelect = 'none'
      document.body.classList.add('resizing')
    }
    const move = (ev) => {
      const d = (axis === 'x' ? ev.clientX : ev.clientY) - start
      if (Math.abs(d) > 3) moved = true
      if (!collapsed && moved) onMove(d) // 折りたたみ中はリサイズしない
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      try {
        handle.releasePointerCapture(e.pointerId)
      } catch {}
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.body.classList.remove('resizing')
      if (moved) {
        if (!collapsed) onEnd()
      } else if (onHandleBtn && onToggle) {
        onToggle() // 動かさず離した＝ハンドルのクリック → 開閉
      }
      // フォーカスをメインコンテンツへ戻す（スクロール可能にする）
      const at = tabs.get(activePath)
      if (at && at.iframe && at.iframe.contentWindow) {
        try {
          at.iframe.contentWindow.focus()
        } catch {}
      }
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  })
}

function setupSplitters() {
  // 左サイドバー幅
  let baseW = 0
  makeDrag(
    document.getElementById('split-left'),
    (d) => {
      const w = Math.max(160, Math.min(window.innerWidth * 0.6, baseW + d))
      $sidebar.style.width = w + 'px'
    },
    () => localStorage.setItem(LS.leftWidth, parseInt($sidebar.offsetWidth, 10)),
    'x',
    () => setLeftHidden($sidebar.style.display !== 'none')
  )
  document.getElementById('split-left').addEventListener('pointerdown', () => (baseW = $sidebar.offsetWidth))

  // 右サイドバー幅（ハンドルは右サイドバーの左側 → 右ドラッグで縮小）
  let baseRW = 0
  makeDrag(
    document.getElementById('split-right'),
    (d) => {
      const w = Math.max(140, Math.min(window.innerWidth * 0.6, baseRW - d))
      $sidebarRight.style.width = w + 'px'
    },
    () => localStorage.setItem(LS.rightWidth, parseInt($sidebarRight.offsetWidth, 10)),
    'x',
    () => setRightHidden($sidebarRight.style.display !== 'none')
  )
  document.getElementById('split-right').addEventListener('pointerdown', () => (baseRW = $sidebarRight.offsetWidth))
}

// ---- イベント ---------------------------------------------------------------

// ボタンのアイコンを SVG で設定（ICONS を単一の定義元にする）
$openBtn.innerHTML = ICONS.folder
$openPathBtn.innerHTML = ICONS.file
$btnPrint.innerHTML = ICONS.printer

$openBtn.addEventListener('click', openFolder)
$openPathBtn.addEventListener('click', openPathDialog)
// 開閉はスプリッタのドラッグ判定（makeDrag の onToggle）で処理する
// 「表示」変更はアクティブなタブにのみ適用・保持する
$view.addEventListener('change', () => {
  const t = tabs.get(activePath)
  if (!t) return
  t.view = $view.value
  renderTab(t)
})
$zoomSelect.addEventListener('change', () => setActiveZoom(parseFloat($zoomSelect.value)))
$zoomIn.addEventListener('click', () => stepZoom(1))
$zoomOut.addEventListener('click', () => stepZoom(-1))
document.addEventListener('keydown', handleZoomKey)
document.addEventListener('keydown', handlePrintKey)
$btnSource.addEventListener('click', () => {
  const t = tabs.get(activePath)
  if (!t || isPdfPath(t.path)) return
  t.source = !t.source
  $btnSource.classList.toggle('on', t.source)
  updateZoomUI() // モード切替でズーム表示も切替モードのものに
  renderTab(t)
})
$btnPrint.addEventListener('click', printActiveTab)

restoreLayout()
setupSplitters()
