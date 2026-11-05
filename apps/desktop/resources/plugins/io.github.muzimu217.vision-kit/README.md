# Vision Kit

Give your PI-Desktop agent eyes: `read_image` reads a local image file and returns it as a **multimodal image block** on the tool result, so vision-capable models can actually see and analyze it. The built-in Read tool is text-only — this plugin closes that gap (originally demonstrated by the community in [vastsa/PI-Desktop#1073](https://github.com/vastsa/PI-Desktop/issues/1073)).

## The `read_image` agent tool

- **Input**: `path` — absolute path or workspace-relative path.
- **Formats**: png / jpg / jpeg / webp / gif, up to 10 MB.
- **Model requirement**: the session model must accept image input (any vision-capable model). The image is attached to the tool result as a multimodal block; text-only models will only see the text summary.
- **Safety model**:
  - All file access goes through the host's scoped fs API. Images inside the open workspace read silently under the declared `fs.read` scope (`**/*.png`, `**/*.jpg`, `**/*.jpeg`, `**/*.webp`, `**/*.gif`); anything outside falls back to the host's per-path user grant. The host's secret-file denylist (`.env`, keys, `.git`, …) always applies.
  - Read-only: no network egress is declared, no writes, no deletes, nothing is executed from image content.
  - Image bytes are attached to the current conversation as model input only — never uploaded anywhere else.
- **Plan mode**: declared via `planSafeActions`, so the agent can look at mockups and screenshots while planning.

## Install

Install from the PI-Desktop plugin center (search "Vision Kit"), or load this folder as a development plugin.

## License

MIT
