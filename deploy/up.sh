#!/usr/bin/env bash
# Build the image from this checkout, start the gsm container, wait until it is healthy.
# Safe to run from any directory. Never prints secret values.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ENV_FILE=deploy/.env
COMPOSE=(docker compose -f deploy/compose.yaml --env-file "$ENV_FILE")
PORT_HOST=8765

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE. Run: cp deploy/.env.example deploy/.env  and fill it in." >&2
  exit 1
fi

# Check the four required variables are set and non-empty, without printing values.
missing=0
for var in API_SECRET ENCRYPTION_KEY ANTHROPIC_API_KEY GITHUB_TOKEN; do
  value="$(grep -E "^${var}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
  value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
  if [ -z "$value" ] || [[ "$value" == \<*\> ]]; then
    echo "$var is empty or still a placeholder in $ENV_FILE" >&2
    missing=1
  fi
done
[ "$missing" -eq 0 ] || exit 1

# Pick up a custom GSM_PORT for the final message only.
custom_port="$(grep -E '^GSM_PORT=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
[ -n "$custom_port" ] && PORT_HOST="$custom_port"

echo "Building image gsm-fullstack:local ..."
"${COMPOSE[@]}" build

echo "Starting gsm ..."
"${COMPOSE[@]}" up -d gsm

echo "Waiting for the container to become healthy (up to 120 s) ..."
deadline=$((SECONDS + 120))
status=""
while [ "$SECONDS" -lt "$deadline" ]; do
  status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' gsm 2>/dev/null || echo missing)"
  [ "$status" = "healthy" ] && break
  sleep 3
done

if [ "$status" != "healthy" ]; then
  echo "gsm did not become healthy (last status: $status). Last 30 log lines:" >&2
  docker logs --tail 30 gsm >&2 || true
  exit 1
fi

echo "gsm is healthy on 127.0.0.1:${PORT_HOST}."
echo
echo "Expose it to the tailnet (once; needs sudo or 'sudo tailscale set --operator=\$USER'):"
echo "  sudo tailscale serve --bg --https=8443 http://127.0.0.1:${PORT_HOST}"
echo "Then open: https://<this-machine>.<your-tailnet>.ts.net:8443/"
echo "Undo with: sudo tailscale serve --https=8443 off"
