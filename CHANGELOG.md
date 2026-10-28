# Changelog

All notable changes to Waypoint are listed here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). There are no version numbers yet, so entries are
grouped by date.

## Unreleased

### Added
- **Real-life error: gyro drift and wheel slip.** The robot now has two poses: where it really is, and where
  its odometry thinks it is. The LemLib motion controllers (and `getPose()`) only see the second one, so the
  error shows up in the run the way it does on a real robot. It can be switched off in the new
  **Real-life error** panel.
  - *Gyro:* a constant bias (drift in degrees per minute) that also wanders slowly, a turn-rate scale error
    (the sensor under- or over-reading rotation) and reading noise. Each run gets its own random draw.
  - *Wheel slip:* ground speed follows the wheels only as far as friction allows, so hard acceleration spins
    the wheels and hard braking skids them. The encoders count the wheel travel, not the robot's travel.
  - *Sideways slide:* a turning robot that is going too fast for its sideways grip slides wide.
  - *Turn scrub:* the robot turns a little less than its wheels say (effective track width above the
    measured one).
  - *Walls:* wheels that keep turning against a wall keep counting distance, so the odometry can think the
    robot arrived when it never did.
  - A **random seed** makes a run repeatable; **New random seed** draws a different robot. Grip also changes
    by a few percent from run to run.
  - `chassis.setPose()` clears the odometry error (like a wall reset). The gyro keeps drifting afterwards.
- A dashed cyan **odometry ghost** on the field shows where the odometry thinks the robot is (toggle
  *odometry ghost* under the field). The `code` readout shows how far off it is.
- The run log ends with a summary: final and worst odometry error, the gyro's drift and scale error, total
  wheel slip, the fastest sideways slide.
- This changelog.

### Changed
- Real-life error is **on by default** with typical V5 values, so results differ slightly from earlier
  versions. Untick *simulate gyro drift and wheel slip* (or set every value to 0) to get the old, perfect
  robot back; with everything off the output is identical to before.
- A `follow()` path in **Shifted to the robot** mode now starts at where the odometry says the robot is.

## 2026-10-27
- Renamed the app to **Waypoint**; added the violet app icon and favicon.
- Applied the Rack Suite design tokens (violet accent, dark / light, Theme toggle).
- Added the Invictus 52111A watermark and credit.
- Restart rewinds without auto-playing.
- Ported the LemLib v0.5.6 motions faithfully (parameters, motion chaining, exit conditions).
- Lift / claw waits no longer hang a run; functions that are not in the paste are listed in the log.
- Paste a whole `main.cpp`: the sim finds and runs the autonomous routine.

## 2026-10-26
- Ported the path.jerryio path editor and its Override field images (GPL-3.0).
- Matched the real Override field and the real jerry.io file formats.
- Rebuilt the Override field from the official setup figure; removed the alliance station areas and the
  invented field elements.
- First version: VEX Override auton sim with LemLib motions, jerry.io paths and Rack support.
