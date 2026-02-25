#!/usr/bin/env python3
"""
Reference UV-island gradient generator (NumPy + Pillow).

Supports three input styles:

1) UV raster ID map
   {
     "id_map": "./uv_ids.png",
     "background_id": 0
   }

2) Explicit islands
   {
     "width": 2048,
     "height": 2048,
     "islands": [
       {
         "id": "hood",
         "pixels": [[x, y], ...],
         "uvs": [[u, v], ...],        # optional, per pixel
         "uv_points": [[u, v], ...],  # optional, for PCA axis
         "mask": "./hood_mask.png"   # optional alternative to pixels
       }
     ]
   }

3) Mesh UVs (islands auto-detected)
   {
     "width": 2048,
     "height": 2048,
     "uv_vertices": [[u, v], ...],
     "faces": [[i0, i1, i2], ...]
   }

   or

   {
     "width": 2048,
     "height": 2048,
     "triangles": [
       [[u0, v0], [u1, v1], [u2, v2]],
       ...
     ]
   }

Output: RGBA PNG where each island has its own local, PCA-aligned gradient.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

import numpy as np
from PIL import Image

EPS = 1e-8

# Nice, clean two-stop HSV palettes:
# A: lavender -> light blue
# B: pink -> peach/orange
# C: teal -> green
# D: magenta -> purple
PALETTE_LIBRARY: List[Tuple[Tuple[float, float, float], Tuple[float, float, float]]] = [
    ((274.0, 0.58, 0.92), (214.0, 0.56, 0.94)),
    ((326.0, 0.64, 0.92), (28.0, 0.64, 0.93)),
    ((188.0, 0.69, 0.89), (132.0, 0.62, 0.92)),
    ((314.0, 0.67, 0.90), (272.0, 0.66, 0.89)),
]


@dataclass
class IslandData:
    island_id: Union[int, str]
    pixels: np.ndarray  # (N, 2) int32, columns: x, y
    pixel_uvs: Optional[np.ndarray] = None  # (N, 2) float32
    uv_points: Optional[np.ndarray] = None  # (M, 2) float32


def stable_hash64(value: Union[int, str]) -> int:
    digest = hashlib.blake2b(str(value).encode("utf-8"), digest_size=8).digest()
    return int.from_bytes(digest, byteorder="big", signed=False)


def clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def clamp01_array(arr: np.ndarray) -> np.ndarray:
    return np.clip(arr, 0.0, 1.0)


def infer_uvs_from_pixels(pixels: np.ndarray, width: int, height: int) -> np.ndarray:
    u = (pixels[:, 0].astype(np.float64) + 0.5) / max(1, width)
    v = 1.0 - (pixels[:, 1].astype(np.float64) + 0.5) / max(1, height)
    return np.column_stack((u, v))


def compute_principal_axis(points_uv: np.ndarray, eps: float = EPS) -> Optional[np.ndarray]:
    if points_uv is None or points_uv.size == 0 or points_uv.shape[0] < 2:
        return None

    sample = points_uv
    if sample.shape[0] > 20000:
        step = int(math.ceil(sample.shape[0] / 20000.0))
        sample = sample[::step]

    centered = sample - np.mean(sample, axis=0, keepdims=True)
    cov = centered.T @ centered / max(1, centered.shape[0])

    try:
        eig_vals, eig_vecs = np.linalg.eigh(cov)
    except np.linalg.LinAlgError:
        return None

    axis = eig_vecs[:, int(np.argmax(eig_vals))].astype(np.float64)
    norm = float(np.linalg.norm(axis))
    if not np.isfinite(norm) or norm < eps:
        return None

    axis /= norm

    # Deterministic orientation: prefer positive dominant component.
    if abs(axis[0]) >= abs(axis[1]):
        if axis[0] < 0:
            axis *= -1.0
    else:
        if axis[1] < 0:
            axis *= -1.0

    return axis


def normalize_local_uv(uvs: np.ndarray, eps: float = EPS) -> Tuple[np.ndarray, float, float]:
    u = uvs[:, 0]
    v = uvs[:, 1]
    min_u = float(np.min(u))
    max_u = float(np.max(u))
    min_v = float(np.min(v))
    max_v = float(np.max(v))

    span_u = max_u - min_u
    span_v = max_v - min_v

    u_local = (u - min_u) / max(eps, span_u)
    v_local = (v - min_v) / max(eps, span_v)
    return np.column_stack((u_local, v_local)), span_u, span_v


def fallback_t_from_bbox(pixel_uvs: np.ndarray, eps: float = EPS) -> np.ndarray:
    local_uv, span_u, span_v = normalize_local_uv(pixel_uvs, eps=eps)

    if span_u < eps and span_v < eps:
        return np.full(pixel_uvs.shape[0], 0.5, dtype=np.float64)

    if span_u >= span_v:
        return local_uv[:, 0]

    return local_uv[:, 1]


def compute_local_t(pixel_uvs: np.ndarray, axis_source_uvs: np.ndarray, eps: float = EPS) -> np.ndarray:
    axis = compute_principal_axis(axis_source_uvs, eps=eps)
    if axis is None:
        return clamp01_array(fallback_t_from_bbox(pixel_uvs, eps=eps))

    center = np.mean(axis_source_uvs, axis=0)
    t_raw = (pixel_uvs - center) @ axis
    t_min = float(np.min(t_raw))
    t_max = float(np.max(t_raw))
    span = t_max - t_min
    if not np.isfinite(span) or span < eps:
        return clamp01_array(fallback_t_from_bbox(pixel_uvs, eps=eps))

    return clamp01_array((t_raw - t_min) / span)


def palette_for_island(island_id: Union[int, str]) -> Tuple[np.ndarray, np.ndarray]:
    seed = stable_hash64(island_id)
    base_left, base_right = PALETTE_LIBRARY[seed % len(PALETTE_LIBRARY)]

    hue_offset = (((seed >> 8) & 0xFFFF) / 65535.0) * 16.0 - 8.0
    sat_offset = (((seed >> 24) & 0xFFFF) / 65535.0) * 0.06 - 0.03
    val_offset = (((seed >> 40) & 0xFFFF) / 65535.0) * 0.04 - 0.02

    left = np.array(
        [
            (base_left[0] + hue_offset) % 360.0,
            clamp(base_left[1] + sat_offset, 0.55, 0.75),
            clamp(base_left[2] + val_offset, 0.85, 0.95),
        ],
        dtype=np.float64,
    )
    right = np.array(
        [
            (base_right[0] + hue_offset) % 360.0,
            clamp(base_right[1] + sat_offset, 0.55, 0.75),
            clamp(base_right[2] + val_offset, 0.85, 0.95),
        ],
        dtype=np.float64,
    )
    return left, right


def lerp_hsv(left_hsv: np.ndarray, right_hsv: np.ndarray, t: np.ndarray) -> np.ndarray:
    h0, s0, v0 = left_hsv
    h1, s1, v1 = right_hsv

    dh = ((h1 - h0 + 180.0) % 360.0) - 180.0
    h = (h0 + dh * t) % 360.0
    s = s0 + (s1 - s0) * t
    v = v0 + (v1 - v0) * t
    return np.column_stack((h, s, v))


def hsv_to_rgb_np(hsv: np.ndarray) -> np.ndarray:
    h = hsv[:, 0] % 360.0
    s = clamp01_array(hsv[:, 1])
    v = clamp01_array(hsv[:, 2])

    c = v * s
    hp = h / 60.0
    x = c * (1.0 - np.abs((hp % 2.0) - 1.0))
    m = v - c

    r = np.zeros_like(h)
    g = np.zeros_like(h)
    b = np.zeros_like(h)

    conds = [
        (hp >= 0) & (hp < 1),
        (hp >= 1) & (hp < 2),
        (hp >= 2) & (hp < 3),
        (hp >= 3) & (hp < 4),
        (hp >= 4) & (hp < 5),
        (hp >= 5) & (hp < 6),
    ]

    r[conds[0]], g[conds[0]], b[conds[0]] = c[conds[0]], x[conds[0]], 0
    r[conds[1]], g[conds[1]], b[conds[1]] = x[conds[1]], c[conds[1]], 0
    r[conds[2]], g[conds[2]], b[conds[2]] = 0, c[conds[2]], x[conds[2]]
    r[conds[3]], g[conds[3]], b[conds[3]] = 0, x[conds[3]], c[conds[3]]
    r[conds[4]], g[conds[4]], b[conds[4]] = x[conds[4]], 0, c[conds[4]]
    r[conds[5]], g[conds[5]], b[conds[5]] = c[conds[5]], 0, x[conds[5]]

    rgb = np.column_stack((r + m, g + m, b + m))
    rgb = np.clip(np.round(rgb * 255.0), 0, 255).astype(np.uint8)
    return rgb


def normalize_pixels(pixels: np.ndarray, width: int, height: int) -> np.ndarray:
    p = np.asarray(pixels, dtype=np.int64)
    if p.ndim != 2 or p.shape[1] != 2:
        raise ValueError("pixels must be an (N,2) array of [x, y].")

    in_bounds = (
        (p[:, 0] >= 0)
        & (p[:, 0] < width)
        & (p[:, 1] >= 0)
        & (p[:, 1] < height)
    )
    p = p[in_bounds]
    if p.size == 0:
        return np.empty((0, 2), dtype=np.int32)

    p = np.unique(p.astype(np.int32), axis=0)
    return p


def render_island_gradients(
    width: int,
    height: int,
    islands: Sequence[IslandData],
    transparent_background: bool = True,
) -> np.ndarray:
    out = np.zeros((height, width, 4), dtype=np.uint8)
    if not transparent_background:
        out[..., 3] = 255

    for island in islands:
        pixels = island.pixels
        if pixels is None or pixels.size == 0:
            continue

        x = pixels[:, 0]
        y = pixels[:, 1]

        if island.pixel_uvs is not None and island.pixel_uvs.shape[0] == pixels.shape[0]:
            pixel_uvs = island.pixel_uvs.astype(np.float64)
        else:
            pixel_uvs = infer_uvs_from_pixels(pixels, width, height)

        axis_source = island.uv_points
        if axis_source is None or axis_source.size == 0:
            axis_source = pixel_uvs
        else:
            axis_source = axis_source.astype(np.float64)

        t = compute_local_t(pixel_uvs, axis_source, eps=EPS)
        left_hsv, right_hsv = palette_for_island(island.island_id)
        hsv = lerp_hsv(left_hsv, right_hsv, t)
        rgb = hsv_to_rgb_np(hsv)

        out[y, x, 0:3] = rgb
        out[y, x, 3] = 255

    return out


def load_id_map(path: Path) -> np.ndarray:
    image = Image.open(path)
    arr = np.asarray(image)

    if arr.ndim == 2:
        return arr.astype(np.int64)

    if arr.ndim == 3:
        channels = arr.shape[2]
        if channels >= 3:
            rgb = arr[..., :3].astype(np.int64)
            ids = (rgb[..., 0] << 16) | (rgb[..., 1] << 8) | rgb[..., 2]
            if channels >= 4:
                alpha = arr[..., 3]
                ids = ids.copy()
                ids[alpha == 0] = 0
            return ids

    raise ValueError(f"Unsupported ID map shape: {arr.shape}")


def islands_from_id_map(ids: np.ndarray, background_id: int = 0) -> Tuple[List[IslandData], int, int]:
    if ids.ndim != 2:
        raise ValueError("ID map must be 2D after decoding.")

    height, width = ids.shape
    unique_ids = np.unique(ids)
    unique_ids = unique_ids[unique_ids != background_id]

    islands: List[IslandData] = []
    for island_id in sorted(unique_ids.tolist()):
        ys, xs = np.where(ids == island_id)
        if xs.size == 0:
            continue
        pixels = np.column_stack((xs, ys)).astype(np.int32)
        islands.append(IslandData(island_id=island_id, pixels=pixels))

    return islands, width, height


def mask_pixels_from_image(mask_path: Path) -> np.ndarray:
    mask = Image.open(mask_path).convert("L")
    arr = np.asarray(mask)
    ys, xs = np.where(arr > 0)
    return np.column_stack((xs, ys)).astype(np.int32)


def parse_float_points(points: Any, label: str) -> np.ndarray:
    arr = np.asarray(points, dtype=np.float64)
    if arr.ndim != 2 or arr.shape[1] != 2:
        raise ValueError(f"{label} must be an (N,2) array.")
    return arr


def parse_int_points(points: Any, label: str) -> np.ndarray:
    arr = np.asarray(points, dtype=np.int64)
    if arr.ndim != 2 or arr.shape[1] != 2:
        raise ValueError(f"{label} must be an (N,2) array.")
    return arr


def resolve_path(base_dir: Path, value: str) -> Path:
    p = Path(value)
    if p.is_absolute():
        return p
    return (base_dir / p).resolve()


def islands_from_explicit_payload(payload: Dict[str, Any], base_dir: Path) -> Tuple[List[IslandData], int, int]:
    islands_raw = payload.get("islands")
    if not isinstance(islands_raw, list) or len(islands_raw) == 0:
        raise ValueError("payload.islands must be a non-empty list.")

    width = payload.get("width")
    height = payload.get("height")
    if width is None or height is None:
        for entry in islands_raw:
            if isinstance(entry, dict) and isinstance(entry.get("mask"), str):
                sample_mask = np.asarray(Image.open(resolve_path(base_dir, entry["mask"])).convert("L"))
                height, width = sample_mask.shape[:2]
                break

    if width is None or height is None:
        raise ValueError("Explicit islands input requires width and height (or at least one mask to infer them).")

    width = int(width)
    height = int(height)
    if width <= 0 or height <= 0:
        raise ValueError("width and height must be > 0.")

    islands: List[IslandData] = []
    for idx, entry in enumerate(islands_raw):
        if not isinstance(entry, dict):
            continue

        island_id: Union[int, str] = entry.get("id", idx + 1)

        if "pixels" in entry:
            pixels = parse_int_points(entry["pixels"], "islands[].pixels")
        elif isinstance(entry.get("mask"), str):
            pixels = mask_pixels_from_image(resolve_path(base_dir, entry["mask"]))
        else:
            raise ValueError(f"islands[{idx}] needs either 'pixels' or 'mask'.")

        pixels = normalize_pixels(pixels, width, height)
        if pixels.size == 0:
            continue

        pixel_uvs = None
        if "uvs" in entry and entry["uvs"] is not None:
            uvs = parse_float_points(entry["uvs"], "islands[].uvs")
            if uvs.shape[0] == pixels.shape[0]:
                pixel_uvs = uvs.astype(np.float32)

        uv_points = None
        if "uv_points" in entry and entry["uv_points"] is not None:
            uv_points = parse_float_points(entry["uv_points"], "islands[].uv_points").astype(np.float32)

        islands.append(
            IslandData(
                island_id=island_id,
                pixels=pixels,
                pixel_uvs=pixel_uvs,
                uv_points=uv_points,
            )
        )

    if not islands:
        raise ValueError("No valid islands were parsed from explicit payload.")

    return islands, width, height


def connected_components_from_faces(faces: np.ndarray) -> List[List[int]]:
    triangles_by_vertex: Dict[int, List[int]] = {}
    for tri_idx, face in enumerate(faces):
        for vertex in face:
            key = int(vertex)
            triangles_by_vertex.setdefault(key, []).append(tri_idx)

    visited = np.zeros(faces.shape[0], dtype=np.uint8)
    components: List[List[int]] = []

    for start in range(faces.shape[0]):
        if visited[start]:
            continue

        stack = [start]
        visited[start] = 1
        comp: List[int] = []

        while stack:
            tri_idx = stack.pop()
            comp.append(tri_idx)
            for vertex in faces[tri_idx]:
                for nbr in triangles_by_vertex.get(int(vertex), []):
                    if visited[nbr]:
                        continue
                    visited[nbr] = 1
                    stack.append(nbr)

        if comp:
            components.append(comp)

    return components


def quantized_uv_key(u: float, v: float, quant: float = 1e-6) -> Tuple[int, int]:
    return (int(round(float(u) / quant)), int(round(float(v) / quant)))


def connected_components_from_raw_triangles(triangles_uv: np.ndarray) -> List[List[int]]:
    triangles_by_uv: Dict[Tuple[int, int], List[int]] = {}
    for tri_idx in range(triangles_uv.shape[0]):
        tri = triangles_uv[tri_idx]
        for p in tri:
            key = quantized_uv_key(float(p[0]), float(p[1]))
            triangles_by_uv.setdefault(key, []).append(tri_idx)

    visited = np.zeros(triangles_uv.shape[0], dtype=np.uint8)
    components: List[List[int]] = []

    for start in range(triangles_uv.shape[0]):
        if visited[start]:
            continue

        stack = [start]
        visited[start] = 1
        comp: List[int] = []

        while stack:
            tri_idx = stack.pop()
            comp.append(tri_idx)
            tri = triangles_uv[tri_idx]
            for p in tri:
                key = quantized_uv_key(float(p[0]), float(p[1]))
                for nbr in triangles_by_uv.get(key, []):
                    if visited[nbr]:
                        continue
                    visited[nbr] = 1
                    stack.append(nbr)

        if comp:
            components.append(comp)

    return components


def uv_to_px(uv: np.ndarray, width: int, height: int) -> np.ndarray:
    px = np.empty_like(uv, dtype=np.float64)
    px[:, 0] = np.clip(uv[:, 0], 0.0, 1.0) * max(1, width - 1)
    px[:, 1] = (1.0 - np.clip(uv[:, 1], 0.0, 1.0)) * max(1, height - 1)
    return px


def rasterize_triangle_into_map(id_map: np.ndarray, tri_px: np.ndarray, island_id: int, background_id: int) -> None:
    x0, y0 = tri_px[0]
    x1, y1 = tri_px[1]
    x2, y2 = tri_px[2]

    min_x = max(0, int(math.floor(min(x0, x1, x2))))
    max_x = min(id_map.shape[1] - 1, int(math.ceil(max(x0, x1, x2))))
    min_y = max(0, int(math.floor(min(y0, y1, y2))))
    max_y = min(id_map.shape[0] - 1, int(math.ceil(max(y0, y1, y2))))

    if min_x > max_x or min_y > max_y:
        return

    den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
    if abs(den) < 1e-12:
        return

    xs = np.arange(min_x, max_x + 1, dtype=np.float64)
    ys = np.arange(min_y, max_y + 1, dtype=np.float64)
    gx, gy = np.meshgrid(xs, ys)

    w0 = ((y1 - y2) * (gx - x2) + (x2 - x1) * (gy - y2)) / den
    w1 = ((y2 - y0) * (gx - x2) + (x0 - x2) * (gy - y2)) / den
    w2 = 1.0 - w0 - w1

    mask = (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6)
    if not np.any(mask):
        return

    sub = id_map[min_y : max_y + 1, min_x : max_x + 1]
    paint_mask = mask & (sub == background_id)
    sub[paint_mask] = island_id
    id_map[min_y : max_y + 1, min_x : max_x + 1] = sub


def islands_from_mesh_payload(payload: Dict[str, Any]) -> Tuple[List[IslandData], int, int]:
    width = int(payload.get("width", 0))
    height = int(payload.get("height", 0))
    if width <= 0 or height <= 0:
        raise ValueError("Mesh input requires positive width and height.")

    background_id = int(payload.get("background_id", 0))

    uv_vertices = payload.get("uv_vertices")
    faces = payload.get("faces")
    triangles = payload.get("triangles")

    if uv_vertices is not None and faces is not None:
        uv_vertices_arr = parse_float_points(uv_vertices, "uv_vertices")
        faces_arr = np.asarray(faces, dtype=np.int64)
        if faces_arr.ndim != 2 or faces_arr.shape[1] != 3:
            raise ValueError("faces must be an (M,3) array.")

        if np.any(faces_arr < 0) or np.any(faces_arr >= uv_vertices_arr.shape[0]):
            raise ValueError("faces contain out-of-range UV vertex indices.")

        triangles_uv = uv_vertices_arr[faces_arr]
        components = connected_components_from_faces(faces_arr)

    elif triangles is not None:
        triangles_uv = np.asarray(triangles, dtype=np.float64)
        if triangles_uv.ndim != 3 or triangles_uv.shape[1:] != (3, 2):
            raise ValueError("triangles must be an (M,3,2) array.")
        components = connected_components_from_raw_triangles(triangles_uv)

    else:
        raise ValueError("Mesh payload needs either (uv_vertices + faces) or triangles.")

    id_map = np.full((height, width), background_id, dtype=np.int64)
    islands: List[IslandData] = []

    next_island_id = 1
    for _comp_idx, comp in enumerate(components, start=1):
        tri_indices = np.asarray(comp, dtype=np.int64)
        comp_tris = triangles_uv[tri_indices]

        while next_island_id == background_id:
            next_island_id += 1
        island_id = next_island_id
        next_island_id += 1

        for tri_uv in comp_tris:
            tri_px = uv_to_px(tri_uv, width, height)
            rasterize_triangle_into_map(id_map, tri_px, island_id=island_id, background_id=background_id)

        ys, xs = np.where(id_map == island_id)
        if xs.size == 0:
            continue

        pixels = np.column_stack((xs, ys)).astype(np.int32)
        uv_points = comp_tris.reshape(-1, 2)
        islands.append(
            IslandData(
                island_id=island_id,
                pixels=pixels,
                pixel_uvs=None,
                uv_points=uv_points.astype(np.float32),
            )
        )

    if not islands:
        raise ValueError("No islands were detected/rasterized from mesh payload.")

    return islands, width, height


def load_payload(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError("Top-level JSON payload must be an object.")
    return data


def load_islands(
    payload: Dict[str, Any],
    payload_base_dir: Path,
    cli_id_map: Optional[Path],
    background_id_override: Optional[int],
) -> Tuple[List[IslandData], int, int]:
    background_id = int(
        background_id_override
        if background_id_override is not None
        else payload.get("background_id", 0)
    )

    id_map_path = cli_id_map
    if id_map_path is None and isinstance(payload.get("id_map"), str):
        id_map_path = resolve_path(payload_base_dir, payload["id_map"])

    if id_map_path is not None:
        ids = load_id_map(id_map_path)
        return islands_from_id_map(ids, background_id=background_id)

    if isinstance(payload.get("islands"), list):
        return islands_from_explicit_payload(payload, payload_base_dir)

    if payload.get("uv_vertices") is not None or payload.get("triangles") is not None:
        return islands_from_mesh_payload(payload)

    raise ValueError(
        "Could not determine input mode. Provide id_map, islands, or mesh UV data (uv_vertices/faces or triangles)."
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate per-UV-island gradient PNG.")
    parser.add_argument(
        "--input",
        type=str,
        default=None,
        help="Path to JSON payload (id_map, islands, or mesh UV data).",
    )
    parser.add_argument(
        "--id-map",
        type=str,
        default=None,
        help="Optional raster ID map PNG path (overrides payload.id_map).",
    )
    parser.add_argument(
        "--output",
        type=str,
        required=True,
        help="Output PNG path.",
    )
    parser.add_argument(
        "--background-id",
        type=int,
        default=None,
        help="Background ID value in ID maps (default 0).",
    )
    parser.add_argument(
        "--opaque-bg",
        action="store_true",
        help="Write opaque black background instead of transparent.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    payload: Dict[str, Any] = {}
    payload_base_dir = Path.cwd()

    if args.input:
        payload_path = Path(args.input).resolve()
        payload = load_payload(payload_path)
        payload_base_dir = payload_path.parent

    cli_id_map = Path(args.id_map).resolve() if args.id_map else None

    islands, width, height = load_islands(
        payload=payload,
        payload_base_dir=payload_base_dir,
        cli_id_map=cli_id_map,
        background_id_override=args.background_id,
    )

    rgba = render_island_gradients(
        width=width,
        height=height,
        islands=islands,
        transparent_background=not args.opaque_bg,
    )

    output_path = Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, mode="RGBA").save(output_path, format="PNG")

    print(
        f"Saved {output_path} ({width}x{height}) with {len(islands)} islands, "
        f"background={'opaque-black' if args.opaque_bg else 'transparent'}"
    )


if __name__ == "__main__":
    main()
