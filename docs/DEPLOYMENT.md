# Deployment Guide

This guide covers deploying NahidArbX on your local MacBook with PM2 and Cloudflare Tunnel.

## Quick Start

```bash
# One command deploy (build + start with PM2)
npm run deploy
```

## Prerequisites

- Node.js 20+
- npm
- PM2 (`npm install -g pm2`)
- cloudflared (`brew install cloudflared`)

## Initial Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Environment Variables

Create `.env.local` with your credentials:

```env
# Betjili/Pinnacle (required for token capture)
BETJILI_USERNAME=your_username
BETJILI_PASSWORD=your_password

# Security (required)
JWT_SECRET=your_random_secret_key_at_least_32_chars

# Token capture mode
TOKEN_HEADLESS=true   # false to see browser during debugging
```

**Note:** Production env vars like `PORT` and `FETCH_INTERVAL_MS` are set in `ecosystem.config.js`.

### 3. Cloudflare Tunnel Setup (First Time Only)

```bash
# Login to Cloudflare
cloudflared tunnel login

# Create a named tunnel
cloudflared tunnel create nahidarbx

# Configure tunnel (creates ~/.cloudflared/config.yml)
# Point it to your domain and localhost:4747
```

## Deployment Commands

### Deploy (Build + Start)

```bash
npm run deploy
```

This command:

1. Builds the production app
2. Stops any existing PM2 process
3. Starts the app with PM2 (port 4747)
4. Shows PM2 process list

### Start All Services (App + Tunnel)

```bash
pm2 start ecosystem.config.js --env production
```

### View Status

```bash
pm2 list
```

### View Logs

```bash
# All logs
pm2 logs

# App logs only
pm2 logs nahidarbx

# Tunnel logs only
pm2 logs tunnel

# Follow logs (real-time)
pm2 logs --lines 100
```

### Restart Services

```bash
# Restart app only
pm2 restart nahidarbx

# Restart all
pm2 restart all
```

### Stop Services

```bash
# Stop all
pm2 stop all

# Stop specific service
pm2 stop nahidarbx
pm2 stop tunnel
```

## PM2 Configuration

All PM2 settings are in `ecosystem.config.js`:

| Setting              | Value | Description                   |
| -------------------- | ----- | ----------------------------- |
| `PORT`               | 4747  | Production port               |
| `FETCH_INTERVAL_MS`  | 30000 | Sync every 30 seconds         |
| `max_memory_restart` | 1G    | Restart if memory exceeds 1GB |
| `autorestart`        | true  | Auto-restart on crash         |

### Modify Sync Interval

Edit `ecosystem.config.js`:

```javascript
env_production: {
  NODE_ENV: "production",
  PORT: 4747,
  FETCH_INTERVAL_MS: 30000,  // Change this (in milliseconds)
},
```

Then restart:

```bash
pm2 restart nahidarbx --env production
```

## Auto-Start on Mac Reboot

### Setup (One Time)

```bash
# Generate startup script
pm2 startup

# Run the command it outputs (requires sudo)
sudo env PATH=$PATH:/Users/nahidhasan/.nvm/versions/node/v20.12.2/bin pm2 startup launchd -u nahidhasan --hp /Users/nahidhasan

# Save current process list
pm2 save
```

After this, PM2 will auto-start your app and tunnel when your Mac boots.

## Health Check

```bash
# Local check
curl http://localhost:4747/api/health

# Public check (via tunnel)
curl https://nahidarbx.store/api/health
```

## Troubleshooting

### App not starting?

```bash
# Check logs
pm2 logs nahidarbx --lines 50

# Check if port is in use
lsof -i :4747

# Kill process on port
lsof -ti:4747 | xargs kill -9
```

### Tunnel not working?

```bash
# Check tunnel logs
pm2 logs tunnel --lines 50

# Restart tunnel
pm2 restart tunnel

# Check cloudflared config
cat ~/.cloudflared/config.yml
```

### Too many Chrome processes?

```bash
# Kill all Chromium processes
pkill -f Chromium

# Check count
ps aux | grep -i chrom | wc -l
```

### Token capture fails?

1. Set `TOKEN_HEADLESS=false` in `.env.local`
2. Restart app: `pm2 restart nahidarbx`
3. Watch the browser to debug

### Build hangs?

The scheduler was starting during build. This is fixed - if it happens:

```bash
# Force kill and rebuild
pkill -f node
npm run deploy
```

## File Locations

| File                  | Purpose                       |
| --------------------- | ----------------------------- |
| `ecosystem.config.js` | PM2 configuration             |
| `.env.local`          | Secrets (credentials, JWT)    |
| `logs/pm2-out.log`    | PM2 stdout logs               |
| `logs/pm2-error.log`  | PM2 error logs                |
| `sessions/betjili/`   | Browser session & token cache |
| `~/.cloudflared/`     | Cloudflare tunnel config      |

## Management Summary

| Task        | Command                 |
| ----------- | ----------------------- |
| Deploy      | `npm run deploy`        |
| View status | `pm2 list`              |
| View logs   | `pm2 logs`              |
| Restart app | `pm2 restart nahidarbx` |
| Restart all | `pm2 restart all`       |
| Stop all    | `pm2 stop all`          |
| Save state  | `pm2 save`              |
| Monitor     | `pm2 monit`             |
