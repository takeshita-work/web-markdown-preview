#!/usr/bin/env bash
# web-markdown-preview 起動スクリプト (macOS / Linux)
#   使い方:
#     ./start.sh           # ポート 4321 で起動
#     ./start.sh 5000      # ポート指定
#   プレビュー対象フォルダはブラウザの「フォルダを開く」で選択します。
set -e

# tools/web-markdown-preview のルート (scripts の1つ上)
TOOL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$TOOL_DIR"

if [ ! -d node_modules ]; then
  echo "[web-markdown-preview] 依存をインストールしています..."
  npm install
fi

PORT="${1:-4321}"

# 少し待ってからブラウザを開く
(
  sleep 3
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "http://localhost:$PORT"
  elif command -v open >/dev/null 2>&1; then open "http://localhost:$PORT"
  fi
) >/dev/null 2>&1 &

echo "[web-markdown-preview] http://localhost:$PORT"
node bin/cli.js --port "$PORT"
