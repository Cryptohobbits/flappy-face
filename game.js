/* Flappy Face — an original tap-to-flap game. All art is drawn in code.
   Photos chosen by the player are processed locally and never leave the device. */
(() => {
'use strict';

// ---------- DOM ----------
const $ = id => document.getElementById(id);
const game = $('game'), cv = $('cv'), ctx = cv.getContext('2d');
const startEl = $('start'), overEl = $('over'), pausedEl = $('paused'), cropEl = $('crop');
const muteBtn = $('mute'), toastEl = $('toast');
const FONT = 'ui-rounded, "SF Pro Rounded", "Nunito", "Varela Round", "Trebuchet MS", system-ui, sans-serif';

// ---------- storage (safe in private mode) ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};
const KEY_BEST = 'flappyFace.best', KEY_FACE = 'flappyFace.face', KEY_MUTE = 'flappyFace.muted';

// ---------- tuning (logical px & seconds; play field is >= 640 tall) ----------
const BASE_H = 640, MIN_W = 270, MAX_ASPECT = 0.66, GROUND = 100;
const GRAVITY = 1500, FLAP_V = -460, MAX_FALL = 720, SPEED = 160;
const PIPE_W = 62, GAP_START = 160, GAP_MIN = 140, PIPE_SPACING = 215, CAP_H = 26, CAP_OVER = 4;
const BIRD_R = 14;         // collision radius (drawn body is a bit bigger: forgiving)
const STEP = 1 / 120;      // max physics sub-step

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

let W = 360, H = 640, scale = 1, dpr = 1, K = 1, groundY = H - GROUND;
let bw = 360, bh = 640; // CSS px size of the game box

const bird = { x: 180, y: 270, vy: 0, rot: 0, wing: 0, flapT: 0 };
let pipes = [];
let state = 'start';          // start | play | dying | over | paused
let score = 0, best = parseInt(store.get(KEY_BEST) || '0', 10) || 0, newBest = false;
let time = 0, overReadyAt = 0, shake = 0, flash = 0;
let muted = store.get(KEY_MUTE) === '1';
let faceImg = null;
let layers = [], groundLayer = null, skyGrad = null;

// ---------- sound (Web Audio, created on first user gesture) ----------
const sfx = (() => {
  let ac = null, master = null, noise = null;
  function unlock() {
    try {
      if (!ac) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ac = new AC();
        master = ac.createGain(); master.gain.value = 0.55; master.connect(ac.destination);
        const len = Math.floor(ac.sampleRate * 0.4);
        noise = ac.createBuffer(1, len, ac.sampleRate);
        const d = noise.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        const s = ac.createBufferSource(); s.buffer = ac.createBuffer(1, 1, 22050); s.connect(ac.destination); s.start(0); // iOS unlock
      }
      if (ac.state === 'suspended') { const p = ac.resume(); if (p && p.catch) p.catch(() => {}); }
    } catch (e) {}
  }
  function tone(f0, f1, dur, type, vol, delay = 0) {
    if (!ac || muted) return;
    const t = ac.currentTime + delay, o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.03);
  }
  function burst(dur, vol, freq) {
    if (!ac || muted) return;
    const t = ac.currentTime, s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    s.buffer = noise; f.type = 'lowpass'; f.frequency.value = freq;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(master); s.start(t); s.stop(t + dur + 0.02);
  }
  return {
    unlock,
    flap() { tone(420, 820, 0.09, 'triangle', 0.32); burst(0.06, 0.08, 2500); },
    score() { tone(988, 988, 0.07, 'square', 0.1); tone(1480, 1480, 0.16, 'square', 0.1, 0.07); },
    hit() { burst(0.2, 0.55, 1400); tone(200, 50, 0.28, 'sawtooth', 0.28); },
    fall() { tone(640, 160, 0.42, 'sine', 0.22, 0.12); },
    blip() { tone(660, 990, 0.08, 'sine', 0.25); }
  };
})();
['pointerdown', 'touchend', 'click', 'keydown'].forEach(ev => window.addEventListener(ev, sfx.unlock, { passive: true, capture: true }));

// ---------- seeded random for stable scenery ----------
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// ---------- layout ----------
function resize() {
  const vw = window.innerWidth, vh = window.innerHeight;
  bw = vw; bh = vh;
  if (bw / bh > MAX_ASPECT) bw = Math.round(bh * MAX_ASPECT);
  scale = Math.min(bh / BASE_H, bw / MIN_W);
  W = bw / scale; H = bh / scale; groundY = H - GROUND;
  dpr = Math.min(window.devicePixelRatio || 1, 3);
  K = scale * dpr;
  game.style.width = bw + 'px'; game.style.height = bh + 'px';
  game.style.setProperty('--s', scale.toFixed(4));
  cv.width = Math.round(bw * dpr); cv.height = Math.round(bh * dpr);
  buildScenery();
  if (state === 'start') { bird.x = W * 0.5; bird.y = H * 0.42; }
  if (crop.open) crop.layout();
}

function makeTile(lw, lh) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(lw * K)); c.height = Math.max(1, Math.ceil(lh * K));
  const g = c.getContext('2d'); g.scale(K, K);
  return { c, g, tw: c.width / K, th: c.height / K };
}

function drawCloud(g, x, y, s, shade) {
  const puffs = [[0, 0, 17], [17, -9, 21], [38, -3, 17], [53, 4, 12], [-15, 5, 12], [20, 7, 15], [36, 8, 13]];
  g.fillStyle = shade;
  g.beginPath(); for (const [px, py, r] of puffs) { g.moveTo(x + px * s + r * s, y + py * s + 4 * s); g.arc(x + px * s, y + py * s + 4 * s, r * s, 0, Math.PI * 2); } g.fill();
  g.fillStyle = '#fff';
  g.beginPath(); for (const [px, py, r] of puffs) { g.moveTo(x + px * s + r * s, y + py * s); g.arc(x + px * s, y + py * s, r * s, 0, Math.PI * 2); } g.fill();
}

function buildScenery() {
  const old = layers.map(l => l.off), oldG = groundLayer ? groundLayer.off : 0;
  skyGrad = ctx.createLinearGradient(0, 0, 0, groundY);
  skyGrad.addColorStop(0, '#48ade0'); skyGrad.addColorStop(0.55, '#86d3f0'); skyGrad.addColorStop(1, '#d8f3f6');

  const L = [];
  // clouds (far and near)
  for (const [seed, n, sMin, sMax, alpha, speed] of [[7, 5, 0.5, 0.75, 0.75, 7], [11, 3, 0.85, 1.15, 1, 17]]) {
    const band = H * 0.5, t = makeTile(560, band), r = rng(seed);
    t.g.globalAlpha = alpha;
    for (let i = 0; i < n; i++) {
      const x = (i + r() * 0.6) * t.tw / n, y = 30 + r() * (band - 80), s = sMin + r() * (sMax - sMin);
      for (const dx of [-t.tw, 0, t.tw]) drawCloud(t.g, x + dx, y, s, '#d3ecf5');
    }
    L.push({ ...t, y: H * 0.04, speed, always: true, off: 0 });
  }
  // far hills
  {
    const t = makeTile(600, 180), g = t.g, w = t.tw, h = t.th;
    g.beginPath(); g.moveTo(0, h);
    for (let i = 0, N = Math.ceil(w / 3); i <= N; i++) { const x = i * w / N, a = x / w * Math.PI * 2; g.lineTo(x, h - (95 + 32 * Math.sin(a * 2 + 1) + 20 * Math.sin(a * 5 + 2) + 8 * Math.sin(a * 9))); }
    g.lineTo(w, h); g.closePath(); g.fillStyle = '#b3e2d4'; g.fill();
    L.push({ ...t, y: groundY - t.th, speed: 12, off: 0 });
  }
  // near hills with little trees
  {
    const t = makeTile(420, 130), g = t.g, w = t.tw, h = t.th;
    const hy = x => { const a = x / w * Math.PI * 2; return h - (58 + 22 * Math.sin(a * 2 + 0.5) + 12 * Math.sin(a * 3 + 2.2)); };
    g.beginPath(); g.moveTo(0, h); for (let i = 0, N = Math.ceil(w / 3); i <= N; i++) { const x = i * w / N; g.lineTo(x, hy(x)); } g.lineTo(w, h); g.closePath();
    g.fillStyle = '#86cf9c'; g.fill(); g.lineWidth = 2; g.strokeStyle = '#6cb785'; g.stroke();
    const r = rng(5);
    for (let i = 0; i < 7; i++) {
      const x = (i + 0.2 + r() * 0.6) * w / 7, y = hy(x) + 6, s = 0.7 + r() * 0.5;
      for (const dx of [-w, 0, w]) {
        g.fillStyle = '#8a6a45'; g.fillRect(x + dx - 1.5 * s, y - 10 * s, 3 * s, 12 * s);
        g.fillStyle = '#4fae6b'; g.beginPath(); g.ellipse(x + dx, y - 17 * s, 8 * s, 12 * s, 0, 0, Math.PI * 2); g.fill();
        g.fillStyle = 'rgba(255,255,255,.18)'; g.beginPath(); g.ellipse(x + dx - 3 * s, y - 21 * s, 3 * s, 5 * s, 0, 0, Math.PI * 2); g.fill();
      }
    }
    L.push({ ...t, y: groundY - t.th + 2, speed: 28, off: 0 });
  }
  // bushes
  {
    const t = makeTile(360, 56), g = t.g, w = t.tw, h = t.th, r = rng(3), bs = [];
    for (let i = 0; i < 14; i++) bs.push([(i + r() * 0.5) * w / 14, 14 + r() * 13]);
    for (const [col, off] of [['#4ea85e', 0], ['#63bf6f', 4]]) {
      g.fillStyle = col; g.beginPath();
      for (const [x, rad] of bs) for (const dx of [-w, 0, w]) { g.moveTo(x + dx + rad, h - rad * 0.55 + off); g.arc(x + dx, h - rad * 0.55 + off, rad - off * 0.6, 0, Math.PI * 2); }
      g.fill();
    }
    g.fillStyle = 'rgba(255,255,255,.2)';
    for (const [x, rad] of bs) for (const dx of [-w, 0, w]) { g.beginPath(); g.arc(x + dx - rad * 0.3, h - rad * 0.9, rad * 0.25, 0, Math.PI * 2); g.fill(); }
    L.push({ ...t, y: groundY - t.th + 8, speed: 60, off: 0 });
  }
  L.forEach((l, i) => { l.off = old[i] || 0; });
  layers = L;

  // ground
  {
    const t = makeTile(336, GROUND + 2), g = t.g, w = t.tw, p = w / 14;
    const dirt = g.createLinearGradient(0, 0, 0, t.th); dirt.addColorStop(0, '#ecd08b'); dirt.addColorStop(1, '#d5ae62');
    g.fillStyle = dirt; g.fillRect(0, 0, w, t.th);
    g.fillStyle = '#8fd34a'; g.fillRect(0, 0, w, 17);
    g.fillStyle = '#77bf36';
    for (let x = -p; x < w + p; x += p) { g.beginPath(); g.moveTo(x, 3); g.lineTo(x + p / 2, 3); g.lineTo(x + p / 2 - 9, 15); g.lineTo(x - 9, 15); g.closePath(); g.fill(); }
    g.fillStyle = '#5a9a2c'; g.fillRect(0, 15, w, 3);
    g.fillStyle = '#3f7a24'; g.fillRect(0, 0, w, 2.5);
    g.fillStyle = 'rgba(255,255,255,.35)'; g.fillRect(0, 2.5, w, 2);
    g.fillStyle = '#c9a052'; g.fillRect(0, 18, w, 4);
    const r = rng(9);
    for (let i = 0; i < 26; i++) {
      const x = r() * w, y = 30 + r() * (GROUND - 40), rx = 2 + r() * 4;
      for (const dx of [-w, 0, w]) { g.fillStyle = 'rgba(150,105,45,.35)'; g.beginPath(); g.ellipse(x + dx, y, rx, rx * 0.6, 0, 0, Math.PI * 2); g.fill(); }
    }
    groundLayer = { ...t, y: groundY, speed: SPEED, off: oldG };
  }
}

function drawTiles(l) {
  const px = 1 / K;
  let x = -(l.off % l.tw); x = Math.round(x / px) * px - l.tw;
  for (; x < W + 20; x += l.tw) ctx.drawImage(l.c, x, l.y, l.tw, l.th);
}

// ---------- pipes ----------
let pipeGrad = null, capGrad = null;
function pipeGradients() {
  pipeGrad = ctx.createLinearGradient(0, 0, PIPE_W, 0);
  pipeGrad.addColorStop(0, '#2f9a63'); pipeGrad.addColorStop(0.18, '#63d18f'); pipeGrad.addColorStop(0.32, '#9ff0bf');
  pipeGrad.addColorStop(0.5, '#4fc07e'); pipeGrad.addColorStop(1, '#2a7f52');
  capGrad = ctx.createLinearGradient(-CAP_OVER, 0, PIPE_W + CAP_OVER, 0);
  capGrad.addColorStop(0, '#35a56c'); capGrad.addColorStop(0.2, '#79dea2'); capGrad.addColorStop(0.34, '#b6f7cf');
  capGrad.addColorStop(0.55, '#58c886'); capGrad.addColorStop(1, '#2d8757');
}
function rr(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function drawPipe(p) {
  const gt = p.gapY - p.gap / 2, gb = p.gapY + p.gap / 2;
  ctx.save(); ctx.translate(p.x, 0);
  ctx.lineWidth = 2.5; ctx.strokeStyle = '#1f5a3d';
  ctx.fillStyle = pipeGrad;
  ctx.fillRect(0, -10, PIPE_W, gt - CAP_H + 10); ctx.strokeRect(0, -10, PIPE_W, gt - CAP_H + 10);
  ctx.fillRect(0, gb + CAP_H, PIPE_W, groundY - gb - CAP_H + 5); ctx.strokeRect(0, gb + CAP_H, PIPE_W, groundY - gb - CAP_H + 5);
  // subtle rings
  ctx.fillStyle = 'rgba(20,70,45,.18)';
  for (let y = gt - CAP_H - 40; y > -10; y -= 70) ctx.fillRect(1.5, y, PIPE_W - 3, 5);
  for (let y = gb + CAP_H + 40; y < groundY; y += 70) ctx.fillRect(1.5, y, PIPE_W - 3, 5);
  ctx.fillStyle = capGrad;
  rr(-CAP_OVER, gt - CAP_H, PIPE_W + CAP_OVER * 2, CAP_H, 5); ctx.fill(); ctx.stroke();
  rr(-CAP_OVER, gb, PIPE_W + CAP_OVER * 2, CAP_H, 5); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(20,70,45,.25)';
  ctx.fillRect(-CAP_OVER + 2, gt - 6, PIPE_W + CAP_OVER * 2 - 4, 4.5);
  ctx.fillRect(-CAP_OVER + 2, gb + CAP_H - 6, PIPE_W + CAP_OVER * 2 - 4, 4.5);
  ctx.restore();
}
function newPipe(x) {
  const gap = Math.max(GAP_MIN, GAP_START - score * 0.7);
  const margin = 56, minY = margin + gap / 2, maxY = groundY - margin - gap / 2;
  const prev = pipes.length ? pipes[pipes.length - 1].gapY : (minY + maxY) / 2;
  const lo = Math.max(minY, prev - 170), hi = Math.min(maxY, prev + 170);
  pipes.push({ x, gap, gapY: lo + Math.random() * Math.max(0, hi - lo), scored: false });
}
function circleRect(cx, cy, r, x, y, w, h) {
  const nx = clamp(cx, x, x + w), ny = clamp(cy, y, y + h), dx = cx - nx, dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}
function hitsPipe(p) {
  const gt = p.gapY - p.gap / 2, gb = p.gapY + p.gap / 2, bx = bird.x, by = bird.y, r = BIRD_R;
  return circleRect(bx, by, r, p.x, -2000, PIPE_W, gt + 2000) ||
    circleRect(bx, by, r, p.x - CAP_OVER, gt - CAP_H, PIPE_W + CAP_OVER * 2, CAP_H) ||
    circleRect(bx, by, r, p.x, gb, PIPE_W, groundY - gb + 50) ||
    circleRect(bx, by, r, p.x - CAP_OVER, gb, PIPE_W + CAP_OVER * 2, CAP_H);
}

// ---------- the bird ----------
let bodyGrad = null;
function birdGradients() {
  bodyGrad = ctx.createRadialGradient(-5, -8, 2, 0, 0, 19);
  bodyGrad.addColorStop(0, '#7fe3ef'); bodyGrad.addColorStop(0.6, '#3ec1d3'); bodyGrad.addColorStop(1, '#2699ad');
}
function drawBird() {
  const OL = '#1d4e5c';
  ctx.save();
  ctx.translate(bird.x, bird.y); ctx.rotate(bird.rot);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.lineWidth = 2; ctx.strokeStyle = OL;
  const wingA = (state === 'dying' || state === 'over') ? 0.5 : Math.sin(bird.wing) * 0.6;
  // tail feathers
  ctx.save(); ctx.translate(-14, 2);
  for (const [a, col] of [[-0.5, '#ff6b6b'], [0.05, '#ffd84d'], [0.55, '#ff6b6b']]) {
    ctx.save(); ctx.rotate(Math.PI + a); ctx.beginPath(); ctx.ellipse(8, 0, 9, 3.6, 0, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill(); ctx.stroke(); ctx.restore();
  }
  ctx.restore();
  // head tuft
  ctx.fillStyle = '#2699ad';
  for (const [x, a] of [[-3, -0.5], [2, -0.1]]) { ctx.save(); ctx.translate(x, -16); ctx.rotate(a); ctx.beginPath(); ctx.ellipse(0, -5, 2.8, 6, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.restore(); }
  // body
  ctx.beginPath(); ctx.arc(0, 0, 18, 0, Math.PI * 2); ctx.fillStyle = bodyGrad; ctx.fill();
  ctx.save(); ctx.clip();
  ctx.beginPath(); ctx.ellipse(4, 10, 14, 9, 0, 0, Math.PI * 2); ctx.fillStyle = '#fff1c1'; ctx.fill();
  ctx.restore();
  ctx.lineWidth = 2.2; ctx.beginPath(); ctx.arc(0, 0, 18, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 2;
  if (faceImg) {
    const fx = 2, fy = -1, fr = 15.5;
    ctx.save(); ctx.beginPath(); ctx.arc(fx, fy, fr, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.drawImage(faceImg, fx - fr, fy - fr, fr * 2, fr * 2);
    ctx.restore();
    ctx.beginPath(); ctx.arc(fx, fy, fr + 1.2, 0, Math.PI * 2); ctx.lineWidth = 2.6; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.beginPath(); ctx.arc(fx, fy, fr + 2.6, 0, Math.PI * 2); ctx.lineWidth = 1.4; ctx.strokeStyle = OL; ctx.stroke();
    ctx.lineWidth = 2; ctx.strokeStyle = OL;
    drawBeak(15.5, 3);
  } else {
    // eye
    ctx.beginPath(); ctx.arc(7, -5, 6.8, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke();
    const look = clamp(bird.vy / 400, -1, 1) * 1.2;
    ctx.beginPath(); ctx.arc(9, -4.8 + look, 3.4, 0, Math.PI * 2); ctx.fillStyle = '#1a1a2e'; ctx.fill();
    ctx.beginPath(); ctx.arc(10.3, -6.3 + look, 1.3, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
    if (state === 'dying' || state === 'over') { // dizzy X eye
      ctx.beginPath(); ctx.arc(7, -5, 6.8, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(4.5, -7.5); ctx.lineTo(9.5, -2.5); ctx.moveTo(9.5, -7.5); ctx.lineTo(4.5, -2.5); ctx.stroke();
    }
    // blush
    ctx.fillStyle = 'rgba(255,140,165,.65)'; ctx.beginPath(); ctx.ellipse(4, 5, 3.6, 2.2, 0, 0, Math.PI * 2); ctx.fill();
    drawBeak(13, 0);
  }
  // wing
  ctx.save(); if (faceImg) ctx.translate(-13, 7); else ctx.translate(-5, 4); ctx.rotate(wingA);
  ctx.beginPath(); ctx.ellipse(-4, 0, 10, 6.5, -0.25, 0, Math.PI * 2); ctx.fillStyle = '#2aa3b8'; ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-10, 0); ctx.quadraticCurveTo(-4, 3.5, 2, 1); ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.restore();
  ctx.restore();
  function drawBeak(bx, by) {
    ctx.beginPath(); ctx.moveTo(bx, by - 1); ctx.quadraticCurveTo(bx + 9, by - 1.5, bx + 12, by + 3); ctx.lineTo(bx + 1, by + 4); ctx.closePath();
    ctx.fillStyle = '#ffae34'; ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(bx + 1, by + 4); ctx.lineTo(bx + 10, by + 4); ctx.quadraticCurveTo(bx + 7, by + 8.5, bx + 1, by + 7.5); ctx.closePath();
    ctx.fillStyle = '#f08a1c'; ctx.fill(); ctx.stroke();
  }
}

// ---------- game flow ----------
function show(el, on) { el.classList.toggle('hidden', !on); }
function updateStartUI() {
  $('best-start').textContent = best > 0 ? 'Best: ' + best : '';
  $('reset-face').hidden = !faceImg;
}
function toStart() {
  state = 'start'; pipes = []; score = 0; bird.vy = 0; bird.rot = 0; bird.x = W * 0.5; bird.y = H * 0.42;
  show(overEl, false); show(pausedEl, false); show(startEl, true); updateStartUI();
}
function startGame(fromStart) {
  pipes = []; score = 0; newBest = false; bird.vy = 0; bird.rot = 0;
  if (!fromStart) { bird.x = W * 0.3; bird.y = H * 0.42; }
  state = 'play';
  show(startEl, false); show(overEl, false); show(pausedEl, false);
  flap();
}
function flap() { bird.vy = FLAP_V; bird.flapT = 1; sfx.flap(); }
function hit() {
  if (state !== 'play') return;
  state = 'dying'; sfx.hit(); flash = 1; shake = 0.35; bird.vy = Math.max(bird.vy, 0);
  try { navigator.vibrate && navigator.vibrate(35); } catch (e) {}
  if (bird.y + BIRD_R < groundY - 30) sfx.fall();
}
function land() {
  state = 'over'; bird.vy = 0; overReadyAt = time + 0.6;
  if (score > best) { best = score; newBest = true; store.set(KEY_BEST, String(best)); }
  $('score-val').textContent = score; $('best-val').textContent = best;
  $('newbest').hidden = !newBest;
  const m = $('medal'), tiers = [[80, 'plat'], [40, 'gold'], [20, 'silver'], [10, 'bronze']], tier = tiers.find(t => score >= t[0]);
  m.hidden = !tier; m.className = 'medal' + (tier ? ' ' + tier[1] : ''); m.textContent = tier ? '★' : '';
  setTimeout(() => { if (state === 'over') show(overEl, true); }, 450);
}
function action() {
  sfx.unlock();
  if (crop.open) return;
  switch (state) {
    case 'start': startGame(true); break;
    case 'play': flap(); break;
    case 'paused': state = 'play'; show(pausedEl, false); flap(); break;
    case 'over': if (time >= overReadyAt) startGame(false); break;
  }
}

function update(dt) {
  time += dt;
  const moving = state === 'start' || state === 'play';
  for (const l of layers) if (moving || (l.always && state !== 'paused')) l.off += l.speed * dt;
  if (moving) groundLayer.off += SPEED * dt;
  flash = Math.max(0, flash - dt * 3.5); shake = Math.max(0, shake - dt);
  bird.flapT = Math.max(0, bird.flapT - dt * 4);
  if (state === 'start' || state === 'play') bird.wing += dt * (state === 'play' ? 11 + 30 * bird.flapT : 9);
  if (state === 'start') {
    bird.x = W * 0.5; bird.y = H * 0.42 + Math.sin(time * 3) * 8; bird.rot = Math.sin(time * 3 + 1) * 0.06;
    return;
  }
  if (state === 'play' || state === 'dying') {
    const n = Math.max(1, Math.ceil(dt / STEP - 1e-6)), h = dt / n;
    for (let i = 0; i < n && (state === 'play' || state === 'dying'); i++) step(h);
  }
}
function step(h) {
  bird.vy = Math.min(bird.vy + GRAVITY * h, MAX_FALL);
  bird.y += bird.vy * h;
  if (state === 'play') bird.x += (W * 0.3 - bird.x) * Math.min(1, h * 5);
  const target = clamp(bird.vy / 500, -0.45, 1.35);
  bird.rot += (target - bird.rot) * Math.min(1, h * (target < bird.rot ? 14 : 5));
  if (state === 'play') {
    for (const p of pipes) {
      p.x -= SPEED * h;
      if (!p.scored && p.x + PIPE_W < bird.x - BIRD_R) { p.scored = true; score++; sfx.score(); }
    }
    while (pipes.length && pipes[0].x < -PIPE_W - 20) pipes.shift();
    let last = pipes[pipes.length - 1];
    if (!last) newPipe(W + 40);
    else if (last.x + PIPE_SPACING <= W + 40) newPipe(last.x + PIPE_SPACING);
    if (bird.y - BIRD_R <= 0) { bird.y = BIRD_R; bird.vy = 0; hit(); }
    else for (const p of pipes) if (hitsPipe(p)) { hit(); break; }
  }
  if (bird.y + BIRD_R >= groundY) {
    bird.y = groundY - BIRD_R;
    if (state === 'play') hit();
    bird.rot = Math.max(bird.rot, 1.2);
    land();
  }
}

function render() {
  ctx.setTransform(K, 0, 0, K, 0, 0);
  if (shake > 0) { const m = shake * 20; ctx.translate((Math.random() - 0.5) * m, (Math.random() - 0.5) * m); }
  ctx.fillStyle = skyGrad; ctx.fillRect(-20, -20, W + 40, H + 40);
  // sun
  const sx = W * 0.8, sy = H * 0.13;
  const sg = ctx.createRadialGradient(sx, sy, 10, sx, sy, 70);
  sg.addColorStop(0, 'rgba(255,248,200,.9)'); sg.addColorStop(1, 'rgba(255,248,200,0)');
  ctx.fillStyle = sg; ctx.fillRect(sx - 70, sy - 70, 140, 140);
  ctx.fillStyle = '#fff4b8'; ctx.beginPath(); ctx.arc(sx, sy, 22, 0, Math.PI * 2); ctx.fill();
  for (const l of layers) drawTiles(l);
  for (const p of pipes) drawPipe(p);
  drawTiles(groundLayer);
  drawBird();
  if (state === 'play' || state === 'dying' || state === 'paused') {
    ctx.font = `900 54px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round'; ctx.lineWidth = 9; ctx.strokeStyle = '#1d4e5c';
    const y = Math.max(70, H * 0.11);
    ctx.strokeText(String(score), W / 2, y); ctx.fillStyle = '#fff'; ctx.fillText(String(score), W / 2, y);
  }
  if (flash > 0) { ctx.fillStyle = `rgba(255,255,255,${flash * 0.8})`; ctx.fillRect(-20, -20, W + 40, H + 40); }
}

let last = performance.now();
function frame(now) {
  let dt = (now - last) / 1000; last = now;
  if (!(dt > 0)) dt = 0; if (dt > 0.1) dt = 0.1;
  update(dt); render();
  requestAnimationFrame(frame);
}

// ---------- input ----------
const isUI = t => t && t.closest && t.closest('button, input, label, a, .no-tap');
game.addEventListener('pointerdown', e => {
  if (isUI(e.target)) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault(); action();
});
game.addEventListener('touchstart', e => { if (!(e.target.closest && e.target.closest('button, input, label, a'))) e.preventDefault(); }, { passive: false });
document.addEventListener('gesturestart', e => e.preventDefault());
document.addEventListener('dblclick', e => e.preventDefault());
game.addEventListener('contextmenu', e => e.preventDefault());
window.addEventListener('keydown', e => {
  if (crop.open) { if (e.code === 'Escape') crop.close(); return; }
  if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
    e.preventDefault(); if (e.repeat) return;
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    action();
  } else if (e.code === 'KeyM') toggleMute();
  else if ((e.code === 'KeyP' || e.code === 'Escape') && state === 'play') pause();
});
window.addEventListener('keyup', e => { if (e.code === 'Space') e.preventDefault(); });
function pause() { state = 'paused'; show(pausedEl, true); }
document.addEventListener('visibilitychange', () => { if (document.hidden && state === 'play') pause(); });
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 200));
if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);

function toggleMute() {
  muted = !muted; store.set(KEY_MUTE, muted ? '1' : '0'); updateMute();
  if (!muted) { sfx.unlock(); sfx.blip(); }
}
function updateMute() {
  $('ico-on').style.display = muted ? 'none' : ''; $('ico-off').style.display = muted ? '' : 'none';
  muteBtn.setAttribute('aria-pressed', String(muted)); muteBtn.setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound');
}
muteBtn.addEventListener('click', e => { e.stopPropagation(); toggleMute(); muteBtn.blur(); });
$('menu-btn').addEventListener('click', e => { e.stopPropagation(); e.currentTarget.blur(); toStart(); });

let toastT = 0;
function toast(msg) { toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), 2200); }

// ---------- face photo: pick -> crop -> save (all local) ----------
const MAX_SRC = 1600, FACE_OUT = 160;
function setFace(img) { faceImg = img; updateStartUI(); }
function loadStoredFace() {
  const d = store.get(KEY_FACE);
  if (!d || d.indexOf('data:image/') !== 0) return;
  const img = new Image(); img.onload = () => setFace(img); img.onerror = () => store.del(KEY_FACE); img.src = d;
}
// Decode respecting EXIF orientation, then downscale big camera images.
async function decodeFile(file) {
  let src = null, w = 0, h = 0;
  if (window.createImageBitmap) {
    try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); w = src.width; h = src.height; } catch (e) { src = null; }
  }
  if (!src) {
    const url = URL.createObjectURL(file);
    try {
      src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      w = src.naturalWidth; h = src.naturalHeight; // modern browsers apply EXIF orientation (image-orientation: from-image)
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  if (!w || !h) throw new Error('empty image');
  const f = Math.min(1, MAX_SRC / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * f)); c.height = Math.max(1, Math.round(h * f));
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, c.width, c.height);
  if (src.close) src.close();
  return c;
}
function onFile(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  if (file.type && !/^image\//.test(file.type)) { toast('Please pick an image'); return; }
  toast('Loading photo…');
  decodeFile(file).then(c => { toastEl.classList.remove('show'); crop.openWith(c); })
    .catch(() => toast("Couldn't read that image"));
}
const selfieIn = $('file-selfie'), chooseIn = $('file-choose');
$('selfie-btn').addEventListener('click', e => { e.stopPropagation(); e.currentTarget.blur(); sfx.unlock(); selfieIn.click(); });
$('choose-btn').addEventListener('click', e => { e.stopPropagation(); e.currentTarget.blur(); sfx.unlock(); chooseIn.click(); });
selfieIn.addEventListener('change', () => onFile(selfieIn));
chooseIn.addEventListener('change', () => onFile(chooseIn));
$('reset-face').addEventListener('click', e => { e.stopPropagation(); e.currentTarget.blur(); store.del(KEY_FACE); setFace(null); toast('Face reset'); });

const crop = (() => {
  const c = $('crop-cv'), g = c.getContext('2d'), zoomIn = $('zoom');
  const S = { open: false, img: null, rot: 0, z: 1, ox: 0, oy: 0, cw: 0, ch: 0, cx: 0, cy: 0, R: 100, dpr: 1 };
  const ptrs = new Map(); let pinch = null;
  const dims = () => (S.rot % 2) ? [S.img.height, S.img.width] : [S.img.width, S.img.height];
  const baseScale = () => { const [w, h] = dims(); return (2 * S.R) / Math.min(w, h); };
  const sc = () => baseScale() * S.z;
  function clampPos() {
    const [w, h] = dims(), s = sc();
    const mx = Math.max(0, w * s / 2 - S.R), my = Math.max(0, h * s / 2 - S.R);
    S.ox = clamp(S.ox, -mx, mx); S.oy = clamp(S.oy, -my, my);
  }
  function layout() {
    const r = c.getBoundingClientRect();
    S.cw = r.width || bw; S.ch = r.height || bh; S.dpr = Math.min(window.devicePixelRatio || 1, 3);
    c.width = Math.round(S.cw * S.dpr); c.height = Math.round(S.ch * S.dpr);
    S.R = Math.min(S.cw * 0.4, S.ch * 0.26, 180);
    S.cx = S.cw / 2; S.cy = S.ch * 0.44;
    clampPos(); draw();
  }
  function draw() {
    if (!S.img) return;
    g.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    g.fillStyle = '#10262e'; g.fillRect(0, 0, S.cw, S.ch);
    g.save(); g.translate(S.cx + S.ox, S.cy + S.oy); g.rotate(S.rot * Math.PI / 2); const s = sc(); g.scale(s, s);
    g.imageSmoothingQuality = 'high'; g.drawImage(S.img, -S.img.width / 2, -S.img.height / 2); g.restore();
    // dim outside the circle
    g.beginPath(); g.rect(0, 0, S.cw, S.ch); g.arc(S.cx, S.cy, S.R, 0, Math.PI * 2, true);
    g.fillStyle = 'rgba(8,24,30,.72)'; g.fill('evenodd');
    g.beginPath(); g.arc(S.cx, S.cy, S.R, 0, Math.PI * 2); g.lineWidth = 3; g.strokeStyle = '#fff'; g.stroke();
    g.setLineDash([6, 8]); g.beginPath(); g.arc(S.cx, S.cy, S.R + 8, 0, Math.PI * 2); g.lineWidth = 2; g.strokeStyle = 'rgba(255,216,77,.8)'; g.stroke(); g.setLineDash([]);
  }
  function zoomAt(px, py, nz) {
    nz = clamp(nz, 1, 5); const s0 = sc(); S.z = nz; const k = sc() / s0;
    const ax = px - S.cx, ay = py - S.cy;         // anchor relative to circle centre
    S.ox = ax - (ax - S.ox) * k; S.oy = ay - (ay - S.oy) * k;
    clampPos(); zoomIn.value = S.z; draw();
  }
  const local = e => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  c.addEventListener('pointerdown', e => {
    e.preventDefault(); try { c.setPointerCapture(e.pointerId); } catch (err) {}
    ptrs.set(e.pointerId, local(e)); pinch = null;
  });
  c.addEventListener('pointermove', e => {
    if (!ptrs.has(e.pointerId)) return;
    e.preventDefault();
    const p = local(e), prev = ptrs.get(e.pointerId);
    if (ptrs.size === 1) { S.ox += p[0] - prev[0]; S.oy += p[1] - prev[1]; ptrs.set(e.pointerId, p); clampPos(); draw(); return; }
    ptrs.set(e.pointerId, p);
    const [a, b] = [...ptrs.values()];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], dist = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
    if (pinch) {
      S.ox += mid[0] - pinch.mid[0]; S.oy += mid[1] - pinch.mid[1];
      zoomAt(mid[0], mid[1], S.z * dist / pinch.dist);
    }
    pinch = { mid, dist };
  });
  const up = e => { ptrs.delete(e.pointerId); pinch = null; };
  c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up); c.addEventListener('lostpointercapture', up);
  c.addEventListener('wheel', e => { e.preventDefault(); const [x, y] = local(e); const k = e.ctrlKey ? 0.01 : (e.deltaMode === 1 ? 0.05 : 0.002); zoomAt(x, y, S.z * Math.exp(-e.deltaY * k)); }, { passive: false });
  zoomIn.addEventListener('input', () => zoomAt(S.cx, S.cy, parseFloat(zoomIn.value)));
  $('rotate-btn').addEventListener('click', () => { S.rot = (S.rot + 1) % 4; const t = S.ox; S.ox = -S.oy; S.oy = t; clampPos(); draw(); });
  $('crop-cancel').addEventListener('click', () => close());
  $('crop-use').addEventListener('click', () => {
    const out = document.createElement('canvas'); out.width = out.height = FACE_OUT;
    const o = out.getContext('2d'), f = FACE_OUT / (2 * S.R);
    o.beginPath(); o.arc(FACE_OUT / 2, FACE_OUT / 2, FACE_OUT / 2, 0, Math.PI * 2); o.clip();
    o.translate(FACE_OUT / 2 + S.ox * f, FACE_OUT / 2 + S.oy * f); o.rotate(S.rot * Math.PI / 2);
    const s = sc() * f; o.scale(s, s); o.imageSmoothingQuality = 'high';
    o.drawImage(S.img, -S.img.width / 2, -S.img.height / 2);
    let saved = store.set(KEY_FACE, out.toDataURL('image/png'));
    if (!saved) saved = store.set(KEY_FACE, out.toDataURL('image/webp', 0.85));
    setFace(out); close();
    toast(saved ? 'Looking good! Face saved on this device' : 'Face set (could not save on this device)');
  });
  function openWith(img) {
    S.img = img; S.rot = 0; S.z = 1; S.ox = 0; S.oy = 0; zoomIn.value = 1; S.open = true;
    show(cropEl, true); layout();
  }
  function close() { S.open = false; S.img = null; ptrs.clear(); show(cropEl, false); }
  return { get open() { return S.open; }, openWith, close, layout, _S: S };
})();

// ---------- test/debug hooks (read-only-ish helpers) ----------
window.FF = {
  get state() { return state; }, get score() { return score; }, get best() { return best; },
  get bird() { return { ...bird }; }, get pipes() { return pipes.map(p => ({ ...p })); },
  get hasFace() { return !!faceImg; }, get crop() { return crop._S; },
  get groundY() { return groundY; }, get W() { return W; }, get H() { return H; }, PIPE_W, BIRD_R,
  action
};

// ---------- boot ----------
pipeGradients(); birdGradients(); updateMute(); loadStoredFace();
resize(); toStart();
requestAnimationFrame(t => { last = t; requestAnimationFrame(frame); });
})();
