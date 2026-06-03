<#
  web-markdown-preview 起動スクリプト (PowerShell)
    使い方:
      ./start.ps1            # ポート 4321 で起動
      ./start.ps1 -Port 5000 # ポート指定
  プレビュー対象フォルダはブラウザの「フォルダを開く」で選択します。
  ※ カレントディレクトリは変更しません（Set-Location を使いません）。
#>
param(
  [int]$Port = 4321
)
$ErrorActionPreference = 'Stop'

# スクリプトの場所を取得（実行環境差に強いようフォールバックする）
$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition }
if (-not $ScriptDir) { throw 'スクリプトの場所を特定できませんでした。start.ps1 をフルパスで実行してください。' }

# tools/web-markdown-preview のルート (scripts の1つ上)。cd せず絶対パスで参照する。
$ToolDir = Split-Path -Parent $ScriptDir

if (-not (Test-Path (Join-Path $ToolDir 'node_modules'))) {
  Write-Host '[web-markdown-preview] 依存をインストールしています...'
  npm install --prefix $ToolDir
}

# 少し待ってからブラウザを開く (サーバ起動待ち)
Start-Job { Start-Sleep -Seconds 3; Start-Process "http://localhost:$using:Port" } | Out-Null

Write-Host "[web-markdown-preview] http://localhost:$Port"
node (Join-Path $ToolDir 'bin/cli.js') --port $Port
