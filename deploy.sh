#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python}"

export DEPLOY_HOST="${DEPLOY_HOST:-192.210.254.235}"
export DEPLOY_USER="${DEPLOY_USER:-root}"
export DEPLOY_PATH="${DEPLOY_PATH:-/opt/career-ops}"
export DEPLOY_PM2_BIN="${DEPLOY_PM2_BIN:-/opt/node-v22.22.1-linux-x64/bin/pm2}"
export DEPLOY_APP_NAME="${DEPLOY_APP_NAME:-career-ops}"

"${PYTHON_BIN}" - "${SCRIPT_DIR}" <<'PY'
import os
import posixpath
import shlex
import subprocess
import sys
import tarfile
import time
from pathlib import Path

try:
    import paramiko
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "paramiko"])
    import paramiko

root = Path(sys.argv[1]).resolve()
password = os.environ.get("DEPLOY_PASSWORD", "").strip()
if not password:
    raise SystemExit("DEPLOY_PASSWORD is required.")

host = os.environ["DEPLOY_HOST"].strip()
user = os.environ["DEPLOY_USER"].strip()
remote_path = os.environ["DEPLOY_PATH"].strip()
pm2_bin = os.environ["DEPLOY_PM2_BIN"].strip()
app_name = os.environ["DEPLOY_APP_NAME"].strip()

timestamp = int(time.time())
archive_dir = root / ".deploy"
archive_dir.mkdir(exist_ok=True)
archive_path = archive_dir / f"{app_name}-{timestamp}.tar.gz"

excluded_prefixes = (
    ".git",
    ".deploy",
    "backend/node_modules",
    "backend/storage",
)
excluded_names = {
    "__pycache__",
    ".DS_Store",
}

def should_exclude(relative_path: Path) -> bool:
    rel = relative_path.as_posix()
    if not rel:
        return False

    parts = relative_path.parts
    if any(part in excluded_names for part in parts):
        return True

    return any(rel == prefix or rel.startswith(prefix + "/") for prefix in excluded_prefixes)

with tarfile.open(archive_path, "w:gz") as tar:
    for path in root.rglob("*"):
        rel = path.relative_to(root)
        if should_exclude(rel):
            continue
        tar.add(path, arcname=rel.as_posix())

remote_archive = posixpath.join("/tmp", archive_path.name)
release_dir = f"{remote_path}.incoming-{timestamp}"
backup_dir = f"{remote_path}.prev"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

print(f"[deploy] Connecting to {user}@{host} ...")
client.connect(
    hostname=host,
    username=user,
    password=password,
    timeout=30,
    look_for_keys=False,
    allow_agent=False,
)

try:
    sftp = client.open_sftp()
    try:
        print(f"[deploy] Uploading {archive_path.name} ...")
        sftp.put(str(archive_path), remote_archive)
    finally:
        sftp.close()

    remote_script = f"""
set -e
APP_DIR={shlex.quote(remote_path)}
RELEASE_DIR={shlex.quote(release_dir)}
BACKUP_DIR={shlex.quote(backup_dir)}
ARCHIVE_PATH={shlex.quote(remote_archive)}
PM2_BIN={shlex.quote(pm2_bin)}

rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"
tar -xzf "$ARCHIVE_PATH" -C "$RELEASE_DIR"

if [ -f "$APP_DIR/backend/.env" ]; then
  cp "$APP_DIR/backend/.env" "$RELEASE_DIR/backend/.env"
fi

if [ -d "$APP_DIR/backend/storage" ]; then
  mkdir -p "$RELEASE_DIR/backend/storage"
  cp -a "$APP_DIR/backend/storage/." "$RELEASE_DIR/backend/storage/"
fi

cd "$RELEASE_DIR/backend"
npm install --omit=dev

if ! fc-list :lang=zh | grep -q .; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y fonts-noto-cjk fonts-wqy-zenhei
  fc-cache -f
fi

rm -rf "$BACKUP_DIR"
if [ -d "$APP_DIR" ]; then
  mv "$APP_DIR" "$BACKUP_DIR"
fi
mv "$RELEASE_DIR" "$APP_DIR"

cd "$APP_DIR"
"$PM2_BIN" startOrReload ecosystem.config.js --update-env
"$PM2_BIN" delete career-ops-pdf-worker >/dev/null 2>&1 || true
"$PM2_BIN" save
rm -f "$ARCHIVE_PATH"
"""

    print("[deploy] Running remote install + PM2 reload ...")
    stdin, stdout, stderr = client.exec_command(f"bash -lc {shlex.quote(remote_script)}", get_pty=True)
    exit_status = stdout.channel.recv_exit_status()
    stdout_text = stdout.read().decode("utf-8", errors="replace")
    stderr_text = stderr.read().decode("utf-8", errors="replace")

    if stdout_text.strip():
      print(stdout_text, end="" if stdout_text.endswith("\n") else "\n")
    if stderr_text.strip():
      print(stderr_text, file=sys.stderr, end="" if stderr_text.endswith("\n") else "\n")

    if exit_status != 0:
        raise SystemExit(exit_status)

    print("[deploy] Deployment completed successfully.")
finally:
    client.close()
    try:
        archive_path.unlink()
    except FileNotFoundError:
        pass
PY
