#!/usr/bin/env python3
"""Branded Instagram card for Beyond Paradise Adventures. Deterministic, $0.
usage: card.py <spec.json> <out.png>   spec: {label, headline, lines[], tag, date, brand, tagline}
       card.py --slides <spec.json> <outdir>  carousel: spec {brand, tag, date, label, slides:[{role,text,counter,recap?}]} -> outdir/slide-N.png
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
def render_slides(spec, outdir):
    """Carousel mode: one 1080x1350 PNG per slide, same palette/type as the single card, counter top-right."""
    import os
    os.makedirs(outdir, exist_ok=True); M = 88; n = len(spec["slides"]); paths = []
    for i, s in enumerate(spec["slides"]):
        img = Image.new("RGB", (W, H), BASE); d = ImageDraw.Draw(img)
        def wrap(text, f, max_w):
            out = []
            for para in text.split("\n"):
                cur = ""
                for w in para.split():
                    c = (cur + " " + w).strip()
                    if d.textlength(c, font=f) <= max_w: cur = c
                    else:
                        if cur: out.append(cur)
                        cur = w
                out.append(cur)
            return out
        role = s.get("role"); counter = s.get("counter", f"{i+1}/{n}")
        d.text((M, 96), (spec.get("label", "") if role != "save" else "Save this").upper(), font=font(SANS_B, 30), fill=GOLD)
        f_c = font(SANS_B, 30); cw = d.textlength(counter, font=f_c); d.text((W - M - cw, 96), counter, font=f_c, fill=MUTED)
        d.line((M, 150, W - M, 150), fill=GOLD, width=2)
        if role == "hook": fonts, start, lim = SERIF_I, 112, 6
        elif role == "save": fonts, start, lim = SERIF, 72, 5
        else: fonts, start, lim = SERIF, 60, 9
        size = start
        while True:
            f = font(fonts, size); lines = wrap(s["text"], f, W - 2 * M)
            if len(lines) <= lim or size <= 40: break
            size -= 4
        lh = int(size * 1.25); block_h = len(lines) * lh
        y = max(200, (H - block_h) // 2 - 40)
        for ln in lines: d.text((M, y), ln, font=f, fill=CREAM if role != "save" else GOLD); y += lh
        if role == "save" and s.get("recap"):
            y += 30; f_r = font(SANS, 34)
            for ln in wrap(s["recap"], f_r, W - 2 * M)[:4]: d.text((M, y), ln, font=f_r, fill=MUTED); y += 48
        if role == "hook" and spec.get("tag"):
            f_tag = font(SANS_B, 28); tw = d.textlength(spec["tag"].upper(), font=f_tag); ty = H - 260
            d.rounded_rectangle((M, ty, M + tw + 40, ty + 52), radius=8, outline=TEAL, width=2); d.text((M + 20, ty + 11), spec["tag"].upper(), font=f_tag, fill=TEAL)
        d.line((M, H - 170, W - M, H - 170), fill="#2A2A30", width=2)
        d.text((M, H - 140), spec.get("brand", "Beyond Paradise Adventures"), font=font(SERIF, 40), fill=GOLD)
        if role == "hook": d.text((W - M - d.textlength("Swipe  \u2192", font=font(SANS, 30)), H - 132), "Swipe  \u2192", font=font(SANS, 30), fill=MUTED)
        p = os.path.join(outdir, f"slide-{i+1}.png"); img.save(p, "PNG", optimize=True); paths.append(p)
    print("\n".join(paths))
if len(sys.argv) >= 4 and sys.argv[1] == "--slides":
    render_slides(json.load(open(sys.argv[2])), sys.argv[3]); sys.exit(0)
spec = json.load(open(sys.argv[1]))
img = Image.new("RGB", (W, H), BASE); d = ImageDraw.Draw(img)
M = 88
# top label + date
f_label = font(SANS_B, 30); d.text((M, 96), spec.get("label", "").upper(), font=f_label, fill=GOLD, spacing=4)
f_date = font(SANS, 30); dt = spec.get("date", ""); dw = d.textlength(dt, font=f_date); d.text((W - M - dw, 96), dt, font=f_date, fill=MUTED)
d.line((M, 150, W - M, 150), fill=GOLD, width=2)
# headline (serif italic), wrapped
def wrap_measured(text, f, max_w):
    lines, cur = [], ""
    for w in text.split():
        cand = (cur + " " + w).strip()
        if d.textlength(cand, font=f) <= max_w: cur = cand
        else:
            if cur: lines.append(cur)
            cur = w
    if cur: lines.append(cur)
    return lines
head = spec.get("headline", ""); size = 84
while size > 48:
    f_head = font(SERIF_I, size); lines = wrap_measured(head, f_head, W - 2 * M)
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
    for ln in wrap_measured(item, f_body, W - 2 * M):
        if y > H - 260: break
        d.text((M, y), ln, font=f_body, fill=CREAM); y += 54
    y += 18
# footer
d.line((M, H - 170, W - M, H - 170), fill="#2A2A30", width=2)
f_brand = font(SERIF, 40); d.text((M, H - 140), spec.get("brand", "Beyond Paradise Adventures"), font=f_brand, fill=GOLD)
# tagline: a PUBLISHED brand claim, supplied by cardSpec from config.reelTagline (audit finding 9)
tagline = spec.get("tagline") or spec.get("footer") or ""
if tagline:
    f_small = font(SANS, 26); d.text((M, H - 84), tagline, font=f_small, fill=MUTED)
img.save(sys.argv[2], "PNG", optimize=True); print(sys.argv[2])
