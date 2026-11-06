"""Install Python libraries the user drops into a folder, with no network.

A customer on an intranet, or offline entirely, sometimes needs one more library
than the installer shipped. Asking them to run pip against an index is not an
option, and hand-editing PYTHONPATH is worse. So they drop a `.whl` into a
folder and this script does the rest.

The interesting part is what happens when a wheel's dependencies are missing.
pip cannot resolve against an index that is not there, so this script reads the
`Requires-Dist` lines out of each wheel's own METADATA — the same data pip would
have fetched — and reports exactly which wheels are still needed. That report is
the difference between "it failed" and "download these three files".

Layout, all under the user layer the application already runs from:

    <drop>/            wheels the user put here; this script drains it
    <drop>/done/       wheels that installed cleanly
    <drop>/failed/     wheels that did not, next to the reason
    <site>/            the target the app puts first on PYTHONPATH
    <site>/installed.json   what this script installed

Protocol matches tools/office.py: one JSON request on stdin, one JSON response
on stdout, diagnostics on stderr.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import zipfile


def fail(code: str, message: str, **extra) -> dict:
    return {"ok": False, "code": code, "error": message, **extra}


# ------------------------------------------------------------------ metadata

# A requirement line looks like "requests>=2.0,<3; python_version >= '3.8'".
# The name is what matters for "is it present"; the specifier only decides
# whether an installed version is acceptable.
REQUIREMENT = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$")
SPECIFIER = re.compile(r"([<>=!~]=?)\s*([0-9][0-9A-Za-z.+-]*)")
VERSION = re.compile(r"^\s*([0-9]+(?:\.[0-9A-Za-z]+)*)")


def normalise(name: str) -> str:
    """PEP 503 name normalisation, so et_xmlfile and Et-XMLfile match."""
    return re.sub(r"[-_.]+", "-", name).lower()


def read_wheel(path: str) -> dict:
    """Name, version and dependencies, straight out of the wheel's METADATA."""
    try:
        with zipfile.ZipFile(path) as archive:
            entries = [n for n in archive.namelist() if n.endswith(".dist-info/METADATA")]
            if not entries:
                return {"error": "no .dist-info/METADATA in the archive"}
            text = archive.read(entries[0]).decode("utf-8", "replace")
    except zipfile.BadZipFile:
        return {"error": "not a zip archive (a .whl is a zip)"}
    except OSError as error:
        return {"error": str(error)}

    def field(key: str) -> str:
        match = re.search(rf"^{key}: (.+)$", text, re.M)
        return match.group(1).strip() if match else ""

    requires = re.findall(r"^Requires-Dist: (.+)$", text, re.M)
    return {
        "name": field("Name"),
        "version": field("Version"),
        "requires": requires,
    }


def split_requirement(line: str) -> tuple[str, str, str]:
    """(name, specifier, marker) for one Requires-Dist line."""
    body, _, marker = line.partition(";")
    match = REQUIREMENT.match(body)
    if not match:
        return ("", "", marker.strip())
    return (normalise(match.group(1)), (match.group(3) or "").strip(), marker.strip())


def marker_applies(marker: str) -> bool:
    """
    Whether an environment marker selects this platform.

    Only the shapes that actually appear in wheel metadata are evaluated. An
    unknown marker is treated as "applies", because reporting a dependency the
    user does not need is a better failure than silently installing a broken
    tree.
    """
    if not marker:
        return True
    checks = {
        "extra": None,  # optional feature groups are never installed implicitly
    }
    match = re.search(r"""extra\s*==\s*['"]([^'"]+)['"]""", marker)
    if match:
        # Nothing here installs extras, so any extra-gated requirement is out.
        return False
    for variable in ("sys_platform", "platform_system", "os_name"):
        for pattern in (rf"""{variable}\s*==\s*['"]([^'"]+)['"]""",
                        rf"""{variable}\s*!=\s*['"]([^'"]+)['"]"""):
            match = re.search(pattern, marker)
            if not match:
                continue
            value = {
                "sys_platform": sys.platform,
                "platform_system": sys.platform and ("Windows" if sys.platform.startswith("win")
                                                    else "Darwin" if sys.platform == "darwin" else "Linux"),
                "os_name": os.name,
            }[variable]
            differs = "!=" in match.group(0)
            equal = value == match.group(1) if not differs else value != match.group(1)
            if not equal:
                return False
    if re.search(r"python_version\s*[<>]", marker):
        # A version-gated requirement is close enough to "applies" that guessing
        # false would hide a real need.
        return True
    return True


def installed_versions(site: str) -> dict:
    """{normalised name: version} for what the user layer already holds."""
    found: dict[str, str] = {}
    if not os.path.isdir(site):
        return found
    for entry in os.listdir(site):
        if not entry.endswith(".dist-info"):
            continue
        metadata = os.path.join(site, entry, "METADATA")
        if not os.path.isfile(metadata):
            continue
        with open(metadata, "r", encoding="utf-8", errors="replace") as handle:
            text = handle.read()
        name = re.search(r"^Name: (.+)$", text, re.M)
        version = re.search(r"^Version: (.+)$", text, re.M)
        if name:
            found[normalise(name.group(1).strip())] = version.group(1).strip() if version else ""
    return found


def satisfies(version: str, specifier: str) -> bool:
    """
    Whether an installed version meets a specifier.

    A deliberately small comparator: >=, <=, >, <, ==, != on dotted versions.
    Anything more elaborate (compatible-release `~=`, wildcards, epochs) is
    treated as satisfied, because refusing a library over a specifier this
    script cannot parse would be worse than accepting it.
    """
    if not specifier or not version:
        return True
    have = VERSION.match(version)
    if not have:
        return True
    numbers = [int(part) if part.isdigit() else part
               for part in have.group(1).replace("-", ".").split(".") if part != ""]
    for operator, wanted in SPECIFIER.findall(specifier):
        want = [int(part) if part.isdigit() else part
                for part in wanted.replace("-", ".").split(".") if part != ""]
        length = max(len(numbers), len(want))
        left = (numbers + [0] * length)[:length]
        right = (want + [0] * length)[:length]
        try:
            if operator == ">=" and not left >= right:
                return False
            if operator == "<=" and not left <= right:
                return False
            if operator == ">" and not left > right:
                return False
            if operator == "<" and not left < right:
                return False
            if operator == "==" and not left == right:
                return False
            if operator == "!=" and not left != right:
                return False
        except TypeError:
            # Mixed str/int segments from a pre-release; do not block on it.
            return True
    return True


# ------------------------------------------------------------------ scanning

def scan(drop: str, site: str) -> dict:
    """What is in the drop folder, and what is still missing."""
    present = installed_versions(site)
    dropped: list[dict] = []
    provided: dict[str, str] = {}

    if os.path.isdir(drop):
        for entry in sorted(os.listdir(drop)):
            if not entry.lower().endswith(".whl"):
                continue
            path = os.path.join(drop, entry)
            if not os.path.isfile(path):
                continue
            info = read_wheel(path)
            if "error" in info:
                dropped.append({"file": entry, "error": info["error"]})
                continue
            name = normalise(info["name"])
            provided[name] = info["version"]
            dropped.append({
                "file": entry,
                "name": name,
                "version": info["version"],
                "requires": [split_requirement(line) for line in info["requires"]
                             if marker_applies(split_requirement(line)[2])],
            })

    missing: dict[str, list[str]] = {}
    for wheel in dropped:
        for name, specifier, _marker in wheel.get("requires", []):
            if not name:
                continue
            if name in provided:
                continue  # the user already brought it in this batch
            have = present.get(name)
            if have is None:
                missing.setdefault(name, []).append(f"{wheel['name']} needs {name}{specifier}")
            elif not satisfies(have, specifier):
                missing[name].append(f"{wheel['name']} needs {name}{specifier}, found {have}")

    return {
        "ok": True,
        "drop": drop,
        "site": site,
        "dropped": dropped,
        "missing": [{"name": name, "reasons": reasons} for name, reasons in sorted(missing.items())],
        "ready": [wheel["file"] for wheel in dropped if "error" not in wheel],
    }


# ------------------------------------------------------------------ install

def move_blocked(drop: str, blocked: list[dict], missing: list[dict] | None = None) -> None:
    """
    Park refused wheels in `failed/` with a note naming what to fetch.

    The note is the whole point: on an offline machine "missing dependencies"
    is useless, and "python-docx needs lxml>=3.1.0" is a shopping list.
    """
    if not blocked:
        return
    failed_dir = os.path.join(drop, "failed")
    os.makedirs(failed_dir, exist_ok=True)
    reasons_by_name = {item["name"]: item["reasons"] for item in (missing or [])}
    for item in blocked:
        source = os.path.join(drop, item["file"])
        if not os.path.isfile(source):
            continue
        shutil.move(source, os.path.join(failed_dir, item["file"]))
        lines = [item["reason"], ""]
        for need in item.get("missing", []):
            for reason in reasons_by_name.get(need, []):
                lines.append(f"  - {reason}")
        lines.append("")
        lines.append("Put the missing .whl files here too, then run the install again.")
        with open(os.path.join(failed_dir, item["file"] + ".txt"), "w", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")


def install(drop: str, site: str) -> dict:
    """
    Install what can be installed, and say precisely what could not.

    Wheels whose dependencies are all present go in together, in one pip call
    with `--no-index`, so pip itself never looks at a network. Anything left
    over is reported with the reason, and the file moves to `failed/` so the
    next scan does not retry it in a loop.
    """
    report = scan(drop, site)
    if not report["ok"]:
        return report
    missing_names = {item["name"] for item in report["missing"]}

    installable: list[str] = []
    blocked: list[dict] = []
    for wheel in report["dropped"]:
        if "error" in wheel:
            blocked.append({"file": wheel["file"], "reason": wheel["error"]})
            continue
        unmet = sorted({name for name, _spec, _marker in wheel.get("requires", [])
                        if name in missing_names})
        if unmet:
            blocked.append({
                "file": wheel["file"],
                "reason": "missing dependencies: " + ", ".join(unmet),
                "missing": unmet,
            })
            continue
        installable.append(os.path.join(drop, wheel["file"]))

    if not installable:
        # Park the blocked wheels next to the reason, so the folder a user is
        # looking at is empty of things that will never install, and the note
        # says which library to fetch next. Without this the same wheel is
        # retried on every scan and the user has no idea why it never works.
        move_blocked(drop, blocked, report["missing"])
        return {
            "ok": False,
            "code": "DEPENDENCIES_MISSING" if blocked else "NOTHING_TO_INSTALL",
            "error": ("these wheels need libraries that are not here yet"
                      if blocked else "no wheels in the drop folder"),
            "blocked": blocked,
            "missing": report["missing"],
            "drop": drop,
            "site": site,
        }

    os.makedirs(site, exist_ok=True)
    command = [
        sys.executable, "-m", "pip", "install",
        "--no-index",
        "--no-deps",
        "--target", site,
        "--upgrade",
        # Wheels are installed by this script, not by pip's cache machinery, so
        # nothing is compiled and nothing is downloaded.
        "--no-compile",
    ] + installable
    completed = subprocess.run(command, capture_output=True, text=True)
    if completed.returncode != 0:
        tail = (completed.stderr or completed.stdout or "").strip().splitlines()[-6:]
        return {
            "ok": False,
            "code": "INSTALL_FAILED",
            "error": "pip refused the wheels",
            "detail": tail,
            "blocked": blocked,
            "missing": report["missing"],
            "drop": drop,
            "site": site,
        }

    done_dir = os.path.join(drop, "done")
    os.makedirs(done_dir, exist_ok=True)
    for path in installable:
        shutil.move(path, os.path.join(done_dir, os.path.basename(path)))

    if blocked:
        move_blocked(drop, blocked, report["missing"])

    # Record what this script put there, so "what did I install" is answerable
    # without reading dist-info directories by hand.
    record_path = os.path.join(site, "installed.json")
    history: list[dict] = []
    if os.path.isfile(record_path):
        try:
            with open(record_path, "r", encoding="utf-8") as handle:
                history = json.load(handle).get("installs", [])
        except (OSError, ValueError):
            history = []
    history.append({
        "files": [os.path.basename(path) for path in installable],
        "blocked": [item["file"] for item in blocked],
    })
    with open(record_path, "w", encoding="utf-8") as handle:
        json.dump({"installs": history[-50:]}, handle, indent=2)

    return {
        "ok": True,
        "installed": [os.path.basename(path) for path in installable],
        "blocked": blocked,
        "missing": report["missing"],
        "drop": drop,
        "site": site,
    }


def main() -> int:
    try:
        request = json.load(sys.stdin)
    except Exception as error:
        json.dump(fail("INVALID_ARGUMENT", f"request is not JSON: {error}"), sys.stdout)
        return 2

    action = str(request.get("action", "scan")).lower()
    drop = request.get("drop") or ""
    site = request.get("site") or ""
    if not drop or not site:
        json.dump(fail("INVALID_ARGUMENT", "drop and site are required"), sys.stdout)
        return 2

    try:
        if action == "scan":
            result = scan(drop, site)
        elif action == "install":
            result = install(drop, site)
        else:
            result = fail("INVALID_ARGUMENT", f"unknown action {action!r}")
    except Exception as error:  # a broken wheel must not look like a crash
        import traceback
        result = fail("LIBRARY_INSTALL_UNREADABLE", f"{type(error).__name__}: {error}",
                      trace=traceback.format_exc(limit=3))

    json.dump(result, sys.stdout, ensure_ascii=False, default=str)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
