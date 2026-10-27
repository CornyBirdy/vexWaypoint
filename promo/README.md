# Waypoint reveal video

~46 s. 16:9 master 1920x1080 @ 60 fps (YouTube) and 9:16 1080x1920 @ 30 fps (Instagram). Everything in it is the real app: `render.js` opens `index.html` in Chromium,
drives it with real mouse events and steps its clock one frame at a time, so the footage is the actual
simulator and every render is identical.

```
node promo/render.js all --out /tmp/frames   # 1800 PNG frames (3 shots in parallel, ~12 min)
node promo/render.js all --fmt v --out /tmp/frames-v   # 900 frames, 1080x1920 @ 30 fps (Instagram)
promo/build.sh /tmp/frames /tmp/frames-v     # score + loudness + H.264 -> promo/out/*.mp4
```

| File | What it is |
|---|---|
| `shots.js` | the shot list: timings, camera moves, cursor path, captions. Edit this to change the film |
| `stage.html`, `stage.js` | the composition (background, window, captions, scenes, wipes). Pure function of time |
| `inject.js` | swaps the embedded app's clock for a virtual one |
| `render.js` | frame renderer (`--stills 1.2,3.4` renders only those times for quick checks) |
| `audio.py`, `events.js` | synthesized score (numpy only), cut-synced to the shot list |
| `build.sh` | frames + score -> YouTube 16:9 master and the 9:16 Instagram cut |
| `fonts/` | Archivo Black (the logo face) and Cascadia Mono (the app's code face), both OFL |

Needs: Node + `playwright` (Chromium), ffmpeg, Python 3 + numpy. Install the two fonts first
(`~/.fonts` on Linux) so Chromium picks them up.
