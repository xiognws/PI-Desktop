"""Make the extras folder behave like a site directory.

`python-extras/site-packages` is installed with ``pip --target`` and put on
``PYTHONPATH`` by ``python-runtime.ts``. A ``PYTHONPATH`` entry is not a *site*
directory, so two things Python normally does for a real site-packages never
happen here:

* ``.pth`` files are not processed. pywin32 keeps its modules in ``win32/``,
  ``win32/lib`` and ``Pythonwin`` and relies on ``win32.pth`` to put them on
  ``sys.path``; without this, ``import win32api`` fails although the files are
  next to it.
* ``os.add_dll_directory`` entries from those ``.pth`` files never run, so
  ``pywintypes312.dll`` in ``pywin32_system32`` cannot be found.

Everything stays inside this folder: nothing is copied into ``%WINDIR%`` and no
registry keys are written, so deleting the folder removes the whole stack.
"""

import os
import sys

_ROOT = os.path.dirname(os.path.abspath(__file__))

for _sub in ("win32", "win32/lib", "Pythonwin"):
    _path = os.path.join(_ROOT, _sub)
    if os.path.isdir(_path) and _path not in sys.path:
        sys.path.append(_path)

for _sub in ("pywin32_system32", "win32"):
    _path = os.path.join(_ROOT, _sub)
    if os.path.isdir(_path) and hasattr(os, "add_dll_directory"):
        try:
            os.add_dll_directory(_path)
        except OSError:
            pass

del _sub, _path
