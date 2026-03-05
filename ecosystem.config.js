module.exports = {
  apps: [
    {
      name: 'consensus-main',
      script: './node_modules/.bin/dotenvx',
      args: 'run -- node server.js',
      interpreter: 'none',
      cwd: '/home/icpi/Desktop/consensus/server',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        DOTENV_PRIVATE_KEY: process.env.DOTENV_PRIVATE_KEY
      },
      error_file: '/home/icpi/Desktop/consensus/logs/main-error.log',
      out_file: '/home/icpi/Desktop/consensus/logs/main-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    },
    {
      name: 'consensus-proxy',
      script: './node_modules/.bin/dotenvx',
      args: 'run -- node server.js',
      interpreter: 'none',
      cwd: '/home/icpi/Desktop/consensus/x402-proxy',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '2G',
      env: {
        DOTENV_PRIVATE_KEY: process.env.DOTENV_PRIVATE_KEY_PROXY
      },
      error_file: '/home/icpi/Desktop/consensus/logs/proxy-error.log',
      out_file: '/home/icpi/Desktop/consensus/logs/proxy-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    }
  ]
};
