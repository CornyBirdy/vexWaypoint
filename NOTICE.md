# Notice

This project includes work derived from **path.jerryio** by Jerry Lum
(<https://github.com/Jerrylum/path.jerryio>), which is licensed under the
**GNU General Public License v3.0**. This project is therefore distributed under
the same licence (see `LICENSE`).

Taken from path.jerryio:

- `assets/field/override-match.png`, `assets/field/override-skills.png` - the Override field images.
- The path editor: the path / segment / control model, the way curves and
  end points are added, split, converted, removed and dragged, the speed
  keyframes and speed profile calculation, and the file layouts it writes
  (`js/editor.js`, `js/export.js`, `js/paths.js`), ported from TypeScript to
  plain JavaScript.

The motion controllers in `js/lemlib.js` (moveToPoint, moveToPose, turnTo*, swingTo*,
follow, PID, exit conditions, motion queueing and chaining) are a JavaScript port of the logic in
**LemLib v0.5.6** (<https://github.com/LemLib/LemLib>), which is licensed under the MIT licence:

> MIT License
>
> Copyright (c) 2024 Liam Teale and LemLib contributors
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

Everything else (the simulator, physics, C++ translator, Rack launchers) is original to this project.
