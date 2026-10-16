#!/usr/bin/env bash
set -e

TARGET_DIR="${1:-$(pwd)}"
APP_NAME="${2:-btcusd}"

# 1. Load shell environment & NVM paths for non-interactive SSH
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$HOME/.profile" ] && \. "$HOME/.profile"
[ -s "$HOME/.bashrc" ] && \. "$HOME/.bashrc" 2>/dev/null || true

# Add any installed Node version from nvm or standard paths
if [ -d "$HOME/.nvm/versions/node" ]; then
  LATEST_NODE_DIR="$(ls -1d "$HOME/.nvm/versions/node"/* 2>/dev/null | tail -n 1)"
  if [ -n "$LATEST_NODE_DIR" ] && [ -d "$LATEST_NODE_DIR/bin" ]; then
    export PATH="$LATEST_NODE_DIR/bin:$PATH"
  fi
fi
export PATH="$HOME/.local/bin:$HOME/bin:/usr/local/bin:/usr/bin:$PATH"

echo "=== Server Environment ==="
echo "Node: $(node -v 2>/dev/null || echo 'not found')"
echo "NPM:  $(npm -v 2>/dev/null || echo 'not found')"

cd "${TARGET_DIR}"
mkdir -p data

echo "=== Installing Dependencies ==="
if ! command -v pnpm &> /dev/null && command -v npm &> /dev/null; then
  echo "Installing pnpm..."
  npm install -g pnpm 2>/dev/null || true
fi

if command -v pnpm &> /dev/null; then
  pnpm install --frozen-lockfile
elif command -v npm &> /dev/null; then
  npm install
else
  echo "Warning: neither pnpm nor npm found in PATH!"
fi

echo "=== Building Production Assets ==="
if command -v pnpm &> /dev/null; then
  pnpm run build
elif command -v npm &> /dev/null; then
  npm run build
fi

echo "=== Checking PM2 ==="
if ! command -v pm2 &> /dev/null; then
  echo "pm2 not found in PATH. Checking global install or npx..."
  if command -v npm &> /dev/null; then
    npm install -g pm2 || true
  fi
fi

if command -v pm2 &> /dev/null; then
  PM2_BIN="pm2"
elif command -v npx &> /dev/null; then
  PM2_BIN="npx pm2"
elif [ -f "./node_modules/.bin/pm2" ]; then
  PM2_BIN="./node_modules/.bin/pm2"
else
  echo "ERROR: Neither pm2 nor npx could be executed!"
  exit 1
fi
echo "Using PM2 executable: $PM2_BIN"

echo "=== Managing Application with PM2 ==="
if $PM2_BIN describe "${APP_NAME}" &> /dev/null; then
  echo "Reloading existing process ${APP_NAME}..."
  $PM2_BIN reload "${APP_NAME}" --update-env || $PM2_BIN restart "${APP_NAME}" --update-env
else
  echo "Starting new process ${APP_NAME}..."
  if [ -f "ecosystem.config.cjs" ]; then
    $PM2_BIN start ecosystem.config.cjs --name "${APP_NAME}"
  else
    $PM2_BIN start npm --name "${APP_NAME}" -- start
  fi
fi

$PM2_BIN save
echo "=== PM2 Process Status ==="
$PM2_BIN status
echo "Deployment complete!"
