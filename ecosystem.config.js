/**
 * PM2 Ecosystem Configuration
 *
 * Production-ready process management with auto-healing capabilities.
 *
 * Features:
 * - Auto-restart on crash
 * - Exponential backoff restart strategy
 * - Memory limit monitoring
 * - Log rotation
 * - Cluster mode support
 *
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 start ecosystem.config.js --env production
 *   pm2 restart nahidarbx
 *   pm2 logs nahidarbx
 *
 * @see https://pm2.keymetrics.io/docs/usage/application-declaration/
 */

module.exports = {
  apps: [
    {
      // Application name (used in PM2 commands)
      name: "nahidarbx",

      // Start script
      script: "npm",
      args: "run start",

      // Working directory
      cwd: __dirname,

      // ==========================================
      // Auto-Healing Configuration
      // ==========================================

      // Restart on crash
      autorestart: true,

      // Exponential backoff restart (prevents restart loops)
      // Increases delay between restarts: 100ms → 200ms → 400ms → ...
      exp_backoff_restart_delay: 100,

      // Maximum restarts before giving up (0 = unlimited)
      max_restarts: 50,

      // Minimum uptime before considering app "started"
      // Prevents restart loops for apps that crash immediately
      min_uptime: "10s",

      // Restart if memory exceeds this limit (prevents memory leaks)
      max_memory_restart: "1G",

      // ==========================================
      // Cluster Mode (optional)
      // ==========================================

      // Number of instances (use "max" for all CPU cores)
      // Note: WebSocket connections may need sticky sessions
      instances: 1,

      // Execution mode: "fork" or "cluster"
      exec_mode: "fork",

      // ==========================================
      // Logging
      // ==========================================

      // Log output paths
      out_file: "./logs/pm2-out.log",
      error_file: "./logs/pm2-error.log",

      // Combine stdout and stderr into one file
      merge_logs: true,

      // Prefix logs with timestamp
      time: true,

      // Log rotation (requires pm2-logrotate module)
      // Install: pm2 install pm2-logrotate

      // ==========================================
      // Environment Variables
      // ==========================================

      env: {
        NODE_ENV: "development",
        PORT: 3000,
      },

      env_production: {
        NODE_ENV: "production",
        PORT: 4747,
        FETCH_INTERVAL_MS: 30000, // 30 seconds sync interval
        NAHIDARBX_ENGINE: "1", // Web-only mode when engine runs separately
      },

      // ==========================================
      // Watch & Reload (development only)
      // ==========================================

      // Watch for file changes (disable in production)
      watch: false,

      // Ignore patterns for watch
      ignore_watch: [
        "node_modules",
        "logs",
        ".git",
        ".next",
        "sessions",
        "rawData",
      ],

      // ==========================================
      // Graceful Shutdown
      // ==========================================

      // Time to wait for graceful shutdown (ms)
      kill_timeout: 5000,

      // Listen for shutdown signal
      wait_ready: true,

      // Signal to use for shutdown
      shutdown_with_message: true,

      // ==========================================
      // Health Check (optional - requires pm2-probe)
      // ==========================================

      // Custom health check endpoint
      // PM2 Plus feature - monitors /api/health endpoint
    },

    // ==========================================
    // Standalone Engine Process
    // Runs all background subsystems (sync, detection,
    // settlement, WebSockets, Telegram) separately from
    // the Next.js web server.
    // ==========================================
    {
      name: "nahidarbx-engine",

      script: "node",
      args: "--import tsx/esm engine.ts",

      cwd: __dirname,

      // Auto-Healing
      autorestart: true,
      exp_backoff_restart_delay: 100,
      max_restarts: 50,
      min_uptime: "10s",
      max_memory_restart: "2G", // Engine gets generous 2GB limit

      instances: 1,
      exec_mode: "fork",

      // Logging
      out_file: "./logs/pm2-engine-out.log",
      error_file: "./logs/pm2-engine-error.log",
      merge_logs: true,
      time: true,

      env: {
        NODE_ENV: "development",
        NAHIDARBX_ENGINE: "1",
      },

      env_production: {
        NODE_ENV: "production",
        NAHIDARBX_ENGINE: "1",
      },

      watch: false,

      // Graceful Shutdown
      kill_timeout: 5000,
      wait_ready: true,
      shutdown_with_message: true,
    },

    // ==========================================
    // Cloudflare Tunnel
    // ==========================================
    {
      name: "tunnel",
      script: "cloudflared",
      args: "tunnel run",
      autorestart: true,
      max_restarts: 50,
      exp_backoff_restart_delay: 100,
    },
  ],

  // ==========================================
  // Deployment Configuration (optional)
  // ==========================================
  deploy: {
    production: {
      // SSH user
      user: "deploy",

      // Target host
      host: "your-server.com",

      // Git reference
      ref: "origin/main",

      // Git repository
      repo: "git@github.com:user/nahidarbx.git",

      // Deployment path
      path: "/var/www/nahidarbx",

      // Pre-deploy commands (on local machine)
      "pre-deploy-local": "",

      // Post-deploy commands (on remote server)
      "post-deploy":
        "npm ci && npm run build && pm2 reload ecosystem.config.js --env production",

      // Pre-setup commands (first deploy only)
      "pre-setup": "",
    },
  },
};
