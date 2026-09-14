// Instagram Reel renderer for Beyond Paradise posts — HyperFrames (headless Chrome + FFmpeg,
// CPU-only, Apache-2.0, telemetry disabled). Same brand tokens as card.py; 9:16 for Reels.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Highlight the first number with a comma/decimal (the "hero figure") in gold. */
function heroNumber(text) { const e = esc(text); return e.replace(/(\d[\d,.]{2,})/, '<span class="num">$1</span>'); }

export function buildComposition(spec, { width = 1080, height = 1920, seconds = 8 } = {}) {
  // A Reel is glanced at: keep the first sentence or two of each block, hard-capped.
  const clip = (s, max) => { const out = []; for (const sent of String(s || '').split(/(?<=[.!?])\s+/)) { if ((out.join(' ') + ' ' + sent).trim().length > max) break; out.push(sent); } if (out.length) return out.join(' ').trim(); const cut = String(s || '').slice(0, max - 1); return cut.slice(0, cut.lastIndexOf(' ')) + '…'; };
  const lines = (spec.lines || []).map((l) => l.replace(/^(Why it matters|What I'd do|What changed): /, ''));
  const body = esc(clip(lines[0], 220));
  const body2 = esc(clip(lines[1], 170));
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@1,700&family=Inter:wght@400;600&display=swap">
<style>
html,body{margin:0;background:#09090B}
#stage{position:relative;width:${width}px;height:${height}px;background:#09090B;color:#F5F0E8;font-family:Inter,system-ui,sans-serif;overflow:hidden}
.pad{position:absolute;left:88px;right:88px}
.label{top:140px;font-weight:600;font-size:30px;letter-spacing:.08em;color:#C9A96E;text-transform:uppercase}
.date{top:140px;text-align:right;font-size:28px;color:#9A968E}
.rule{position:absolute;left:88px;right:88px;top:196px;height:2px;background:#C9A96E;transform-origin:left}
.content{position:absolute;left:88px;right:88px;top:270px;bottom:330px;display:flex;flex-direction:column;gap:44px;justify-content:flex-start}
.head{font-family:'Playfair Display',Georgia,serif;font-style:italic;font-weight:700;font-size:84px;line-height:1.08}
.num{color:#C9A96E}
.tag{align-self:flex-start;font-weight:600;font-size:28px;letter-spacing:.06em;color:#4AABB8;border:2px solid #2A7B8C;border-radius:8px;padding:10px 20px;text-transform:uppercase}
.body{font-size:40px;line-height:1.42}
.body2{font-size:33px;line-height:1.42;color:#CFC9BE}
.foot{position:absolute;left:88px;right:88px;bottom:120px;border-top:2px solid #2A2A30;padding-top:28px}
.brand{font-family:'Playfair Display',Georgia,serif;font-size:40px;color:#C9A96E}
.sub{font-size:26px;color:#9A968E;margin-top:8px}
</style></head><body>
<div id="stage" data-composition-id="card" data-start="0" data-duration="${seconds}" data-width="${width}" data-height="${height}" data-fps="30">
  <div class="pad label clip" data-start="0" data-duration="${seconds}">${esc(spec.label)}</div>
  <div class="pad date clip" data-start="0" data-duration="${seconds}">${esc(spec.date)}</div>
  <div class="rule clip" data-start="0" data-duration="${seconds}"></div>
  <div class="content clip" data-start="0" data-duration="${seconds}">
    <div class="head" id="head">${heroNumber(spec.headline)}</div>
    <div class="tag" id="tag">${esc(spec.tag)}</div>
    <div class="body" id="body">${body}</div>
    ${body2 ? `<div class="body2" id="body2">${body2}</div>` : ''}
  </div>
  <div class="foot clip" data-start="0" data-duration="${seconds}"><div class="brand">${esc(spec.brand)}</div><div class="sub">Daily tourism intelligence for Zanzibar &amp; Dar es Salaam</div></div>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>
  <script>
    const tl = gsap.timeline({ paused: true });
    tl.from(".rule", { scaleX: 0, duration: 0.6 }, 0.1)
      .from(".label, .date", { opacity: 0, y: -12, duration: 0.5 }, 0.2)
      .from("#head", { opacity: 0, y: 40, duration: 0.9, ease: "power3.out" }, 0.5)
      .from(".num", { color: "#F5F0E8", duration: 0.6 }, 1.4)
      .from("#tag", { opacity: 0, x: -20, duration: 0.5 }, 1.6)
      .from("#body", { opacity: 0, y: 24, duration: 0.8 }, 2.0)
      .from("#body2", { opacity: 0, y: 24, duration: 0.8 }, 3.2)
      .from(".foot", { opacity: 0, duration: 0.6 }, 3.8);
    window.__timelines = window.__timelines || {}; window.__timelines.card = tl;
  </script>
</div></body></html>`;
}

/** Render a draft's spec to an MP4 (9:16). Returns the mp4 path. ~60-90 s on this Mac, CPU only. */
export function renderReel(id, spec, outDir = path.join(HERE, 'reels')) {
  const dir = path.join(outDir, id); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), buildComposition(spec));
  const out = path.join(outDir, `${id}.mp4`);
  execFileSync('npx', ['hyperframes', 'render', dir, '-o', out, '--quality', 'looks', '--quiet'], { cwd: HERE, stdio: 'pipe', timeout: 600000 });
  if (!fs.existsSync(out)) throw new Error('hyperframes produced no output');
  return out;
}
