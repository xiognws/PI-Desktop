# Layout Control

> `io.github.mafeis.layout-control` — widen the PI-Desktop conversation area, and set its side gutters, from a button in the composer toolbar.

PI-Desktop caps conversation content at 760px (`.main-pane` → `--chat-content-max-width`), so on a wide window both sides stay empty. This plugin takes over the three width variables through a renderer extension:

| Variable | Controls |
| --- | --- |
| `--chat-content-max-width` | the transcript column `.thread-content`, settle placeholder |
| `--chat-composer-max-width` | the composer stack `.composer-stack` |
| `--chat-prose-max-width` | a single message / card (`.message-bubble`, tool cards, …) |

## Usage

1. Click `⇔ 1200` on the right of the composer toolbar — a panel opens.
2. Pick a preset (default 760 / comfortable 960 / wide 1200 / extra wide 1440 / full width), or drag the slider for anything between 640 and 2400 px.
3. **Side gutter** is the transcript's inline padding (default 32 px, down to 8 px). On a narrow window it does more than the width does.
4. Turn **Enable layout override** off and the app's own width is back, untouched.
5. **Widen when the sidebar is collapsed** (on by default): collapsing the session list adds the freed space — sidebar width minus the 56 px rail it leaves behind — and expanding it gives the space back. The number on the button is the width actually in effect; the tooltip says how much was added.
6. The native drag handles still work: the plugin steps aside while you drag, then adopts and remembers the width you dragged out (with the sidebar bonus subtracted before saving).

The last line of the panel, "measured content width", is the real measured value — proof the override landed.

The same values are plugin settings (`width` / `gutter` / `enabled` / `followSidebar` / `showTrigger`), so editing them on the settings page works too; those edits reach the UI the next time you open the panel or reload the plugin.

`showTrigger` turns the composer shortcut icon off. That is the only way to open the panel, so flip it back from the settings page — the width override keeps working while the icon is hidden.

## How it works

- `main.js` only reads and writes plugin settings and answers `getLayoutConfig` / `setLayoutConfig` through `onRendererCall`.
- `renderer/index.mjs` does all the UI work:
  - the width lives in `--pio-w` on `<html>` and the stylesheet rules only forward it with `var()` → changing the width never re-injects a stylesheet;
  - the host writes its variables as **plain inline declarations** on `.chat-surface`, so a stylesheet rule with `!important` wins;
  - while dragging, the host marks both `<html>` and `.chat-surface` with `data-chat-resizing`; the rules step aside with `:not([data-chat-resizing])` and adopt the dragged value once dragging ends;
  - a collapsed sidebar puts `sidebar-collapsed` on `.app-shell` (leaving `.sidebar-rail`), so the plugin watches class changes and adds "sidebar width (inline `--ds-sidebar-width` on `.app-shell`) − 56 px rail".
- The only permission requested is `renderer.extension` — flagged high risk because the extension runs inside PI-Desktop's own window. No filesystem, network or clipboard access, no agent tools.
- The layout override needs its own `<style>` element: `pi.ui.injectStyle` wraps every rule in `@scope ([data-pi-plugin="<id>"])`, which can only reach the plugin's own subtree and never the app's DOM. The button and panel still use `injectStyle` for their own styling.

## Develop

```bash
node --check main.js
node --check renderer/index.mjs
```

Load the folder as a development plugin (**Plugins → ⋯ → Load development plugin**); saving a file reloads it. `~/.pi-desktop/logs/app/plugin.log` should then show `plugin.load.success` / `plugin.reload.success` with `pluginId: io.github.mafeis.layout-control`.

To install it like any other plugin, build the package with the host's own `PluginCheck` / `PluginPack` and install the resulting `dist/io.github.mafeis.layout-control-0.1.0.piplug` from the plugins page.

## 中文说明

把会话区从「不到 760px 的一窄条」放开：内容宽度、左右留白都能调，入口在输入框工具栏右侧的 `⇔` 按钮上。

1. 点 `⇔ 1200` 打开面板。
2. 选预设（默认 760 / 舒适 960 / 宽 1200 / 超宽 1440 / 满宽），或拖滑杆自定义 640–2400px。
3. 「左右留白」调的是正文栏内边距（默认 32px，最低 8px）；窗口不宽时它比宽度更有效。
4. 关掉「启用布局覆盖」就完全回到应用自己的宽度。
5. 「侧栏收起时自动加宽」（默认开）：收起左侧会话列表后正文自动加上腾出来的空间（侧栏宽 − 56px 轨道），展开即退回；按钮上的数字是当前实际生效宽度。
6. 拖动会话两侧边缘照旧可用：拖动期间插件让位，松手后接住拖出来的宽度（自动扣掉侧栏加成再存）。

面板底部「正文栏实际宽度」是量出来的真实值。设置项（`width` / `gutter` / `enabled` / `followSidebar`）在设置页改同样有效，但要等下次打开面板或重载插件才反映到界面。

## License

MIT — see [LICENSE](LICENSE).
