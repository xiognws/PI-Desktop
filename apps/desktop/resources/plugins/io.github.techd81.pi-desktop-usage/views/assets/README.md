# Bundled images

Both marks are taken from the official repositories and are used only to label
the two data sources in the panel. They are **not** covered by this project's
MIT license and remain the property of their projects.

| File | Source | Upstream license |
| --- | --- | --- |
| `pi-cli.svg` | <https://pi.dev/logo-auto.svg> — the logo referenced by the README of <https://github.com/earendil-works/pi> | MIT (Pi) |
| `pi-desktop.png` | `docs/image/readme/logo.png` in <https://github.com/vastsa/PI-Desktop>, downscaled from 512×512 to 128×128 | LGPL-3.0 (PI-Desktop) |
| `icon.png` | Drawn by `scripts/make-icon.mjs` (own work, MIT) | MIT (this project) |

`icon.png` is the plugin's own mark, referenced by `manifest.icon`. It is
generated rather than drawn by hand, so it can be re-rendered at any size:

```bash
npm run icon
```

If either upstream project changes its mark, replace the file here and keep the
file name so the panel keeps working.
