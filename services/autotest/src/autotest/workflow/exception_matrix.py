"""异常场景矩阵：把"异常"从一条通用模板，扩成按依据可判定的若干类。

以前每个功能点只生成一条"异常输入"用例，步骤是"构造违反该约束的输入"，
预期是"被拦截或给出提示"——既没有具体输入值，也没有可观测结果，脚本只能写成
骨架。异常场景真正要覆盖的是**失效模式**：越界、边界、非法枚举、通信超时、
电气故障、上下电、并发重入、持久化失败。

这里的每一类都要求"依据能支撑到哪一步":
* 有原文数值 → 越界/边界可以写出具体值；
* 原文提到通信/报文 → 可以写停发/超时；
* 原文提到保护/阈值/采样 → 可以写电气故障注入；
* 依据支撑不了的类，不编造，记进 `gaps` 让界面提示"这块缺资料"。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True)
class ExceptionClass:
    """一类异常场景。`keywords` 命中功能点名称或条款原文才算"有依据可写"。"""

    id: str
    label: str
    keywords: tuple[str, ...]
    needs_numbers: bool = False


# 顺序即生成优先级：安全/数值类优先，恢复类靠后。
CLASSES: tuple[ExceptionClass, ...] = (
    ExceptionClass("out_of_range", "越界值", ("阈值", "范围", "限值", "最大值", "最小值", "上限", "下限"), needs_numbers=True),
    ExceptionClass("boundary", "边界值", ("阈值", "范围", "限值", "上限", "下限", "临界"), needs_numbers=True),
    ExceptionClass("illegal_value", "非法枚举", ("状态", "模式", "档位", "枚举", "命令", "指令", "模式切换")),
    ExceptionClass("comm_timeout", "通信超时", ("报文", "信号", "通信", "CAN", "LIN", "以太网", "总线", "周期")),
    ExceptionClass("electrical", "电气故障", ("采样", "电压", "电流", "开路", "短路", "传感器", "保护")),
    ExceptionClass("power_cycle", "上下电", ("上电", "下电", "掉电", "休眠", "唤醒", "复位", "初始化")),
    ExceptionClass("concurrency", "并发重入", ("重复", "并发", "多次", "并行", "触发", "请求")),
    ExceptionClass("persistence", "持久化", ("存储", "记录", "写入", "掉数据", "NVM", "Flash", "快照")),
)

# 命中这些词说明失效后果涉及安全/硬件，优先级要抬到"高"。
SAFETY_KEYWORDS = ("保护", "过压", "过流", "短路", "急停", "互锁", "失效", "安全", "烧", "熔断")

DEFAULT_EXCEPTION_BUDGET = 3


def _format(value: float, unit: str) -> str:
    shown = int(value) if float(value).is_integer() else round(float(value), 2)
    return f"{shown}{unit}"


def _numbers(evidence: list[dict]) -> list[tuple[float, str]]:
    out: list[tuple[float, str]] = []
    for item in evidence:
        for entry in item.get("numbers") or []:
            value = entry.get("value")
            if isinstance(value, (int, float)):
                out.append((float(value), str(entry.get("unit") or "")))
    return out


def _text(name: str, evidence: list[dict]) -> str:
    parts = [name]
    for item in evidence:
        parts.append(str(item.get("quote") or ""))
    return " ".join(parts)


def applicable(
    name: str,
    evidence: list[dict],
    budget: int = DEFAULT_EXCEPTION_BUDGET,
) -> tuple[list[str], list[str]]:
    """返回 (能写的异常类 id 列表, 依据不足而跳过的类 id 列表)。

    只按依据判断"能不能写"，不看数量；条数裁剪交给 `budget`。
    """
    text = _text(name, evidence)
    has_numbers = bool(_numbers(evidence))
    usable: list[str] = []
    gaps: list[str] = []
    for spec in CLASSES:
        # 数值类（越界/边界）只要有原文数值就能写，不必命中关键词；
        # 其余类必须条款里提到对应场景，否则就是在编造失效模式。
        if spec.needs_numbers:
            ok = has_numbers
        else:
            ok = any(word in text for word in spec.keywords)
        if ok:
            usable.append(spec.id)
        else:
            gaps.append(spec.id)
    # 超出预算的类没有生成，但依据是够的，不算缺口
    return usable[:budget], gaps


def priority_for(name: str, evidence: list[dict], fallback: str = "中") -> str:
    text = _text(name, evidence)
    if any(word in text for word in SAFETY_KEYWORDS):
        return "高"
    return fallback


def _basis(evidence: list[dict], name: str) -> str:
    primary = evidence[0] if evidence else {}
    doc = str(primary.get("doc") or "项目资料")
    quote = str(primary.get("quote") or "").strip() or f"《{doc}》中关于“{name}”的条款"
    return f"《{doc}》：{quote}"


def build(class_id: str, name: str, evidence: list[dict]) -> dict:
    """按异常类写具体步骤与可判定的预期。数值取自原文，绝不编造阈值。"""
    basis = _basis(evidence, name)
    nums = _numbers(evidence)
    first_value, first_unit = nums[0] if nums else (None, "")
    shown = "、".join(_format(v, u) for v, u in nums[:3])

    if class_id == "out_of_range" and first_value is not None:
        step = max(abs(first_value) * 0.1, 1.0)
        over = _format(first_value + step, first_unit)
        under = _format(max(first_value - step, 0.0), first_unit)
        return {
            "precondition": basis,
            "steps": [
                f"按{basis}把“{name}”的输入置为原文阈值 {_format(first_value, first_unit)}，确认基线正常",
                f"将输入改为越界值 {over} 与 {under}，各执行一次“{name}”",
                "记录两次的拒绝/保护动作、提示信息与恢复条件",
            ],
            "expected": [
                f"越界值 {over} / {under} 被拒绝或触发保护，不写入脏数据（原文阈值 {_format(first_value, first_unit)}）",
                f"退出越界输入后“{name}”恢复正常，状态与保护前一致",
            ],
        }

    if class_id == "boundary" and first_value is not None:
        near = max(abs(first_value) * 0.01, 0.01)
        return {
            "precondition": basis,
            "steps": [
                f"按{basis}把“{name}”的输入依次置为 {_format(first_value - near, first_unit)}、{_format(first_value, first_unit)}、{_format(first_value + near, first_unit)}",
                "每次保持输入稳定一个采样周期，记录判定结果与状态字",
                "比较三者的接受/拒绝边界是否与原文一致",
            ],
            "expected": [
                f"等于原文阈值 {_format(first_value, first_unit)} 时行为与条款一致，越过阈值即切换",
                "边界两侧无抖动、无重复触发",
            ],
        }

    if class_id == "illegal_value":
        return {
            "precondition": basis,
            "steps": [
                f"按{basis}确认“{name}”合法的状态/枚举取值",
                f"注入一个未定义取值（越界枚举或未实现的模式/档位）执行“{name}”",
                "检查系统是否停留在原状态，并记录上报的错误/DTC",
            ],
            "expected": [
                "未定义取值被拒绝，系统保持在上一个合法状态，不进入未定义态",
                "给出明确错误上报（错误码或 DTC），恢复合法取值后功能可继续",
            ],
        }

    if class_id == "comm_timeout":
        return {
            "precondition": basis,
            "steps": [
                f"按{basis}让“{name}”在正常通信下运行并确认报文/信号周期性到达",
                "停止发送该报文/信号（或注入超时），保持到超时阈值以上",
                "恢复通信，观察退出超时状态的条件",
            ],
            "expected": [
                "超时被检出并按条款进入降级/保护，相关信号标记为失效",
                "通信恢复后自动退出超时状态，无需重启",
            ],
        }

    if class_id == "electrical":
        return {
            "precondition": basis,
            "steps": [
                f"按{basis}让“{name}”在正常采样值下运行并记录基线",
                "注入开路（断线）与短路（对地/对电源），各保持一个采样周期",
                "恢复接线，检查故障记录与恢复条件",
            ],
            "expected": [
                "开路/短路被检出，触发条款描述的保护动作，不产生误动作",
                "恢复后故障消失，DTC/故障记录与恢复条件符合条款",
            ],
        }

    if class_id == "power_cycle":
        return {
            "precondition": basis,
            "steps": [
                f"按{basis}让“{name}”进入工作状态并记录关键状态量",
                "运行中断电再上电（分别做正常下电与硬掉电）",
                "上电后读取状态、配置与故障记录",
            ],
            "expected": [
                f"上电后“{name}”重新初始化完成，配置与掉电前一致",
                "无脏数据、无卡死；掉电期间的不完整操作有明确处理结果",
            ],
        }

    if class_id == "concurrency":
        return {
            "precondition": basis,
            "steps": [
                f"按{basis}准备“{name}”的两个可同时发起的操作",
                "连续快速触发两次（以及并发触发），观察执行顺序",
                "读取最终状态与计数，确认没有重复执行",
            ],
            "expected": [
                "重复/并发触发的请求被串行化或去重，不出现重复执行",
                "最终状态与单次执行一致，计数无漂移",
            ],
        }

    if class_id == "persistence":
        return {
            "precondition": basis,
            "steps": [
                f"按{basis}让“{name}”写入一条记录/配置",
                "在写入过程中断电，或把存储写满后再触发写入",
                "重启并读取已存在的数据",
            ],
            "expected": [
                "已存在的数据不被破坏，写入失败有明确返回",
                "重启后能从最后一条完整记录恢复，不需要人工清理",
            ],
        }

    raise ValueError(f"未知异常类：{class_id}")


def label_of(class_id: str) -> str:
    for spec in CLASSES:
        if spec.id == class_id:
            return spec.label
    return class_id


def gap_labels(class_ids: list[str]) -> list[str]:
    return [label_of(item) for item in class_ids]
