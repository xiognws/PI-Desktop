/**
 * 壳插件入口：本插件不持有后台服务，也没有面板。
 *
 * 能力来自 `contributes.agentExtensions`（src/tools.ts，跑在 Agent sidecar
 * 进程内），这个文件只是宿主要求的 `main` 入口，必须存在且能正常被 require。
 */
function onLoad() {}

function onUnload() {}

module.exports = { onLoad, onUnload };
