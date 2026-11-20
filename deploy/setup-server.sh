#!/bin/sh
# One-time setup of a fresh Ubuntu 24.04 box (run as root): Node 24, cloudflared, firewall, user, backups.
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -q && apt-get install -yq ca-certificates curl gnupg ufw sqlite3 unattended-upgrades
if ! command -v node >/dev/null; then curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -yq nodejs; fi
if ! command -v cloudflared >/dev/null; then
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -q && apt-get install -yq cloudflared
fi
id skillnet >/dev/null 2>&1 || useradd --system --home /var/lib/skillnet --shell /usr/sbin/nologin skillnet
install -d -o skillnet -g skillnet -m 700 /var/lib/skillnet /var/lib/skillnet/backups
install -d /opt/skillnet
# Only ssh is open; the web traffic comes in through the Cloudflare Tunnel (outbound).
ufw default deny incoming && ufw allow OpenSSH && ufw --force enable
# Nightly consistent copy of the database, keep 14.
cat > /etc/cron.d/skillnet-backup <<'C'
17 3 * * * skillnet sqlite3 /var/lib/skillnet/skillnet.db ".backup /var/lib/skillnet/backups/skillnet-$(date +\%F).db" && find /var/lib/skillnet/backups -name '*.db' -mtime +14 -delete
C
