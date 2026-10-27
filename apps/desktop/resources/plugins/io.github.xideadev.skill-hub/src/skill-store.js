"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

/**
 * 技能真实文件管理与元数据读写模块
 */

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function atomicWrite(targetPath, content) {
  const dir = path.dirname(targetPath);
  ensureDir(dir);
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, content, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, targetPath);
}

/**
 * 获取所有可能存在的全局技能根目录
 */
function getGlobalCandidateDirs() {
  const home = os.homedir();
  return [
    path.join(home, ".agents", "skills"),
    path.join(home, ".agent", "skills"),
    path.join(home, "agent", "skills"),
    path.join(home, "agent", "skill"),
    path.join(home, ".pi", "agent", "skills"),
  ];
}

function getPrimaryGlobalDir() {
  const candidates = getGlobalCandidateDirs();
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return candidates[0];
}

/**
 * 获取项目专属技能目录
 */
function getProjectSkillsDir(workspacePath) {
  if (!workspacePath) return null;
  const p1 = path.join(workspacePath, ".agents", "skills");
  if (fs.existsSync(p1)) return p1;
  const p2 = path.join(workspacePath, ".agent", "skills");
  if (fs.existsSync(p2)) return p2;
  return p1;
}

/**
 * 解析 SKILL.md 或 <name>.md Frontmatter 元数据
 */
function parseSkillFile(filePath, skillName, scope) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, "utf8");
    
    let desc = "";
    let triggers = [];
    
    // 提取 YAML Frontmatter
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (match) {
      const frontmatter = match[1];
      const descMatch = frontmatter.match(/description:\s*(.*)/i);
      if (descMatch) desc = descMatch[1].replace(/^["']|["']$/g, "").trim();
      
      const triggersMatch = frontmatter.match(/triggers:\s*\[(.*?)\]/i);
      if (triggersMatch) {
        triggers = triggersMatch[1].split(",").map(t => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      }
    }

    if (!desc) {
      // 降级使用正文第一句
      const lines = content.split("\n").filter(l => l.trim() && !l.startsWith("#"));
      desc = lines.length ? lines[0].slice(0, 120).trim() : "无详细描述";
    }

    return {
      id: skillName,
      name: skillName,
      scope,
      path: filePath,
      dir: path.dirname(filePath),
      desc,
      triggers,
      content,
      updatedAt: fs.statSync(filePath).mtimeMs
    };
  } catch (err) {
    return null;
  }
}

/**
 * 递归扫描指定根目录下的所有技能（支持子目录 SKILL.md 与单文件 *.md）
 */
function scanSkillsInDir(rootDir, scope) {
  const result = [];
  if (!rootDir || !fs.existsSync(rootDir)) return result;
  
  try {
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;

      if (entry.isDirectory()) {
        const skillPath = path.join(rootDir, entry.name, "SKILL.md");
        if (fs.existsSync(skillPath)) {
          const parsed = parseSkillFile(skillPath, entry.name, scope);
          if (parsed) result.push(parsed);
        }
      } else if (entry.isFile() && entry.name.endsWith(".md") && !/^readme/i.test(entry.name)) {
        const skillName = path.basename(entry.name, ".md");
        const skillPath = path.join(rootDir, entry.name);
        const parsed = parseSkillFile(skillPath, skillName, scope);
        if (parsed) result.push(parsed);
      }
    }
  } catch (err) {
    // 忽略读取受限
  }
  return result;
}

/**
 * 聚合所有已启用的全局技能
 */
function scanAllGlobalSkills() {
  const candidates = getGlobalCandidateDirs();
  const seen = new Set();
  const all = [];

  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    const list = scanSkillsInDir(dir, "global");
    for (const item of list) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        all.push(item);
      }
    }
  }
  return all;
}

/**
 * 保存或创建 SKILL.md
 */
function saveSkill(payload, currentWorkspace) {
  const name = String(payload.name || payload.id || "").trim();
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error("技能标识必须为小写字母、数字或连字符");
  }

  const scope = payload.scope === "project" ? "project" : "global";
  let targetRoot = scope === "project" 
    ? getProjectSkillsDir(currentWorkspace)
    : getPrimaryGlobalDir();

  if (!targetRoot) {
    targetRoot = getPrimaryGlobalDir();
  }

  const skillDir = path.join(targetRoot, name);
  ensureDir(skillDir);
  const targetFile = path.join(skillDir, "SKILL.md");

  let content = payload.content || "";
  if (!content.startsWith("---")) {
    const fm = [
      "---",
      `name: "${name}"`,
      `description: "${(payload.desc || "").replace(/"/g, '\\"')}"`,
      `triggers: [${(payload.triggers || []).map(t => `"${t}"`).join(", ")}]`,
      "---",
      "",
    ].join("\n");
    content = `${fm}${content}`;
  }

  atomicWrite(targetFile, content);
  return parseSkillFile(targetFile, name, scope);
}

/**
 * 删除（归档）技能
 */
function deleteSkill(id, scope, currentWorkspace) {
  const targetRoot = scope === "project" 
    ? getProjectSkillsDir(currentWorkspace)
    : getPrimaryGlobalDir();
    
  if (!targetRoot) return false;
  
  // 1. 检查目录形态
  const skillDir = path.join(targetRoot, id);
  if (fs.existsSync(skillDir) && fs.statSync(skillDir).isDirectory()) {
    const archiveDir = path.join(targetRoot, `.archived-${id}-${Date.now()}`);
    fs.renameSync(skillDir, archiveDir);
    return true;
  }

  // 2. 检查单文件形态
  const skillFile = path.join(targetRoot, `${id}.md`);
  if (fs.existsSync(skillFile)) {
    const archiveFile = path.join(targetRoot, `.archived-${id}-${Date.now()}.md`);
    fs.renameSync(skillFile, archiveFile);
    return true;
  }

  return false;
}
/**
 * 更新指定技能文件的 description 并写回磁盘
 */
function updateSkillDescription(filePath, newDesc) {
  if (!fs.existsSync(filePath)) return false;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const cleanDesc = (newDesc || "")
      .replace(/\\+"/g, '"')
      .replace(/^["\s\\]+|["\s\\]+$/g, "")
      .replace(/"/g, "'")
      .trim();

    let updated = "";
    if (raw.match(/^description:\s*.*$/m)) {
      updated = raw.replace(/^description:\s*.*$/m, `description: "${cleanDesc}"`);
    } else if (raw.startsWith("---")) {
      updated = raw.replace(/^---\r?\n/, `---\ndescription: "${cleanDesc}"\n`);
    } else {
      updated = `---\ndescription: "${cleanDesc}"\n---\n\n${raw}`;
    }
    atomicWrite(filePath, updated);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  getPrimaryGlobalDir,
  getProjectSkillsDir,
  scanSkillsInDir,
  scanAllGlobalSkills,
  saveSkill,
  deleteSkill,
  parseSkillFile,
  updateSkillDescription,
  atomicWrite,
  ensureDir
};
