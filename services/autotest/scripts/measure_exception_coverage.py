"""对比异常覆盖：同一份知识库依据，旧口径（每功能点 1 条）vs 新口径（按失效模式）。"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from autotest.workflow import cases as case_service  # noqa: E402
from autotest.workflow import grounding  # noqa: E402

DB = Path(sys.argv[1])
PROJECT = sys.argv[2] if len(sys.argv) > 2 else "proj_15a2c362"
db_path = DB / "workspace" / PROJECT / "data.db"

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row

# 现有用例（旧口径结果）的分布
rows = conn.execute("SELECT title, case_type, evidence FROM test_cases").fetchall()
old_total = len(rows)
old_exc = [r for r in rows if r["case_type"] == "异常"]
print(f"旧库：用例 {old_total} 条，其中异常 {len(old_exc)} 条")

# 取功能点：从 workflow_steps 里最近一次 prd-parse 的 payload 读
run_rows = conn.execute(
    "SELECT payload_json FROM workflow_steps WHERE tool = 'autotest_prd_parse' ORDER BY rowid DESC LIMIT 1"
).fetchall()
function_points: list[dict] = []
for row in run_rows:
    try:
        payload = json.loads(row["payload_json"] or "{}")
    except ValueError:
        continue
    data = payload.get("data") or payload
    points = data.get("function_points") or []
    if points:
        function_points = points
        break
if not function_points:
    # 退一步：从现有用例标题反推功能点（去掉 "主流程" 后缀）
    names = sorted({r["title"][: -len("-主流程")] for r in rows if r["title"].endswith("-主流程")})
    function_points = [{"name": name} for name in names]
print(f"功能点：{len(function_points)} 个")

evidence = grounding.collect(conn, PROJECT, function_points)
reasons = grounding.diagnose(conn, PROJECT, function_points)
result = case_service.design_cases(
    {"function_points": function_points},
    types=["功能", "异常"],
    evidence=evidence,
    reasons=reasons,
)
stats = result["stats"]
print("\n新口径：")
print(f"  用例 {stats['total']} 条 | by_type={stats['by_type']}")
print(f"  grounding={stats['grounding']} | 跳过 {stats['skipped']} 条")
print(f"  异常失效模式分布：{stats['by_exception_class']}")
print(f"  覆盖到 {len(stats['by_exception_class'])} 类")
gaps = stats["exception_gaps"]
print(f"  有 {len(gaps)} 个功能点存在「资料没写到」的失效模式")
gap_counter: dict[str, int] = {}
for labels in gaps.values():
    for label in labels:
        gap_counter[label] = gap_counter.get(label, 0) + 1
print(f"  缺口类别频次：{dict(sorted(gap_counter.items(), key=lambda kv: -kv[1]))}")

print("\n抽样（前 3 条异常用例）：")
for case in [c for c in result["cases"] if c["case_type"] == "异常"][:3]:
    print(f"- {case['title']} [{case['priority']}] grounding={case['grounding']}")
    for step in case["steps"]:
        print(f"    步骤：{step}")
    for exp in case["expected"]:
        print(f"    预期：{exp}")
