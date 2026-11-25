#!/usr/bin/env bash
# Drag the screen left, right, down and up with the keyboard open, close it,
# and drag again; screenshots after each round and one video for all of it.
# Usage: drag.sh <name>   (needs $UDID, $RUNNER_TEMP, idb)
set -u
N=$1
OUT="$RUNNER_TEMP/shots"
read -r W H < <(idb describe --udid "$UDID" --json | python3 -c "import json,sys; d=json.load(sys.stdin)['screen_dimensions']; print(int(d['width_points']), int(d['height_points']))")
CX=$((W/2)); Y=$((H*35/100))
round() {
  idb ui swipe --udid "$UDID" --duration 0.8 $((W*80/100)) $Y $((W*20/100)) $Y
  idb ui swipe --udid "$UDID" --duration 0.8 $((W*20/100)) $Y $((W*80/100)) $Y
  idb ui swipe --udid "$UDID" --duration 0.8 $CX $((H*25/100)) $CX $((H*50/100))
  idb ui swipe --udid "$UDID" --duration 0.8 $CX $((H*50/100)) $CX $((H*25/100))
}
xcrun simctl io "$UDID" recordVideo --codec h264 --force "$OUT/$N.mp4" &
REC=$!
sleep 2
xcrun simctl io "$UDID" screenshot "$OUT/$N-0-keyboard-start.png"
round
sleep 1
xcrun simctl io "$UDID" screenshot "$OUT/$N-1-keyboard-after.png"
# The keyboard bar's Done (the check mark), trailing, just above the keys.
idb ui tap --udid "$UDID" $((W*90/100)) $((H*58/100)) || true
sleep 2
xcrun simctl io "$UDID" screenshot "$OUT/$N-2-closed-start.png"
round
sleep 1
xcrun simctl io "$UDID" screenshot "$OUT/$N-3-closed-after.png"
kill -INT $REC; wait $REC || true
