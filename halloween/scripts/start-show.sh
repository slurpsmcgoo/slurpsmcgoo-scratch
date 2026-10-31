#!/usr/bin/env bash
# One-command show start: build the app, start the show server, keep the Mac
# awake, and open Chrome full-screen in kiosk mode.
#
#   scripts/start-show.sh
#   SHOW_X=1920 scripts/start-show.sh   # put the window on a display that starts at x=1920
#
# The first run asks for camera and microphone permission once; Chrome keeps it
# in the dedicated profile at ~/.halloween-show-chrome. Quit with Cmd+Q, then
# Ctrl+C here.
set -euo pipefail
cd "$(dirname "$0")/.."

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT="$(node -e "console.log(JSON.parse(require('fs').readFileSync('config/show.json','utf8')).server.port)")"

if [ ! -f public/models/pose_landmarker_lite.task ]; then
  echo "The pose model is missing. Run 'npm run fetch-models' once while online." >&2
  exit 1
fi
if [ ! -x "$CHROME" ]; then
  echo "Google Chrome was not found at $CHROME" >&2
  exit 1
fi

npm run build

node server/index.ts &
SERVER=$!
trap 'kill "$SERVER" 2>/dev/null || true' EXIT

for _ in $(seq 1 50); do
  curl -sf "http://localhost:$PORT/api/config" >/dev/null && break
  sleep 0.2
done

# No system sleep, display sleep or idle sleep while the server runs.
# The throttling flags below keep Chrome from slowing the show to one timer
# tick a minute if it ever decides the window is hidden or covered.
caffeinate -dimsu -w "$SERVER" &

"$CHROME" \
  --kiosk \
  --app="http://localhost:$PORT/" \
  --user-data-dir="$HOME/.halloween-show-chrome" \
  --autoplay-policy=no-user-gesture-required \
  --no-first-run \
  --no-default-browser-check \
  --disable-session-crashed-bubble \
  --disable-features=Translate \
  --disable-background-timer-throttling \
  --disable-renderer-backgrounding \
  --disable-backgrounding-occluded-windows \
  --window-position="${SHOW_X:-0},${SHOW_Y:-0}" \
  >/dev/null 2>&1 &

echo "Show running. Phone remote: see the 'Phone remote' address above."
wait "$SERVER"
