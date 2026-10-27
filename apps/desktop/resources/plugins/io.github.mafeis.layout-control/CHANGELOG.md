# Changelog

## 0.1.4

- Settings changed on the plugin settings page now take effect right away: the renderer re-reads them on a short poll and whenever the window regains focus, instead of only once at load.
- Turning the composer icon back on, or changing the width, no longer needs an app restart.
- 中文：设置页的改动现在立刻生效——渲染器会短间隔回读，并在窗口重新获得焦点时立即同步，不再只在加载时读一次；重新打开快捷图标或改宽度都不必重启应用。

## 0.1.3

- New setting `showTrigger`: turn the composer shortcut icon off and on from the plugin settings page.
- Hiding the icon closes the panel it anchors and leaves the toolbar untouched; the width override keeps working.
- 中文：新增设置 `showTrigger`，可在插件设置页关闭/开启输入框里的快捷图标；关闭时自动收起面板，宽度覆盖照常生效。

## 0.1.2

- The composer button lost its border and background — only the icon is left, and it grew from 14 to 18 px.
- The icon is a solid glyph now (content block plus solid arrows), which stays readable at toolbar size.
- 中文：工具栏按钮去掉边框与底色，只留图标；图标从 14px 放大到 18px，并改成实心图形，工具栏尺寸下不再糊。

## 0.1.1

- The composer button is a plain layout icon now: a content container with arrows pointing out to the side gutters. No number on it.
- The current width, and any sidebar bonus, moved into the button's tooltip.
- 中文：工具栏按钮换成「内容容器 + 两侧向外箭头」的布局图标，不再显示数字；当前宽度与侧栏加成移到悬浮提示里。

## 0.1.0

First release.

- Control the conversation content width from the composer toolbar: presets 760 / 960 / 1200 / 1440 / full width, or any value between 640 and 2400 px
- Adjustable side gutters between 8 and 56 px
- Follows the sidebar: widen automatically while the sidebar is collapsed
- Respects the native width drag handles and adopts the width you drag out
- Panel shows the measured width of the real transcript column
- 中文：输入框工具栏调节会话内容宽度（预设 / 自定义 / 满宽）与左右留白；侧栏收起时自动加宽；兼容原生拖动手柄并记住拖出的宽度；面板显示实测正文宽度
