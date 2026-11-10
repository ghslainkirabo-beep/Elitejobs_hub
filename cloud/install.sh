#!/usr/bin/env bash
# Elitejobs Hub — always-on cloud server setup.
# For a fresh Ubuntu 22.04 / 24.04 server. Run as root:
#   curl -fsSL https://raw.githubusercontent.com/ghslainkirabo-beep/Elitejobs_hub/main/cloud/install.sh | bash -s -- <CLOUDFLARE_TUNNEL_TOKEN>
# Safe to run again (it updates instead of reinstalling, and never touches the Hub's data).
set -euo pipefail
TOKEN="${1:-}"
if [ -z "$TOKEN" ]; then echo "✖ Put the Cloudflare Tunnel token after the command (bash -s -- <token>)."; exit 1; fi
REPO=https://github.com/ghslainkirabo-beep/Elitejobs_hub.git
APP=/opt/elitejobs-hub
DATA=/var/lib/elitejobs-hub
ENVF=/etc/elitejobs-hub.env
export DEBIAN_FRONTEND=noninteractive
say() { printf '\n\033[1;35m▸ %s\033[0m\n' "$1"; }

say "Updating the server and installing basics"
apt-get update -y -q
apt-get install -y -q git curl ca-certificates ufw unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades || true   # security updates install by themselves

say "Installing Node.js 20"
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -q nodejs
fi

say "Installing Cloudflare Tunnel (the only way in — no open ports)"
mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" > /etc/apt/sources.list.d/cloudflared.list
apt-get update -y -q && apt-get install -y -q cloudflared

say "Getting the Hub engine"
id hub >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin hub
mkdir -p "$DATA" && chown hub:hub "$DATA" && chmod 700 "$DATA"
if [ -d "$APP/.git" ]; then
  git -C "$APP" fetch -q --depth 1 origin main && git -C "$APP" reset -q --hard origin/main
else
  git clone -q --depth 1 --filter=blob:none --sparse "$REPO" "$APP"
  git -C "$APP" sparse-checkout set server cloud
fi
(cd "$APP/server" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

say "Settings"
if [ ! -f "$ENVF" ]; then
  CODE=$(tr -dc 'A-HJ-NP-Z2-9' </dev/urandom | head -c 16)
  cat > "$ENVF" <<EOT
HUB_CLOUD=1
HUB_DATA_DIR=$DATA
PORT=8787
HUB_PUBLIC_URL=https://hub.elitejobsrwanda.com
HUB_RESTORE_CODE=$CODE
EOT
  chmod 600 "$ENVF"
fi
CODE=$(grep '^HUB_RESTORE_CODE=' "$ENVF" | cut -d= -f2)

cat > /etc/systemd/system/elitejobs-hub.service <<EOT
[Unit]
Description=Elitejobs Hub
After=network-online.target
Wants=network-online.target

[Service]
User=hub
Group=hub
EnvironmentFile=$ENVF
WorkingDirectory=$APP/server
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
EOT

# Engine updates: every 10 minutes, fetch the latest engine from GitHub; restart only if it changed.
cat > /usr/local/bin/elitejobs-hub-update <<EOT
#!/usr/bin/env bash
set -e
cd $APP
old=\$(git rev-parse HEAD:server 2>/dev/null || echo none)
git fetch -q --depth 1 origin main && git reset -q --hard origin/main
new=\$(git rev-parse HEAD:server)
if [ "\$old" != "\$new" ]; then (cd server && npm ci --omit=dev --no-audit --no-fund --loglevel=error) && systemctl restart elitejobs-hub; echo "Engine updated to \$new"; fi
EOT
chmod 755 /usr/local/bin/elitejobs-hub-update
cat > /etc/systemd/system/elitejobs-hub-update.service <<EOT
[Unit]
Description=Update the Elitejobs Hub engine
[Service]
Type=oneshot
ExecStart=/usr/local/bin/elitejobs-hub-update
EOT
cat > /etc/systemd/system/elitejobs-hub-update.timer <<EOT
[Unit]
Description=Check for Elitejobs Hub engine updates every 10 minutes
[Timer]
OnBootSec=5min
OnUnitActiveSec=10min
[Install]
WantedBy=timers.target
EOT

say "Starting the Hub"
systemctl daemon-reload
systemctl enable --now elitejobs-hub elitejobs-hub-update.timer >/dev/null
systemctl restart elitejobs-hub

say "Connecting to Cloudflare"
if systemctl list-unit-files | grep -q '^cloudflared.service'; then
  echo "Tunnel already installed."
else
  cloudflared service install "$TOKEN"
fi

say "Firewall: only SSH (for you); the Hub is reached only through Cloudflare"
ufw default deny incoming >/dev/null; ufw default allow outgoing >/dev/null; ufw allow OpenSSH >/dev/null; ufw --force enable >/dev/null

ok=no; for i in $(seq 40); do if curl -fs http://127.0.0.1:8787/api/ui-version >/dev/null; then ok=yes; break; fi; sleep 1; done
echo
if [ "$ok" = yes ]; then
  printf '\033[1;32m✔ The cloud Hub is running.\033[0m\n'
else
  printf '\033[1;31m✖ The Hub did not answer. Show this to IT:\033[0m\n'; journalctl -u elitejobs-hub -n 30 --no-pager
fi
if [ ! -f "$DATA/restore-done.json" ]; then
  echo
  echo "  ┌──────────────────────────────────────────────┐"
  echo "  │  MOVE CODE:  $CODE                │"
  echo "  └──────────────────────────────────────────────┘"
  echo "  On the office Hub PC: IT → System control → Move the Hub to the cloud,"
  echo "  type https://hub.elitejobsrwanda.com and this code."
fi
