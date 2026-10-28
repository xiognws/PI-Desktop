"""Make the tests import *this* checkout of ``autotest``.

The development machine has an editable install of an older checkout on the
path, and whichever copy is imported first stays in ``sys.modules``. That
silently ran the tests against the wrong source once; rather than depend on the
shell, drop any preloaded ``autotest`` modules and put this platform's ``src``
first.
"""

from __future__ import annotations

import sys
from pathlib import Path

PLATFORM_ROOT = Path(__file__).resolve().parent.parent
SRC = PLATFORM_ROOT / "src"

if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

for name in [key for key in sys.modules if key == "autotest" or key.startswith("autotest.")]:
    del sys.modules[name]

import autotest  # noqa: E402

loaded = Path(autotest.__file__).resolve()
if SRC not in loaded.parents and loaded.parent != SRC:
    raise RuntimeError(
        f"tests loaded autotest from {loaded}, expected a module under {SRC}; "
        "remove the conflicting editable install or set PYTHONPATH"
    )
