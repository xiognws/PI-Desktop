# Vision Kit 读图工具

给你的 PI-Desktop agent 一双眼睛：`read_image` 读取本地图片文件，并通过工具结果的 **images 字段把图片作为多模态输入回传**，视觉模型可以直接「看见」并分析图片。内置 Read 工具仅支持文本——本插件补上这块能力缺口（技术路径由社区在 [vastsa/PI-Desktop#1073](https://github.com/vastsa/PI-Desktop/issues/1073) 首先实证）。

## read_image 工具

- **入参**：`path` —— 绝对路径或 workspace 相对路径。
- **格式**：png / jpg / jpeg / webp / gif，最大 10MB。
- **安全模型**：
  - 文件访问全部经宿主 fs 策略 API：工作区内按声明的 `fs.read` scope（`**/*.png` 等五个图片扩展名）零提示读取；范围外路径回落宿主逐次授权。宿主的密钥文件拒绝清单（`.env`、密钥、`.git` 等）始终生效。
  - 纯只读：不声明任何出网域名、不写不删、不执行图片内容。
  - 图片字节仅作为多模态输入附加到当前会话，不上传到任何其他位置。
- **Plan 模式**：已声明 `planSafeActions`，agent 在规划阶段也能直接查看设计稿与截图。

## 安装

在 PI-Desktop 插件中心搜索 "Vision Kit" 安装；或以开发模式加载本目录。

## 许可

MIT
