"""给功能点找「依据」：从项目知识库里检索原文条款（确定性 RAG，不调模型）。

用例之所以长得像模板（"进入 X 入口，执行正常操作"），是因为生成时手里只有功能点
的名字。项目知识库里其实躺着条款原文（"单体电压 > 3.65 V 时进入过压保护"），
这一层负责把它检索出来、摘出可用的句子与数值，交给用例生成去写具体的步骤与预期。

刻意不调模型：判断"该测什么"仍由 Agent 负责；这里只做可复现的检索与抽取，
所以同一份文档每次得到的依据完全一致，能被测试锁住。
"""

from __future__ import annotations

import re
import sqlite3

from autotest.knowledge import store as knowledge_store

MAX_EVIDENCE_PER_POINT = 3
MAX_QUOTE_CHARS = 220
MIN_TOKEN_CHARS = 2

# 带单位的数值：3.65V / 120A / 200ms / 12.9 V / 95%
# 两侧都要卡边界："Figure 4AFE均衡电路" 里的 "4A" 不是电流阈值，
# 不加边界就会把图号当成参数写进用例。
_NUMBER = re.compile(
    r"(?<![A-Za-z0-9._])(?P<value>\d+(?:\.\d+)?)\s*"
    r"(?P<unit>kV|mV|mA|kA|V|A|ms|us|ns|s|%|℃|度|Hz|kHz|MHz|bps|kbps|KB|MB|GB|bit|个|次|条|秒|毫秒|伏|安)"
    r"(?![A-Za-z])",
    re.IGNORECASE,
)

# 切句：中文句号/分号/换行，以及表格单元格分隔
_SENTENCE = re.compile(r"[^。；;\n|]+[。；;]?")

# 这些词太泛，出现在任何条款里都不算"这个功能点的依据"
_STOP_TOKENS = {
    "功能", "模块", "系统", "要求", "相关", "支持", "提供", "进行", "实现", "管理",
    "监控", "保护", "控制", "状态", "数据", "信息", "参数", "设计", "需求",
}


def _tokens(name: str) -> list[str]:
    """功能点名拆成可检索的词：整体 + 分隔片段 + 2 字滑窗。

    「电压监控」这种四字名，原文里常写成「单体电压大于 3.65V」——只有整体匹配就会
    漏掉真正带阈值的条款，所以补上 2 字滑窗（"电压"/"监控"）。
    """
    parts = [chunk for chunk in re.split(r"[\s、,，/（）()\[\]【】\-_]+", name) if chunk]
    tokens: list[str] = []
    if len(name) >= MIN_TOKEN_CHARS:
        tokens.append(name)
    for part in parts:
        if len(part) >= MIN_TOKEN_CHARS and part not in _STOP_TOKENS and part not in tokens:
            tokens.append(part)
        for index in range(len(part) - 1):
            window = part[index : index + 2]
            if window not in _STOP_TOKENS and window not in tokens:
                tokens.append(window)
    return tokens


def extract_numbers(text: str) -> list[dict]:
    """摘出文本里的带单位数值（去重，保持出现顺序）。"""
    seen: set[tuple[float, str]] = set()
    numbers: list[dict] = []
    for match in _NUMBER.finditer(text or ""):
        try:
            value = float(match.group("value"))
        except ValueError:
            continue
        unit = match.group("unit")
        key = (value, unit.lower())
        if key in seen:
            continue
        seen.add(key)
        numbers.append({"value": value, "unit": unit, "text": match.group(0).strip()})
    return numbers


def best_sentence(content: str, name: str) -> str:
    """从切片里挑一句最像"这个功能点的要求"的原文；挑不到返回空串。

    打分规则：含功能点名 +3，含带单位数值 +2，提到 应/必须/不得 等约束词 +1，
    过短的句子不给分（"见下表"这种没有信息量）。
    """
    tokens = _tokens(name)
    best = ""
    best_score = 0
    for match in _SENTENCE.finditer(content or ""):
        sentence = match.group(0).strip(" \t\r\n|")
        if len(sentence) < 8:
            continue
        score = 0
        if any(token in sentence for token in tokens):
            score += 2
        if extract_numbers(sentence):
            # 带阈值/参数的条款才是能写出具体用例的那种，权重给最高
            score += 3
        if any(word in sentence for word in ("应", "必须", "不得", "禁止", "要求", "大于", "小于", "超过")):
            score += 1
        # 排查经验、临时建议不是需求条款：拿它当依据会写出"确认供电是不是大于5.5V"
        # 这种调试步骤，而不是验收步骤。
        if any(word in sentence for word in ("排查", "确认下", "建议", "如果", "若是", "试试")):
            # 排查经验读起来像条款但会被写成调试步骤：整句压到阈值以下，
            # 宁可让这条用例退回模板（weak），也不要拿调试建议当验收依据。
            score -= 4
        if len(sentence) > 160:
            score -= 2
        # 图题/表题（"Figure 4 xxx"/"图 3 xxx"）是标签不是要求
        if sentence.strip().lower().startswith(("figure", "fig.", "table", "图", "表")):
            score -= 3
        if score > best_score:
            best, best_score = sentence, score
    if best_score < 3:
        return ""
    return best[:MAX_QUOTE_CHARS]


def _document_name(conn: sqlite3.Connection, record: dict) -> str:
    """切片的 title 通常只是块序号，真正的文档名要从 source_ref 反查。"""
    reference = str(record.get("source_ref") or "")
    if reference.startswith("doc:"):
        doc_id = reference[4:].split("#")[0]
        try:
            row = conn.execute(
                "SELECT filename FROM knowledge_docs WHERE id = ?", (doc_id,)
            ).fetchone()
        except sqlite3.Error:
            row = None
        if row is not None and row[0]:
            return str(row[0])
    return str(record.get("title") or reference or "项目资料")


def collect(
    conn: sqlite3.Connection,
    project_id: str,
    function_points: list[dict],
    *,
    limit: int = 8,
) -> dict[str, list[dict]]:
    """功能点名 → 依据列表（原始条款 + 数值）。检索不到就给空列表，不编造。"""
    evidence: dict[str, list[dict]] = {}
    for point in function_points:
        name = str(point.get("name") or "").strip()
        if not name:
            continue
        found: list[dict] = []
        seen_quotes: set[str] = set()
        records = knowledge_store.search_records(conn, project_id, query=name, limit=limit)
        if not records:
            # FTS 索引可能落后于 knowledge_records（手工入库、索引重建中），
            # 退到 LIKE 再找一遍：搜不到依据会让用例悄悄退回模板。
            from autotest.workflow import store as workflow_store

            records = workflow_store.search_knowledge(conn, project_id, name, "", "", limit)
        for record in records:
            body = str(record.get("content") or record.get("excerpt") or "")
            quote = best_sentence(body, name)
            if not quote or quote in seen_quotes:
                continue
            seen_quotes.add(quote)
            found.append(
                {
                    "doc": _document_name(conn, record),
                    "source_ref": str(record.get("source_ref") or ""),
                    "chunk_id": record.get("id"),
                    "quote": quote,
                    "numbers": extract_numbers(quote),
                }
            )
            if len(found) >= MAX_EVIDENCE_PER_POINT:
                break
        evidence[name] = found
    return evidence
