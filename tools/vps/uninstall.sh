#!/usr/bin/env bash
# msync uninstall: removes everything deploy.sh added, then checks nothing is left.
#
#   sudo bash tools/vps/uninstall.sh --dry-run   # list exactly what would be removed; change nothing
#   sudo bash tools/vps/uninstall.sh             # asks you to type "msync" to confirm
#   sudo bash tools/vps/uninstall.sh --yes
#
# Removes only what deploy.sh recorded as msync's own:
#   containers, volumes (films, database, certificates) and network of compose project "msync";
#   image and build-cache IDs created by msync's builds/pulls (pre-existing ones never recorded);
#   ufw rules msync added (rules that were there before are never recorded, so never deleted);
#   the compose plugin, only if deploy.sh installed it and no other compose project uses it;
#   this folder.
# It runs no global prune, and never deletes other containers, images, volumes or rules.
set -uo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STATE="$DIR/.msync-state"
DRY=0
YES=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --yes) YES=1 ;;
  esac
done

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then echo "  would run: $*"; else "$@"; fi; }
state() { grep -E "^$1=" "$STATE" 2>/dev/null | cut -d= -f2-; }
label=com.docker.compose.project=msync

[ "$(id -u)" = 0 ] || { echo "Run with sudo." >&2; exit 1; }
grep -q '^name: msync$' "$DIR/docker-compose.yml" 2>/dev/null || { echo "Not an msync folder: $DIR" >&2; exit 1; }
cd "$DIR"

if [ "$DRY" = 1 ]; then
  echo "DRY RUN: nothing will be changed."
elif [ "$YES" != 1 ]; then
  echo "This deletes msync from this server: every film, the database, certificates, its images"
  echo "and $DIR itself. Other things on the server are not touched."
  echo "(Run with --dry-run first to see the exact list.)"
  read -rp "Type msync to continue: " a
  [ "$a" = "msync" ] || { echo "Cancelled."; exit 1; }
fi

say "Containers, volumes and network of project msync"
for c in $(docker ps -aq --filter "label=$label"); do
  echo "  container $(docker inspect -f '{{.Name}} ({{.Config.Image}})' "$c")"
done
for v in $(docker volume ls -q --filter "label=$label"); do echo "  volume $v"; done
for n in $(docker network ls -q --filter "label=$label"); do echo "  network $(docker network inspect -f '{{.Name}}' "$n")"; done
if docker compose version >/dev/null 2>&1; then
  run docker compose down --volumes --remove-orphans --timeout 20
fi
# anything still carrying the project label (if compose files were edited since)
for c in $(docker ps -aq --filter "label=$label"); do run docker rm -f "$c" >/dev/null; done
for v in $(docker volume ls -q --filter "label=$label"); do run docker volume rm -f "$v" >/dev/null; done
for n in $(docker network ls -q --filter "label=$label"); do run docker network rm "$n" >/dev/null; done

say "Images created by msync's builds and pulls"
# Only IDs recorded at deploy time. An image that existed before msync, or that another
# container uses now, is kept.
if [ -s .msync-owned-images ]; then
  while read -r img; do
    [ -z "$img" ] && continue
    docker image inspect "$img" >/dev/null 2>&1 || continue
    tags="$(docker image inspect -f '{{join .RepoTags ", "}}' "$img")"
    users="$(docker ps -aq --filter ancestor="$img" | grep -v -F -x -f <(docker ps -aq --filter "label=$label") || true)"
    if [ -n "$users" ]; then
      echo "  keep ${img:7:12} ${tags:-<untagged>} (used by another container)"
      continue
    fi
    echo "  image ${img:7:12} ${tags:-<untagged layer>}"
    run docker image rm -f "$img" >/dev/null 2>&1
  done < .msync-owned-images
else
  echo "  no ownership record; only msync's own images msync-api and msync-web"
  run docker image rm msync-api msync-web >/dev/null 2>&1
fi

say "Build cache created by msync's builds"
if [ -s .msync-owned-cache ] && docker buildx version >/dev/null 2>&1; then
  echo "  $(grep -c . .msync-owned-cache) cache records"
  while read -r id; do
    [ -n "$id" ] && run docker builder prune -f --filter "id=$id" >/dev/null 2>&1
  done < .msync-owned-cache
else
  echo "  none recorded (the legacy builder keeps its layers as images, handled above)"
fi

say "Firewall rules msync added"
if command -v ufw >/dev/null && grep -qE '^ufw=' "$STATE" 2>/dev/null; then
  grep -E '^ufw=' "$STATE" | cut -d= -f2- | while read -r r; do
    echo "  allow $r"
    run ufw delete allow "$r" >/dev/null 2>&1
  done
else
  echo "  none (ufw was off, or every port was already allowed before msync)"
fi

say "Packages msync installed"
pkg="$(state installed_pkg)"
if [ -z "$pkg" ]; then
  echo "  none"
else
  others="$(docker compose ls -aq 2>/dev/null | grep -vx msync || true)"
  if [ -n "$others" ]; then
    echo "  keep $pkg: other compose projects use it ($others)"
  else
    echo "  $pkg"
    run apt-get remove -y "$pkg" >/dev/null
  fi
fi

say "Files"
echo "  $DIR ($(du -sh "$DIR" 2>/dev/null | cut -f1))"
cd /
case "$DIR" in
  /|/root|/home|/home/*/|/srv|/usr*|/etc*|/var|/opt|/bin*|/sbin*|/lib*|/boot*) echo "  refusing to delete $DIR" ;;
  *) run rm -rf "$DIR" ;;
esac

[ "$DRY" = 1 ] && { echo; echo "Dry run finished. Nothing was changed."; exit 0; }

say "Check: nothing of msync left"
left=0
[ -n "$(docker ps -aq --filter "label=$label")" ] && { echo "  containers remain"; left=1; }
[ -n "$(docker volume ls -q --filter "label=$label")" ] && { echo "  volumes remain"; left=1; }
[ -n "$(docker network ls -q --filter "label=$label")" ] && { echo "  networks remain"; left=1; }
docker images --format '{{.Repository}}' | grep -qE '^msync-' && { echo "  msync images remain"; left=1; }
command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '# msync' && { echo "  ufw rules tagged msync remain"; left=1; }
[ -e "$DIR" ] && { echo "  $DIR remains"; left=1; }
[ "$left" = 0 ] && echo "  clean: no msync containers, volumes, networks, images, firewall rules or files."
echo
echo "Not removable from here: the Let's Encrypt certificate was published in the public"
echo "Certificate Transparency logs when it was issued (true of every HTTPS site); it simply expires."
