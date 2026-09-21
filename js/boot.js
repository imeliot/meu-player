// Tela de boot: algumas linhas estilo terminal por menos de 1 segundo.
// Ela não bloqueia cliques (pointer-events: none) e o app carrega por baixo ao mesmo tempo.
import { $, el } from './ui.js';

const MAX_MS = 900; // some sozinha depois disso, mesmo se algo ainda estiver carregando

export function startBoot() {
  const screen = $('#boot');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const pending = new Set();

  const hide = () => {
    if (screen.hidden) return;
    screen.classList.add('boot-done');
    setTimeout(() => (screen.hidden = true), 200);
  };

  if (!reduceMotion) {
    screen.replaceChildren(el('p', 'dim', '> meu player v0.4'));
    screen.hidden = false;
    setTimeout(hide, MAX_MS);
    // Qualquer tecla ou clique pula o boot.
    addEventListener('keydown', hide, { once: true });
    addEventListener('pointerdown', hide, { once: true });
  }

  return {
    // Mostra "> texto... " e acrescenta OK/ERRO quando a promessa terminar.
    line(text, promise) {
      if (reduceMotion) return;
      const line = el('p', null, `> ${text}... `);
      screen.append(line);
      pending.add(promise);
      promise.then(
        () => line.append(el('span', 'ok', 'OK')),
        () => line.append(el('span', 'error-text', 'ERRO')),
      ).finally(() => {
        pending.delete(promise);
        // Tudo pronto: some logo (um instante pra dar tempo de ler o OK).
        if (!pending.size) setTimeout(hide, 250);
      });
    },
  };
}
