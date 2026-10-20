#!/usr/bin/env bash
# msync preflight: READ-ONLY. Changes nothing on the server.
# Shows what is already using the ports msync needs, and whether the box can host it.
#
#   sudo bash tools/vps/preflight.sh            # default ports
#   HTTPS_PORT=8443 sudo -E bash tools/vps/preflight.sh
#
# Exit code: 0 ready, 2 a port msync needs is taken (the report says what to do).
set -uo pipefail

HTTP_PORT="${HTTP_PORT:-80}"
HTTPS_PORT="${HTTPS_PORT:-443}"
TURN_PORT="${TURN_PORT:-3478}"
TURN_MIN_PORT="${TURN_MIN_PORT:-49160}"
TURN_MAX_PORT="${TURN_MAX_PORT:-49200}"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32mok\033[0m    %s\n' "$*"; }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$*"; }
bad() { printf '  \033[31mtaken\033[0m %s\n' "$*"; }

if [ "$(id -u)" != 0 ]; then
  echo "Run with sudo so the report can name the process holding each port." >&2
fi

bold "Machine"
. /etc/os-release 2>/dev/null && echo "  $PRETTY_NAME"
echo "  CPU: $(nproc) cores · RAM: $(free -h | awk '/Mem:/{print $2" total, "$7" available"}')"
echo "  Disk free under /srv: $(df -h --output=avail /srv 2>/dev/null | tail -1 | tr -d ' ' || df -h --output=avail / | tail -1)"
PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null || echo unknown)"
echo "  Public IPv4: $PUBLIC_IP"

bold "Docker"
if command -v docker >/dev/null; then
  ok "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '(daemon not reachable)')"
  if docker compose version >/dev/null 2>&1; then ok "compose plugin $(docker compose version --short)"; else warn "no 'docker compose' plugin: deploy.sh installs it (and uninstall.sh removes it again)"; fi
  n_ctr=$(docker ps -aq | wc -l); n_img=$(docker images -q | wc -l)
  echo "  Existing on this Docker: $n_ctr containers, $n_img images (msync never touches these)"
  if docker ps -a --filter label=com.docker.compose.project=msync -q | grep -q .; then warn "msync containers already exist (a previous deploy)"; fi
else
  bad "docker is not installed"
fi

bold "Ports msync needs"
TAKEN=0
tcp_listeners="$(ss -H -tlnp 2>/dev/null)"
udp_listeners="$(ss -H -ulnp 2>/dev/null)"
docker_ports="$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null)"

holder() { # proto port -> "process" or ""
  local proto="$1" port="$2" lines
  if [ "$proto" = tcp ]; then lines="$tcp_listeners"; else lines="$udp_listeners"; fi
  echo "$lines" | awk -v p=":$port" '$4 ~ p"$" {print ($NF ~ /users:/ ? $NF : "(process name needs sudo)")}' | head -1 | sed 's/users:((//; s/))//'
}

check() { # proto port purpose
  local proto="$1" port="$2" what="$3" h d
  h="$(holder "$proto" "$port")"
  d="$(echo "$docker_ports" | grep -E "[:.]$port->[0-9]+/$proto" | awk '{print $1}' | head -1)"
  if [ -n "$h$d" ]; then
    bad "$port/$proto  $what  — used by ${d:+container $d }${h}"
    TAKEN=1
  else
    ok "$port/$proto  $what"
  fi
}

check tcp "$HTTP_PORT" "HTTP (certificate challenge, redirect)"
check tcp "$HTTPS_PORT" "HTTPS (the app)"
check udp "$HTTPS_PORT" "HTTP/3"
check tcp "$TURN_PORT" "TURN (call relay)"
check udp "$TURN_PORT" "TURN (call relay)"
range_hits="$(echo "$udp_listeners" | awk -v a="$TURN_MIN_PORT" -v b="$TURN_MAX_PORT" '{n=split($4,x,":"); p=x[n]+0; if (p>=a && p<=b) print p}' | sort -u | tr '\n' ' ')"
if [ -n "$range_hits" ]; then bad "$TURN_MIN_PORT-$TURN_MAX_PORT/udp TURN relay range — in use: $range_hits"; TAKEN=1; else ok "$TURN_MIN_PORT-$TURN_MAX_PORT/udp TURN relay range"; fi

bold "Everything currently listening (for reference)"
echo "$tcp_listeners" | awk '{print "  tcp " $4 "  " ($NF ~ /users:/ ? $NF : "")}' | sed 's/users:((//; s/))//' | sort -u
echo "$udp_listeners" | awk '{print "  udp " $4 "  " ($NF ~ /users:/ ? $NF : "")}' | sed 's/users:((//; s/))//' | sort -u

bold "Firewall"
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  echo "  ufw is active; deploy.sh adds rules tagged 'msync' and uninstall.sh deletes exactly those."
else
  echo "  ufw is not active; deploy.sh leaves it alone."
fi
echo "  Also check the GoDaddy panel firewall (if your plan has one) for the ports above."

bold "Outbound"
if curl -fsS --max-time 8 -o /dev/null https://acme-v02.api.letsencrypt.org/directory; then ok "Let's Encrypt reachable"; else bad "cannot reach Let's Encrypt (certificates will fail)"; TAKEN=1; fi
if [ "$PUBLIC_IP" != unknown ]; then
  name="${PUBLIC_IP//./-}.sslip.io"
  if getent hosts "$name" | grep -q "$PUBLIC_IP"; then ok "$name resolves to this server"; else warn "$name does not resolve yet (sslip.io down?) — use the bare-IP mode: deploy.sh --ip"; fi
fi

bold "Verdict"
if [ "$TAKEN" = 0 ]; then
  echo "  Ready. Next: sudo bash tools/vps/deploy.sh"
  exit 0
fi
cat <<EOF
  A port msync needs is taken. Options:
  - Only $HTTPS_PORT is taken: deploy on another HTTPS port, e.g.
      sudo HTTPS_PORT=8443 bash tools/vps/deploy.sh      -> https://<name>:8443
    (port $HTTP_PORT must then be free so Let's Encrypt can check the name)
  - Only $HTTP_PORT is taken: deploy with HTTP_PORT=8080 (certificates then come over $HTTPS_PORT).
  - Both $HTTP_PORT and $HTTPS_PORT are taken by another web server: a certificate cannot be
    issued for msync without one of them; stop that server, or put msync behind it.
  - TURN ports taken: TURN_PORT=3479 TURN_MIN_PORT=50160 TURN_MAX_PORT=50200 sudo -E bash tools/vps/deploy.sh
EOF
exit 2
