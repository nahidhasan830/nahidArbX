
module.exports = {
  apps: [
    {
      name: "nahidarbx",

      script: "npm",
      args: "run start",

      cwd: __dirname,


      autorestart: true,

      exp_backoff_restart_delay: 100,

      max_restarts: 50,

      min_uptime: "10s",

      max_memory_restart: "1G",


      instances: 1,

      exec_mode: "fork",


      out_file: "./logs/pm2-out.log",
      error_file: "./logs/pm2-error.log",

      merge_logs: true,

      time: true,


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


      watch: false,

      ignore_watch: [
        "node_modules",
        "logs",
        ".git",
        ".next",
        "sessions",
        "rawData",
      ],


      kill_timeout: 5000,

      wait_ready: true,

      shutdown_with_message: true,


    },

    {
      name: "nahidarbx-engine",

      script: "node",
      args: "--import tsx/esm engine.ts",

      cwd: __dirname,

      autorestart: true,
      exp_backoff_restart_delay: 100,
      max_restarts: 50,
      min_uptime: "10s",
      max_memory_restart: "2G", // Engine gets generous 2GB limit

      instances: 1,
      exec_mode: "fork",

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

      kill_timeout: 5000,
      wait_ready: true,
      shutdown_with_message: true,
    },

    {
      name: "tunnel",
      script: "cloudflared",
      args: "tunnel run",
      autorestart: true,
      max_restarts: 50,
      exp_backoff_restart_delay: 100,
    },
  ],

  deploy: {
    production: {
      user: "deploy",

      host: "your-server.com",

      ref: "origin/main",

      repo: "git@github.com:user/nahidarbx.git",

      path: "/var/www/nahidarbx",

      "pre-deploy-local": "",

      "post-deploy":
        "npm ci && npm run build && pm2 reload ecosystem.config.js --env production",

      "pre-setup": "",
    },
  },
};
