#!/usr/bin/env bash
# Waypoint reveal: assemble frames + score into the deliverables.
#   promo/build.sh FRAMES_DIR [OUT_DIR]
# Needs: ffmpeg, python3 + numpy (score), node + playwright (frames, see render.js).
set -euo pipefail
FRAMES=${1:?frames dir}
OUT=${2:-"$(dirname "$0")/out"}
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT"
FPS=60

node "$HERE/events.js" > "$HERE/out/events.json"
python3 "$HERE/audio.py"

# loudness: YouTube normalises to about -14 LUFS, so master there with 1.5 dB true-peak headroom
ffmpeg -y -loglevel error -i "$HERE/out/score.wav" \
  -af "loudnorm=I=-14:TP=-1.5:LRA=9:print_format=summary" \
  -ar 48000 "$OUT/score-normalised.wav" 2> "$OUT/loudnorm.txt" || true

COLOR="scale=out_color_matrix=bt709:out_range=tv:flags=lanczos+accurate_rnd+full_chroma_int,format=yuv420p"
TAGS=(-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv)

# master: 1080p60, YouTube
ffmpeg -y -loglevel error -framerate $FPS -i "$FRAMES/%05d.png" -i "$OUT/score-normalised.wav" \
  -vf "$COLOR" -c:v libx264 -preset slow -profile:v high -level 4.2 -crf 14 -maxrate 24M -bufsize 48M \
  -g 120 -bf 2 -pix_fmt yuv420p "${TAGS[@]}" \
  -c:a aac -b:a 320k -ar 48000 -t 30 -movflags +faststart "$OUT/waypoint-reveal-1080p60.mp4"

# Instagram: 1080p30 horizontal, lighter
ffmpeg -y -loglevel error -i "$OUT/waypoint-reveal-1080p60.mp4" -r 30 \
  -c:v libx264 -preset slow -profile:v high -level 4.2 -crf 17 -maxrate 12M -bufsize 24M -g 60 -pix_fmt yuv420p "${TAGS[@]}" \
  -c:a copy -movflags +faststart "$OUT/waypoint-reveal-1080p30-instagram.mp4"

ls -lh "$OUT"/*.mp4
