#!/usr/bin/env python3
"""Generate Personal Assistant desktop app icons (PNG, ICO, ICNS) without extra deps.

Design: warm indigo-to-violet gradient with a stylised person silhouette
and a small sparkle accent — approachable, friendly, distinctly different
from the Research Pilot's cyan/orbit motif.
"""

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


# --------------------------------------------------------------------------- #
# Maths helpers
# --------------------------------------------------------------------------- #

def clamp01(v: float) -> float:
    return max(0.0, min(1.0, v))


def smoothstep(edge0: float, edge1: float, x: float) -> float:
    if edge0 == edge1:
        return 0.0
    t = clamp01((x - edge0) / (edge1 - edge0))
    return t * t * (3.0 - 2.0 * t)


def mix(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def mix3(a: tuple[float, ...], b: tuple[float, ...], t: float) -> tuple[float, ...]:
    return tuple(mix(ai, bi, t) for ai, bi in zip(a, b))


def segment_distance(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    abx, aby = bx - ax, by - ay
    apx, apy = px - ax, py - ay
    denom = abx * abx + aby * aby
    if denom <= 1e-9:
        return math.hypot(px - ax, py - ay)
    t = clamp01((apx * abx + apy * aby) / denom)
    return math.hypot(px - (ax + abx * t), py - (ay + aby * t))


def sdf_round_rect(x: float, y: float, half_w: float, half_h: float, radius: float) -> float:
    qx = abs(x) - half_w + radius
    qy = abs(y) - half_h + radius
    ox, oy = max(qx, 0.0), max(qy, 0.0)
    return math.hypot(ox, oy) - radius + min(max(qx, qy), 0.0)


def sdf_circle(x: float, y: float, cx: float, cy: float, r: float) -> float:
    return math.hypot(x - cx, y - cy) - r


def alpha_blend(
    dst: tuple[float, float, float, float],
    src: tuple[float, float, float, float],
) -> tuple[float, float, float, float]:
    dr, dg, db, da = dst
    sr, sg, sb, sa = src
    out_a = sa + da * (1.0 - sa)
    if out_a <= 1e-6:
        return (0.0, 0.0, 0.0, 0.0)
    inv = 1.0 / out_a
    return (
        (sr * sa + dr * da * (1.0 - sa)) * inv,
        (sg * sa + dg * da * (1.0 - sa)) * inv,
        (sb * sa + db * da * (1.0 - sa)) * inv,
        out_a,
    )


# --------------------------------------------------------------------------- #
# Icon renderer
# --------------------------------------------------------------------------- #

def render_icon(size: int = 1024) -> bytes:
    pixels = bytearray(size * size * 4)
    inv = 1.0 / size

    # Palette
    top_col = (0.16, 0.08, 0.36)      # deep indigo
    bot_col = (0.42, 0.14, 0.56)      # warm violet
    person_col = (0.95, 0.95, 1.0)    # near-white
    sparkle_col = (1.0, 0.85, 0.45)   # warm gold
    shadow_col = (0.10, 0.05, 0.22)   # dark shadow

    for y in range(size):
        ny = ((y + 0.5) * inv) * 2.0 - 1.0
        for x in range(size):
            nx = ((x + 0.5) * inv) * 2.0 - 1.0

            # -- Rounded-square base --
            rr = sdf_round_rect(nx, ny, 0.86, 0.86, 0.28)
            base_a = smoothstep(0.012, -0.012, rr)
            if base_a <= 0.0:
                continue

            # Gradient background
            gy = clamp01((ny + 1.0) * 0.5)
            bg = mix3(top_col, bot_col, gy)
            vignette = 1.0 - 0.15 * (nx * nx + ny * ny)
            color: tuple[float, float, float, float] = (
                bg[0] * vignette,
                bg[1] * vignette,
                bg[2] * vignette,
                base_a,
            )

            # -- Subtle radial glow behind the person --
            glow_d = math.hypot(nx, ny + 0.05)
            glow_a = smoothstep(0.65, 0.0, glow_d) * 0.18 * base_a
            if glow_a > 0:
                color = alpha_blend(color, (0.55, 0.35, 0.85, glow_a))

            # -- Person silhouette (head + torso) --
            # Head: circle
            head_d = sdf_circle(nx, ny, 0.0, -0.18, 0.16)
            head_a = smoothstep(0.012, -0.012, head_d) * base_a

            # Shadow behind head
            head_shadow_d = sdf_circle(nx, ny, 0.015, -0.16, 0.17)
            head_shadow_a = smoothstep(0.035, -0.015, head_shadow_d) * 0.3 * base_a
            if head_shadow_a > 0:
                color = alpha_blend(color, (*shadow_col, head_shadow_a))

            if head_a > 0:
                color = alpha_blend(color, (*person_col, head_a))

            # Torso/shoulders: wide rounded shape, clipped at bottom by icon edge
            torso_cx = 0.0
            torso_cy = 0.32
            t_hw = 0.34    # half-width
            t_hh = 0.36    # half-height (extends below icon edge)
            t_r = 0.22     # corner radius (very rounded top)
            tdx = nx - torso_cx
            tdy = ny - torso_cy
            torso_d = sdf_round_rect(tdx, tdy, t_hw, t_hh, t_r)
            torso_a = smoothstep(0.012, -0.012, torso_d) * base_a

            # Shadow behind torso
            shadow_tdx = nx - (torso_cx + 0.015)
            shadow_tdy = ny - (torso_cy - 0.015)
            torso_shadow_d = sdf_round_rect(shadow_tdx, shadow_tdy, t_hw + 0.01, t_hh + 0.01, t_r)
            torso_shadow_a = smoothstep(0.035, -0.015, torso_shadow_d) * 0.25 * base_a
            if torso_shadow_a > 0:
                color = alpha_blend(color, (*shadow_col, torso_shadow_a))

            if torso_a > 0:
                color = alpha_blend(color, (*person_col, torso_a))

            # -- Sparkle / star accent (upper right) --
            sx, sy = 0.38, -0.42
            # 4-point star via min of two perpendicular diamond shapes
            star_dx = abs(nx - sx)
            star_dy = abs(ny - sy)
            arm_len = 0.12
            arm_width = 0.025
            h_arm = max(star_dx / arm_len, star_dy / arm_width) - 1.0
            v_arm = max(star_dx / arm_width, star_dy / arm_len) - 1.0
            star_d = min(h_arm, v_arm)
            star_a = smoothstep(0.08, -0.04, star_d) * base_a

            if star_a > 0:
                color = alpha_blend(color, (*sparkle_col, star_a * 0.95))

            # Small secondary sparkle
            s2x, s2y = 0.52, -0.28
            s2_dx = abs(nx - s2x)
            s2_dy = abs(ny - s2y)
            s2_arm = 0.055
            s2_w = 0.012
            s2_h = max(s2_dx / s2_arm, s2_dy / s2_w) - 1.0
            s2_v = max(s2_dx / s2_w, s2_dy / s2_arm) - 1.0
            s2_d = min(s2_h, s2_v)
            s2_a = smoothstep(0.06, -0.03, s2_d) * base_a * 0.7

            if s2_a > 0:
                color = alpha_blend(color, (*sparkle_col, s2_a))

            # Write pixel
            idx = (y * size + x) * 4
            pixels[idx + 0] = int(clamp01(color[0]) * 255.0)
            pixels[idx + 1] = int(clamp01(color[1]) * 255.0)
            pixels[idx + 2] = int(clamp01(color[2]) * 255.0)
            pixels[idx + 3] = int(clamp01(color[3]) * 255.0)

    return bytes(pixels)


# --------------------------------------------------------------------------- #
# PNG / ICO / ICNS writers (same as research-pilot)
# --------------------------------------------------------------------------- #

def write_png(path: Path, size: int, rgba: bytes) -> None:
    if len(rgba) != size * size * 4:
        raise ValueError("RGBA buffer size mismatch")

    raw = bytearray()
    row = size * 4
    for y in range(size):
        raw.append(0)
        raw.extend(rgba[y * row : y * row + row])

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

    for name, sz in specs.items():
        run_checked(["sips", "-z", str(sz), str(sz), str(source_png), "--out", str(iconset_dir / name)])

    run_checked(["iconutil", "-c", "icns", str(iconset_dir), "-o", str(icns_path)])
    shutil.rmtree(iconset_dir, ignore_errors=True)
    return True


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #

def main() -> None:
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    print("Rendering 1024x1024 icon...")
    rgba = render_icon(size=1024)
    write_png(PNG_PATH, 1024, rgba)

    # ICO (256x256)
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
