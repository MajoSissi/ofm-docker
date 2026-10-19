#!/bin/sh
# Our Free Model — container entrypoint.
#
# Why this file exists, and the one thing it must not do:
#
# Upstream's standalone service deliberately refuses to bind anything but a
# loopback address (`service.mjs`: `the standalone service binds a loopback
# address only`). The check is `isLoopbackHost()`, which accepts exactly
# `127.0.0.1`, `localhost`, `::1`, `[::1]` — nothing else. So `--host 0.0.0.0`
# is rejected by design: upstream considers this a safety fence, because the
# free lanes are keyed to *this machine's* egress and priced against whoever
# shares it, so handing them to a whole subnet through a bind string is exactly
# what the fence exists to stop.
#
# Inside a container that is a real problem: `docker run -p HOST:CONTAINER`
# reaches the container's eth0 address, which is not loopback — and the local
# listener will never bind it. So port-publishing the plain service port is
# impossible without breaking the upstream fence, and silently weakening that
# fence is not something this image does.
#
# The one door upstream intentionally binds wider is the LAN relay: it listens
# on `0.0.0.0` (see `src/forward.js` → `startLanRelay`), carries the inference
# routes only (`/v1/models`, `/v1/chat/completions`, `/v1/responses`,
# `/v1/messages`, `/v1/messages/count_tokens`), and has its *own* separately
# generated, separately rotatable key — `settings.json` → `standaloneLanKey`
# — which is never the same as the local `forwardKey`. Both claims were
# verified with a live request: the local key is answered with
# `401 missing or invalid LAN key`.
#
# So this entrypoint turns the LAN relay on and prints its key. The management
# page stays loopback-only by design: reach it with `docker exec`, per README.
set -eu

: "${OFM_HOME:=/data}"
export OFM_HOME

# The service takes a lock in its data directory, so it must exist first.
mkdir -p "$OFM_HOME"

# --- ports -------------------------------------------------------------
# OFM_PORT    : the local listener (always 127.0.0.1, never publishable)
# OFM_LAN_PORT: the LAN relay — the only externally reachable door. 0 = let the
#               service pick a free port, which is the safe default.
OFM_PORT="${OFM_PORT:-18900}"
OFM_LAN_PORT="${OFM_LAN_PORT:-0}"

# --- helpers -----------------------------------------------------------
# Read one field out of the service's settings.json with node (the image has no
# jq). Kept as a function so nothing is duplicated and the failure mode is loud
# but non-fatal: a missing key must not take the service down.
#
# IMPORTANT: settings.json's `standaloneLanPort` is the *requested* port, not the
# live one. When it is 0 — the default, meaning "pick a free port" — the service
# binds an ephemeral port and leaves 0 on disk. So a relay port read from
# settings.json is wrong in the default configuration, which the CI verify job
# also learned the hard way. The live port is read from the service's own
# management summary instead.
ofm_setting() {
  node -e '
    const fs = require("node:fs")
    const file = (process.env.OFM_HOME || "/data") + "/settings.json"
    const field = process.argv[1]
    try {
      const doc = JSON.parse(fs.readFileSync(file, "utf8"))
      const value = doc ? doc[field] : null
      process.stdout.write(typeof value === "string" ? value : "")
    } catch {
      // The file may not exist yet on a cold start; the caller polls for it.
      process.stdout.write("")
    }
  ' "$1"
}

# The live relay port, straight from the service. Loopback-only route, so this
# exec is allowed to read it.
ofm_relay_port() {
  node -e '
    const http = require("node:http")
    const fs = require("node:fs")
    const home = process.env.OFM_HOME || "/data"
    const port = process.env.OFM_PORT || 18900
    let settings = {}
    try { settings = JSON.parse(fs.readFileSync(home + "/settings.json", "utf8")) } catch { process.exit(0) }
    const key = typeof settings.forwardKey === "string" ? settings.forwardKey : ""
    http.get(
      { host: "127.0.0.1", port, path: "/api/management/summary", headers: { Authorization: "Bearer " + key } },
      response => {
        let body = ""
        response.setEncoding("utf8")
        response.on("data", chunk => { body += chunk })
        response.on("end", () => {
          try {
            const relayPort = JSON.parse(body).lan.port
            process.stdout.write(relayPort ? String(relayPort) : "")
          } catch { process.stdout.write("") }
        })
      },
    ).on("error", () => process.exit(0))
  '
}

print_access() {
  # Poll: the service writes settings.json during startup, and the relay state
  # is only non-empty once it is actually bound.
  i=0
  while [ "$i" -lt 30 ]; do
    if [ -f "$OFM_HOME/settings.json" ]; then
      LAN_KEY=$(ofm_setting standaloneLanKey 2>/dev/null || true)
      if [ -n "${LAN_KEY:-}" ]; then
        # The live port, not the persisted request.
        LIVE_PORT=$(ofm_relay_port 2>/dev/null || true)
        LAN_PORT="${LIVE_PORT:-$OFM_LAN_PORT}"
        echo ""
        echo "  ┌─ Our Free Model · container access ─────────────────────"
        echo "  │ data dir      : $OFM_HOME"
        echo "  │ local listener: 127.0.0.1:$OFM_PORT  (loopback only, by design)"
        echo "  │ LAN relay     : 0.0.0.0:${LAN_PORT:-?}  (inference only)"
        echo "  │ LAN key       : $LAN_KEY"
        echo "  │"
        echo "  │ relay call:  curl -s http://127.0.0.1:${LAN_PORT:-?}/v1/models \\"
        echo "  │               -H \"Authorization: Bearer $LAN_KEY\""
        echo "  │"
        echo "  │ NOTE: the relay port is assigned at runtime. To publish it,"
        echo "  │ set OFM_LAN_PORT to a fixed value and map the same port."
        echo "  │"
        echo "  │ The local forwardKey is never shared and stays loopback-only."
        echo "  │ Management page: 'docker exec -it <container> sh' + the URL above."
        echo "  └─────────────────────────────────────────────────────────"
        return 0
      fi
    fi
    i=$((i + 1))
    sleep 1
  done
  echo "[ofm] note: LAN key not available yet; see $OFM_HOME/settings.json"
}

# --- banner ------------------------------------------------------------
echo "[ofm] Our Free Model standalone service"
echo "[ofm] data dir      : $OFM_HOME"
echo "[ofm] local listener: 127.0.0.1:$OFM_PORT  (loopback only — not publishable)"
echo "[ofm] LAN relay     : 0.0.0.0:$OFM_LAN_PORT  (inference only; this is what -p exposes)"

# Hand out the key as soon as it exists, without blocking the server.
( print_access ) &
PRINT_PID=$!
trap 'kill $PRINT_PID 2>/dev/null || true' EXIT INT TERM

# --- arguments ---------------------------------------------------------
set -- --port "$OFM_PORT" --lan --lan-port "$OFM_LAN_PORT"

if [ "${OFM_ENABLE_REFRESH:-1}" = "0" ]; then
  # Refresh performs upstream catalog/availability work at start. Channel
  # account tasks still run. This is the offline/CI posture.
  set -- "$@" --no-refresh
fi

# exec so signals reach node and the container stops on SIGTERM/SIGINT, and so
# the service can clean up service.lock on the way out.
exec node packages/standalone/cli.mjs "$@"
