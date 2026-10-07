#!/usr/bin/env python3
"""用 FreeType 把 "R" 字形渲染成启动器图标（黑底白字）。

用法:
  python3 make_icon.py <font.ttf> <out.png> <size> [mode]
    mode: square | round | fg
      square 普通方形图标（黑底白 R）
      round  圆形图标（圆形黑底白 R）
      fg     adaptive icon 前景（透明底白 R，R 落在中心 72/108 安全区内）
"""
import ctypes, struct, sys, zlib

FT_LOAD_RENDER = 0x4
FT_PIXEL_MODE_GRAY = 2


class FT_Bitmap(ctypes.Structure):
    _fields_ = [
        ("rows", ctypes.c_uint),
        ("width", ctypes.c_uint),
        ("pitch", ctypes.c_int),
        ("buffer", ctypes.POINTER(ctypes.c_ubyte)),
        ("num_grays", ctypes.c_ushort),
        ("pixel_mode", ctypes.c_ubyte),
        ("palette_mode", ctypes.c_ubyte),
        ("palette", ctypes.c_void_p),
    ]


class FT_GlyphSlotRec(ctypes.Structure):
    _fields_ = [
        ("library", ctypes.c_void_p),
        ("face", ctypes.c_void_p),
        ("next", ctypes.c_void_p),
        ("glyph_index", ctypes.c_uint),
        ("generic", ctypes.c_byte * 16),
        ("metrics", ctypes.c_byte * 64),
        ("linearHoriAdvance", ctypes.c_long),
        ("linearVertAdvance", ctypes.c_long),
        ("advance_x", ctypes.c_long),
        ("advance_y", ctypes.c_long),
        ("format", ctypes.c_uint),
        ("bitmap", FT_Bitmap),
        ("bitmap_left", ctypes.c_int),
        ("bitmap_top", ctypes.c_int),
    ]


class FT_FaceRec(ctypes.Structure):
    _fields_ = [
        ("num_faces", ctypes.c_long),
        ("face_index", ctypes.c_long),
        ("face_flags", ctypes.c_long),
        ("style_flags", ctypes.c_long),
        ("num_glyphs", ctypes.c_long),
        ("family_name", ctypes.c_char_p),
        ("style_name", ctypes.c_char_p),
        ("num_fixed_sizes", ctypes.c_int),
        ("available_sizes", ctypes.c_void_p),
        ("num_charmaps", ctypes.c_int),
        ("charmaps", ctypes.c_void_p),
        ("generic", ctypes.c_byte * 16),
        ("bbox_xmin", ctypes.c_long), ("bbox_ymin", ctypes.c_long),
        ("bbox_xmax", ctypes.c_long), ("bbox_ymax", ctypes.c_long),
        ("units_per_EM", ctypes.c_ushort),
        ("ascender", ctypes.c_short),
        ("descender", ctypes.c_short),
        ("height", ctypes.c_short),
        ("max_advance_width", ctypes.c_short),
        ("max_advance_height", ctypes.c_short),
        ("underline_position", ctypes.c_short),
        ("underline_thickness", ctypes.c_short),
        ("glyph", ctypes.c_void_p),
        ("size", ctypes.c_void_p),
        ("charmap", ctypes.c_void_p),
    ]


def load_glyph_bitmap(font_path, char, px):
    """渲染单个字符，返回 (宽, 高, pitch, bytes) 的 8bit 灰度位图。"""
    ft = ctypes.CDLL("libfreetype.so.6")
    lib = ctypes.c_void_p()
    if ft.FT_Init_FreeType(ctypes.byref(lib)) != 0:
        raise RuntimeError("FT_Init_FreeType failed")
    face = ctypes.POINTER(FT_FaceRec)()
    if ft.FT_New_Face(lib, font_path.encode(), 0, ctypes.byref(face)) != 0:
        raise RuntimeError("FT_New_Face failed: " + font_path)
    if ft.FT_Set_Pixel_Sizes(face, 0, px) != 0:
        raise RuntimeError("FT_Set_Pixel_Sizes failed")
    if ft.FT_Load_Char(face, ctypes.c_ulong(ord(char)), FT_LOAD_RENDER) != 0:
        raise RuntimeError("FT_Load_Char failed")
    slot = ctypes.cast(face.contents.glyph, ctypes.POINTER(FT_GlyphSlotRec)).contents
    bm = slot.bitmap
    if bm.pixel_mode != FT_PIXEL_MODE_GRAY:
        raise RuntimeError("unexpected pixel_mode=%d" % bm.pixel_mode)
    rows, width, pitch = bm.rows, bm.width, bm.pitch
    data = ctypes.string_at(bm.buffer, pitch * rows)
    return width, rows, pitch, data


def ink_bbox(w, h, pitch, data):
    """返回实际墨迹包围盒 (x0, y0, x1, y1)，右下开区间。"""
    x0, y0, x1, y1 = w, h, 0, 0
    for y in range(h):
        row = data[y * pitch:(y + 1) * pitch]
        for x in range(w):
            if row[x] > 8:
                if x < x0: x0 = x
                if x > x1: x1 = x
                if y < y0: y0 = y
                if y > y1: y1 = y
    if x1 < x0:
        return None
    return (x0, y0, x1 + 1, y1 + 1)


def render_R(font_path, tile, cap_ratio, char="R"):
    """把 R 渲染进 tile×tile 的覆盖图，返回 [[coverage 0..1]]。

    cap_ratio 是「字形墨迹高度 / tile」，不是字号比例：先用参考字号量出
    该字体的实际字高比例，再反推字号，这样换字体也能精确占同样高度。
    """
    P_REF = 100
    w, h, pitch, data = load_glyph_bitmap(font_path, char, P_REF)
    bb = ink_bbox(w, h, pitch, data)
    if bb is None:
        raise RuntimeError("empty glyph")
    ink_ratio = (bb[3] - bb[1]) / float(P_REF)

    P = max(4, int(round(cap_ratio * tile / ink_ratio)))
    w, h, pitch, data = load_glyph_bitmap(font_path, char, P)
    bb = ink_bbox(w, h, pitch, data)
    if bb is None:
        raise RuntimeError("empty glyph at size %d" % P)
    x0, y0, x1, y1 = bb
    gw, gh = x1 - x0, y1 - y0

    cov = [[0.0] * tile for _ in range(tile)]
    ox = (tile - gw) // 2
    oy = (tile - gh) // 2
    for y in range(gh):
        srow = data[(y0 + y) * pitch:(y0 + y) * pitch + w]
        drow = cov[oy + y]
        for x in range(gw):
            drow[ox + x] = srow[x0 + x] / 255.0
    return cov


def circle_cov(tile, ss=4):
    """圆形遮罩覆盖率。"""
    out = [[0.0] * tile for _ in range(tile)]
    r = tile / 2.0
    n = ss * ss
    for y in range(tile):
        for x in range(tile):
            acc = 0
            for dy in range(ss):
                py = y + (dy + 0.5) / ss
                for dx in range(ss):
                    px = x + (dx + 0.5) / ss
                    if (px - r) ** 2 + (py - r) ** 2 <= r * r:
                        acc += 1
            out[y][x] = acc / n
    return out


def write_png(path, w, h, get_pixel):
    """get_pixel(x,y) -> (r,g,b,a)"""
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        for x in range(w):
            r, g, b, a = get_pixel(x, y)
            raw += bytes((r, g, b, a))
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


BG = 0x000000  # 纯黑底
FG = 255


def build(font_path, out, tile, mode, cap_ratio=None):
    if mode == "fg":
        cr = cap_ratio or 0.44          # 108 视口里 R 高约 47px，落在中央 72 安全区内
        cov = render_R(font_path, tile, cr)
        mask = None
    elif mode == "round":
        cr = cap_ratio or 0.50
        cov = render_R(font_path, tile, cr)
        mask = circle_cov(tile)
    else:
        cr = cap_ratio or 0.52
        cov = render_R(font_path, tile, cr)
        mask = None

    def px(x, y):
        if mode == "fg":
            a = int(round(cov[y][x] * 255))
            return (FG, FG, FG, a)
        m = mask[y][x] if mask else 1.0
        # 黑底 + 白色字形
        v = BG + (FG - BG) * cov[y][x]
        r = g = b = int(round(v))
        a = int(round(m * 255))
        return (r, g, b, a)

    write_png(out, tile, tile, px)
    print("wrote %s (%dx%d, %s, cap=%.2f)" % (out, tile, tile, mode, cr))


if __name__ == "__main__":
    font = sys.argv[1]
    out = sys.argv[2]
    size = int(sys.argv[3])
    mode = sys.argv[4] if len(sys.argv) > 4 else "square"
    cap = float(sys.argv[5]) if len(sys.argv) > 5 else None
    build(font, out, size, mode, cap)
