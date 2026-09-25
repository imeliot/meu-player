// Painel "dispositivos": lista os aparelhos da conta (Spotify Connect) e transfere a
// reprodução pra qualquer um. Só consulta a API enquanto o painel está aberto e visível.
import * as api from './api.js';
import { transferTo, browserDeviceId } from './player.js';
import { $, el, showNotice } from './ui.js';

const REFRESH_MS = 10000; // com o painel aberto, atualiza a cada 10s

const TYPE_LABEL = {
  computer: 'pc',
  smartphone: 'celular',
  tablet: 'tablet',
  speaker: 'caixa de som',
  tv: 'tv',
  avr: 'receiver',
  stb: 'tv box',
  audiodongle: 'dongle',
  gameconsole: 'videogame',
  castvideo: 'chromecast',
  castaudio: 'chromecast',
  automobile: 'carro',
};

let timer = null;
let shown = false;
let safely = (fn) => fn();

export function initDevices(safelyFn) {
  safely = safelyFn;
  $('#devices-refresh').addEventListener('click', () => safely(refreshDevices));
}

// O app avisa quando o painel aparece/some.
export function setDevicesShown(isShown) {
  shown = isShown;
  clearInterval(timer);
  timer = null;
  if (!shown) return;
  safely(refreshDevices);
  timer = setInterval(() => {
    if (document.visibilityState === 'visible') safely(refreshDevices);
  }, REFRESH_MS);
}

export async function refreshDevices() {
  const data = await api.getDevices();
  render(data?.devices ?? []);
}

function render(devices) {
  const active = devices.find((d) => d.is_active);
  const status = $('#devices-status');
  if (active) {
    status.textContent = `> tocando em: ${active.name}`;
    status.className = '';
  } else {
    status.textContent =
      '> nenhum dispositivo ativo. abra o spotify uma vez e volte.' +
      (devices.length ? ' ou escolha um abaixo pra começar.' : ' ');
    status.className = 'dim';
    if (!devices.length) {
      // Atalho pro app do Spotify: sem ele aberto, não há o que controlar.
      const link = el('a', 'btn-link', '[abrir o spotify]');
      link.href = 'spotify:';
      status.append(link);
    }
  }

  const mine = browserDeviceId();
  $('#devices-list').replaceChildren(
    ...devices.map((d) => {
      const btn = el('button', 'lib-item');
      btn.type = 'button';
      btn.classList.toggle('selected', d.is_active);
      const tags = [
        TYPE_LABEL[d.type?.toLowerCase()] ?? d.type?.toLowerCase(),
        d.id && d.id === mine ? 'este navegador' : null,
        d.is_restricted ? 'não aceita comandos' : null,
        d.is_private_session ? 'sessão privada' : null,
      ].filter(Boolean);
      btn.append(el('span', 'lib-name', d.name), el('span', 'dim', tags.join(' · ')));
      btn.title = [d.name, ...tags].join(' · '); // texto completo ao passar o mouse / segurar
      // Sem id ou "restrito": o Spotify não deixa controlar pela Web API.
      btn.disabled = !d.id || d.is_restricted;
      btn.addEventListener('click', () =>
        safely(async () => {
          await transferTo(d.id);
          showNotice(`reprodução enviada pra ${d.name}.`, 'success');
          setTimeout(() => shown && safely(refreshDevices), 1500);
        }),
      );
      const li = el('li');
      li.append(btn);
      return li;
    }),
  );
}
