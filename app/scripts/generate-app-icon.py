#!/usr/bin/env python3
"""Generate CoPilot desktop app icons from a checked-in source PNG."""

from __future__ import annotations

import shutil
import struct
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ASSETS_DIR = ROOT / "assets"
BUILD_DIR = ROOT / "build"
SOURCE_PNG_PATH = ASSETS_DIR / "icon-source.png"
PNG_PATH = BUILD_DIR / "icon.png"
ICO_PATH = BUILD_DIR / "icon.ico"
ICNS_PATH = BUILD_DIR / "icon.icns"
ICONSET_DIR = BUILD_DIR / "icon.iconset"


def run_checked(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def write_ico(ico_path: Path, png_data: bytes) -> None:
    header = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack("<BBBBHHII", 0, 0, 0, 0, 1, 32, len(png_data), 22)
    ico_path.write_bytes(header + entry + png_data)


def require_source_png() -> None:
    if not SOURCE_PNG_PATH.exists():
        raise FileNotFoundError(
            f"Missing icon source PNG at {SOURCE_PNG_PATH}. Add a 1024x1024 icon before generating app icons."
        )


def copy_master_png() -> None:
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(SOURCE_PNG_PATH, PNG_PATH)


def make_ico(source_png: Path, ico_path: Path) -> None:
    if shutil.which("sips"):
        ico_png = BUILD_DIR / "icon-256.png"
        run_checked(["sips", "-z", "256", "256", str(source_png), "--out", str(ico_png)])
        write_ico(ico_path, ico_png.read_bytes())
        ico_png.unlink(missing_ok=True)
        return

    write_ico(ico_path, source_png.read_bytes())


def make_icns(source_png: Path, iconset_dir: Path, icns_path: Path) -> bool:
    if shutil.which("sips") is None or shutil.which("iconutil") is None:
        return False

    if iconset_dir.exists():
        shutil.rmtree(iconset_dir)
    iconset_dir.mkdir(parents=True, exist_ok=True)

    specs = {
        "icon_16x16.png": 16,
        "icon_16x16@2x.png": 32,
        "icon_32x32.png": 32,
        "icon_32x32@2x.png": 64,
        "icon_128x128.png": 128,
        "icon_128x128@2x.png": 256,
        "icon_256x256.png": 256,
        "icon_256x256@2x.png": 512,
        "icon_512x512.png": 512,
        "icon_512x512@2x.png": 1024,
    }

    for name, size in specs.items():
        out = iconset_dir / name
        run_checked(["sips", "-z", str(size), str(size), str(source_png), "--out", str(out)])

    run_checked(["iconutil", "-c", "icns", str(iconset_dir), "-o", str(icns_path)])
    shutil.rmtree(iconset_dir, ignore_errors=True)
    return True


def main() -> None:
    require_source_png()
    copy_master_png()
    make_ico(PNG_PATH, ICO_PATH)

    icns_ok = make_icns(PNG_PATH, ICONSET_DIR, ICNS_PATH)
    if not icns_ok:
        print("Generated icon.png and icon.ico (skipped icon.icns: requires sips + iconutil).")
    else:
        print("Generated icon.png, icon.ico, and icon.icns.")


if __name__ == "__main__":
    main()
