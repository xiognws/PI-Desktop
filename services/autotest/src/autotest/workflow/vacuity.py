"""变异抽查：确认生成的断言"能失败"。

一条断言只要不能失败，就等于没写 —— 它会让报告变绿，却不阻挡任何缺陷。
做法：把每条生成断言的**期望写反**，再跑一遍。真在验的断言此时必然失败；
变异体却通过，说明这条断言是恒真的空壳，打回。

实现上把变异体都写进项目 scripts 目录（相对路径的 `_support` 才对得上），
一次 pytest 跑完，跑完即删，不留在项目里。
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from autotest.workflow import assertion_gen, scripts as script_service
from autotest.workflow.dut_contract import Contract

MUTANT_PREFIX = "_mutant_"


def _mutant_name(script_name: str) -> str:
    return f"{MUTANT_PREFIX}{script_name}"


def check(
    scripts_dir: Path,
    cases: list[dict],
    contract: Contract,
    *,
    sdk: str = "pytest",
    runner=subprocess.run,
    timeout_s: float = 240.0,
) -> dict:
    """返回 `{checked, vacuous[], skipped[], errors[]}`。

    `vacuous` 是"期望写反了还能通过"的用例标题 —— 这些断言必须修，不能进交付。
    """
    scripts_dir = Path(scripts_dir)
    mutants: dict[Path, str] = {}
    skipped: list[dict] = []

    for case in cases:
        title = str(case.get("title") or "")
        entry = contract.get(str(case.get("function_point") or ""))
        if entry is None:
            skipped.append({"title": title, "reason": "missing_contract"})
            continue
        try:
            mutant_body = assertion_gen.invert(
                case, entry, driver=contract.driver, imports=contract.imports
            )
        except assertion_gen.GenerationError as problem:
            skipped.append({"title": title, "reason": str(problem)})
            continue
        script = script_service.author_script(case, sdk, mutant_body)
        path = scripts_dir / _mutant_name(str(script["name"]))
        path.write_text(script["content"], encoding="utf-8")
        mutants[path] = title

    if not mutants:
        return {"checked": 0, "vacuous": [], "skipped": skipped, "errors": []}

    try:
        result = runner(
            [
                sys.executable,
                "-m",
                "pytest",
                *[str(path) for path in mutants],
                "-q",
                "--no-header",
                "-p",
                "no:cacheprovider",
                "--tb=no",
                "-rA",
            ],
            cwd=str(scripts_dir),
            capture_output=True,
            text=True,
            timeout=timeout_s,
        )
        output = f"{result.stdout}\n{result.stderr}"
    finally:
        for path in mutants:
            path.unlink(missing_ok=True)

    vacuous: list[str] = []
    errors: list[str] = []
    for path, title in mutants.items():
        passed = f"PASSED {path.name}" in output
        failed = f"FAILED {path.name}" in output
        if passed:
            # 期望写反还能过 —— 这条断言没有判定力
            vacuous.append(title)
        elif not failed:
            errors.append(title)

    return {
        "checked": len(mutants),
        "vacuous": vacuous,
        "skipped": skipped,
        "errors": errors,
    }
