#!/usr/bin/env bash
# Deploy X/Twitter downloader to your own server.
# Copies server.js + public/ -> /opt/xdl, sets up a venv with yt-dlp,
# installs a systemd unit (xdl.service) and starts it.
#
# Usage:
#   VPS_HOST=user@your-server ./deploy.sh
# or set it once in ./.deploy.local (gitignored) and just run ./deploy.sh
#
# Requires: ssh key auth to the server, passwordless sudo (for systemd/unit + /opt).
set -euo pipefail

# load local overrides (not committed)
if [ -f .deploy.local ]; then . ./.deploy.local; fi

: "${VPS_HOST:?Set VPS_HOST=user@server (env or ./.deploy.local)}"
REMOTE_USER="${VPS_HOST%@*}"
REMOTE="/opt/xdl"
UNIT="xdl.service"
PORT="${APP_PORT:-18820}"

echo "==> [1/4] mkdir remote + copy files (server.js, public/)"
ssh -o ConnectTimeout=10 -o BatchMode=yes "$VPS_HOST" "sudo mkdir -p $REMOTE && sudo chown $REMOTE_USER:$REMOTE_USER $REMOTE"
tar czf - server.js public | ssh -o ConnectTimeout=10 -o BatchMode=yes "$VPS_HOST" "tar xzf - -C $REMOTE"

echo "==> [2/4] ensure yt-dlp venv (idempotent)"
ssh -o ConnectTimeout=10 -o BatchMode=yes "$VPS_HOST" "
if [ ! -x $REMOTE/venv/bin/yt-dlp ]; then
  python3 -m venv $REMOTE/venv
  $REMOTE/venv/bin/pip install -q -U yt-dlp
  echo '  created venv + installed yt-dlp: ' \$($REMOTE/venv/bin/yt-dlp --version)
else
  $REMOTE/venv/bin/pip install -q -U yt-dlp >/dev/null 2>&1 || true
  echo '  yt-dlp already present: ' \$($REMOTE/venv/bin/yt-dlp --version)
fi
"

echo "==> [3/4] write systemd unit"
ssh -o ConnectTimeout=10 -o BatchMode=yes "$VPS_HOST" "sudo tee /etc/systemd/system/$UNIT > /dev/null" <<EOF
[Unit]
Description=X/Twitter video downloader (xdl)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$REMOTE_USER
WorkingDirectory=$REMOTE
Environment=PORT=$PORT
Environment=TMP_DIR=/tmp/xdl
Environment=PATH=$REMOTE/venv/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

echo "==> [4/4] enable + restart"
ssh -o ConnectTimeout=10 -o BatchMode=yes "$VPS_HOST" "sudo systemctl daemon-reload && sudo systemctl enable --now $UNIT && sudo systemctl restart $UNIT && sleep 1 && systemctl is-active $UNIT && sudo journalctl -u $UNIT -n 2 --no-pager | tail -2"

echo
echo "==> Done. The app listens on 127.0.0.1:$PORT."
echo "    Point a reverse proxy at it (see README for a Caddy example)."