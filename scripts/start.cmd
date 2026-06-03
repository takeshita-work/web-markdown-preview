@echo off
rem ============================================================
rem  web-markdown-preview 起動スクリプト (Windows / ダブルクリック対応)
rem    使い方:
rem      start.cmd            … ポート 4321 で起動
rem      start.cmd 5000       … ポート指定
rem  プレビュー対象フォルダはブラウザの「フォルダを開く」で選択します。
rem ============================================================
setlocal
chcp 65001 >nul

rem tools/web-markdown-preview のルート (このスクリプトの1つ上)
set "TOOL_DIR=%~dp0.."
pushd "%TOOL_DIR%"

rem 依存が未インストールなら導入
if not exist "node_modules" (
  echo [web-markdown-preview] 依存をインストールしています...
  call npm install
  if errorlevel 1 (
    echo [web-markdown-preview] npm install に失敗しました。
    popd & pause & exit /b 1
  )
)

if "%~1"=="" (set "PORT=4321") else (set "PORT=%~1")

rem 少し待ってからブラウザを開く (サーバ起動待ち)
start "" cmd /c "timeout /t 3 >nul & start http://localhost:%PORT%"

echo [web-markdown-preview] http://localhost:%PORT%
node "bin\cli.js" --port %PORT%

popd
endlocal
