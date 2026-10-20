#!/usr/bin/env bash
# msync deploy. Run from the project folder on the VPS (e.g. /srv/msync):
#
#   sudo bash tools/vps/deploy.sh            # https://<ip-with-dashes>.sslip.io
#   sudo bash tools/vps/deploy.sh --ip       # https://<ip> (6-day IP certificates, auto-renewed)
#   sudo HTTPS_PORT=8443 bash tools/vps/deploy.sh   # when 443 is already taken
#
# Everything it adds is recorded in .msync-state so tools/vps/uninstall.sh can remove it all:
# containers, volumes, network, the images it built or pulled, its build cache, its firewall
# rules, the compose plugin if it had to install it, and this folder.
# Safe to run again (it updates in place and keeps your .env and data).
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$DIR"
STATE="$DIR/.msync-state"
MODE=sslip
[ "${1:-}" = "--ip" ] && MODE=ip

export HTTP_PORT="${HTTP_PORT:-80}" HTTPS_PORT="${HTTPS_PORT:-443}"
export TURN_PORT="${TURN_PORT:-3478}" TURN_MIN_PORT="${TURN_MIN_PORT:-49160}" TURN_MAX_PORT="${TURN_MAX_PORT:-49200}"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
record() { grep -qxF "$1" "$STATE" 2>/dev/null || echo "$1" >> "$STATE"; }

[ "$(id -u)" = 0 ] || die "Run with sudo."
[ -f docker-compose.yml ] || die "Run this from the msync folder (docker-compose.yml not found in $DIR)."
command -v docker >/dev/null || die "Docker is not installed."

# --- 1. preflight (skip the port check on a re-deploy: our own containers hold the ports) -------
FIRST_RUN=1
[ -f "$STATE" ] && FIRST_RUN=0
if [ "$FIRST_RUN" = 1 ]; then
  say "Preflight"
  bash tools/vps/preflight.sh || die "Fix the items marked 'taken' above, then run deploy again."
  touch "$STATE"
  record "dir=$DIR"
fi

# Ownership ledger: uninstall removes only images and build-cache records that appeared while
# THIS script was building/pulling, and never anything that existed before.
snap_images() { docker image ls -a -q --no-trunc | sort -u; }
snap_cache() { docker buildx du --verbose 2>/dev/null | awk '/^ID:/{print $2}' | sort -u; }

# --- 2. compose plugin --------------------------------------------------------------------------
if ! docker compose version >/dev/null 2>&1; then
  say "Installing the docker compose plugin"
  apt-get update -y
  if apt-get install -y docker-compose-plugin; then record "installed_pkg=docker-compose-plugin"
  elif apt-get install -y docker-compose-v2; then record "installed_pkg=docker-compose-v2"
  else die "Could not install docker compose."; fi
fi

# --- 3. .env ------------------------------------------------------------------------------------
PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org || curl -fsS --max-time 5 https://ifconfig.me)"
[ -n "$PUBLIC_IP" ] || die "Could not find this server's public IP."
if [ "$MODE" = ip ]; then SITE="$PUBLIC_IP"; else SITE="${PUBLIC_IP//./-}.sslip.io"; fi

if [ ! -f .env ]; then
  say "Writing .env"
  {
    echo "SITE_ADDRESS=$SITE"
    echo "PUBLIC_IP=$PUBLIC_IP"
    [ "$MODE" = ip ] && echo "CADDYFILE=Caddyfile.ip"
    echo "ACME_EMAIL="
    echo "SESSION_SECRET=$(openssl rand -hex 32)"
    echo "TURN_SECRET=$(openssl rand -hex 32)"
    echo "HTTP_PORT=$HTTP_PORT"
    echo "HTTPS_PORT=$HTTPS_PORT"
    echo "TURN_PORT=$TURN_PORT"
    echo "TURN_MIN_PORT=$TURN_MIN_PORT"
    echo "TURN_MAX_PORT=$TURN_MAX_PORT"
  } > .env
  chmod 600 .env
else
  set -a; . ./.env; set +a
  SITE="$SITE_ADDRESS"
fi

# --- 4. firewall (only if ufw is already on; never switch it on behind your back) -------------
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  say "Opening msync's ports in ufw (rules tagged 'msync')"
  for r in "$HTTP_PORT/tcp" "$HTTPS_PORT/tcp" "$HTTPS_PORT/udp" "$TURN_PORT/tcp" "$TURN_PORT/udp" "$TURN_MIN_PORT:$TURN_MAX_PORT/udp"; do
    if grep -qxF "ufw=$r" "$STATE"; then continue; fi
    # a rule that already exists belongs to someone else: leave it, and never claim it
    if ufw show added 2>/dev/null | grep -qE "^ufw allow $r( |$)"; then
      echo "  $r already allowed before msync: left as is"
      continue
    fi
    ufw allow "$r" comment msync >/dev/null
    record "ufw=$r"
  done
fi

# --- 5. build and start -------------------------------------------------------------------------
say "Building (first time: a few minutes)"
IMG_BEFORE="$(snap_images)"; CACHE_BEFORE="$(snap_cache)"
docker compose build
docker compose pull --quiet tusd coturn

if ! grep -q '^ADMIN_PASSWORD_HASH=' .env; then
  say "Choose the host password (at least 10 characters)"
  while :; do
    read -rsp "  Host password: " pw1; echo
    read -rsp "  Again: " pw2; echo
    [ "$pw1" = "$pw2" ] && [ ${#pw1} -ge 10 ] && break
    echo "  They differ or are shorter than 10 characters. Try again."
  done
  HASH="$(printf '%s' "$pw1" | docker compose run --rm -T --no-deps api python -c \
    'import sys; from argon2 import PasswordHasher; print(PasswordHasher().hash(sys.stdin.read()))')"
  unset pw1 pw2
  echo "ADMIN_PASSWORD_HASH='$HASH'" >> .env
fi

say "Starting"
docker compose up -d --remove-orphans
comm -13 <(echo "$IMG_BEFORE") <(snap_images) >> "$DIR/.msync-owned-images"
comm -13 <(echo "$CACHE_BEFORE") <(snap_cache) >> "$DIR/.msync-owned-cache"
sort -u -o "$DIR/.msync-owned-images" "$DIR/.msync-owned-images"
sort -u -o "$DIR/.msync-owned-cache" "$DIR/.msync-owned-cache"

# --- 6. wait for HTTPS --------------------------------------------------------------------------
PORT_SUFFIX=""; [ "$HTTPS_PORT" != 443 ] && PORT_SUFFIX=":$HTTPS_PORT"
URL="https://$SITE$PORT_SUFFIX"
say "Waiting for the certificate for $SITE"
for i in $(seq 1 60); do
  if curl -fsS --max-time 5 "$URL/api/health" >/dev/null 2>&1; then
    printf '\n\033[32mmsync is live: %s\033[0m\n' "$URL"
    echo "Sign in with the host password. Remove everything later with: sudo bash tools/vps/uninstall.sh"
    exit 0
  fi
  sleep 3
done
echo "No valid HTTPS yet. Recent web logs:"
docker compose logs --tail 40 web
die "Check that port $HTTP_PORT or 443 is reachable from the internet (ufw and the GoDaddy panel firewall)."
