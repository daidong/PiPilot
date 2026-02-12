#!/usr/bin/env python3
"""Generate Research Pilot desktop app icons (PNG, ICO, ICNS) without extra deps."""

from __future__ import annotations

import math
import shutil
import struct
import subprocess
import zlib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUILD_DIR = ROOT / "build"
PNG_PATH = BUILD_DIR / "icon.png"
ICO_PATH = BUILD_DIR / "icon.ico"
ICNS_PATH = BUILD_DIR / "icon.icns"
ICONSET_DIR = BUILD_DIR / "icon.iconset"


def clamp01(value: float) -> float:
    if value < 0.0:
        return 0.0
    if value > 1.0:
        return 1.0
    return value


def smoothstep(edge0: float, edge1: float, x: float) -> float:
    if edge0 == edge1:
        return 0.0
    t = clamp01((x - edge0) / (edge1 - edge0))
    return t * t * (3.0 - 2.0 * t)


def mix(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def segment_distance(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    abx = bx - ax
    aby = by - ay
    apx = px - ax
    apy = py - ay
    denom = abx * abx + aby * aby
    if denom <= 1e-9:
        return math.hypot(px - ax, py - ay)
    t = clamp01((apx * abx + apy * aby) / denom)
    cx = ax + abx * t
    cy = ay + aby * t
    return math.hypot(px - cx, py - cy)


def sdf_round_rect(x: float, y: float, half_w: float, half_h: float, radius: float) -> float:
    qx = abs(x) - half_w + radius
    qy = abs(y) - half_h + radius
    ox = max(qx, 0.0)
    oy = max(qy, 0.0)
    outside = math.hypot(ox, oy) - radius
    inside = min(max(qx, qy), 0.0)
    return outside + inside


def ellipse_ring_alpha(x: float, y: float, rx: float, ry: float, thickness: float) -> float:
    # Approximate shortest distance from point to ellipse using angle projection.
    t = math.atan2(y * rx, x * ry)
    ex = rx * math.cos(t)
    ey = ry * math.sin(t)
    d = math.hypot(x - ex, y - ey)
    half = thickness * 0.5
    feather = 0.012
    return smoothstep(half + feather, half - feather, d)


def alpha_blend(dst: tuple[float, float, float, float], src: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    dr, dg, db, da = dst
    sr, sg, sb, sa = src
    out_a = sa + da * (1.0 - sa)
    if out_a <= 1e-6:
        return (0.0, 0.0, 0.0, 0.0)
    out_r = (sr * sa + dr * da * (1.0 - sa)) / out_a
    out_g = (sg * sa + dg * da * (1.0 - sa)) / out_a
    out_b = (sb * sa + db * da * (1.0 - sa)) / out_a
    return (out_r, out_g, out_b, out_a)


def render_icon(size: int = 1024) -> bytes:
    pixels = bytearray(size * size * 4)
    inv = 1.0 / size

    # Palette: deep slate -> cyan gradient, warm highlight accents.
    top = (0.06, 0.13, 0.26)
    bottom = (0.04, 0.55, 0.72)
    ring_col = (0.71, 0.95, 0.98)
    node_col = (1.0, 0.82, 0.43)
    glyph_col = (0.97, 0.99, 1.0)

    for y in range(size):
        ny = ((y + 0.5) * inv) * 2.0 - 1.0
        for x in range(size):
            nx = ((x + 0.5) * inv) * 2.0 - 1.0

            # Rounded-square base
            rr = sdf_round_rect(nx, ny, 0.86, 0.86, 0.28)
            base_a = smoothstep(0.012, -0.012, rr)
            if base_a <= 0.0:
                continue

            gy = clamp01((ny + 1.0) * 0.5)
            bg_r = mix(top[0], bottom[0], gy)
            bg_g = mix(top[1], bottom[1], gy)
            bg_b = mix(top[2], bottom[2], gy)
            vignette = 1.0 - 0.18 * (nx * nx + ny * ny)
            base = (bg_r * vignette, bg_g * vignette, bg_b * vignette, base_a)

            # Orbit ring
            ring = ellipse_ring_alpha(nx * 0.98, ny * 1.02, 0.62, 0.42, 0.075)
            ring = min(ring, base_a)
            color = base
            if ring > 0.0:
                color = alpha_blend(color, (ring_col[0], ring_col[1], ring_col[2], ring * 0.75))

            # Orbit nodes
            node1 = math.hypot(nx - 0.46, ny + 0.13)
            node2 = math.hypot(nx + 0.40, ny - 0.19)
            node_alpha = max(smoothstep(0.055, 0.0, node1), smoothstep(0.05, 0.0, node2)) * base_a
            if node_alpha > 0.0:
                color = alpha_blend(color, (node_col[0], node_col[1], node_col[2], node_alpha * 0.95))

            # Stylized A glyph
            left = segment_distance(nx, ny, -0.28, 0.32, 0.0, -0.34)
            right = segment_distance(nx, ny, 0.0, -0.34, 0.28, 0.32)
            bar = segment_distance(nx, ny, -0.14, 0.05, 0.14, 0.05)
            stroke = min(left, right, bar)
            glyph_a = smoothstep(0.045, 0.0, stroke) * base_a
            if glyph_a > 0.0:
                color = alpha_blend(color, (glyph_col[0], glyph_col[1], glyph_col[2], glyph_a))

            idx = (y * size + x) * 4
            pixels[idx + 0] = int(clamp01(color[0]) * 255.0)
            pixels[idx + 1] = int(clamp01(color[1]) * 255.0)
            pixels[idx + 2] = int(clamp01(color[2]) * 255.0)
            pixels[idx + 3] = int(clamp01(color[3]) * 255.0)

    return bytes(pixels)


def write_png(path: Path, size: int, rgba: bytes) -> None:
    if len(rgba) != size * size * 4:
        raise ValueError("RGBA buffer size mismatch")

    raw = bytearray()
    row = size * 4
    for y in range(size):
        raw.append(0)
        start = y * row
        raw.extend(rgba[start : start + row])

    compressed = zlib.compress(bytes(raw), level=9)

    def chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag)
        crc = zlib.crc32(data, crc) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    png = bytearray()
    png.extend(b"\x89PNG\r\n\x1a\n")
    png.extend(chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)))
    png.extend(chunk(b"IDAT", compressed))
    png.extend(chunk(b"IEND", b""))

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(bytes(png))


def write_ico(ico_path: Path, png_data: bytes) -> None:
    # ICO can store PNG payload directly.
    header = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack("<BBBBHHII", 0, 0, 0, 0, 1, 32, len(png_data), 22)
    ico_path.write_bytes(header + entry + png_data)


def run_checked(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


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
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    rgba = render_icon(size=1024)
    write_png(PNG_PATH, 1024, rgba)

    # Build a dedicated 256x256 PNG and wrap as ICO.
    ico_png = BUILD_DIR / "icon-256.png"
    if shutil.which("sips"):
        run_checked(["sips", "-z", "256", "256", str(PNG_PATH), "--out", str(ico_png)])
        write_ico(ICO_PATH, ico_png.read_bytes())
        ico_png.unlink(missing_ok=True)
    else:
        write_ico(ICO_PATH, PNG_PATH.read_bytes())

    icns_ok = make_icns(PNG_PATH, ICONSET_DIR, ICNS_PATH)
    if not icns_ok:
        print("Generated icon.png and icon.ico (skipped icon.icns: requires sips + iconutil).")
    else:
        print("Generated icon.png, icon.ico, and icon.icns.")


if __name__ == "__main__":
    main()
