"""用例生成（确定性，不调模型）。

Agent 负责"这个功能点该测什么"的判断；这一层把判断落成统一格式，保证 steps /
expected 字段形状一致，脚本生成和报告统计不必为每条用例做兼容分支。

有知识库依据时，步骤与预期会写具体的条款原文和数值（"单体电压置 3.70 V，超过原文
3.65 V 阈值"），而不是"执行正常操作"这种空话；没有依据时退回模板，并把用例标记为
ungrounded —— 让界面上能看出哪些用例还没底。
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


def _format_number(item: dict) -> str:
    value = item.get("value")
    unit = item.get("unit") or ""
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return f"{value}{unit}"


def _over_value(item: dict) -> str | None:
    """按原文阈值造一个"越界值"：超 10%，太小的量级至少加 1。"""
    value = item.get("value")
    unit = item.get("unit") or ""
    if not isinstance(value, (int, float)):
        return None
    step = max(abs(float(value)) * 0.1, 1.0)
    over = round(float(value) + step, 2)
    if float(over).is_integer():
        over = int(over)
    return f"{over}{unit}"


def _under_value(item: dict) -> str | None:
    value = item.get("value")
    unit = item.get("unit") or ""
    if not isinstance(value, (int, float)):
        return None
    step = max(abs(float(value)) * 0.1, 1.0)
    under = round(max(float(value) - step, 0.0), 2)
    if float(under).is_integer():
        under = int(under)
    return f"{under}{unit}"


def _grounded_case(
    name: str,
    case_type: str,
    evidence: list[dict],
) -> dict | None:
    """依据齐全时，按原文条款写具体步骤；依据不够就返回 None 交给模板。"""
    primary = evidence[0] if evidence else None
    numbers = [item for item in ((primary or {}).get("numbers") or []) if item.get("value") is not None]
    if primary is None or not numbers:
        return None

    doc = str(primary.get("doc") or "项目资料")
    quote = str(primary.get("quote") or "").strip()
    first = numbers[0]
    shown = "、".join(_format_number(item) for item in numbers[:3])

    if case_type == "功能":
        steps = [
            f"按《{doc}》要求准备环境：{quote}",
            f"把“{name}”的输入置为原文范围内的正常值（原文参数：{shown}）",
            f"读取“{name}”的输出与状态，逐项对照原文判定",
        ]
        expected = [f"结果符合《{doc}》：{quote}", "过程无报错、无脏数据"]
    elif case_type == "异常":
        over = _over_value(first)
        under = _under_value(first)
        abnormal = " / ".join(item for item in (over, under) if item)
        steps = [
            f"按《{doc}》确认“{name}”的阈值：{_format_number(first)}",
            f"输入越界值 {abnormal}（超出原文阈值 {_format_number(first)}）执行“{name}”",
            "观察系统提示、保护动作与后续状态",
        ]
        expected = [
            f"越界输入被拒绝或触发保护（原文阈值 {_format_number(first)}）",
            "不写入脏数据，系统可继续操作",
        ]
    elif case_type == "边界":
        normal = _format_number(first)
        steps = [
            f"按《{doc}》取“{name}”的边界点：{normal}",
            f"分别在 {normal}、略低于与略高于 {normal} 三个点执行“{name}”",
            "记录每个点的实际结果与系统提示",
        ]
        expected = [
            f"边界 {normal} 处行为与原文一致",
            "越界侧的输入被拒绝，另一侧正常执行",
        ]
    elif case_type == "接口":
        steps = [
            f"按《{doc}》构造“{name}”的合法请求（原文参数：{shown}）",
            "校验返回码、字段与业务码",
            "构造越界与缺省参数的请求，验证校验逻辑",
        ]
        expected = ["合法请求响应与原文约定一致", "非法请求被拒绝且不泄露内部信息"]
    else:  # 兼容
        steps = [
            f"在目标机型/版本上按《{doc}》配置“{name}”（原文参数：{shown}）",
            "执行主流程操作",
            "检查布局、交互与响应时间",
        ]
        expected = ["功能可用，布局无遮挡", "交互响应在可接受范围内"]

    return {
        "precondition": f"《{doc}》：{quote}",
        "steps": steps,
        "expected": expected,
    }


def _reason_counts(
    uncovered: dict[str, dict], reasons: dict[str, str] | None = None
) -> dict[str, int]:
    """按"为什么没依据"分组计数（按被跳过的用例条数），界面据此提示该补什么。"""
    counts: dict[str, int] = {}
    for name, entry in uncovered.items():
        key = str(entry.get("reason") or (reasons or {}).get(name) or "no_clause")
        counts[key] = counts.get(key, 0) + len(entry.get("case_types") or ["功能"])
    return counts


def design_cases(
    prd_result: dict,
    types: list[str] | None = None,
    template: str = "standard",
    evidence: dict[str, list[dict]] | None = None,
    reasons: dict[str, str] | None = None,
    skip_ungrounded: bool = True,
) -> dict:
    """按功能点 × 测试类型生成用例。

    `evidence`：功能点名 → 依据列表（来自 grounding.collect）。给了且含数值时写
    具体步骤，否则退回模板并把 grounding 标成 weak / none。
    `reasons`：功能点名 → 为什么没有依据（grounding.diagnose 的结论），
    会跟着用例落库，界面上能直接说"资料这一节没正文"而不是让人猜。
    `skip_ungrounded`：没有依据时**不生成**这条用例，只把它记进待补资料清单
    （默认如此）。生成一堆"进入 X 入口执行正常操作"的空壳，只会让用例库变成
    噪音，也让人误以为已经覆盖了这个功能点。
    `template` 目前只接受 "standard"；保留参数是为了后续加"精简/详细"两档时
    不动调用方签名。
    """
    function_points = prd_result.get("function_points") or []
    chosen_types = _normalize_types(types)
    grounded_map = evidence or {}
    reason_map = reasons or {}

    cases: list[dict] = []
    levels = {"strong": 0, "weak": 0, "none": 0}
    uncovered: dict[str, dict] = {}

    for point in function_points:
        name = str(point.get("name") or "").strip()
        if not name:
            continue
        priority = str(point.get("priority") or "中")
        point_evidence = grounded_map.get(name) or []
        for case_type in chosen_types:
            if len(cases) >= MAX_CASES:
                break
            spec = _TEMPLATES[case_type]
            grounded = _grounded_case(name, case_type, point_evidence)
            if grounded is not None:
                level = "strong"
                precondition = grounded["precondition"]
                steps = grounded["steps"]
                expected = grounded["expected"]
            else:
                level = "weak" if point_evidence else "none"
                if level == "none" and skip_ungrounded:
                    reason_key = reason_map.get(name) or "no_clause"
                    levels["none"] += 1
                    entry = uncovered.setdefault(
                        name,
                        {
                            "function_point": name,
                            "reason": reason_key,
                            "case_types": [],
                        },
                    )
                    entry["case_types"].append(case_type)
                    continue
                precondition = f"“{name}”对应功能已可用，测试环境就绪"
                steps = [str(step).format(name=name) for step in spec["steps"]]
                expected = [str(item).format(name=name) for item in spec["expected"]]
                if level == "weak":
                    # 有条款但没数值：把原文挂上，至少知道依据在哪
                    precondition = f"《{point_evidence[0].get('doc') or '项目资料'}》：{point_evidence[0].get('quote')}"

            levels[level] += 1
            reason = "ok" if level != "none" else (reason_map.get(name) or "no_clause")
            primary = point_evidence[0] if point_evidence else None
            cases.append(
                {
                    "title": f"{name}-{spec['suffix']}",
                    "function_point": name,
                    "case_type": case_type,
                    "priority": priority,
                    "precondition": precondition,
                    "steps": steps,
                    "expected": expected,
                    "grounding": level,
                    "basis_reason": reason,
                    "evidence": (
                        {
                            "doc": primary.get("doc"),
                            "quote": primary.get("quote"),
                            "numbers": [_format_number(item) for item in (primary.get("numbers") or [])],
                        }
                        if primary
                        else None
                    ),
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
            "grounding": levels,
            "reasons": _reason_counts(uncovered, reasons=reason_map),
            "skipped": sum(len(item["case_types"]) for item in uncovered.values()),
            "uncovered": list(uncovered.values()),
            "generate_all": not skip_ungrounded,
        },
    }
