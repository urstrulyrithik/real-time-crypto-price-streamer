#!/bin/bash
set -e

echo "🚀 Starting Crypto Price Streamer..."

# 1) Generate protobufs (frontend + backend)
echo "📝 Generating protobuf code..."
pnpm generate

# 2) Ensure Playwright browsers are installed for the backend (headed mode requires real browsers)
echo "🧩 Installing Playwright browsers..."
pnpm --filter backend exec playwright install

# 3) Start backend & frontend (pnpm-native, no npx)
echo "🔧 Starting backend server..."
(pnpm -C backend start) &
BACKEND_PID=$!

echo "🎨 Starting frontend server..."
(pnpm -C frontend dev) &
FRONTEND_PID=$!

cleanup() {
  echo ""
  echo "🛑 Shutting down servers..."
  kill $BACKEND_PID 2>/dev/null || true
  kill $FRONTEND_PID 2>/dev/null || true
  wait $BACKEND_PID 2>/dev/null || true
  wait $FRONTEND_PID 2>/dev/null || true
  exit 0
}

trap cleanup EXIT INT TERM
wait
