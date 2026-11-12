// Kleine Helfer für Darstellung und Effekte.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const PLAYER_COLORS = ['#ff5d73', '#4cc9f0', '#ffd23f', '#7bd389', '#c77dff', '#ff9f43', '#2ec4b6', '#f72585', '#a0c4ff', '#e9c46a', '#90be6d', '#ff7aa2'];
export const OPTION_COLORS = ['#b8323f', '#2463a8', '#c98a12', '#1f8a5b'];
export const OPTION_LETTERS = ['A', 'B', 'C', 'D'];

export function toast(msg, ms = 2600) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}

// Konfetti für Siege.
export function confetti(duration = 2500) {
  const c = document.createElement('canvas');
  c.className = 'confetti';
  document.body.appendChild(c);
  const ctx = c.getContext('2d');
  const resize = () => { c.width = innerWidth; c.height = innerHeight; };
  resize();
  const GOLD = ['#f6c453', '#eaa62a', '#d9822b', '#fff1c7', '#b8862b'];
  const parts = Array.from({ length: 160 }, (_, i) => ({
    x: Math.random() * c.width, y: -20 - Math.random() * c.height * 0.5,
    vx: (Math.random() - 0.5) * 4, vy: 2 + Math.random() * 4,
    r: 4 + Math.random() * 6, a: Math.random() * Math.PI, va: (Math.random() - 0.5) * 0.3,
    col: i % 3 ? GOLD[i % GOLD.length] : PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)],
  }));
  const end = performance.now() + duration;
  (function frame(t) {
    ctx.clearRect(0, 0, c.width, c.height);
    parts.forEach(p => {
      p.x += p.vx; p.y += p.vy; p.a += p.va; p.vy += 0.05;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a);
      ctx.fillStyle = p.col; ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r);
      ctx.restore();
    });
    if (t < end) requestAnimationFrame(frame);
    else c.remove();
  })(performance.now());
}

// Bild verkleinern, damit Quizze klein bleiben.
export function readImage(file, max = 1600) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Bild konnte nicht gelesen werden'));
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const cv = document.createElement('canvas');
        cv.width = Math.round(img.width * scale);
        cv.height = Math.round(img.height * scale);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        resolve(cv.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

export function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Profilbild (Selfie) oder farbiger Kreis mit Initialen
export function avatar(p, cls = '') {
  if (!p) return '';
  if (p.photo) return `<span class="av ${cls}" style="--c:${p.color || '#888'}"><img src="${p.photo}" alt=""></span>`;
  const ini = String(p.name || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  return `<span class="av ${cls}" style="--c:${p.color || '#888'}"><b>${esc(ini)}</b></span>`;
}

// Text so weit verkleinern, bis er in seinen Rahmen passt
export function fitText(root = document) {
  root.querySelectorAll('[data-fit]').forEach(el => {
    el.style.fontSize = '';
    const cs = getComputedStyle(el);
    let size = parseFloat(cs.fontSize);
    const min = Number(el.dataset.fit) || 14;
    const maxH = cs.maxHeight === 'none' ? Infinity : parseFloat(cs.maxHeight);
    // zu breit (einzelnes Wort passt nicht) oder höher als erlaubt (Unterlängen/Zeilenhöhe großzügig toleriert)
    const tooBig = () => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > maxH + size * 0.25;
    let guard = 40;
    while (guard-- > 0 && size > min && tooBig()) {
      size *= 0.92;
      el.style.fontSize = size + 'px';
    }
  });
}

// Bild verkleinern und quadratisch zuschneiden (für Selfies)
export function squareImage(file, size = 220) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Bild konnte nicht gelesen werden'));
      img.onload = () => {
        const s = Math.min(img.width, img.height);
        const cv = document.createElement('canvas');
        cv.width = cv.height = size;
        cv.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
        resolve(cv.toDataURL('image/jpeg', 0.75));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

export function slug(s) {
  return String(s).toLowerCase().replace(/[äöüß]/g, c => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' }[c])).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'quiz';
}
