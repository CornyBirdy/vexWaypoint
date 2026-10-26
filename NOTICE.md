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

Everything else (the LemLib motion port, simulator, C++ translator, Rack launchers) is original to this project.

LemLib is a separate project (<https://github.com/LemLib/LemLib>); its algorithms are reimplemented here, not copied.
