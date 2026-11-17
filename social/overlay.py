#!/usr/bin/env python3
"""Hook overlay for the automatic lane: a transparent 1080x1920 PNG with the hook on a dark translucent band in the upper third.
usage: overlay.py <spec.json> <out.png>     spec: {"hook": "<text>"}
Own file (not a mode of card.py): card.py runs its card code at import time, so its font list cannot be imported without drawing a card.
The font list below is the same list card.py uses for its sans bold (a test compares the two lists, so they cannot drift).
Refuses (exit 3, one line on stderr, no PNG written) when the text does not fit in 3 lines at the minimum size inside the 90 px safe margin,
or when none of the listed fonts exists (the default bitmap font is far too small to read on a phone)."""
import json, os, sys
from PIL import Image, ImageDraw, ImageFont
W, H = 1080, 1920
MARGIN = 90                      # safe margin left and right
MAX_LINES = 3
SIZE_MAX, SIZE_MIN, SIZE_STEP = 76, 44, 4
UPPER_THIRD = H // 3             # the band stays above y = 640
CENTER_Y = 440                   # below the app's top bar (about 250 px), inside the upper third
PAD = 44
BAND = (9, 9, 11, 170)           # DESIGN.md base #09090B, about 67 percent opaque
CREAM = (245, 240, 232, 255)     # DESIGN.md cream #F5F0E8
SANS_B = ["/Library/Fonts/Inter-SemiBold.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/System/Library/Fonts/Helvetica.ttc"]

def refuse(msg):
    sys.stderr.write("overlay refused: " + msg + "\n"); sys.exit(3)

def find_font():
    return next((p for p in SANS_B if os.path.exists(p)), None)

def wrap(draw, text, font, max_w):
    lines, cur = [], ""
    for w in text.split():
        cand = (cur + " " + w).strip()
        if draw.textlength(cand, font=font) <= max_w: cur = cand
        else:
            if cur: lines.append(cur)
            cur = w
    if cur: lines.append(cur)
    return lines

def layout(draw, text, path):
    max_w = W - 2 * MARGIN
    size = SIZE_MAX
    while size >= SIZE_MIN:
        f = ImageFont.truetype(path, size)
        lines = wrap(draw, text, f, max_w)
        if len(lines) <= MAX_LINES and all(draw.textlength(l, font=f) <= max_w for l in lines): return f, size, lines
        size -= SIZE_STEP
    refuse("the hook does not fit in %d lines at size %d inside the %d px margin" % (MAX_LINES, SIZE_MIN, MARGIN))

def main():
    if len(sys.argv) != 3: sys.stderr.write("usage: overlay.py <spec.json> <out.png>\n"); sys.exit(2)
    hook = " ".join(str(json.load(open(sys.argv[1])).get("hook", "")).split())
    if not hook: refuse("empty hook")
    path = find_font()
    if not path: refuse("no font file from the card.py list exists on this machine")
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(img)
    f, size, lines = layout(d, hook, path)
    lh = int(size * 1.25); block = lh * len(lines)
    top = CENTER_Y - block // 2; band_top, band_bottom = top - PAD, top + block + PAD
    if band_bottom > UPPER_THIRD: refuse("the band would leave the upper third")
    d.rectangle((0, band_top, W, band_bottom), fill=BAND)
    y = top
    for ln in lines:
        d.text(((W - d.textlength(ln, font=f)) / 2, y), ln, font=f, fill=CREAM); y += lh
    img.save(sys.argv[2], "PNG", optimize=True); print(sys.argv[2])

if __name__ == "__main__": main()
