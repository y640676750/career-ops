#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run as root: sudo bash init.sh"
  exit 1
fi

NODE_MAJOR="${NODE_MAJOR:-22}"

echo "[1/6] Updating Ubuntu packages..."
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates \
  curl \
  gnupg \
  git \
  unzip \
  build-essential \
  nginx \
  redis-server \
  fonts-noto-cjk \
  libnss3 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libdrm2 \
  libxkbcommon0 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  libgbm1 \
  libasound2 \
  libpangocairo-1.0-0 \
  libgtk-3-0

echo "[2/6] Installing Node.js ${NODE_MAJOR}.x..."
install -d -m 0755 /etc/apt/keyrings
curl -fsSL "https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key" | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs

echo "[3/6] Installing PM2..."
npm install -g pm2

echo "[4/6] Enabling Nginx and Redis..."
systemctl enable --now nginx
systemctl enable --now redis-server

echo "[5/6] Preparing app directory..."
mkdir -p /opt/career-ops

echo "[6/6] Versions and next steps:"
node -v
npm -v
pm2 -v
nginx -v
redis-server --version

cat <<'EOF'

Ubuntu init completed.

Next deployment steps:
1. Upload project files into /opt/career-ops.
2. Install backend dependencies:
   cd /opt/career-ops/backend && npm ci
3. Create /opt/career-ops/backend/.env with production variables.
4. Start services:
   cd /opt/career-ops && pm2 start ecosystem.config.js --update-env && pm2 save
5. Optional PM2 boot:
   pm2 startup systemd
   # Then run the command printed by PM2.

Temporary IP test:
   curl http://SERVER_IP:3000/ping

Nginx reverse proxy can be added after domain备案 is ready.
EOF
