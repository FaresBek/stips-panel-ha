#!/usr/bin/env python3
"""Validate the standalone HACS distribution."""

import json
from pathlib import Path
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parents[1]
INTEGRATION = ROOT / "custom_components/stips_panel"
EXPECTED_VERSION = "1.5.6"


def main() -> None:
    manifest = json.loads((INTEGRATION / "manifest.json").read_text(encoding="utf-8"))
    hacs = json.loads((ROOT / "hacs.json").read_text(encoding="utf-8"))
    if manifest.get("version") != EXPECTED_VERSION:
        raise AssertionError("manifest version is stale")
    if manifest.get("documentation") != "https://github.com/FaresBek/stips-panel-ha":
        raise AssertionError("documentation URL does not point to the public repository")
    if manifest.get("issue_tracker") != "https://github.com/FaresBek/stips-panel-ha/issues":
        raise AssertionError("issue tracker does not point to the public repository")
    if not hacs.get("zip_release") or hacs.get("filename") != "stips-panel-remote-manager.zip":
        raise AssertionError("HACS release packaging is not configured")
    for required in (
        "__init__.py",
        "config_flow.py",
        "const.py",
        "services.yaml",
        "brand/icon.png",
        "frontend/stips-panel-editor.js",
        "translations/en.json",
    ):
        if not (INTEGRATION / required).is_file():
            raise AssertionError(f"missing integration file: {required}")
    for path in INTEGRATION.rglob("*.py"):
        compile(path.read_text(encoding="utf-8"), str(path), "exec")
    for path in INTEGRATION.rglob("*.json"):
        json.loads(path.read_text(encoding="utf-8"))

    from build_release import OUTPUT, main as build_release

    build_release()
    with ZipFile(OUTPUT) as archive:
        names = set(archive.namelist())
    if "manifest.json" not in names or "frontend/stips-panel-editor.js" not in names:
        raise AssertionError("release archive layout is invalid")
    print(f"STIPS Panel Remote Manager {EXPECTED_VERSION} distribution is valid ({len(names)} files).")


if __name__ == "__main__":
    main()

