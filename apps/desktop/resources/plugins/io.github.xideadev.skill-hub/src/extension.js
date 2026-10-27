"use strict";

const fs = require("node:fs");
const path = require("node:path");
const store = require("./skill-store.js");

const CONFIG_PATH = path.join(__dirname, "..", "data", "config.json");

function readConfigSafe() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    }
  } catch {}
  return { enabledSkills: {}, directInjections: {}, projectBindings: {}, sessionBindings: {} };
}

/**
 * Sidecar Agent Extension
 * 核心职责：拦截 before_agent_start 实现精准技能索引与常驻注入
 */
function skillHubExtension(pi) {
  pi.on("before_agent_start", (payload, ctx) => {
    try {
      const cfg = readConfigSafe();
      const workspace = (ctx && ctx.cwd) || process.cwd();
      const sessionId = (ctx && ctx.sessionId) || "default";

      const globalSkills = store.scanAllGlobalSkills();
      const projectSkills = store.scanSkillsInDir(store.getProjectSkillsDir(workspace), "project");
      const allSkills = [...globalSkills, ...projectSkills];

      // 根据会话绑定、项目绑定与全局开关过滤激活的技能
      const activeSkills = allSkills.filter(s => {
        if (cfg.sessionBindings[sessionId] && cfg.sessionBindings[sessionId].includes(s.id)) return true;
        if (cfg.projectBindings[workspace] && cfg.projectBindings[workspace].includes(s.id)) return true;
        return cfg.enabledSkills[s.id] !== false;
      });

      if (!activeSkills.length) return undefined;

      const directInjections = [];
      const indexList = [];

      for (const skill of activeSkills) {
        if (cfg.directInjections[skill.id]) {
          directInjections.push(`\n\n--- [Skill: ${skill.name}] ---\n${skill.content}\n`);
        } else {
          indexList.push(`- \`${skill.name}\` — ${skill.desc}`);
        }
      }

      let extraPrompt = "";
      if (indexList.length > 0) {
        extraPrompt += `\n\n# Available Skills (Skill Hub)\nCall \`Skill\` with exact id to load when matching the scenario:\n${indexList.join("\n")}\n`;
      }
      if (directInjections.length > 0) {
        extraPrompt += `\n\n# Active Mandatory Skills\n${directInjections.join("\n")}\n`;
      }

      if (!extraPrompt) return undefined;

      let currentPrompt = "";
      if (typeof payload?.systemPrompt === "string") {
        currentPrompt = payload.systemPrompt;
      } else if (payload?.systemPrompt?.content) {
        currentPrompt = typeof payload.systemPrompt.content === "string" 
          ? payload.systemPrompt.content 
          : JSON.stringify(payload.systemPrompt.content);
      }

      if (currentPrompt && currentPrompt.includes("# Available Skills (Skill Hub)")) {
        return undefined;
      }

      return {
        systemPrompt: currentPrompt ? `${currentPrompt}\n${extraPrompt}` : extraPrompt
      };
    } catch {
      return undefined;
    }
  });
}

module.exports = skillHubExtension;
module.exports.default = skillHubExtension;
