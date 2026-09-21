// Player no navegador usando o Spotify Web Playback SDK.
// Doc: https://developer.spotify.com/documentation/web-playback-sdk/reference
// O SDK transforma esta aba num dispositivo "Spotify Connect".
import { getAccessToken } from './auth.js';
import * as api from './api.js';
import { drawPixelCover, clearPixelCover } from './cover.js';

const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';
const VOLUME_KEY = 'player_volume';

const $ = (sel) => document.querySelector(sel);

let player = null;
let deviceId = null;
let callbacks = {};

// Último estado recebido + hora local em que chegou (pra animar o progresso).
let lastState = null;
let lastStateAt = 0;
let seeking = false; // true enquanto o usuário arrasta a barra de progresso

function formatTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function savedVolume() {
  try {
    const v = parseFloat(localStorage.getItem(VOLUME_KEY));
    return Number.isFinite(v) ? v : 0.5;
  } catch {
    return 0.5;
  }
}

function setControlsEnabled(enabled) {
  for (const id of ['#pb-shuffle', '#pb-prev', '#pb-toggle', '#pb-next', '#pb-repeat', '#pb-progress']) {
    $(id).disabled = !enabled;
  }
}

// Modos de repetir, na ordem do SDK: repeat_mode 0, 1 e 2.
const REPEAT_MODES = [
  { api: 'off', text: 'OFF', label: 'Repetir: desligado' },
  { api: 'context', text: 'LIST', label: 'Repetir: lista' },
  { api: 'track', text: 'TRACK', label: 'Repetir: música' },
];

// ---------- Barras em ASCII ----------

// Largura de um caractere da fonte (mede uma vez; fonte monoespaçada).
let charWidth = 0;
function measureChar() {
  const probe = document.createElement('span');
  probe.textContent = '0000000000';
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
  $('#pb-progress-bar').append(probe);
  charWidth = probe.getBoundingClientRect().width / 10;
  probe.remove();
}

// Quantos caracteres cabem dentro dos colchetes da barra.
function barChars(bar) {
  if (!charWidth) measureChar();
  return Math.max(4, Math.floor(bar.parentElement.clientWidth / (charWidth || 10)) - 2);
}

// Progresso: [=========>----------]
function progressText(fraction, n) {
  const head = Math.round(Math.min(Math.max(fraction, 0), 1) * (n - 1));
  return `[${'='.repeat(head)}>${'-'.repeat(n - 1 - head)}]`;
}

// Volume: [######----]
function volumeText(fraction, n) {
  const full = Math.round(Math.min(Math.max(fraction, 0), 1) * n);
  return `[${'#'.repeat(full)}${'-'.repeat(n - full)}]`;
}

function drawProgressBar() {
  const input = $('#pb-progress');
  const bar = $('#pb-progress-bar');
  const max = Number(input.max) || 1;
  bar.textContent = progressText(Number(input.value) / max, barChars(bar));
}

function drawVolumeBar() {
  const bar = $('#pb-volume-bar');
  bar.textContent = volumeText($('#pb-volume').value / 100, barChars(bar));
}

// Posição atual: última posição conhecida + tempo que passou desde então.
function currentPosition() {
  if (!lastState) return 0;
  const elapsed = lastState.paused ? 0 : Date.now() - lastStateAt;
  return Math.min(lastState.position + elapsed, lastState.duration);
}

// Roda um comando do player mostrando erros na tela.
async function run(fn) {
  try {
    await fn();
  } catch (err) {
    console.error(err);
    if (err.status === 401) return callbacks.onAuthError();
    callbacks.onError(err.message);
    // Deu errado: busca o estado real pra desfazer o que mudamos na tela.
    const real = await player?.getCurrentState();
    if (real) {
      lastState = real;
      lastStateAt = Date.now();
      render();
    }
  }
}

// Atualiza a aparência dos botões de aleatório e repetir.
function renderModes() {
  const shuffle = $('#pb-shuffle');
  shuffle.textContent = `shuffle:${lastState.shuffle ? 'ON' : 'OFF'}`;
  shuffle.classList.toggle('active', lastState.shuffle);
  shuffle.setAttribute('aria-pressed', String(lastState.shuffle));

  const mode = lastState.repeat_mode;
  const repeat = $('#pb-repeat');
  repeat.textContent = `repeat:${REPEAT_MODES[mode].text}`;
  repeat.classList.toggle('active', mode > 0);
  repeat.setAttribute('aria-label', REPEAT_MODES[mode].label);
  repeat.title = REPEAT_MODES[mode].label;
}

// Muda o estado na tela na hora (sem esperar o Spotify); o próximo aviso do SDK confirma.
function updateLocally(changes) {
  lastState = { ...lastState, ...changes };
  renderModes();
}

// Carrega o script do SDK e cria o player. Chame uma vez, depois do login.
// callbacks: onError(msg), onAuthError(), onTrackChange(uri)
export function initPlayer(cbs) {
  callbacks = cbs;
  setupControls();

  // O SDK chama esta função global quando termina de carregar.
  window.onSpotifyWebPlaybackSDKReady = createPlayer;

  const script = document.createElement('script');
  script.src = SDK_URL;
  script.onerror = () =>
    callbacks.onError(
      'Não foi possível carregar o player do Spotify. Verifique a internet ou se algum bloqueador de anúncios está bloqueando sdk.scdn.co.',
    );
  document.head.append(script);
}

function createPlayer() {
  player = new Spotify.Player({
    name: 'Meu Player (navegador)',
    // O SDK pede o token quando conecta e quando o token expira.
    getOAuthToken: (cb) =>
      getAccessToken()
        .then(cb)
        .catch(() => callbacks.onAuthError()),
    volume: savedVolume(),
    enableMediaSession: true, // teclas de mídia do teclado e controles do sistema
  });

  // Pronto: o navegador já aparece como dispositivo no Spotify Connect.
  player.addListener('ready', ({ device_id }) => {
    deviceId = device_id;
    $('#pb-status').textContent = '> pronto. clique numa música pra tocar.';
  });

  player.addListener('not_ready', () => {
    deviceId = null;
    setControlsEnabled(false);
    $('#pb-status').textContent = '> player desconectado (sem internet?). tentando reconectar…';
  });

  player.addListener('player_state_changed', (state) => {
    lastState = state;
    lastStateAt = Date.now();
    render();
  });

  // Erros, com mensagens claras.
  player.addListener('initialization_error', () =>
    callbacks.onError(
      'Este navegador não conseguiu iniciar o player: ele precisa de suporte a DRM (EME/Widevine). ' +
        'No Firefox: Configurações → procure "DRM" → ative "Reproduzir conteúdo controlado por DRM". ' +
        'No Chrome/Chromium, confirme que o Widevine está instalado. Depois recarregue a página.',
    ),
  );
  player.addListener('authentication_error', () => callbacks.onAuthError());
  player.addListener('account_error', () =>
    callbacks.onError('Tocar música no navegador exige uma conta Spotify Premium.'),
  );
  player.addListener('playback_error', ({ message }) =>
    callbacks.onError(`Não foi possível tocar esta música. (${message})`),
  );
  player.addListener('autoplay_failed', () =>
    callbacks.onError('O navegador bloqueou a reprodução automática. Clique no botão de play.'),
  );

  player.connect();
}

// Toca algo neste navegador. Use contextUri+offset (playlist) ou uris+offset (lista solta).
export async function playHere({ contextUri, uris, offset }) {
  if (!player || !deviceId) {
    throw new Error('O player ainda está carregando. Espere alguns segundos e tente de novo.');
  }
  // Precisa ser chamado dentro do clique, senão o navegador pode bloquear o áudio.
  player.activateElement();
  await api.play({ deviceId, contextUri, uris, offset });
}

// Atualiza a barra de baixo com o estado atual.
function render() {
  const state = lastState;

  // state nulo = a música foi pra outro dispositivo (ex: celular).
  if (!state) {
    setControlsEnabled(false);
    $('#pb-status').textContent = '> tocando em outro dispositivo. clique numa música pra trazer pra cá.';
    $('#pb-info').hidden = true;
    clearPixelCover($('#pb-cover'));
    callbacks.onTrackChange(null);
    return;
  }

  const track = state.track_window.current_track;
  setControlsEnabled(true);
  $('#pb-info').hidden = false;
  $('#pb-status').textContent = '';

  // Capa pixelada: a menor imagem já basta (vira 24×24 "pixels").
  const cover = track.album.images.at(-1)?.url;
  if (cover) drawPixelCover($('#pb-cover'), cover);
  else clearPixelCover($('#pb-cover'));
  $('#pb-title').textContent = track.name;
  $('#pb-artist').textContent = track.artists.map((a) => a.name).join(', ');

  const toggle = $('#pb-toggle');
  toggle.textContent = state.paused ? '[ > ]' : '[ || ]';
  toggle.setAttribute('aria-label', state.paused ? 'Tocar' : 'Pausar');

  renderModes();

  $('#pb-progress').max = state.duration;
  $('#pb-duration').textContent = formatTime(state.duration);
  renderProgress();

  // Avisa o app pra destacar a música na lista (o Spotify às vezes troca a
  // versão da música; linked_from guarda a original).
  callbacks.onTrackChange(track.linked_from?.uri ?? track.uri, track.uri);
}

// Calcula a posição atual: última posição conhecida + tempo que passou desde então.
function renderProgress() {
  if (!lastState || seeking) return;
  const position = currentPosition();
  $('#pb-progress').value = position;
  $('#pb-position').textContent = formatTime(position);
  drawProgressBar();
}

// ---------- Controles (usados pelos botões e pelos comandos :play, :next…) ----------

// Os comandos precisam de uma música carregada neste navegador.
function requireTrack() {
  if (!player || !lastState) {
    throw new Error('nada tocando neste navegador. clique numa música primeiro.');
  }
}

export async function resume() {
  requireTrack();
  await player.resume();
}

export async function pause() {
  requireTrack();
  await player.pause();
}

export async function nextTrack() {
  requireTrack();
  await player.nextTrack();
}

// Anterior: depois de 3 segundos volta pro começo da música; antes, vai pra anterior.
export async function previousTrack() {
  requireTrack();
  if (currentPosition() > 3000 || lastState.disallows?.skipping_prev) return player.seek(0);
  return player.previousTrack();
}

// Aleatório: liga/desliga. Devolve o estado novo (true = ligado).
export async function toggleShuffle() {
  requireTrack();
  const on = !lastState.shuffle;
  updateLocally({ shuffle: on });
  await api.setShuffle(deviceId, on);
  return on;
}

// Repetir: desligado → lista → música → desligado. Devolve "OFF", "LIST" ou "TRACK".
export async function cycleRepeat() {
  requireTrack();
  const next = (lastState.repeat_mode + 1) % REPEAT_MODES.length;
  updateLocally({ repeat_mode: next });
  await api.setRepeat(deviceId, REPEAT_MODES[next].api);
  return REPEAT_MODES[next].text;
}

// Música tocando agora (ou null).
export const currentTrack = () => lastState?.track_window.current_track ?? null;

function setupControls() {
  setControlsEnabled(false);

  $('#pb-toggle').addEventListener('click', () => player?.togglePlay());
  $('#pb-next').addEventListener('click', () => player?.nextTrack());
  // Os botões ficam desativados sem música, então "lastState &&" só evita avisos à toa.
  $('#pb-prev').addEventListener('click', () => run(() => lastState && previousTrack()));
  $('#pb-shuffle').addEventListener('click', () => run(() => lastState && toggleShuffle()));
  $('#pb-repeat').addEventListener('click', () => run(() => lastState && cycleRepeat()));

  // Progresso: enquanto arrasta, só mostra o tempo; ao soltar, pula pra lá.
  const progress = $('#pb-progress');
  progress.addEventListener('input', () => {
    seeking = true;
    $('#pb-position').textContent = formatTime(progress.value);
    drawProgressBar();
  });
  progress.addEventListener('change', async () => {
    const position = Number(progress.value);
    await player?.seek(position);
    // Atualiza já, sem esperar o próximo aviso do SDK (evita a barra "voltar").
    if (lastState) {
      lastState = { ...lastState, position };
      lastStateAt = Date.now();
    }
    seeking = false;
  });

  // Volume: 0–100 na tela, 0–1 no SDK. Lembramos o valor pra próxima vez.
  const volume = $('#pb-volume');
  volume.value = Math.round(savedVolume() * 100);
  volume.addEventListener('input', () => {
    const v = volume.value / 100;
    drawVolumeBar();
    player?.setVolume(v);
    try {
      localStorage.setItem(VOLUME_KEY, String(v));
    } catch {
      // sem problema: só não lembra o volume
    }
  });

  // Desenha as barras agora, e de novo quando a largura mudar (ex: janela redimensionada).
  drawProgressBar();
  drawVolumeBar();
  const resize = new ResizeObserver(() => {
    drawProgressBar();
    drawVolumeBar();
  });
  resize.observe($('#pb-progress-bar').parentElement);
  resize.observe($('#pb-volume-bar').parentElement);
  // Quando a fonte carrega ou o tema troca de fonte, a largura das letras muda: mede de novo.
  const remeasure = () => {
    charWidth = 0;
    drawProgressBar();
    drawVolumeBar();
  };
  document.fonts?.ready.then(remeasure);
  window.addEventListener('themechange', remeasure);

  // Anima a barra de progresso enquanto toca.
  setInterval(renderProgress, 500);
}
