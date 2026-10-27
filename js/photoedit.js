// Editor de fotos: escribir texto y dibujar a mano sobre la imagen.
// editPhoto(blob) devuelve la foto nueva, o null si se cancela.

const COLORS = ['#ff3b30', '#ffcc00', '#ffffff', '#111111'];

export function editPhoto(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onerror = () => { URL.revokeObjectURL(url); alert('No se pudo abrir la foto.'); resolve(null); };
    img.onload = () => open(img, (result) => { URL.revokeObjectURL(url); resolve(result); });
    img.src = url;
  });
}

function open(img, done) {
  const box = document.createElement('div');
  box.className = 'photo-editor';
  box.innerHTML = `
    <div class="pe-bar">
      <button class="pe-btn" data-cancel>Cancelar</button>
      <span class="pe-hint"></span>
      <button class="pe-btn pe-ok" data-ok>Listo</button>
    </div>
    <div class="pe-stage"><canvas></canvas></div>
    <div class="pe-bar">
      <button class="pe-btn" data-mode="text">Aa Texto</button>
      <button class="pe-btn" data-mode="draw">✏️ Dibujar</button>
      ${COLORS.map((c) => `<button class="pe-color" data-color="${c}" style="background:${c}" aria-label="Color"></button>`).join('')}
      <button class="pe-btn" data-undo>↶</button>
    </div>`;
  document.body.appendChild(box);

  const canvas = box.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ops = [];
  let mode = 'text';
  let color = COLORS[0];
  let current = null;
  const fontSize = () => Math.round(Math.max(canvas.width, canvas.height) * 0.045);
  const lineWidth = () => Math.max(4, Math.round(Math.max(canvas.width, canvas.height) * 0.008));

  function redraw() {
    ctx.drawImage(img, 0, 0);
    for (const op of ops) {
      if (op.type === 'path') {
        ctx.strokeStyle = op.color;
        ctx.lineWidth = op.width;
        ctx.lineCap = ctx.lineJoin = 'round';
        ctx.beginPath();
        op.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        if (op.points.length === 1) ctx.lineTo(op.points[0][0] + 0.1, op.points[0][1]);
        ctx.stroke();
      } else {
        ctx.font = `bold ${op.size}px -apple-system, "Segoe UI", Roboto, sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(3, op.size / 7);
        ctx.strokeStyle = op.color === '#111111' ? '#ffffff' : '#000000';
        op.text.split('\n').forEach((line, i) => {
          const y = op.y + i * op.size * 1.2;
          ctx.strokeText(line, op.x, y);
          ctx.fillStyle = op.color;
          ctx.fillText(line, op.x, y);
        });
      }
    }
  }

  function point(e) {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * (canvas.width / r.width), (e.clientY - r.top) * (canvas.height / r.height)];
  }

  function setMode(m) {
    mode = m;
    box.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    box.querySelector('.pe-hint').textContent = m === 'text' ? 'Tocá donde va el texto' : 'Dibujá con el dedo';
  }
  function setColor(c) {
    color = c;
    box.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('on', b.dataset.color === c));
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (mode !== 'draw') return;
    canvas.setPointerCapture(e.pointerId);
    current = { type: 'path', color, width: lineWidth(), points: [point(e)] };
    ops.push(current);
    redraw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!current) return;
    current.points.push(point(e));
    redraw();
  });
  const end = () => { current = null; };
  canvas.addEventListener('pointerup', (e) => {
    if (mode === 'text') {
      const [x, y] = point(e);
      const text = prompt('Texto para la foto:');
      if (text && text.trim()) {
        const size = fontSize();
        ctx.font = `bold ${size}px sans-serif`;
        // Que no se salga por la derecha.
        const width = Math.max(...text.trim().split('\n').map((l) => ctx.measureText(l).width));
        ops.push({ type: 'text', text: text.trim(), color, size, x: Math.max(4, Math.min(x, canvas.width - width - 4)), y });
        redraw();
      }
    }
    end();
  });
  canvas.addEventListener('pointercancel', end);

  box.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  box.querySelectorAll('[data-color]').forEach((b) => b.addEventListener('click', () => setColor(b.dataset.color)));
  box.querySelector('[data-undo]').addEventListener('click', () => { ops.pop(); redraw(); });
  box.querySelector('[data-cancel]').addEventListener('click', () => {
    if (ops.length && !confirm('¿Descartar los cambios de la foto?')) return;
    box.remove();
    done(null);
  });
  box.querySelector('[data-ok]').addEventListener('click', () => {
    if (!ops.length) { box.remove(); done(null); return; }
    canvas.toBlob((out) => { box.remove(); done(out); }, 'image/jpeg', 0.85);
  });

  setMode('text');
  setColor(color);
  redraw();
}
