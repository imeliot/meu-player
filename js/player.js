// Player com dois "motores":
//  • SDK (Web Playback SDK): esta aba vira um dispositivo Spotify Connect e toca aqui.
//    Doc: https://developer.spotify.com/documentation/web-playback-sdk/reference
//  • Remoto (Web API): controla outro dispositivo (app do celular, PC, caixa de som…),
//    lendo o estado por "polling" (pergunta a cada 3s, só com a tela visível).
// No celular/tablet o SDK não funciona direito, então lá é sempre remoto. No PC usa o SDK
// quando a música está tocando aqui, e o remoto quando ela está em outro dispositivo.
import { getAccessToken } from './auth.js';
import * as api from './api.js';
import { drawPixelCover, clearPixelCover } from './cover.js';

const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';
const VOLUME_KEY = 'player_volume';
const MODE_KEY = 'player_mode'; // escolha manual (:mode): 'remote' ou 'sdk'
const POLL_MS = 3000; // intervalo do polling
const POLL_MAX_MS = 30000; // teto quando o Spotify pede pra ir mais devagar (429)

const $ = (sel) => document.querySelector(sel);

let player = null; // Spotify.Player do SDK (null no modo remoto)
let deviceId = null; // id deste navegador como dispositivo (SDK)
let callbacks = {};

let sdkState = null; // último estado do SDK (null = a música não está neste navegador)
let remote = null; // último estado lido da Web API: { state, device } ou null

// Estado mostrado na tela (formato do SDK) + hora local em que chegou (pra animar o progresso).
let lastState = null;
let lastStateAt = 0;
let seeking = false; // true enquanto o usuário arrasta a barra de progresso
let volumeDragging = false;

// ---------- Qual motor usar ----------

// Celular e tablet (inclui iPad, que se apresenta como Mac com tela de toque).
export const isMobileBrowser = () =>
  /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
  (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

function chosenMode() {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved === 'remote' || saved === 'sdk') return saved;
  } catch {
    // sem escolha salva
  }
  return isMobileBrowser() ? 'remote' : 'sdk';
}

let mode = 'sdk'; // definido no initPlayer

// Está controlando outro dispositivo agora? (sim no modo remoto, ou no PC quando a música
// não está neste navegador)
const isRemote = () => mode === 'remote' || !sdkState;

// Dispositivo que recebe os comandos remotos (o ativo), ou null.
const targetDevice = () => remote?.device?.id ?? null;

export const playerMode = () => mode;

// :mode remoto | navegador — salva a escolha e recarrega a página.
export function setPlayerMode(newMode) {
  try {
    localStorage.setItem(MODE_KEY, newMode);
  } catch {
    // sem problema
  }
  location.reload();
}

// ---------- Utilidades ----------

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
  // Volume: no remoto, só se o dispositivo aceitar (o app do iPhone costuma não aceitar).
  const volumeOk = enabled && (!isRemote() || remote?.device?.supports_volume !== false);
  $('#pb-volume').disabled = !volumeOk;
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

// ---------- Estado vindo da Web API → formato do SDK ----------

const REPEAT_INDEX = { off: 0, context: 1, track: 2 };

function fromWebApi(s) {
  const item = s.item;
  const track = item && {
    uri: item.uri,
    name: item.name,
    // Episódio de podcast não tem "artists": usa o nome do programa.
    artists: item.artists ?? [{ name: item.show?.name ?? '' }],
    album: { images: item.album?.images ?? item.images ?? [] },
    linked_from: item.linked_from,
  };
  return {
    paused: !s.is_playing,
    position: s.progress_ms ?? 0,
    duration: item?.duration_ms ?? 0,
    shuffle: Boolean(s.shuffle_state),
    repeat_mode: REPEAT_INDEX[s.repeat_state] ?? 0,
    disallows: s.actions?.disallows ?? {},
    track_window: { current_track: track },
  };
}

// ---------- Polling (só no modo remoto e com a tela visível) ----------

let pollTimer = null;
let pollDelay = POLL_MS;

function pollingWanted() {
  return isRemote() && document.visibilityState === 'visible';
}

// Agenda a próxima leitura (cancela a anterior).
function schedulePoll(delay = pollDelay) {
  clearTimeout(pollTimer);
  pollTimer = null;
  if (pollingWanted()) pollTimer = setTimeout(poll, delay);
}

// Depois de um comando, lê o estado logo (o Spotify leva um instante pra aplicar).
const pollSoon = () => schedulePoll(700);

async function poll() {
  pollTimer = null;
  if (!pollingWanted()) return;
  try {
    const s = await api.getPlaybackState();
    pollDelay = POLL_MS;
    remote = s?.device ? { state: s, device: s.device } : null;
    if (isRemote()) {
      lastState = remote && s.item ? fromWebApi(s) : null;
      lastStateAt = Date.now();
      if (!volumeDragging && remote?.device?.volume_percent != null) {
        $('#pb-volume').value = remote.device.volume_percent;
        drawVolumeBar();
      }
      render();
    }
  } catch (err) {
    console.error(err);
    if (err.status === 401) return callbacks.onAuthError();
    // 429 = muitas perguntas: espera o que o Spotify pedir (ou dobra o intervalo).
    if (err.status === 429) {
      pollDelay = Math.min(Math.max(err.retryAfter * 1000, pollDelay * 2), POLL_MAX_MS);
    }
  }
  schedulePoll();
}

// Tela apagada / app em segundo plano: para de perguntar. Voltou: pergunta na hora.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') schedulePoll(0);
  else {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
});

// ---------- Início ----------

// callbacks: onError(msg), onAuthError(), onTrackChange(uri, uri2), onNoDevice()
export function initPlayer(cbs) {
  callbacks = cbs;
  mode = chosenMode();
  setupControls();

  if (mode === 'remote') {
    $('#pb-status').textContent = '> modo controle remoto: procurando dispositivo…';
    schedulePoll(0);
    return;
  }

  // O SDK chama esta função global quando termina de carregar.
  window.onSpotifyWebPlaybackSDKReady = createPlayer;

  const script = document.createElement('script');
  script.src = SDK_URL;
  script.onerror = () => {
    switchToRemote(
      'não deu pra carregar o player do spotify (internet ou bloqueador de anúncios bloqueando sdk.scdn.co). ' +
        'usando o modo controle remoto.',
    );
  };
  document.head.append(script);
  // Enquanto a música não estiver neste navegador, mostra o que toca em outro lugar.
  schedulePoll(0);
}

// O SDK falhou: segue como controle remoto, avisando o motivo.
function switchToRemote(reason) {
  mode = 'remote';
  player?.disconnect();
  player = null;
  sdkState = null;
  callbacks.onError(reason);
  schedulePoll(0);
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
    if (!lastState) $('#pb-status').textContent = '> pronto. clique numa música pra tocar.';
  });

  player.addListener('not_ready', () => {
    deviceId = null;
    $('#pb-status').textContent = '> player desconectado (sem internet?). tentando reconectar…';
  });

  player.addListener('player_state_changed', (state) => {
    sdkState = state;
    if (state) {
      // A música está neste navegador: o SDK manda, sem polling.
      remote = null;
      lastState = state;
      lastStateAt = Date.now();
      schedulePoll(); // (não agenda nada: isRemote() é falso)
      render();
    } else {
      // Foi pra outro dispositivo: passa a ler o estado pela Web API.
      lastState = null;
      render();
      schedulePoll(0);
    }
  });

  // Erros, com mensagens claras.
  player.addListener('initialization_error', () =>
    switchToRemote(
      'este navegador não toca música (precisa de DRM/Widevine). no firefox: configurações → "drm" → ' +
        'ative "reproduzir conteúdo controlado por drm" e recarregue. por enquanto: modo controle remoto.',
    ),
  );
  player.addListener('authentication_error', () => callbacks.onAuthError());
  player.addListener('account_error', () =>
    callbacks.onError('Tocar e controlar música exige uma conta Spotify Premium.'),
  );
  player.addListener('playback_error', ({ message }) =>
    callbacks.onError(`Não foi possível tocar esta música. (${message})`),
  );
  player.addListener('autoplay_failed', () =>
    callbacks.onError('O navegador bloqueou a reprodução automática. Clique no botão de play.'),
  );

  player.connect();
}

// ---------- Tocar algo ----------

function noDeviceError() {
  callbacks.onNoDevice?.();
  const err = new Error('nenhum dispositivo ativo. abra o spotify uma vez e volte.');
  err.reason = 'NO_ACTIVE_DEVICE';
  return err;
}

// Toca uma lista/playlist. Se outro dispositivo estiver tocando, manda pra ele (como no
// Spotify Connect); senão, toca neste navegador (SDK). No modo remoto, precisa de um ativo.
export async function playHere({ contextUri, uris, offset }) {
  const otherDevice = remote?.device?.is_active && remote.device.id !== deviceId ? remote.device.id : null;
  if (otherDevice || mode === 'remote') {
    const target = otherDevice ?? targetDevice();
    if (!target) throw noDeviceError();
    await api.play({ deviceId: target, contextUri, uris, offset });
    pollSoon();
    return;
  }
  if (!player || !deviceId) {
    throw new Error('O player ainda está carregando. Espere alguns segundos e tente de novo.');
  }
  // Precisa ser chamado dentro do clique, senão o navegador pode bloquear o áudio.
  player.activateElement();
  await api.play({ deviceId, contextUri, uris, offset });
}

// Manda a reprodução pra outro dispositivo (lista "dispositivos").
export async function transferTo(id) {
  // Pra este navegador: precisa "ativar" o áudio dentro do clique.
  if (id === deviceId) player?.activateElement();
  const playing = lastState ? !lastState.paused : false;
  await api.transferPlayback(id, playing);
  pollSoon();
}

export const browserDeviceId = () => deviceId;

// ---------- Tela ----------

// O que mostrar quando nada está tocando.
function idleMessage() {
  if (remote?.device) return `> ${remote.device.name}: nada tocando. escolha uma música.`;
  if (mode === 'sdk') return deviceId ? '> pronto. clique numa música pra tocar.' : '> carregando player…';
  return '> nenhum dispositivo ativo. abra o spotify uma vez e volte.';
}

// Atualiza a barra "tocando agora" com o estado atual.
function render() {
  const state = lastState;
  const track = state?.track_window.current_track;

  if (!track) {
    setControlsEnabled(false);
    $('#pb-info').hidden = true;
    clearPixelCover($('#pb-cover'));
    $('#pb-device').textContent = '';
    $('#pb-status').textContent = idleMessage();
    callbacks.onTrackChange(null);
    return;
  }

  setControlsEnabled(true);
  $('#pb-info').hidden = false;
  $('#pb-status').textContent = '';
  // Onde está tocando (quando não é aqui).
  $('#pb-device').textContent = isRemote() && remote?.device ? `@ ${remote.device.name}` : '';

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

  $('#pb-progress').max = state.duration || 1;
  $('#pb-duration').textContent = formatTime(state.duration);
  renderProgress();

  // Avisa o app pra destacar a música na lista (o Spotify às vezes troca a
  // versão da música; linked_from guarda a original).
  callbacks.onTrackChange(track.linked_from?.uri ?? track.uri, track.uri);
}

// Atualiza a aparência dos botões de aleatório e repetir.
function renderModes() {
  const shuffle = $('#pb-shuffle');
  shuffle.querySelector('.mode-value').textContent = lastState.shuffle ? 'ON' : 'OFF';
  shuffle.classList.toggle('active', lastState.shuffle);
  shuffle.setAttribute('aria-pressed', String(lastState.shuffle));

  const modeInfo = REPEAT_MODES[lastState.repeat_mode] ?? REPEAT_MODES[0];
  const repeat = $('#pb-repeat');
  repeat.querySelector('.mode-value').textContent = modeInfo.text;
  repeat.classList.toggle('active', lastState.repeat_mode > 0);
  repeat.setAttribute('aria-label', modeInfo.label);
  repeat.title = modeInfo.label;
}

// Calcula a posição atual e redesenha a barra de progresso.
function renderProgress() {
  if (!lastState || seeking) return;
  const position = currentPosition();
  $('#pb-progress').value = position;
  $('#pb-position').textContent = formatTime(position);
  drawProgressBar();
}

// Muda o estado na tela na hora (sem esperar o Spotify); a próxima leitura confirma.
function updateLocally(changes) {
  lastState = { ...lastState, ...changes };
  lastStateAt = Date.now();
  renderModes();
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
    if (isRemote()) return pollSoon();
    const real = await player?.getCurrentState();
    if (real) {
      lastState = real;
      lastStateAt = Date.now();
      render();
    }
  }
}

// ---------- Controles (usados pelos botões e pelos comandos :play, :next…) ----------

function requireTrack() {
  if (!lastState) {
    if (isRemote()) throw noDeviceError();
    throw new Error('nada tocando neste navegador. clique numa música primeiro.');
  }
}

export async function resume() {
  requireTrack();
  if (isRemote()) {
    updateLocally({ paused: false });
    await api.play({ deviceId: targetDevice() });
    return pollSoon();
  }
  await player.resume();
}

export async function pause() {
  requireTrack();
  if (isRemote()) {
    updateLocally({ position: currentPosition(), paused: true });
    await api.pausePlayback(targetDevice());
    return pollSoon();
  }
  await player.pause();
}

const togglePlay = () => (lastState?.paused ? resume() : pause());

export async function nextTrack() {
  requireTrack();
  if (isRemote()) {
    await api.skipNext(targetDevice());
    return pollSoon();
  }
  await player.nextTrack();
}

// Anterior: depois de 3 segundos volta pro começo da música; antes, vai pra anterior.
export async function previousTrack() {
  requireTrack();
  const restart = currentPosition() > 3000 || lastState.disallows?.skipping_prev;
  if (isRemote()) {
    if (restart) await seek(0);
    else await api.skipPrevious(targetDevice());
    return pollSoon();
  }
  if (restart) return player.seek(0);
  return player.previousTrack();
}

async function seek(position) {
  if (isRemote()) {
    await api.seekTo(position, targetDevice());
  } else {
    await player?.seek(position);
  }
  // Atualiza já, sem esperar o próximo aviso (evita a barra "voltar").
  if (lastState) {
    lastState = { ...lastState, position };
    lastStateAt = Date.now();
  }
}

// Aleatório: liga/desliga. Devolve o estado novo (true = ligado).
export async function toggleShuffle() {
  requireTrack();
  const on = !lastState.shuffle;
  updateLocally({ shuffle: on });
  await api.setShuffle(isRemote() ? targetDevice() : deviceId, on);
  if (isRemote()) pollSoon();
  return on;
}

// Repetir: desligado → lista → música → desligado. Devolve "OFF", "LIST" ou "TRACK".
export async function cycleRepeat() {
  requireTrack();
  const next = (lastState.repeat_mode + 1) % REPEAT_MODES.length;
  updateLocally({ repeat_mode: next });
  await api.setRepeat(isRemote() ? targetDevice() : deviceId, REPEAT_MODES[next].api);
  if (isRemote()) pollSoon();
  return REPEAT_MODES[next].text;
}

// Música tocando agora (ou null).
export const currentTrack = () => lastState?.track_window.current_track ?? null;

function setupControls() {
  setControlsEnabled(false);

  // Os botões ficam desativados sem música, então "lastState &&" só evita avisos à toa.
  $('#pb-toggle').addEventListener('click', () => run(() => lastState && togglePlay()));
  $('#pb-next').addEventListener('click', () => run(() => lastState && nextTrack()));
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
  progress.addEventListener('change', () =>
    run(async () => {
      try {
        await seek(Number(progress.value));
      } finally {
        seeking = false;
      }
    }),
  );

  // Volume: 0–100 na tela. No SDK muda na hora; no remoto, manda ao soltar
  // (cada ajuste seria uma chamada à API).
  const volume = $('#pb-volume');
  volume.value = Math.round(savedVolume() * 100);
  volume.addEventListener('input', () => {
    volumeDragging = true;
    drawVolumeBar();
    if (isRemote()) return;
    const v = volume.value / 100;
    player?.setVolume(v);
    try {
      localStorage.setItem(VOLUME_KEY, String(v));
    } catch {
      // sem problema: só não lembra o volume
    }
  });
  volume.addEventListener('change', () =>
    run(async () => {
      try {
        if (isRemote() && targetDevice()) await api.setVolume(Number(volume.value), targetDevice());
      } finally {
        volumeDragging = false;
      }
    }),
  );

  // Desenha as barras agora, e de novo quando a largura mudar (ex: janela redimensionada).
  drawProgressBar();
  drawVolumeBar();
  const resize = new ResizeObserver(() => {
    charWidth = 0; // girou a tela / mudou a escala: a letra pode ter mudado de tamanho
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
