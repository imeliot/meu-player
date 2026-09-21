// "Roll" de títulos: texto cortado com "…" anda de lado, um caractere por vez (estilo
// letreiro de terminal), pausa no fim e volta ao começo. Assim dá pra ler qualquer nome.
//
// Rola sozinho: tocando agora, a música que está tocando na lista, a playlist escolhida,
// o título dos painéis e o menu do toque longo.
// Rola quando o mouse passa ou o teclado chega: qualquer música, álbum ou playlist.

const STEP_MS = 150; // tempo entre um caractere e o próximo
const PAUSE_MS = 1200; // pausa no começo e no fim

// Sempre rolando (se o texto não couber).
const AUTO = [
  '#pb-info',
  '.item.playing .col-title',
  '.item.playing .col-artist',
  '.row.kb-selected .col-title',
  '.lib-item.selected .lib-name',
  '.box-title',
  '#row-menu[open] .row-menu-title',
].join(', ');

// Partes que rolam quando a linha está sob o mouse ou com foco.
const PARTS = '.col-title, .col-artist, .col-album, .lib-name';

const state = new WeakMap(); // elemento → { waitUntil, forward }
let rolling = new Set(); // elementos rolando agora
let hovered = null; // linha sob o mouse

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// Cabe inteiro? (1px de folga pra arredondamentos)
const overflows = (el) => el.scrollWidth > el.clientWidth + 1 && el.getClientRects().length > 0;

function candidates() {
  const found = new Set(document.querySelectorAll(AUTO));
  for (const line of [hovered, document.activeElement?.closest?.('.item, .lib-item')]) {
    if (line) line.querySelectorAll(PARTS).forEach((el) => found.add(el));
  }
  return [...found].filter(overflows);
}

// Largura de um caractere na fonte do elemento (fonte monoespaçada: o "0" mede igual a todos).
const measurer = document.createElement('canvas').getContext('2d');
const widthCache = new Map();
function charWidth(el) {
  // Monta a fonte peça por peça (o atalho "font" pode vir vazio no Firefox).
  const cs = getComputedStyle(el);
  const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  if (!widthCache.has(font)) {
    measurer.font = font;
    widthCache.set(font, Math.max(4, measurer.measureText('0').width));
  }
  return widthCache.get(font);
}

function stop(el) {
  el.scrollLeft = 0;
  el.classList.remove('rolling');
  state.delete(el);
}

function tick() {
  if (document.visibilityState !== 'visible') return;
  const now = Date.now();
  const next = new Set(reduceMotion.matches ? [] : candidates());

  // Quem saiu da lista volta ao começo.
  for (const el of rolling) if (!next.has(el)) stop(el);
  rolling = next;

  for (const el of rolling) {
    let s = state.get(el);
    if (!s) {
      s = { waitUntil: now + PAUSE_MS };
      state.set(el, s);
      el.classList.add('rolling'); // tira o "…" enquanto rola
    }
    if (now < s.waitUntil) continue;
    const max = el.scrollWidth - el.clientWidth;
    if (el.scrollLeft >= max) {
      // Chegou no fim: pausa e volta pro começo.
      if (!s.atEnd) {
        s.atEnd = true;
        s.waitUntil = now + PAUSE_MS;
      } else {
        s.atEnd = false;
        el.scrollLeft = 0;
        s.waitUntil = now + PAUSE_MS;
      }
      continue;
    }
    // Um caractere por vez.
    el.scrollLeft = Math.min(max, el.scrollLeft + charWidth(el));
  }
}

export function initRoll() {
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'mouse') hovered = e.target.closest?.('.item, .lib-item') ?? null;
  });
  document.addEventListener('pointerleave', () => (hovered = null));
  // Fonte carregou ou o tema trocou de fonte: mede de novo.
  const remeasure = () => widthCache.clear();
  document.fonts?.ready.then(remeasure);
  window.addEventListener('themechange', remeasure);
  setInterval(tick, STEP_MS);
}
