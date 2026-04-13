#!/usr/bin/env sh
set -eu

ACTION="${1:-start}"
FLAG="${2:-}"

print_usage() {
  cat <<'EOF'
Usage:
  ./scripts/stack-control.sh start [--no-build]
  ./scripts/stack-control.sh stop [--volumes|--skip-backup]
  ./scripts/stack-control.sh restart [--no-build|--volumes|--skip-backup]
  ./scripts/stack-control.sh status
  ./scripts/stack-control.sh logs
  ./scripts/stack-control.sh backup
EOF
}

get_lan_ip() {
  if command -v hostname >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    if [ -n "${ip:-}" ]; then
      printf '%s\n' "$ip"
      return 0
    fi
  fi

  if command -v ip >/dev/null 2>&1; then
    ip="$(ip route get 1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
    if [ -n "${ip:-}" ]; then
      printf '%s\n' "$ip"
      return 0
    fi
  fi

  return 1
}

print_urls() {
  lan_ip="$(get_lan_ip || true)"
  printf '\nService URLs\n'
  printf '%s\n' '- Web UI (local): http://localhost:5173'
  printf '%s\n' '- API (local): http://localhost:3000'

  if [ -n "${lan_ip:-}" ]; then
    printf '%s\n' "- Web UI (LAN):   http://${lan_ip}:5173"
    printf '%s\n' "- API (LAN):      http://${lan_ip}:3000"
  else
    printf '%s\n' '- LAN IP not detected automatically.'
  fi

  printf '\n%s\n' 'If LAN access fails, allow inbound TCP 5173 and 3000 in your firewall.'
}

case "$ACTION" in
  start)
    if [ "$FLAG" = "--no-build" ]; then
      docker compose up -d
    else
      docker compose up --build -d
    fi
    print_urls
    ;;
  stop)
    if [ "$FLAG" != "--skip-backup" ]; then
      ./scripts/db-backup.sh
    fi

    if [ "$FLAG" = "--volumes" ]; then
      docker compose down -v
    else
      docker compose down
    fi
    ;;
  restart)
    if [ "$FLAG" != "--skip-backup" ]; then
      ./scripts/db-backup.sh
    fi

    if [ "$FLAG" = "--volumes" ]; then
      docker compose down -v
      docker compose up --build -d
    elif [ "$FLAG" = "--no-build" ]; then
      docker compose down
      docker compose up -d
    else
      docker compose down
      docker compose up --build -d
    fi
    print_urls
    ;;
  status)
    docker compose ps
    ;;
  logs)
    docker compose logs -f --tail 200
    ;;
  backup)
    ./scripts/db-backup.sh
    ;;
  *)
    print_usage
    exit 1
    ;;
esac
