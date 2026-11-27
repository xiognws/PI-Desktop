/**
 * The workbench's pipeline, in the order the platform runs it.
 *
 * The page groups its work into seven stages and the embedded menu listed twelve
 * views; the user reads the platform as those seven steps. The list lives here,
 * outside both consumers, because the surface's sidebar draws it and the
 * window's status bar reports which step the page is on — one list, so the two
 * cannot disagree about how many steps there are or what they are called.
 */
export const AUTOTEST_PIPELINE = [
  { step: "01", path: "requirements", name: "资料导入" },
  { step: "02", path: "knowledge", name: "需求解析" },
  { step: "03", path: "cases", name: "用例设计" },
  { step: "04", path: "approvals", name: "用例评审" },
  { step: "05", path: "scripts", name: "脚本生成" },
  { step: "06", path: "executions", name: "执行" },
  { step: "07", path: "reports", name: "报告" },
] as const;

export type AutotestPipelineStep = (typeof AUTOTEST_PIPELINE)[number];

/** The step a page route belongs to, or null when the route is not a step. */
export function autotestPipelineStep(view: string): AutotestPipelineStep | null {
  if (!view) return null;
  return AUTOTEST_PIPELINE.find((item) => item.path === view) ?? null;
}
