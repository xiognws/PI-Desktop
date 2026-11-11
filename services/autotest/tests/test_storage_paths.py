"""平台库位置：显式 env 优先，缺失时退回 cwd 下的 data/。

回归来源：`DEFAULT_DB` 原来是相对路径，宿主以服务目录为 cwd 拉起服务时，
安装包里会把库写进 resources 目录。宿主现在固定传 `AUTOTEST_PLATFORM_DB`，
这里的默认值只服务手工起服务与测试。
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT / "src") not in sys.path:
    sys.path.insert(0, str(ROOT / "src"))

from autotest.storage.sqlite import resolve_default_db  # noqa: E402


def test_explicit_env_wins_and_is_stripped():
    assert resolve_default_db({"AUTOTEST_PLATFORM_DB": "  /data/platform.db  "}) == Path(
        "/data/platform.db"
    )


def test_missing_env_falls_back_to_cwd_data_dir():
    assert resolve_default_db({}) == Path("data") / "autotest.db"


def test_blank_env_is_treated_as_missing():
    assert resolve_default_db({"AUTOTEST_PLATFORM_DB": "   "}) == Path("data") / "autotest.db"
