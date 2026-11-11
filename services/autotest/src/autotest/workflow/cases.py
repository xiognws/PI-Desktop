"""用例模板生成（确定性，不调模型）。

Agent 负责"这个功能点该测什么"的判断；这一层只把判断落成统一格式，
保证 200 条用例的 steps/expected 字段形状一致，脚本生成和报告统计不必
为每条用例做兼容分支。
"""

from __future__ import annotations

MAX_CASES = 200

SUPPORTED_TYPES = ("功能", "异常", "边界", "接口", "兼容")

_TEMPLATES: dict[str, dict[str, object]] = {
    "功能": {
        "suffix": "主流程",
        "steps": [
            "进入“{name}”入口，确认前置条件满足",
            "按需求描述执行“{name}”的正常操作",
            "检查页面/接口返回与状态变化",
        ],
        "expected": ["“{name}”按需求描述完成，结果与预期一致", "过程中无报错、无脏数据"],
    },
    "异常": {
        "suffix": "异常输入",
        "steps": [
            "进入“{name}”入口",
            "输入非法、缺省或超长的参数执行“{name}”",
            "观察系统提示与后续状态",
        ],
        "expected": ["给出明确可读的错误提示", "系统不崩溃、不写入脏数据，可继续操作"],
    },
    "边界": {
        "suffix": "边界值",
        "steps": [
            "准备“{name}”的边界数据（空、最小值、最大值、超长）",
            "逐项执行“{name}”并记录实际结果",
            "比较实际结果与边界定义",
        ],
        "expected": ["边界值按定义被接受或拒绝", "无越界、截断或静默失败"],
    },
    "接口": {
        "suffix": "接口契约",
        "steps": [
            "构造“{name}”的合法请求",
            "校验返回码、字段与业务码",
            "构造非法请求，验证参数校验与鉴权",
        ],
        "expected": ["合法请求的响应与接口契约一致", "非法请求被拒绝且不泄露内部信息"],
    },
    "兼容": {
        "suffix": "兼容性",
        "steps": [
            "在目标机型/版本上进入“{name}”",
            "执行主流程操作",
            "检查布局、交互与性能表现",
        ],
        "expected": ["功能可用，布局无遮挡、无错位", "交互响应在可接受范围内"],
    },
}


def _normalize_types(types: list[str] | None) -> list[str]:
    wanted = [item for item in (types or []) if item in _TEMPLATES]
    return wanted or ["功能", "异常"]


def design_cases(prd_result: dict, types: list[str] | None = None, template: str = "standard") -> dict:
    """按功能点 × 测试类型生成用例。

    `template` 目前只接受 "standard"；保留参数是为了后续加"精简/详细"两档时
    不动调用方签名。
    """
    function_points = prd_result.get("function_points") or []
    chosen_types = _normalize_types(types)

    cases: list[dict] = []
    for point in function_points:
        name = str(point.get("name") or "").strip()
        if not name:
            continue
        priority = str(point.get("priority") or "中")
        for case_type in chosen_types:
            if len(cases) >= MAX_CASES:
                break
            spec = _TEMPLATES[case_type]
            cases.append(
                {
                    "title": f"{name}-{spec['suffix']}",
                    "function_point": name,
                    "case_type": case_type,
                    "priority": priority,
                    "precondition": f"“{name}”对应功能已可用，测试环境就绪",
                    "steps": [str(step).format(name=name) for step in spec["steps"]],
                    "expected": [str(item).format(name=name) for item in spec["expected"]],
                }
            )
        if len(cases) >= MAX_CASES:
            break

    by_type: dict[str, int] = {}
    for case in cases:
        by_type[case["case_type"]] = by_type.get(case["case_type"], 0) + 1

    return {
        "cases": cases,
        "stats": {
            "total": len(cases),
            "by_type": by_type,
            "function_points": len(function_points),
            "types": chosen_types,
            "template": template,
        },
    }
