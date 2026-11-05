/**
 * Vision Kit (io.github.muzimu217.vision-kit) — 让 agent 真正「看见」本地图片。
 *
 * MVP 工具：read_image
 *   - 入参 action + path（绝对路径或 workspace 相对路径均可）
 *   - 校验：扩展名白名单（png/jpg/jpeg/webp/gif）→ 存在性与大小（pi.fs.stat，
 *     上限 10MB，与宿主 MAX_INLINE_IMAGE_BYTES 对齐）
 *   - 读取：pi.fs.readRange —— 全程走宿主 fs 策略 API（scope 内零提示、越界
 *     回落宿主逐次授权、密钥文件宿主级拒绝），本插件不做任何裸文件 IO
 *   - 回传：工具结果 images 字段携带 {type:"image", mimeType, data(base64)}
 *     多模态块（官方 #1073 已由社区实证该通道可行）；text 只放简短摘要，
 *     base64 绝不进入任何文本字段，避免污染模型上下文
 *
 * 权限面：fs.read（scope=workspace 图片扩展名）+ agent.tool.register。
 * 不声明 net.domains（零出网）、无写删、无面板、不执行图片内容。
 */
"use strict";

const imageMeta = require("./image-meta.js");

const SUPPORTED_EXTENSIONS = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/** 与宿主 packages/shared attachment-limits 的 MAX_INLINE_IMAGE_BYTES 对齐。 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const TOOL_DESCRIPTION =
  "Read ONE local image file and attach it to the conversation as a multimodal image block, so a " +
  "vision-capable model can actually see it (the built-in Read tool is text-only and cannot do " +
  "this). Use it whenever the user references a screenshot, mockup, diagram, photo or any image " +
  "file by path and wants the agent to look at it. Supports png, jpg, jpeg, webp and gif up to " +
  "10MB. Images inside the open workspace read without prompts; paths outside the workspace " +
  "trigger a one-time user grant. Returns a short text summary plus the attached image — never " +
  "echo base64 image data into your reply.";

const INFO_DESCRIPTION =
  "Inspect ONE local image's metadata WITHOUT loading it into the conversation: format (by magic " +
  "bytes), pixel dimensions and file size. Use it to check an image before reading it visually " +
  "(read_image), or to answer size/dimension questions cheaply. Same path rules and supported " +
  "formats as read_image.";

const LIST_DESCRIPTION =
  "List image files in the open workspace (png/jpg/jpeg/webp/gif) with sizes, so the agent can " +
  "discover which images exist before reading any. Optionally scope to a workspace-relative " +
  "directory. Read-only, results capped at 200 entries.";

/** image_info：头部嗅探格式+尺寸+大小，零解码零 base64。 */
async function executeImageInfo(args /* , ctx */) {
  const pi = globalThis.pi;
  if (!pi || !pi.fs) throw new Error("vision-kit: host fs API unavailable");
  const rawPath = args && typeof args.path === "string" ? args.path.trim() : "";
  if (!rawPath) throw new Error("image_info requires a non-empty `path` argument.");
  const declaredMime = extensionToMime(rawPath);
  if (!declaredMime) {
    throw new Error(
      `Unsupported image type: ${rawPath} — image_info supports ` +
        Object.keys(SUPPORTED_EXTENSIONS).join(", ") + " only.",
    );
  }
  let workspacePath = null;
  try {
    const ws = await pi.workspace.get();
    workspacePath = ws && ws.path ? ws.path : null;
  } catch (e) { /* 无工作区 */ }
  const candidates = pathCandidates(rawPath, workspacePath);
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const stat = await pi.fs.stat(candidate);
      const size = stat ? stat.size : NaN;
      assertReadableImage(candidate, size);
      const probeLen = Math.min(size, 256 * 1024);
      const range = await pi.fs.readRange(candidate, 0, probeLen);
      const bytes = range && range.bytes ? range.bytes : range;
      const meta = imageMeta.probeImage(bytes);
      const dims = meta && meta.width ? `${meta.width}x${meta.height}` : "unknown dimensions";
      const mime = meta && meta.mimeType ? meta.mimeType : declaredMime;
      return {
        content: [{
          type: "text",
          text: `${candidate}: ${mime}, ${dims}, ${humanSize(size)} (${size} bytes). Metadata only — call read_image to attach the visual content.`,
        }],
      };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    (
      `image_info could not read ${rawPath}.` +
      (lastError ? ` Last error: ${lastError.message}.` : "")
    ).trim()
  );
}

/** list_images：按扩展名 glob 工作区图片，合并去重排序，带上限与大小。 */
async function executeListImages(args /* , ctx */) {
  const pi = globalThis.pi;
  if (!pi || !pi.fs || !pi.fs.glob) throw new Error("vision-kit: host fs API unavailable");
  const dir = args && typeof args.dir === "string" ? args.dir.trim().replace(/^\/+|\/+$/g, "") : "";
  const LIMIT = 200;
  const all = new Set();
  for (const ext of Object.keys(SUPPORTED_EXTENSIONS)) {
    const pattern = dir ? `${dir}/**/*.${ext}` : `**/*.${ext}`;
    try {
      const found = await pi.fs.glob(pattern);
      for (const p of Array.isArray(found) ? found : []) all.add(String(p));
    } catch (e) {
      /* 单扩展名失败不阻塞整体 */
    }
  }
  const paths = [...all].sort().slice(0, LIMIT);
  if (paths.length === 0) {
    const scope = dir ? ` under "${dir}"` : "";
    return { content: [{ type: "text", text: `No image files found${scope} in the workspace (searched png/jpg/jpeg/webp/gif).` }] };
  }
  const lines = [];
  for (const p of paths) {
    let sizeNote = "";
    try {
      const stat = await pi.fs.stat(p);
      if (stat && Number.isFinite(stat.size)) sizeNote = ` ${humanSize(stat.size)}`;
    } catch (e) { /* stat 失败仅省略大小 */ }
    lines.push(`- ${p}${sizeNote}`);
  }
  const truncated = all.size > LIMIT ? `\n(+${all.size - LIMIT} more not shown)` : "";
  return {
    content: [{
      type: "text",
      text: `${paths.length} image file(s) in the workspace:\n${lines.join("\n")}${truncated}`,
    }],
  };
}

function extensionToMime(filePath) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(filePath || ""));
  if (!m) return null;
  return SUPPORTED_EXTENSIONS[m[1].toLowerCase()] || null;
}

/** 扩展名 + 大小双校验；通过则返回 mimeType，否则抛带指引的错误。 */
function assertReadableImage(filePath, sizeBytes) {
  const mimeType = extensionToMime(filePath);
  if (!mimeType) {
    throw new Error(
      `Unsupported image type: ${String(filePath)} — read_image supports ` +
        Object.keys(SUPPORTED_EXTENSIONS).join(", ") +
        " only.",
    );
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new Error(`File is empty or unreadable: ${filePath}`);
  }
  if (sizeBytes > MAX_IMAGE_BYTES) {
    throw new Error(
      `Image too large: ${filePath} is ${(sizeBytes / 1048576).toFixed(1)}MB, ` +
        `limit is ${MAX_IMAGE_BYTES / 1048576}MB. Compress or resize it first.`,
    );
  }
  return mimeType;
}

/**
 * 依次尝试的 fs 路径候选（越靠前越少打扰）：
 *   1. 绝对路径落在 workspace 内 → 先试 workspace 相对路径（scope 内零提示）
 *   2. 模型给的原样路径（workspace 相对写法直接命中；绝对写法交宿主逐次授权回落）
 */
function pathCandidates(rawPath, workspacePath) {
  const given = String(rawPath || "").trim();
  if (!given) return [];
  const normalized = given.replace(/\\/g, "/");
  const ws = workspacePath ? String(workspacePath).replace(/\/+$/, "") : "";
  const candidates = [];
  if (ws && normalized.startsWith(ws + "/")) {
    const rel = normalized.slice(ws.length + 1);
    if (rel) candidates.push(rel);
  }
  if (candidates[0] !== given) candidates.push(given);
  return candidates;
}

function humanSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0KB";
  return bytes >= 1048576
    ? (bytes / 1048576).toFixed(1) + "MB"
    : Math.max(1, Math.round(bytes / 1024)) + "KB";
}

function toBase64(bytes) {
  if (typeof Buffer !== "undefined" && Buffer.from) {
    return Buffer.from(bytes).toString("base64");
  }
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function buildToolResult({ path, mimeType, sizeBytes, base64 }) {
  // 引擎原生 AgentToolResult.content 形状：块数组（TextContent | ImageContent）。
  // 桌面端把 execute 返回值整体包进 ToolsExecuteResult.content，宿主/引擎按块
  // 数组透传给模型——图片块必须在这一层，任何嵌套对象字段都会被降级成纯文本。
  const summary =
    `Read image ${path} [${mimeType}, ${humanSize(sizeBytes)}]. ` +
    "The image is attached to this tool result as a visual input block — analyze it directly; do not echo image data.";
  return [
    { type: "text", text: summary },
    { type: "image", mimeType, data: base64 },
  ];
}

async function executeReadImage(args /* , ctx */) {
  const pi = globalThis.pi;
  if (!pi || !pi.fs) throw new Error("vision-kit: host fs API unavailable");

  const rawPath = args && typeof args.path === "string" ? args.path.trim() : "";
  if (!rawPath) throw new Error("read_image requires a non-empty `path` argument.");
  if (!extensionToMime(rawPath)) {
    throw new Error(
      `Unsupported image type: ${rawPath} — read_image supports ` +
        Object.keys(SUPPORTED_EXTENSIONS).join(", ") +
        " only.",
    );
  }

  let workspacePath = null;
  try {
    const ws = await pi.workspace.get();
    workspacePath = ws && ws.path ? ws.path : null;
  } catch (e) {
    /* 无工作区环境，按纯候选序处理 */
  }

  const candidates = pathCandidates(rawPath, workspacePath);
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const stat = await pi.fs.stat(candidate);
      const size = stat ? stat.size : NaN;
      const mimeType = assertReadableImage(candidate, size);
      const range = await pi.fs.readRange(candidate, 0, size);
      const bytes = range && range.bytes ? range.bytes : range;
      return buildToolResult({ path: candidate, mimeType, sizeBytes: size, base64: toBase64(bytes) });
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    (
      `read_image could not read ${rawPath}.` +
      (lastError ? ` Last error: ${lastError.message}.` : "") +
      " Check the file exists and its extension is png/jpg/jpeg/webp/gif." +
      " Images inside the open workspace read without prompts; paths outside the workspace need a one-time user grant."
    ).trim(),
  );
}

async function onLoad() {
  const pi = globalThis.pi;
  if (!pi) throw new Error("vision-kit: globalThis.pi missing at onLoad");
  await pi.agent.registerTool({
    name: "read_image",
    description: TOOL_DESCRIPTION,
    risk: "low",
    planSafeActions: ["read_image"],
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read_image"], description: "Fixed action name." },
        path: {
          type: "string",
          description: "Image file path — absolute, or relative to the open workspace.",
        },
      },
      required: ["action", "path"],
      additionalProperties: false,
    },
    execute: executeReadImage,
  });
  await pi.agent.registerTool({
    name: "image_info",
    description: INFO_DESCRIPTION,
    risk: "low",
    planSafeActions: ["info"],
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["info"], description: "Fixed action name." },
        path: {
          type: "string",
          description: "Image file path — absolute, or relative to the open workspace.",
        },
      },
      required: ["action", "path"],
      additionalProperties: false,
    },
    execute: executeImageInfo,
  });
  await pi.agent.registerTool({
    name: "list_images",
    description: LIST_DESCRIPTION,
    risk: "low",
    planSafeActions: ["list"],
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list"], description: "Fixed action name." },
        dir: { type: "string", description: "Optional workspace-relative directory to scope the listing." },
      },
      required: ["action"],
      additionalProperties: false,
    },
    execute: executeListImages,
  });
}

async function onUnload() {
  try {
    const pi = globalThis.pi;
    if (pi && pi.agent) {
      await pi.agent.unregisterTool("read_image");
      await pi.agent.unregisterTool("image_info");
      await pi.agent.unregisterTool("list_images");
    }
  } catch (e) {
    /* 宿主卸载流程会一并回收工具 */
  }
}

module.exports = {
  onLoad,
  onUnload,
  executeReadImage,
  executeImageInfo,
  executeListImages,
  _internal: {
    SUPPORTED_EXTENSIONS,
    MAX_IMAGE_BYTES,
    extensionToMime,
    assertReadableImage,
    pathCandidates,
    humanSize,
    toBase64,
    buildToolResult,
  },
};
