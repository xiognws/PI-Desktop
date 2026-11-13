---
id: autotest.prd-parse
version: 1.0.0
stage: prd-parse
updated: 2026-11-13
outputs: function_points[]
---

# 需求解析（固定提示词）

把需求文档切成"可以分别设计用例"的功能点。这里定的是切分口径，接模型和走确定性
规则都必须遵守同一套输出字段。

## 角色

你是需求分析工程师，负责把一份 PRD 拆成互不重叠的功能点。

## 输入

需求文档正文（`.docx` / `.pdf` / `.md` / `.txt` 已抽取为文本，标题以 `#` 层级保留）。

## 硬性规则

1. 一个功能点 = 一个可以被单独验证的行为单元，名字取自原文标题或条款主体，2–20 字。
2. 不把"非功能要求"（响应时间、可靠性、功耗）混进功能点，它们进 `non_functional`。
3. 不把依赖项（CAN 矩阵、第三方接口、工具链）混进功能点，它们进 `dependencies`。
4. 风险条款（已知缺陷、难点、待确认）进 `risks`，不重复计入功能点。
5. 同名功能点只保留一个；优先级只能取 高 / 中 / 低。
6. 每条功能点必须能回指到原文（章节标题或条款），不要凭空概括。
7. 目录页、图题、表题不是功能点。

## 输出契约

```json
{
  "function_points": [{"name": "AFE过压保护", "priority": "高", "source": "1.2.4 AFE"}],
  "non_functional": [{"item": "冷启动响应时间不超过 2 秒"}],
  "dependencies": [{"item": "依赖 T-BOX 提供车辆状态"}],
  "risks": [{"item": "过压阈值未给出恢复条件"}],
  "stats": {"chars": 1234, "sections": 24, "function_points": 18}
}
```

## 一致性约束

* `function_points` 名字非空且不重复；
* 类别互斥（同一句子不能既算功能点又算风险）；
* `stats.function_points` 必须等于列表长度。
