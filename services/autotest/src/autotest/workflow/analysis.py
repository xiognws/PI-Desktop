"""日志与链路分析（确定性，不调模型）。

Agent 只负责"要不要分析、分析结论怎么用"；这一层把原始日志压成固定形状：
摘要、时间线、可疑栈帧、按错误类别给出的排查建议。20MB 级别的日志先截尾，
保证响应体不会被日志体积拖垮，也保证同样的输入永远得到同样的输出。
"""

from __future__ import annotations

import re

# 只保留末尾这么多字符：失败现场在尾部，前面几十兆的噪声对结论没有帮助。
MAX_LOG_CHARS = 400_000
MAX_TIMELINE = 40
MAX_SUSPECTS = 10
MAX_SUGGESTIONS = 5
MAX_LINE_CHARS = 500

_TIMESTAMP = re.compile(r"\b(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{3})?|\d{2}:\d{2}:\d{2}(?:[.,]\d{3})?)\b")
_FRAME = re.compile(r'File "([^"]+)", line (\d+)(?:, in (\S+))?')
_ERROR = re.compile(
    r"\b(?:ERROR|FATAL|CRITICAL|FAILED|FAIL|AssertionError|TimeoutError|ConnectionError|"
    r"KeyError|ValueError|TypeError|ImportError|ModuleNotFoundError|PermissionError|"
    r"OSError|RuntimeError|Exception)\b"
)
_EXCEPTION_ANY = re.compile(r"\b([A-Za-z_][\w.]*(?:Error|Exception|Failure))\b")

_HINTS: tuple[tuple[str, str, str], ...] = (
    ("AssertionError", "断言与实际结果不一致", "对照用例 expected 与实际返回值，确认是需求变了还是实现错了"),
    ("ModuleNotFoundError", "运行环境缺少依赖", "确认脚本依赖是否已装进执行环境的 PYTHONPATH"),
    ("ImportError", "模块导入失败", "检查导入路径与被测包是否在同一解释器环境"),
    ("TimeoutError", "等待超时", "确认超时阈值、下游服务健康状态与网络可达性"),
    ("ConnectionError", "连接失败", "确认目标地址、端口与鉴权配置"),
    ("ConnectionRefused", "目标端口无监听", "确认被测服务已启动且监听在预期地址"),
    ("PermissionError", "权限不足", "检查文件/端口/接口的权限与账号配置"),
    ("KeyError", "字段缺失", "对照接口契约，确认响应字段名与结构"),
    ("ValueError", "取值不合法", "检查输入数据构造与边界值"),
    ("TypeError", "类型不匹配", "检查入参类型与序列化/反序列化层"),
    ("RuntimeError", "运行时状态异常", "检查前置步骤是否成功、状态是否被提前释放"),
)


def _clip(text: str) -> str:
    return text if len(text) <= MAX_LINE_CHARS else text[:MAX_LINE_CHARS] + "…"


def _error_type(message: str) -> str:
    # 异常名可能出现在行中间（前面带时间戳/日志前缀），取最后一个出现的类型名。
    matches = _EXCEPTION_ANY.findall(message)
    return matches[-1] if matches else ""


def _suggestions(error_type: str, message: str) -> list[str]:
    picked: list[str] = []
    for key, reason, advice in _HINTS:
        if key in error_type or key in message:
            picked.append(f"{reason}：{advice}")
            if len(picked) >= MAX_SUGGESTIONS:
                break
    if not picked:
        picked.append("日志里没有可识别的异常类型：补充失败用例的执行命令与最小复现步骤，再做二次分析")
    return picked


def analyze_log(raw_log: str, trace_id: str = "", module: str = "") -> dict:
    """把原始日志压成摘要 / 时间线 / 可疑栈帧 / 排查建议。"""
    text = raw_log or ""
    truncated = len(text) > MAX_LOG_CHARS
    if truncated:
        text = text[-MAX_LOG_CHARS:]

    lines = [line.rstrip("\r") for line in text.split("\n")]
    timeline: list[dict[str, object]] = []
    suspects: list[dict[str, object]] = []
    error_lines: list[str] = []

    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        stamp = _TIMESTAMP.search(stripped)
        if stamp and len(timeline) < MAX_TIMELINE:
            timeline.append({"time": stamp.group(1), "line": _clip(stripped)})
        if _ERROR.search(stripped):
            error_lines.append(stripped)
        for match in _FRAME.finditer(line):
            if len(suspects) >= MAX_SUSPECTS:
                break
            suspect = {"file": match.group(1), "line": int(match.group(2))}
            function = match.group(3)
            if function:
                suspect["function"] = function
            suspects.append(suspect)

    last_error = error_lines[-1] if error_lines else ""
    error_type = _error_type(last_error)
    summary = _clip(last_error) if last_error else _clip(next((l for l in reversed(lines) if l.strip()), ""))

    return {
        "summary": summary or "日志为空",
        "error": {"type": error_type, "message": _clip(last_error)} if last_error else None,
        "timeline": timeline,
        "suspects": suspects,
        "suggestions": _suggestions(error_type, last_error),
        "stats": {
            "lines": len(lines),
            "truncated": truncated,
            "error_lines": len(error_lines),
            "trace_id": trace_id,
            "module": module,
        },
    }
