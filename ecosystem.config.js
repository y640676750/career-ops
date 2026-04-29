module.exports = {
  apps: [
    {
      name: 'career-ops-api',
      cwd: './backend',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      time: true,
      node_args: '--expose-gc --max-old-space-size=384',
      max_memory_restart: '450M',
      kill_timeout: 10000,
      env: {
        NODE_ENV: 'production',
        HOST: '0.0.0.0'
      }
    },
    {
      name: 'career-ops-worker',
      cwd: './backend',
      script: 'src/workers/worker.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      time: true,
      node_args: '--expose-gc --max-old-space-size=384',
      max_memory_restart: '600M',
      kill_timeout: 10000,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
