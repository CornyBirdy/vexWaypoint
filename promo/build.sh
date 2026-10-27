#!/usr/bin/env bash
# Waypoint reveal: assemble frames + score into the deliverables.
#   promo/build.sh FRAMES_16x9 FRAMES_9x16 [OUT_DIR]
# Frames come from:  node promo/render.js all --out DIR            (1920x1080, 60 fps)
#                    node promo/render.js all --fmt v --out DIR    (1080x1920, 30 fps)
# Needs: ffmpeg, python3 + numpy (score).
set -euo pipefail
FH=${1:?16:9 frames dir}
FV=${2:?9:16 frames dir}
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT=${3:-"$HERE/out"}
mkdir -p "$OUT"

node "$HERE/events.js" > "$HERE/out/events.json"
python3 "$HERE/audio.py"

# lo-fi sits quietly: -15 LUFS integrated, 1.5 dB true-peak headroom
ffmpeg -y -loglevel error -i "$HERE/out/score.wav" \
  -af "loudnorm=I=-15:TP=-1.5:LRA=9:print_format=summary" -ar 48000 "$OUT/score-normalised.wav" 2> "$OUT/loudnorm.txt" || true

COLOR="scale=out_color_matrix=bt709:out_range=tv:flags=lanczos+accurate_rnd+full_chroma_int,format=yuv420p"
TAGS=(-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv)

# YouTube: 1080p60 horizontal
ffmpeg -y -loglevel error -framerate 60 -i "$FH/%05d.png" -i "$OUT/score-normalised.wav" \
  -vf "$COLOR" -c:v libx264 -preset slow -profile:v high -level 4.2 -crf 14 -maxrate 24M -bufsize 48M \
  -g 120 -bf 2 -pix_fmt yuv420p "${TAGS[@]}" \
  -c:a aac -b:a 320k -ar 48000 -t 46.25 -movflags +faststart "$OUT/waypoint-reveal-1080p60.mp4"

# Instagram: 1080x1920 vertical (Reels / feed 9:16), 30 fps
ffmpeg -y -loglevel error -framerate 30 -i "$FV/%05d.png" -i "$OUT/score-normalised.wav" \
  -vf "$COLOR" -c:v libx264 -preset slow -profile:v high -level 4.2 -crf 15 -maxrate 16M -bufsize 32M \
  -g 60 -bf 2 -pix_fmt yuv420p "${TAGS[@]}" \
  -c:a aac -b:a 256k -ar 48000 -t 46.25 -movflags +faststart "$OUT/waypoint-reveal-1080x1920-instagram.mp4"

ls -lh "$OUT"/*.mp4
