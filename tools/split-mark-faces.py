"""Split the Cortex mark into its colour faces for the boot intro.

Writes src/assets/brand/mark-{left,right,lid,base,inner}.png from
src-tauri/icons/icon.png. Each opaque pixel goes to exactly one face, so the
faces stacked in place recombine into the icon. Rerun after the logo changes:

    python tools/split-mark-faces.py
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "src-tauri" / "icons" / "icon.png"
OUT = ROOT / "src" / "assets" / "brand"
SIZE = 320

# Logo palette: deep, main and light blue, plus the paper inner face.
CENTERS = {
    "left": (0x36, 0x66, 0xC6),
    "main": (0x54, 0x8A, 0xF6),
    "right": (0x82, 0xAC, 0xF6),
    "inner": (0xF0, 0xEA, 0xE4),
}


def nearest(rgb):
    return min(CENTERS, key=lambda k: sum((a - b) ** 2 for a, b in zip(rgb, CENTERS[k])))


def main():
    icon = Image.open(SOURCE).convert("RGBA")
    width, height = icon.size
    names = ["left", "right", "lid", "base", "inner"]
    faces = {name: Image.new("RGBA", icon.size, (0, 0, 0, 0)) for name in names}
    src = icon.load()
    dst = {name: faces[name].load() for name in names}
    for y in range(height):
        for x in range(width):
            pixel = src[x, y]
            if pixel[3] == 0:
                continue
            face = nearest(pixel[:3])
            if face == "main":
                face = "lid" if y < height // 2 else "base"
            dst[face][x, y] = pixel
    OUT.mkdir(parents=True, exist_ok=True)
    for name, image in faces.items():
        image.resize((SIZE, SIZE), Image.LANCZOS).save(OUT / f"mark-{name}.png", optimize=True)


if __name__ == "__main__":
    main()
