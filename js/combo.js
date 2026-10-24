// Campo con lista desplegable que se filtra al escribir y permite agregar
// opciones nuevas, que quedan guardadas para la próxima vez.
import * as db from './db.js';

function norm(text) {
  return String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function customOptions(field) {
  return db.getSetting(`custom-${field}`, []);
}

export async function addCustomOption(field, value) {
  const list = await customOptions(field);
  if (!value || list.some((v) => norm(v) === norm(value))) return;
  list.push(value);
  await db.setSetting(`custom-${field}`, list);
}

// input: el <input>; field: clave para guardar las opciones propias;
// getOptions: función que devuelve las opciones base actuales.
export function combo(input, field, getOptions) {
  const box = document.createElement('div');
  box.className = 'combo-list';
  box.hidden = true;
  input.insertAdjacentElement('afterend', box);
  input.parentElement.classList.add('combo');
  input.setAttribute('autocomplete', 'off');
  let custom = [];
  customOptions(field).then((c) => { custom = c; });

  function render() {
    const q = norm(input.value);
    const base = getOptions();
    const all = [...base, ...custom.filter((c) => !base.some((b) => norm(b) === norm(c)))];
    // Primero las que empiezan con lo escrito, después las que tienen una palabra
    // que empieza así, y al final las que lo contienen en cualquier parte.
    const starts = [];
    const words = [];
    const contains = [];
    for (const opt of all) {
      const n = norm(opt);
      if (!q || n.startsWith(q)) starts.push(opt);
      else if (n.split(/[\s/(]+/).some((w) => w.startsWith(q))) words.push(opt);
      else if (n.includes(q)) contains.push(opt);
    }
    const shown = [...starts, ...words, ...contains];
    const exact = all.some((o) => norm(o) === q);
    box.innerHTML = shown.map((o) => `<button type="button" data-v="${esc(o)}">${esc(o)}</button>`).join('') +
      (q && !exact ? `<button type="button" class="add" data-add="${esc(input.value.trim())}">＋ Agregar “${esc(input.value.trim())}”</button>` : '') +
      (input.value ? '<button type="button" class="clear" data-clear>Borrar selección</button>' : '');
    box.hidden = !box.innerHTML;
  }

  function close() { box.hidden = true; }

  input.addEventListener('focus', render);
  input.addEventListener('input', render);
  input.addEventListener('blur', () => setTimeout(close, 150));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = box.querySelector('button');
      if (first && !box.hidden) first.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    }
  });
  // pointerdown se dispara antes del blur del input, así no se cierra antes de elegir.
  box.addEventListener('pointerdown', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    e.preventDefault();
    if (btn.dataset.clear !== undefined) {
      input.value = '';
    } else if (btn.dataset.add) {
      input.value = btn.dataset.add;
      await addCustomOption(field, btn.dataset.add);
      custom = await customOptions(field);
    } else {
      input.value = btn.dataset.v;
    }
    close();
    input.blur();
  });
}
