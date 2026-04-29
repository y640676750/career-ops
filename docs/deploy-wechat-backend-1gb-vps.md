1GB RAM VPS deployment guide

This repository now includes a lightweight backend for WeChat mini-program integration under `backend/`.

Why this build is safer on a 1GB VPS:

- API is a single HTTP process on port `3000`
- Express `trust proxy` is enabled for Cloudflare or Nginx forwarding
- PDF generation is strictly serial inside the renderer
- BullMQ worker is fixed at `concurrency: 1`
- Puppeteer uses low-memory launch flags
- PDFs are written directly to disk instead of being kept in memory buffers
- Browser and page objects are always closed and cleared after each render
- `global.gc()` can run under PM2 because the processes start with `--expose-gc`
- Request JSON size, HTML size, and Redis job retention are capped

Recommended host baseline:

- 1 vCPU
- 1GB RAM
- 1GB to 2GB swap
- Redis available locally

Bootstrap commands:

```bash
sudo apt update
sudo apt install -y curl unzip redis-server
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
sudo systemctl enable --now redis-server
```

Optional swap:

```bash
sudo fallocate -l 1G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Install the backend:

```bash
git clone https://github.com/y640676750/career-ops.git
cd career-ops/backend
cp .env.example .env
npm install --omit=dev
```

Minimum `.env` values:

- `HOST=0.0.0.0`
- `REDIS_URL=redis://127.0.0.1:6379`
- `PUBLIC_BASE_URL=https://YOUR_DOMAIN`
- `DEEPSEEK_API_KEY=...` for model-based resume customization
- `WECHAT_APP_ID=...` and `WECHAT_APP_SECRET=...` for real mini-program login
- `WECHAT_ALLOW_DEV_LOGIN=false` in production after real WeChat login is ready
- `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium` if you prefer a system Chromium binary

Start with PM2:

```bash
cd ..
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

Smoke tests:

```bash
curl http://127.0.0.1:3000/ping

curl -X POST http://127.0.0.1:3000/api/v1/pdf/render \
  -H 'Content-Type: application/json' \
  -d '{"html":"<html><body><h1>Hello WeChat MVP</h1></body></html>","fileName":"smoke-test"}'

curl -X POST http://127.0.0.1:3000/api/v1/wechat/login \
  -H 'Content-Type: application/json' \
  -d '{"code":"dev-smoke-code","profile":{"nickName":"Dev User"}}'

curl -X POST http://127.0.0.1:3000/api/v1/resume/customize/async \
  -H 'Content-Type: application/json' \
  -d '{
    "resumeMarkdown":"# Alex Chen\nNode.js backend engineer with API and automation experience.",
    "job":{
      "companyName":"Acme AI",
      "roleTitle":"Backend Engineer",
      "description":"Need Node.js, Redis, queue systems, PDF generation, and deployment experience.",
      "language":"en"
    },
    "options":{
      "renderPdf":false
    }
  }'
```

Cloudflare origin notes:

- Keep the app listening on plain HTTP `3000`
- Let Cloudflare or Nginx terminate TLS in front
- Because `trust proxy` is enabled, forwarded protocol and client IP data are preserved
- If you publish through a domain, set `PUBLIC_BASE_URL` to the external URL so download links are correct
