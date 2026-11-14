# Changelog

All notable changes to Waypoint are listed here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). There are no version numbers yet, so entries are
grouped by date.

## Unreleased

### Changed
- **A flatter, quieter look.** The frosted glass, colour glows and gradients are gone. Surfaces are plain neutral greys (dark) or soft whites (light) in steps with thin outlines, the accent colour is used only for the main action and the current selection, buttons are a solid accent, and nothing bounces or lifts on hover any more. Layout, text and what each button does are unchanged.
- **Smoother animations.** The settings tabs now slide the way you are going (to a tab on the right from the right, to one on the left from the left) and their sections arrive one after another. Buttons and tabs spring when pressed and dialogs spring in. Everything is off if your device asks for reduced motion.
- **Softer corners and a bigger run time.** The run time under the field is now a big light number with the spare time next to it, with the other readouts (field, code, speed, align, motion, cursor) in a tidy grid below. The playback controls sit in their own card. Corners are softer everywhere: cards are less round, buttons are rounded rectangles instead of pills, and the Path/Code switch and the settings tabs are a row of buttons with a raised selected one. Everything works the same as before.
- **New look: Rack Glass.** Waypoint now sits on a soft violet colour background with frosted panels, much rounder corners and pill-shaped buttons. The Run button and selected tabs use a gentle violet gradient. Text is now Plus Jakarta Sans (code stays in JetBrains Mono), and both fonts ship with the app so it still works offline. Light and dark both follow the same style, and the field photo, path colours and overlays are unchanged.

### Added
- **Goal aligner presets.** Each side (front and back) has a *Preset*: **Circle, radius 3 in** (a half-circle cup) or **Triangle, base 6 in, height 3 in** (a V notch). Both open away from the robot so a goal nests in them, with the deepest point on the drivetrain edge. *Forward / back (in)* slides a preset along the robot. Presets follow the robot length; editing one in the sketch editor turns it into your own drawing.
- **JAR-Template and RW-Template autons run.** JAR-Template's `chassis.drive_distance`, `turn_to_angle`, swings, `turn_to_point`, `drive_to_point` and `drive_to_pose` (every overload, its PID, exit conditions, `drive_min_voltage` chaining and constants) and RW-Template's `driveTo`, `turnToAngle`, `turnToPoint`, `moveToPoint`, `boomerang`, `curveCircle`, `swing` (its PID, `exit = false` chaining, `runAsync`, the wait helpers, settings read from a pasted `robot-config.cpp`) are ported from their sources. RW's `driveProfiled`, `turnProfiled`, `followPath` and `followPathRamsete` are close approximations. VEXcode `wait(200, msec)` and `waitUntil(...)` work. The run log names the code style it found.
- **PROS and VEXcode drive motors driven directly.** `pros::MotorGroup` / `pros::Motor` (`move`, `move_voltage`, `move_velocity`, `move_relative`, `move_absolute`, `get_position`, `tare_position`) and VEXcode `motor` / `motor_group` (`spin`, `stop`, `spinFor`, `spinToPosition`, `position`) on the drive motors move the robot; the drive motors are found from your declarations. Each drive command shows in the run log.
- **Real runs tab: compare the real robot with the sim.** Drop a pose log from the robot (`plogNNN.csv` from the brain's SD card, or a saved `pros terminal` output with `#POSELOG BEGIN ... END`; from `pose_log.hpp` in Invictus-v2) anywhere on the page, or paste it. The field shows where the robot's odometry says it went, with an outline robot on the timeline, next to the simulated run. The tab lists how far it was from the sim, overshoot on drives and turns, and a drivetrain fit. **Fit sim to run** sets *Real-life speed* and *Motor response* from the log so the sim moves like your robot. **Copy report for Claude** copies a markdown report (per-motion overshoot, rise and settle times, real vs sim pose, the trajectory and the code) for Claude to tune the auton from.
- **Open-loop driving is simulated.** Helpers that drive the motors directly (a `backUp()` that does `chassis.tank(-60, -60); pros::delay(500);`, a `driveToGoal()` that pushes into a goal) used to do nothing in the sim, so an auton built from them looked nothing like the real robot. `chassis.tank()`, `arcade()`, `curvature()` and the drivetrain's motor groups (`leftMotors.move()`, `move_voltage()`, `move_velocity()`, `brake()`, named from your `lemlib::Drivetrain` line) now move the robot until the next command, and `pros::delay()` makes them last. A LemLib motion that is running keeps the motors, so a `tank()` during it is ignored.
- **Helpers that use structs and casts now run.** A goal-reset header like `goal_reset.hpp` (`struct Goal { float x; float y; }`, `inline constexpr Goal GOAL = {30.0f, 20.0f};`, `lastReset = {true, x, y, ...};`) is understood, so `resetAtGoalA()` re-anchors the robot on the goal as it does on the real one instead of throwing. Plain-data structs, brace lists for them (positional or `.name = value`), `(uint32_t)` / `(int8_t)` style casts, and `pros::Task(...)` (skipped, not reported as a missing function) are supported. Before, `lowerUntilStall()` and `waitForLift()` failed to translate because of a `(uint32_t)` cast.
- A function that is not in your paste is now reported in the run log **where it is called** (with its arguments), not only in the summary at the end, so you can see which steps the robot skipped.
- **Path-first flow: draw, watch, export.** A **Preview: Path / Code** switch at the top says what the field runs.
  *Path* (the default) runs just the selected path, so a drawn path can be watched with no code. The first click of
  a new path sets where it starts, the robot stands there facing the way the path leaves, and it drives the path
  when you stop drawing. A new **Use on the robot** panel (Paths tab) has lookahead, timeout and drive-backwards,
  says how long the path takes or that it would time out, and shows the code the preview runs
  (`ASSET(Path_txt)`, `chassis.setPose(...)`, `chassis.follow(...)`). **Download Path.txt** saves the file named so
  PROS's `ASSET()` finds it, **Copy code** copies the snippet and **Add to my code** puts it into your own
  `autonomous()` and runs it there. In *Code* mode, **Start at selected path** moves the start pose to the path's
  first point and heading. A path's file-based name (`Path_txt`) now always works in the sim.
- **Mix 11 W and 5.5 W motors.** *Motors per side* is now two boxes, *11 W motors per side* and *5.5 W motors per
  side*, so a 55 W drive (two 11 W + one 5.5 W a side, 27.5 W) works. The motors are geared to give the wheel RPM
  when unloaded, and the 5.5 W motor has its own figures (0.5 N m stall at about 200 rpm), so it comes out at
  about 48% of an 11 W motor, not exactly half; the readout says so. The current figures for both are under
  *Motor current figures*. Settings saved with the old single motor type carry over.
- **Settings tabs.** The settings are now in tabs (Robot, Aligners and errors, Paths, Code, Everything) and the
  sections of a tab sit in two columns on a wide screen, instead of one long narrow column on the right. The
  chosen tab is remembered.
- **Reasons for greyed-out controls.** A control that is switched off now says why underneath (for example the
  second forward tracking wheel needs the forward one ticked, the cartridge is only for 11 W motors, the speed
  boxes are worked out from the motors, a side needs at least 2 wheels).
- **Motors and weight.** Enter the motor wattage (11 W or 5.5 W), stall / free / limit current, motors per side, cartridge, robot weight (kg or lb) and the sim works out the **real-life speed** and the
  **motor response** itself (the two boxes are filled in and locked). It is a DC motor model with a current
  limit, the gearing from the wheel RPM, rolling resistance from your wheel types, and the robot's mass: a
  heavier robot or fewer motors accelerate slower, six 11 W blue-cartridge motors on a
  5.5 kg robot reach about 94% of the ideal speed. Untick it to type the numbers in as before. The current
  figures are typical (VEX publishes the stall torque and the 2.5 A limit; the true stall and free current come
  from a community fit).
- **Auto-tune timeouts.** Measures how long every motion takes and gives each call a timeout of that time plus a
  safety margin (default 20% + 150 ms). A motion that hits a wall or goal and can never get there gets a timeout
  shortly after it hit (default +400 ms), or shortly after an aligner caught the goal (+200 ms), so it has time to
  square up without pushing in for long. It runs the tuned code again to check, covers several random draws of
  the real-life error, and gives you a table plus a copy of your code with the timeouts put in (copy it, or use
  it in the editor).
- **Goal aligners.** Draw the aligners on the chassis in a CAD-style **sketch editor** (*Goal aligners* panel):
  lines, 3-point arcs, centre-point arcs and circles on an inch grid with snapping (1 / 0.5 / 0.25 in or off),
  exact dimensions typed in (line length and angle, arc and circle radius, arc sweep), select / drag handles,
  mirror copy, undo / redo, zoom and pan. The drivetrain is drawn at its entered size with its wheels. Front
  aligners are on by default; back aligners are drawn separately. Each set has a material (polycarbonate,
  acetal, steel, aluminium), a stock thickness and an alignment point (default the middle of the back of the
  aligners, or drag it).
- **The goals and the field walls are now solid.** The nine goals are fixed to the field. The robot is a rigid
  body: its body and aligners stop against the goals and walls, slide along them with friction and are turned
  by them, so aligners catch and guide the robot. The walls are at 70.25 in from the centre (140.5 in inside).
- **Aligned check.** A goal counts as aligned when any surface of it is within *Aligned within (in)* of the
  alignment point. The run log reports when that happens (or how close it got), the *align* readout and a green
  goal highlight show it on the timeline, and the run history notes it. With real-life error on there is a
  small bias against aligning (stickier aligners, 5% less allowance).
- The goal footprint is a **square with cut-off corners** (about 5.65 in across, corners cut by 1 in, flat sides
  parallel to the walls), measured off the field picture and confirmed by the team. The sizes and the corner cut
  are settable, and *goal hitboxes* shows them on the field.
- **Run history**: every Run is listed as "Run #N" with how long ago, its random seed, how long it took, how far
  off the odometry ended and whether the aligners aligned; **Replay** runs an earlier random draw again.
- **Chassis panel**: map out the drivetrain. Choose how many wheels (2 to 4 per side) and whether each is
  **omni** or **traction**, front to back (click a wheel in the drawing to switch it, or use the lists), with
  the right side mirroring the left or set separately. Add a **forward** and / or **sideways tracking wheel**
  with its offset from the centre. It is drawn top-down on an inch grid with the robot size and wheel
  positions. A summary line shows what the chassis does on the floor.
- The chassis decides the errors: traction wheels grip more and slide less (less drift) but scrub more when
  turning, a traction wheel in the middle scrubs less than one at the ends, omni wheels vary more from run to
  run, and tracking wheels keep the odometry right when the drive wheels spin, skid or push on a wall (a
  sideways one also sees sliding).
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
- `chassis.setPose()` **at the start of the code now sets where the robot starts** (field coordinates, compass
  heading). The Start pose panel follows it, and the code axes move with it. Untick *take the start pose from
  setPose()* to place the robot by hand. A `setPose()` after the robot has moved still just re-anchors the
  code's coordinates.
- `setPose()` accepts every spelling: `setPose(x, y, theta)`, `setPose(x, y, rad, true)`,
  `setPose(lemlib::Pose(x, y, theta))`, `setPose(lemlib::Pose{x, y, theta})`, `setPose({x, y, theta})` and
  `setPose(pose)`. `Pose p{x, y, theta};` declarations are understood. `getPose(radians, standardPosition)` works.
- The **Waypoint logo**: a banner at the top of the README, a start-up splash (shown once per browser session,
  click to skip) and a link-preview image.
- Chassis: choose whether the robot has an **IMU**. Without one the odometry heading comes from the wheels: two
  forward tracking wheels keep it good, drive wheel encoders get it wrong by the wheel slip and scrub (as the
  LemLib docs warn). The chassis summary also shows the horizontal drift LemLib's docs suggest for your wheel
  mix (2 for all omni, 8 with traction wheels).
- **Import settings from code** now also reads `lemlib::TrackingWheel` offsets and the `lemlib::OdomSensors`
  line (forward / sideways tracking wheels, IMU) into the Chassis panel.
- Checked against the LemLib documentation: `chassis.resetLocalPosition()` now works (it did nothing before),
  and the `lemlib` helpers `Pose.lerp` / `Pose.rotate`, `sanitizeAngle`, `angleError`, `avg`, `ema`, `slew`,
  `getCurvature`, `Timer` and `PID` exist in the sim. `printf` fills in `%d`, `%f`, `%s` formats.
- The run log warns when `turnToPoint` / `swingToPoint` aims at a point within 10 in of the robot (the docs
  advise against it).
- This changelog, also shown in the app: the **Changelog** button in the top bar opens it (with a dot until you
  have seen the newest entries).

### Changed
- **The default start pose is now midfield on the red wall, facing the centre** (x -58, y 0, 90°) instead of the bottom-left corner facing up. It is used for drawn paths and for code without its own `chassis.setPose()`. Saved settings keep their start pose: press *Reset settings* to get the new one.
- **New wordmark and splash.** WAYPOINT is now drawn in the Rack Suite VEX lettering (monoline, leaning forward, a
  the A drawn without its crossbar and a violet waypoint inside it) instead of a cut-out of the old logo picture, so it is sharp at any size and follows
  the theme. The start-up splash is rebuilt to match: the wordmark, a route that draws itself in (still with reduce
  motion on) and the tagline. The README banner and link preview use the same artwork. The "Made by Invictus" credit
  now sits at the bottom of the window.
- **New app icon.** A 3x3 field-tile grid with a violet route through it, part of the Rack Suite VEX icon family
  (Recon uses the same grid with a turquoise viewfinder). Replaces the duotone icon; the favicon and every icon
  size are rendered from `assets/icon/icon.svg`.
- **Wider layout.** The field takes the left column at the largest size that fits the screen and the settings get all
  the rest, in columns that pack with no empty gaps, instead of a narrow strip. The wheel dropdowns sit in one row of four.
- **Aligner sketch grid lines up with the drivetrain's edge.** The grid is anchored on the edge you are drawing
  on (the front edge for front aligners, the back edge for back ones), so that edge is a grid line and snapping
  (1, 0.5, 0.25 in) counts whole steps from it, instead of landing 0.25 or 0.5 in off a 15 in robot's edge. The
  rows are labelled with their real positions, the robot's centre lines are dotted, and the status line says how
  far past the edge the cursor is.
- "Aligned within" is explained properly: on the page, in the aligner editor (next to the setting, with the
  circle it draws round the alignment point) and in the README.
- The header says **WAYPOINT** in the logo's own lettering (it is cut from the logo and takes the theme colours).
- The page uses the whole width: the field and the settings share it, up to 1900 px.
- The example auton now uses field coordinates (`chassis.setPose(-58, -58, 0)`, then field positions), as real
  LemLib code does, and the default start pose is (-58, -58) so the robot can turn in place at the wall (the
  walls are now at 70.25 in).
- Turn the contact physics off with *goals and walls are solid* (then the robot is only kept inside the old
  144 in field, as before). Robot-versus-goal and robot-versus-wall contact applies to the perfect robot too.
- **Lift / claw waits no longer add time.** A loop such as `while (liftPIDEnabled != 1) { pros::delay(20); }`
  counts as already finished instead of being carried on after 500 ms. The *Lift / claw wait* setting now
  defaults to 0 (a saved 500 is reset to 0); set it above 0 to make every such wait cost that many ms.
  Loops that do other work, and waits on the drivetrain, behave as before.
- The Real-life error numbers are **no longer adjustable**: it is a single on / off tickbox, and the sizes come
  from the chassis. **Every Run now gives the robot a new random draw**, so results change from run to run
  (re-runs after a setting change keep the same draw). The seed field and *New random seed* button are gone.
- Real-life error is **on by default** with typical V5 values, so results differ slightly from earlier
  versions. Untick *simulate gyro drift and wheel slip* (or set every value to 0) to get the old, perfect
  robot back; with everything off the output is identical to before.
- A `follow()` path in **Shifted to the robot** mode now starts at where the odometry says the robot is.
- **Wheel setup has Blank.** Every chassis has 4 wheel positions a side (8 in all, the default), and each one is
  Omni, Traction or **Blank**. The + / - buttons are gone: a 4WD is four blanks. Clicking a wheel in the drawing
  steps through omni, traction and blank. Settings saved with more or fewer wheels carry over.
- **Real-life error is off by default and smaller.** The gyro drift, scale error, noise and tracking wheel scale
  are turned down about a third to a half. A new **Error size** box multiplies all of them (and loosens the grip)
  so you can simulate a worst case (2 or 3) or a good robot (0.5). Settings saved before this go back to off once.
- **Goal aligners are off by default.** Drawing the first shape switches that set on. Goals and walls are only
  solid when asked for or while aligners are on (the tickbox is greyed out and says why).

### Removed
- **Real-life error.** The panel (gyro drift, wheel slip, sliding, turn scrub, with its error-size multiplier), the odometry ghost and the random draws in *Auto-tune timeouts* are gone: the sim is always a perfect robot, and the "Aligners and errors" tab is now just "Aligners". Saved settings just drop it.
- The last of the drawn field: its 24 unused colour tokens. Only the background behind the field photo is left.
- The "drawn" field picture. Only the match and skills pictures remain (a saved "drawn" setting becomes match).

### Fixed
- **Motion chaining lost speed.** When a motion exited early and the next one was waiting, the sim left the motors at 0 for a full 10 ms tick before the next motion started; on the robot the next motion takes over at once. Chained motions now hand over in the same tick.
- `printf("%.2f")` lost its `f` (the translator treated it like the `2.0f` number suffix), so the number was never filled in. Text in quotes is now left alone, and `printf` handles flags and widths (`%+.2f`, `%05.1f`, `%-6d`).
- The `lemlib::Omniwheel` diameters were wrong (`OLD_4` is 4.18 in, the `_HALF` sizes differ slightly,
  `NEW_2` was missing); they now match the LemLib docs.
- Two declarations on one line (`lemlib::Pose a(0, 0, 0); lemlib::Pose b(1, 1, 0);`) failed to parse.
- A brace list passed as an argument (`avg({1, 2, 3})`) is understood.
- Switching the field picture between match and skills could show the "drawn" field for a few seconds while
  the picture loaded. Both pictures now load at start-up, and the old one stays up until the new one is ready.
- `chassis.setPose(lemlib::Pose(...))`, `setPose(pose)` and `setPose({x, y, theta})` crashed the run or gave
  `NaN`; the radians flag of `setPose(x, y, rad, true)` was ignored.
- **Aligners drawn inside the robot's body now touch the goal.** The robot's body used to hit the goal first, so an
  aligner drawn within the 15 x 15 outline never did anything. The body is now cut back to the rear-most aligner
  point at the front (or back) of the robot, with the sides still full length, so the aligner meets the goal.

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
