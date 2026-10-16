module.exports = {
  apps: [
    {
      name: process.env.PM2_APP_NAME || 'btcusd',
      script: 'src/server.ts',
      node_args: '--env-file-if-exists=.env',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
