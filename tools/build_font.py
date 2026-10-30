"""Builds overlay/fonts/grand9k.json from the server's speech-bubble font.

Speech bubbles use 'Grand9K Pixel' at 6pt (8 px) - interface/fonts/Grand9K_Pixel_modif.ttf in the
server source (the version with Cyrillic). This turns every glyph into its exact pixel pattern plus
its advance width, so the overlay can (a) predict how BYOND wraps and sizes a Russian bubble and
(b) draw English with exactly the same pixels, size and outline.

Usage: python tools/build_font.py path/to/Grand9K_Pixel_modif.ttf overlay/fonts/grand9k.json
"""
import json
import sys

from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw

EM_PX = int(sys.argv[3]) if len(sys.argv) > 3 else 8  # 6pt at 96 dpi = 8 px; Pixellari 12pt = 16 px
SS = 8  # supersampling


def flatten(ops, upem):
    """Recording-pen operations -> list of polygons in pixel units (y up)."""
    polys, cur = [], []
    scale = EM_PX / upem
    for op, args in ops:
        if op == 'moveTo':
            if cur:
                polys.append(cur)
            cur = [args[0]]
        elif op in ('lineTo',):
            cur.append(args[0])
        elif op in ('qCurveTo', 'curveTo'):
            # pixel fonts are made of straight lines; take the end points of curves
            cur.extend(args)
        elif op in ('closePath', 'endPath'):
            if cur:
                polys.append(cur)
            cur = []
    if cur:
        polys.append(cur)
    return [[(x * scale, y * scale) for x, y in p if p] for p in polys]


def main(src, dst):
    font = TTFont(src)
    upem = font['head'].unitsPerEm
    cmap = font.getBestCmap()
    gs = font.getGlyphSet()
    hmtx = font['hmtx']
    asc = round(font['hhea'].ascent * EM_PX / upem)
    desc = round(-font['hhea'].descent * EM_PX / upem)
    out = {'font': font['name'].getDebugName(1), 'em': EM_PX, 'ascent': asc, 'descent': desc, 'glyphs': {}}
    for cp, gname in sorted(cmap.items()):
        if cp > 0xFFFF:
            continue
        adv = hmtx[gname][0] * EM_PX / upem
        pen = DecomposingRecordingPen(gs)
        gs[gname].draw(pen)
        polys = flatten(pen.value, upem)
        top = asc + 2
        H = asc + desc + 4
        W = int(adv) + 6
        img = Image.new('L', (W * SS, H * SS), 0)
        d = ImageDraw.Draw(img)
        # even-odd fill by xor-ing each contour
        for p in polys:
            if len(p) < 3:
                continue
            layer = Image.new('L', img.size, 0)
            ImageDraw.Draw(layer).polygon([((x + 2) * SS, (top - y) * SS) for x, y in p], fill=255)
            img = Image.fromarray(__import__('numpy').bitwise_xor(__import__('numpy').asarray(img), __import__('numpy').asarray(layer)))
        small = img.resize((W, H), Image.BOX)
        px = small.load()
        rows = []
        on = [(x, y) for y in range(H) for x in range(W) if px[x, y] >= 128]
        g = {'a': round(adv)}
        if on:
            x0 = min(x for x, _ in on)
            x1 = max(x for x, _ in on)
            y0 = min(y for _, y in on)
            y1 = max(y for _, y in on)
            for y in range(y0, y1 + 1):
                rows.append(''.join('1' if px[x, y] >= 128 else '0' for x in range(x0, x1 + 1)))
            # x relative to pen position, y relative to baseline (positive = above)
            g.update({'x': x0 - 2, 'y': top - y0, 'r': rows})
        out['glyphs'][str(cp)] = g
    with open(dst, 'w', encoding='utf-8') as f:
        json.dump(out, f, separators=(',', ':'))
    print('glyphs:', len(out['glyphs']), 'ascent', asc, 'descent', desc)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
