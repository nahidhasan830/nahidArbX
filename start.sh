#!/bin/bash
# NahidArbX Production Startup Script

echo "🚀 Starting NahidArbX (Production)..."

# Stop existing processes
pkill -f "node.*next" 2>/dev/null
pkill -f "cloudflared" 2>/dev/null
sleep 2

# Start the production app
cd "$(dirname "$0")"
PORT=4747 NODE_ENV=production nohup npm start > /tmp/arbx.log 2>&1 &
echo "⏳ Waiting for app to start..."
sleep 5

# Check if app is running
if curl -s http://localhost:4747/api/health > /dev/null 2>&1; then
  echo "✅ App running on http://localhost:4747"
else
  echo "❌ App failed to start. Check: tail -f /tmp/arbx.log"
  exit 1
fi

# Start Cloudflare tunnel (permanent)
nohup cloudflared tunnel run nahidarbx > /tmp/tunnel.log 2>&1 &
echo "⏳ Starting tunnel..."
sleep 3

echo ""
echo "==========================================="
echo "🌐 PUBLIC URL: https://nahidarbx.store"
echo "==========================================="
echo ""
echo "Commands:"
echo "  View app logs:    tail -f /tmp/arbx.log"
echo "  View tunnel logs: tail -f /tmp/tunnel.log"
echo "  Stop all:         pkill -f 'node.*next'; pkill -f cloudflared"
