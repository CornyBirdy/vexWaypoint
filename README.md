# VEX Auton Sim

A drivetrain-only autonomous simulator for the **VEX V5 Override** field.
It runs your **LemLib** auton code (C++ or JavaScript), follows **path.jerryio** files, and lets you scrub the result on a timeline.

It includes a **path editor** ported from [path.jerryio](https://github.com/Jerrylum/path.jerryio), so you can draw and tune paths right on the field, and its Override field pictures. Because of that this project is licensed **GPL-3.0** (see `LICENSE` and `NOTICE.md`).

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

### Drawing paths

Press **Edit paths** (above the field), or **New path**, then:

- click empty field: **Curve** or **Line** adds a segment from the last point (the first segment starts at the robot's start pose)
- click a point: **Delete** (end points; their segment goes with them). Drag points to move them; an end point takes its two handles with it, hold `Ctrl` to move it alone
- click a curve: **Convert** (curve <-> line) or **Split** (adds a point there)
- the **speed graph** under the field: click to add a speed point, drag it, double-click (or `Delete`) to remove it. Points on the field are coloured red (slow) to green (fast)
- **Selected path** panel: name, min / max speed, bend-rate range, max deceleration, point density
- `Ctrl+Z` / `Ctrl+Y` undo and redo

Paths you draw (or open from a jerry.io file) are used in code by their name (`Path 2` is `Path_2`), plus the file name for imported ones (`example.txt` is `example_txt`); click the name in the list to copy it.
**Export** writes a jerry.io project (`.jerryio`, opens in jerry.io), a LemLib v0.4 `.txt`, or a LemLib v1.0 `.bin`.

The field picture can be switched between the match field, the skills field and the drawn version.

### Path coordinates

| Mode | Meaning |
|---|---|
| **Field coordinates** (default) | The path sits on the field exactly as drawn in jerry.io (origin = field centre, inches). The sim converts it into your code frame, so it works for any start pose. Put the start pose where your path starts. |
| **Shifted to the robot** | The path keeps its shape and direction but is slid so its first point is on the robot when `follow()` starts. |
| **Code coordinates** | File numbers are used as-is in the odometry frame (what a real robot does if you never rebase them). |

Units come from the file's format (LemLib text = inches, path.jerryio = cm, v1.0 = mm, project files = the unit chosen in jerry.io); you can override them per file.

Dropping a file that contains the full jerry.io project (`.jerryio`, LemLib `.txt` / `.bin` exports, which embed it) opens its paths in the editor. Anything else is used as plain points.

Supported files: LemLib v0.4 text (with the ghost point), LemLib Tarball v0.5 and path.jerryio v0.1 text (`#PATH-POINTS-START` blocks), LemLib v1.0 binary (mm, m/s), and `.jerryio` project JSON. Speeds are converted to motor commands (0-127 and 0-255 are used directly, m/s is scaled to what the robot's wheels can do).

### Supported code

LemLib 0.5-style calls, with LemLib's blocking rules (`async` defaults to `true`, and starting a new motion waits for the previous one to finish):

`setPose` `getPose` `moveToPoint` `moveToPose` `turnToHeading` `turnToPoint` `swingToHeading` `swingToPoint` `follow` `waitUntil` `waitUntilDone` `cancelMotion` `cancelAllMotions`, plus `pros::delay`, `pros::millis`, designated-initialiser params (`{.forwards = false, .maxSpeed = 80}`), `lemlib::DriveSide::LEFT`, `lemlib::AngularDirection::CW_CLOCKWISE`, simple `int / float / bool` variables, `if`, `for`, `while`, and several `void name()` routines (pick one in the **Routine** menu).

You can paste your **whole `main.cpp`**: the sim finds `autonomous()` (or the first routine with "auto" in its name), runs it, and ignores `initialize()`, `opcontrol()` and the rest. Other `void` functions with a body become helpers you can call (with arguments and default values), and `enum`s, `#define NAME value` and simple global constants are understood. If the file has several routines, pick one in the **Routine** menu; the run log says which one ran and which functions were ignored.

You can also paste just a **list of statements** (no `void autonomous() { ... }` around it).

**Lift / claw waits.** The sim only runs the drivetrain, so a loop like `while (liftPIDEnabled != 1) { pros::delay(20); }`, which waits for a lift task to finish, would never end. When such a loop is only waiting (no drivetrain motion running, and the condition does not use `pros::millis()`), the sim carries on after **Lift / claw wait** (default 500 ms, in the Drivetrain settings) and says so in the run log.
**Functions that are not in your paste** (for example `resetAtGoalA()` defined in another file) are skipped and listed at the end of the run log. If one moves the robot, paste its definition too and it will run.

Anything on other objects (`intake.move(127)`, `clamp.set_value(true)`, `pros::lcd::print(...)`, ...) is ignored, and lambdas / `pros::Task` bodies are skipped.
It is a small translator, **not a C++ compiler**: classes, templates and pointer tricks are not supported. If a helper function cannot be translated you get a warning and calls to it are ignored; if the routine itself cannot be parsed the run log points at the line that probably caused it.

**Import drivetrain & gains from code** copies the numbers from your `lemlib::Drivetrain` and `lemlib::ControllerSettings` lines into the sim settings. The LemLib tuning card holds the PID values, exit conditions and slew.

## Things to know (accuracy)

* **LemLib behaviour is a port of the algorithms** (PID, exit conditions, boomerang `moveToPose`, pure-pursuit `follow`), written from the LemLib source as I know it. It is close, not bit-exact: expect small differences from a real robot, and tune on the robot as usual. In particular, a motion ends when *either* the small-error or the large-error exit condition is met.
* **Physics** is a simple differential drive: wheel speed follows the motor command with a first-order lag ("motor response"), odometry is perfect, the robot cannot leave the field walls. No wheel slip, no collisions with goals.
* **Path files**: exported points and speeds are used as they are in plain-point files; paths opened in the editor are recomputed with the same speed rules jerry.io uses (even spacing along the curve, speed limits, bend-rate slowdown, keyframes, deceleration), so they can differ from the exported numbers by small amounts. Followed paths get a "ghost" tail past the end (like LemLib's) so the robot slows to a stop. If a file does not load, the run log says why.
* **Field**: the default is path.jerryio's Override field picture. The "drawn" version is my own, measured off that picture: red side on the left, blue on the right, the 9 goals (octagonal posts; red alliance goals lower-left, blue upper-right, neutral short goals upper-left / lower-right, tall goal in the centre), the four 4-pin starbursts on the double diagonal, wall cup groups, single pins on the other diagonal, the red/blue pins at the diamond points, corner boxes, loaders on the alliance walls, and yellow toggles. Positions were measured off a top-down render of the field (about half an inch of error). Goal and cup sizes are estimates. Everything is plain data in `js/field.js`.

## Files

```
index.html, css/style.css       the page
js/lemlib.js                    LemLib controllers + chassis (motions)
js/sim.js                       physics, virtual clock, runs your code
js/translate.js                 C++ -> JS translator
js/paths.js                     jerry.io file parsing + speed profile
js/editor.js, js/export.js      path editor model, jerry.io-compatible export
js/pathtool.js                  path editing UI (field clicks, speed graph, list)
assets/field/                   Override field pictures (from path.jerryio)
js/field.js, js/render.js       Override field + canvas drawing
js/app.js                       UI
examples/                       example.txt, example.jerryio, example_auton.cpp
rack.json, run-sim.bat, setup.bat, start.bat, serve.py, serve.ps1
tests/engine.test.js            node tests/engine.test.js
tests/editor.test.js            node tests/editor.test.js
tools/make-examples.js          regenerates examples/ and js/examples.js
```

Settings, code and loaded path files are remembered in your browser (local storage).
