# Video tracking plan

**Status: plan only, not built yet.** The pose log + Tune section works without it.

## Why we want it

The pose log says where the robot *thinks* it is (odometry). If a tracking wheel slips
or the IMU drifts, the log is confidently wrong. Then no amount of PID tuning fixes the
auton. A camera filming from a fixed spot gives an independent answer to one question:
**where did the robot really go?**

So the camera is a check on odometry, not the main data source. The log is precise
(10ms, sub-inch). The camera is coarser (about 1 in) but can't drift.

## The setup

### Camera

- Any phone. Landscape, 1080p. Use 60 fps if the phone offers it; 30 is fine.
- As **high** as possible, looking down at the field. A tripod on a table, or taped to
  a shelf. Higher means less distortion and less parallax. It does not need to be
  straight overhead.
- The whole field (or at least the half the auton uses) in frame.
- **Lock exposure and focus.** On iPhone, tap and hold until "AE/AF LOCK" shows. On
  Android, use Pro mode. Auto exposure changing mid-run messes up colour tracking.
- **Same spot every session.** Mark the tripod feet with tape. Then the field
  calibration (below) only has to be done once and can be reused.
- Measure the camera lens height above the tiles once (tape measure, ±2 in is fine).

### Marker on the robot

Two flat coloured circles on top of the robot, on its centre line: one near the front,
one near the back, about 8 in apart.

- Colours that don't appear on the field: **hot pink** front, **lime green** back.
  Not red or blue (alliance colours) and not yellow (game elements).
- Matte card or sticker, 2.5–3 in across. Avoid glossy, because reflections wash out
  the colour.
- Measure their height above the tiles.

Two dots give position (the midpoint) and heading (back → front) using only plain
colour thresholding, with no libraries. An AprilTag would be more robust, but needs
a detector library (apriltag compiled to WebAssembly). That's a possible upgrade if
colour dots prove unreliable under the lights at an event.

## How it works in Waypoint

A **Video** button in the Tune section opens a panel. All of this runs in the browser,
nothing to install.

1. **Load the video.** Waypoint plays it in a hidden `<video>` and reads frames onto
   a canvas.
2. **Calibrate the field (once per camera spot).** Click the 4 field corners on a
   frame. From those four points, Waypoint computes a *homography*: a 3×3 matrix that
   maps pixel → field inches on the floor plane. (Direct linear transform; more points,
   such as tile seam crossings every 24 in, give a least-squares fit and an error
   check.) Saved per camera, so next time it's one click to reuse.
3. **Correct for marker height.** The homography is for the floor, but the dots sit
   about 12 in up. Seen from an angle, they look further from the camera than they
   are. Fix: with the camera's floor position C (from the homography and the measured
   height H) and the dots at height h, the real point is
   `C + (p_floor − C) · (H − h) / H`.
   - Cross-check: the first frame is the robot at the known start pose (Waypoint's
     Start pose). If that's off by more than an inch, the calibration or heights are wrong.
4. **Track.** Click each dot once in the first frame. Its colour (hue, saturation,
   value) is sampled there. For every frame after that:
   - search a small window around where the dot was last frame
   - threshold on that colour and take the centroid
   - map it through the homography with the height correction
   - pose = midpoint of the two dots, heading = direction from back dot to front dot

   If a dot is lost (covered by a lift arm, glare), that frame is skipped and
   interpolated. Several lost frames in a row show as a gap in the line.
5. **Sync with the log.** Both clocks start differently. Waypoint finds the frame
   where the robot first moves and lines it up with the first log sample where the
   speed goes over 2 in/s. A slider nudges it ±200ms by hand.
6. **Compare.** The camera track becomes a third line on the field (sim, odometry,
   camera). The tune report gets an **Odometry vs camera** section: error over time,
   and where it jumps. A sudden jump usually means a goal reset or a wheel lifting off;
   a slow growth means drift.

## What accuracy to expect

From a high corner at 1080p, the field is roughly 1500 px across 144 in, so about
10 px/in near the camera and maybe 4 px/in at the far side. Dot centroids are good to
a pixel or two, so expect **about 0.5–1 in and 2–3°**. That's enough to catch the
problems that matter (odometry drifting several inches over a skills run), but not to
tune final 0.25 in accuracy. Use the pose log for that.

## Simpler alternatives we considered

- **Let Claude watch the video.** Claude can look at still frames and say "it clipped
  the goal", but it can't measure inches from video. The tracking has to be code.
  Still useful: drop 3–4 key frames into the chat next to the report for things the
  numbers can't show (hitting a wall, a game element blocking the path).
- **Python + OpenCV script.** More robust tracking, but everyone on the team needs
  Python set up. The browser version keeps it to "open Waypoint".
- **VEX GPS sensor.** If we ever have one and a field with the GPS strip, its readings
  could go straight into `pose_log.hpp` as two extra columns. No camera needed.

## Build order

1. Homography from 4 clicked points, with a grid overlay drawn back onto the video so
   you can see it lines up. (Small: one 8×8 linear solve.)
2. Colour-dot tracking on a recorded test clip, and export the camera track as a
   pose-log CSV. Then the existing Tune section can show it with no other changes.
3. Height correction and the start-pose cross-check.
4. Auto-sync with the log, and the *Odometry vs camera* section in the report.
5. Only if needed: AprilTag instead of dots.
