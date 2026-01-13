module.exports = {
  apps: [
    {
      name: 'consensus-main',
      script: './server.js',
      cwd: '/home/icpi/Desktop/consensus/server',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      error_file: '/home/icpi/Desktop/consensus/logs/main-error.log',
      out_file: '/home/icpi/Desktop/consensus/logs/main-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    },
    {
      name: 'consensus-proxy',
      script: './server.js',
      cwd: '/home/icpi/Desktop/consensus/x402-proxy',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '2G',
      error_file: '/home/icpi/Desktop/consensus/logs/proxy-error.log',
      out_file: '/home/icpi/Desktop/consensus/logs/proxy-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    }
  ]
};
