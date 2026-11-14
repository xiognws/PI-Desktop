"""被测件接口契约：让"补断言"从手工活变成可重复的生成动作。

骨架脚本之所以一直是骨架，是因为流水线不知道**被测件怎么驱动、从哪里读判定**。
契约把这件事一次说清（每个功能点一条），之后 `assertion_gen` 才能按条款里的数值
生成真断言，而不是靠人逐条改写。

契约存在项目库里（``dut_contracts`` 表，一条 JSON），随项目数据走，不进仓库：
不同项目的被测件不一样，契约必须跟着项目。
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field

# 一个功能点能被怎么驱动、判定从哪里读
ENTRY_KEYS = ("function_point", "factory", "arrange", "observe", "expect")

# 期望值的形态：布尔判定 / 数值判定 / 包含判定 / 应被拒绝
EXPECT_KINDS = ("bool", "number", "contains", "raises")


class ContractError(ValueError):
    """契约不合法。宁可拒绝生成，也不要产出一批假断言。"""


@dataclass
class Entry:
    function_point: str
    factory: str
    arrange: list[str]
    observe: str
    expect: dict
    tolerance: float = 0.0

    @property
    def kind(self) -> str:
        return str(self.expect.get("kind") or "")

    @property
    def value(self) -> object:
        return self.expect.get("value")


@dataclass
class Contract:
    driver: str = ""
    imports: list[str] = field(default_factory=list)
    entries: dict[str, Entry] = field(default_factory=dict)

    def get(self, function_point: str) -> Entry | None:
        return self.entries.get(function_point)

    def missing(self, function_points: list[str]) -> list[str]:
        return [name for name in function_points if name not in self.entries]


def ensure_contract_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS dut_contracts (
            project_id TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )


def _validate_entry(raw: object, index: int) -> Entry:
    if not isinstance(raw, dict):
        raise ContractError(f"entries[{index}] 必须是对象")
    missing = [key for key in ENTRY_KEYS if not raw.get(key)]
    if missing:
        raise ContractError(f"entries[{index}] 缺少字段：{', '.join(missing)}")
    arrange = raw["arrange"]
    if not isinstance(arrange, list) or not all(isinstance(line, str) for line in arrange):
        raise ContractError(f"entries[{index}].arrange 必须是字符串列表（每行一条驱动调用）")
    expect = raw["expect"]
    if not isinstance(expect, dict) or expect.get("kind") not in EXPECT_KINDS:
        raise ContractError(
            f"entries[{index}].expect.kind 只能取 {'/'.join(EXPECT_KINDS)}"
        )
    tolerance = raw.get("tolerance") or 0
    if not isinstance(tolerance, (int, float)) or tolerance < 0:
        raise ContractError(f"entries[{index}].tolerance 必须是非负数")
    return Entry(
        function_point=str(raw["function_point"]),
        factory=str(raw["factory"]),
        arrange=[str(line) for line in arrange],
        observe=str(raw["observe"]),
        expect=dict(expect),
        tolerance=float(tolerance),
    )


def parse(payload: dict | None) -> Contract:
    """校验并解析契约；错误信息要能直接告诉人"哪一条写得不对"。"""
    if payload is None:
        return Contract()
    if not isinstance(payload, dict):
        raise ContractError("契约必须是对象")
    raw_entries = payload.get("entries") or []
    if not isinstance(raw_entries, list):
        raise ContractError("entries 必须是列表")
    entries: dict[str, Entry] = {}
    for index, raw in enumerate(raw_entries):
        entry = _validate_entry(raw, index)
        if entry.function_point in entries:
            raise ContractError(f"功能点「{entry.function_point}」在契约里重复")
        entries[entry.function_point] = entry
    imports = payload.get("imports") or []
    if not isinstance(imports, list):
        raise ContractError("imports 必须是列表")
    return Contract(
        driver=str(payload.get("driver") or ""),
        imports=[str(name) for name in imports],
        entries=entries,
    )


def load(conn: sqlite3.Connection, project_id: str) -> Contract:
    ensure_contract_table(conn)
    row = conn.execute(
        "SELECT payload FROM dut_contracts WHERE project_id = ?", (project_id,)
    ).fetchone()
    if row is None:
        return Contract()
    try:
        payload = json.loads(row["payload"] if hasattr(row, "keys") else row[0])
    except (TypeError, ValueError) as problem:
        raise ContractError(f"项目里存的契约不是合法 JSON：{problem}") from problem
    return parse(payload)


def save(conn: sqlite3.Connection, project_id: str, payload: dict) -> Contract:
    contract = parse(payload)  # 先校验，坏契约不入库
    ensure_contract_table(conn)
    conn.execute(
        "INSERT INTO dut_contracts (project_id, payload, updated_at)"
        " VALUES (?, ?, CURRENT_TIMESTAMP)"
        " ON CONFLICT(project_id) DO UPDATE SET payload = excluded.payload,"
        " updated_at = CURRENT_TIMESTAMP",
        (project_id, json.dumps(payload, ensure_ascii=False)),
    )
    return contract
