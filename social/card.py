#!/usr/bin/env python3
"""Branded Instagram card for Beyond Paradise Adventures. Deterministic, $0.
usage: card.py <spec.json> <out.png>   spec: {label, headline, lines[], tag, date, brand}
Palette from DESIGN.md: base #09090B, gold #C9A96E, teal #2A7B8C, cream #F5F0E8. 1080x1350 (4:5)."""
import json, sys, textwrap
from PIL import Image, ImageDraw, ImageFont
W, H = 1080, 1350
BASE, GOLD, TEAL, CREAM, MUTED = "#09090B", "#C9A96E", "#4AABB8", "#F5F0E8", "#9A968E"
def font(name_candidates, size):
    for n in name_candidates:
        try: return ImageFont.truetype(n, size)
        except Exception: pass
    return ImageFont.load_default()
SERIF_I = ["/System/Library/Fonts/Supplemental/Georgia Bold Italic.ttf", "/System/Library/Fonts/Supplemental/Georgia Italic.ttf"]
SERIF = ["/System/Library/Fonts/Supplemental/Georgia.ttf"]
SANS = ["/Library/Fonts/Inter-Regular.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Helvetica.ttc"]
SANS_B = ["/Library/Fonts/Inter-SemiBold.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/System/Library/Fonts/Helvetica.ttc"]
spec = json.load(open(sys.argv[1]))
img = Image.new("RGB", (W, H), BASE); d = ImageDraw.Draw(img)
M = 88
# top label + date
f_label = font(SANS_B, 30); d.text((M, 96), spec.get("label", "").upper(), font=f_label, fill=GOLD, spacing=4)
f_date = font(SANS, 30); dt = spec.get("date", ""); dw = d.textlength(dt, font=f_date); d.text((W - M - dw, 96), dt, font=f_date, fill=MUTED)
d.line((M, 150, W - M, 150), fill=GOLD, width=2)
# headline (serif italic), wrapped
head = spec.get("headline", ""); size = 84
while size > 48:
    f_head = font(SERIF_I, size); lines = textwrap.wrap(head, width=max(12, int((W - 2 * M) / (size * 0.48))))
    if len(lines) <= 4: break
    size -= 6
y = 200
for ln in lines: d.text((M, y), ln, font=f_head, fill=CREAM); y += int(size * 1.12)
y += 26
# tag
tag = spec.get("tag")
if tag:
    f_tag = font(SANS_B, 28); tw = d.textlength(tag.upper(), font=f_tag)
    d.rounded_rectangle((M, y, M + tw + 40, y + 52), radius=8, outline=TEAL, width=2); d.text((M + 20, y + 11), tag.upper(), font=f_tag, fill=TEAL); y += 96
# body lines
f_body = font(SANS, 38)
for item in spec.get("lines", [])[:4]:
    for ln in textwrap.wrap(item, width=44):
        if y > H - 260: break
        d.text((M, y), ln, font=f_body, fill=CREAM); y += 54
    y += 18
# footer
d.line((M, H - 170, W - M, H - 170), fill="#2A2A30", width=2)
f_brand = font(SERIF, 40); d.text((M, H - 140), spec.get("brand", "Beyond Paradise Adventures"), font=f_brand, fill=GOLD)
f_small = font(SANS, 26); d.text((M, H - 84), spec.get("footer", "Daily tourism intelligence for Zanzibar & Dar es Salaam"), font=f_small, fill=MUTED)
img.save(sys.argv[2], "PNG", optimize=True); print(sys.argv[2])
