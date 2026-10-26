# VEX Auton Sim

A drivetrain-only autonomous simulator for the **VEX V5 Override** field.
It runs your **LemLib** auton code (C++ or JavaScript), follows **path.jerryio** files, and lets you scrub the result on a timeline.

Only the drivetrain is simulated. Intake, lift, claw and the like are ignored, and the game elements (goals, loaders, toggles, cups, pins) are visual only.

## Running it

| How | Steps |
|---|---|
| **Simplest** | Double-click `index.html`. Works straight from the file, nothing to install. |
| **Standalone server** | Double-click `start.bat` (starts a local server and opens the browser). |
| **Rack** | **+ Add app** → point at this folder → **Save**. Run `setup.bat` once, press **Start**, click **Open sim**. |

`run-sim.bat` is the foreground launcher Rack uses. It serves the folder on `%SIM_PORT%` (Rack sets it, default `8137`) using Python if installed, otherwise the PowerShell that ships with Windows. It never opens a browser or waits for a keypress.
There is no build step, so there is no `rebuild.bat`.

## Using the sim

1. **Start pose** - set X / Y / heading on the field (or drag the dashed robot; drag the yellow handle to turn it).
   **`0, 0, 0` in your code is that pose**: `+y` is straight ahead of the robot, `+x` is to its right, heading `0°` is its starting direction. A `chassis.setPose(...)` in the code re-anchors it, like on a real robot. The red / green axes on the field show the code frame.
2. **Drivetrain** - wheel diameter, wheel RPM, **real-life speed %** (how much of the theoretical top speed the robot really reaches), track width, robot size, motor response time and LemLib's horizontal drift.
3. **Path files** - drop in whatever jerry.io exported: LemLib `.txt`, a `.jerryio` project, or a LemLib v1.0 binary file. Each gets a name for your code: the file name with non-letters turned into `_`, e.g. `my path.txt` → `my_path_txt`, `curve.jerryio` → `curve_jerryio` (a file with several paths also gets each path's own name). Click the name to copy it.
4. **Auton code** - paste your `autonomous()` (or the whole `main.cpp`), press **Run auton** or `Ctrl + Enter`.
5. Use the timeline to play, pause and scrub. Click a line in the run log to jump to that motion. Keys: `Space` play/pause, `Home` restart, `←` `→` nudge 0.1 s.

### Path coordinates

| Mode | Meaning |
|---|---|
| **Field coordinates** (default) | The path sits on the field exactly as drawn in jerry.io (origin = field centre, inches). The sim converts it into your code frame, so it works for any start pose. Put the start pose where your path starts. |
| **Shifted to the robot** | The path keeps its shape and direction but is slid so its first point is on the robot when `follow()` starts. |
| **Code coordinates** | File numbers are used as-is in the odometry frame (what a real robot does if you never rebase them). |

Units come from the file's format (LemLib text = inches, path.jerryio = cm, v1.0 = mm, project files = the unit chosen in jerry.io); you can override them per file.

Supported files: LemLib v0.4 text (with the ghost point), LemLib Tarball v0.5 and path.jerryio v0.1 text (`#PATH-POINTS-START` blocks), LemLib v1.0 binary (mm, m/s), and `.jerryio` project JSON. Speeds are converted to motor commands (0-127 and 0-255 are used directly, m/s is scaled to what the robot's wheels can do).

### Supported code

LemLib 0.5-style calls, with LemLib's blocking rules (`async` defaults to `true`, and starting a new motion waits for the previous one to finish):

`setPose` `getPose` `moveToPoint` `moveToPose` `turnToHeading` `turnToPoint` `swingToHeading` `swingToPoint` `follow` `waitUntil` `waitUntilDone` `cancelMotion` `cancelAllMotions`, plus `pros::delay`, `pros::millis`, designated-initialiser params (`{.forwards = false, .maxSpeed = 80}`), `lemlib::DriveSide::LEFT`, `lemlib::AngularDirection::CW_CLOCKWISE`, simple `int / float / bool` variables, `if`, `for`, `while`, and several `void name()` routines (pick one in the **Routine** menu).

Anything on other objects (`intake.move(127)`, `clamp.set_value(true)`, ...) is ignored.
It is a small translator, **not a C++ compiler**: helper functions with parameters, lambdas, classes and templates are not supported (you get a warning).

**Import drivetrain & gains from code** copies the numbers from your `lemlib::Drivetrain` and `lemlib::ControllerSettings` lines into the sim settings. The LemLib tuning card holds the PID values, exit conditions and slew.

## Things to know (accuracy)

* **LemLib behaviour is a port of the algorithms** (PID, exit conditions, boomerang `moveToPose`, pure-pursuit `follow`), written from the LemLib source as I know it. It is close, not bit-exact: expect small differences from a real robot, and tune on the robot as usual. In particular, a motion ends when *either* the small-error or the large-error exit condition is met.
* **Physics** is a simple differential drive: wheel speed follows the motor command with a first-order lag ("motor response"), odometry is perfect, the robot cannot leave the field walls. No wheel slip, no collisions with goals.
* **Path files** are read according to the layouts jerry.io writes (checked against its published source, not copied from it). For `.jerryio` project files the points and speed profile are recomputed here (even spacing along the curve, speed limits, bend-rate slowdown, keyframes, deceleration); for the exported `.txt` / binary files the exported points and speeds are used exactly. Followed paths get a "ghost" tail past the end (like LemLib's) so the robot slows to a stop instead of cutting off. If a file does not load, the run log says why.
* **Field layout** is drawn from the manual's "Override field setup" figure: red side on the left, blue on the right, the 9 goals (octagonal posts; red alliance goals lower-left, blue upper-right, neutral short goals upper-left / lower-right, tall goal in the centre), the four 4-pin starbursts on the double diagonal, wall cup groups, single pins on the other diagonal, the red/blue pins at the diamond points, corner boxes, loaders on the alliance walls, and yellow toggles. Positions were measured off a top-down render of the field (about half an inch of error). Goal and cup sizes are estimates. Everything is plain data in `js/field.js`.

## Files

```
index.html, css/style.css       the page
js/lemlib.js                    LemLib controllers + chassis (motions)
js/sim.js                       physics, virtual clock, runs your code
js/translate.js                 C++ -> JS translator
js/paths.js                     jerry.io file parsing
js/field.js, js/render.js       Override field + canvas drawing
js/app.js                       UI
examples/                       example.txt, example.jerryio, example_auton.cpp
rack.json, run-sim.bat, setup.bat, start.bat, serve.py, serve.ps1
tests/engine.test.js            node tests/engine.test.js
tools/make-examples.js          regenerates examples/ and js/examples.js
```

Settings, code and loaded path files are remembered in your browser (local storage).
