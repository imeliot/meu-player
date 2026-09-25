// Lógica da página principal: login, biblioteca, tocar e gerenciar playlists.
//
// Ideia geral: as listas ficam guardadas em variáveis (o "estado"). Depois de
// qualquer alteração, mudamos o estado e redesenhamos a lista na tela.
import { login, logout, isLoggedIn, hasAllScopes } from './auth.js';
import { APP_ROOT } from './config.js';
import * as api from './api.js';
import { initPlayer, playHere, currentTrack } from './player.js';
import { initCmdline, hint, prefill } from './cmdline.js';
import { initDevices, setDevicesShown } from './devices.js';
import { initRoll } from './roll.js';
import { registerApp, fold } from './commands.js';
import { startBoot } from './boot.js';
import { isThemePlaylist, syncFromPlaylists } from './themes.js';
import * as pins from './pins.js';
import { loadCache, saveCache, dropCache, debounce } from './cache.js';
import { initConfig, setSyncStatus, closeConfig } from './settings.js';
import {
  $,
  el,
  formatDuration,
  decorateBoxes,
  setBoxTitle,
  decodeHtml,
  showNotice,
  hideNotice,
  confirmDialog,
  playlistFormDialog,
  pickPlaylistDialog,
} from './ui.js';

// ---------- Estado ----------

let me = null; // usuário logado

// URL da próxima página de cada lista (null = acabou).
const nextPage = { tracks: null, playlists: null, playlistItems: null, search: null, albums: null };

let likedTracks = []; // músicas curtidas carregadas (mais recente primeiro)
let likedTotal = 0;

// Quais músicas estão curtidas: uri → true/false (usado pelos corações).
const likedStatus = new Map();

let playlists = []; // playlists carregadas (sem as de bastidor)
let playlistsTotal = 0;
const themePlaylists = []; // playlists "⚙ tema: …" (escondidas; viram temas no [config])
let pinsPlaylist = null; // playlist "⚙ fixadas" (escondida; guarda quais estão fixadas)

let openPlaylist = null; // playlist aberta no momento
let playlistEntries = []; // músicas dela: { track, position }

let playingUris = []; // música tocando agora (pra destacar)

// O que o painel da direita mostra: 'liked' (curtidas), 'playlist' ou 'search' (busca).
let currentView = 'liked';

let searchResults = []; // resultados da busca "?texto"
let searchTotal = 0;
let searchAlbums = []; // álbuns encontrados na mesma busca

let savedAlbums = []; // álbuns salvos na conta
let savedAlbumsTotal = 0;
let openAlbum = null; // álbum aberto no painel da direita
let albumTracks = []; // músicas dele

let filterText = ''; // filtro "/texto" da lista aberta
let selectedTrack = null; // música escolhida pelo teclado (usada por :add)
const trackOfRow = new WeakMap(); // linha <li> → música

// A última interação foi pelo teclado? (tecla = sim; clique/toque = não)
let usingKeyboard = false;
document.addEventListener('keydown', () => (usingKeyboard = true), true);
document.addEventListener('pointerdown', () => (usingKeyboard = false), true);

// ---------- Cache local (abrir rápido e voltar de onde parou) ----------

const CACHE_LIBRARY = 'library'; // curtidas e playlists já carregadas
const CACHE_UI = 'ui'; // aba e playlist abertas da última vez

// Junta o estado atual num objeto simples pra guardar.
const librarySnapshot = () => ({
  me,
  liked: { items: likedTracks, total: likedTotal, next: nextPage.tracks },
  playlists: {
    items: playlists,
    themes: themePlaylists,
    total: playlistsTotal,
    next: nextPage.playlists,
  },
});

// Salva no máximo uma vez a cada 2s (as listas mudam várias vezes seguidas).
const saveLibrarySoon = debounce(() => me && saveCache(CACHE_LIBRARY, librarySnapshot()), 2000);

// As músicas de cada playlist ficam numa chave só dela.
const itemsKey = (id) => `items:${id}`;

const saveItemsSoon = debounce(() => {
  if (!openPlaylist || !playlistEntries.length) return;
  saveCache(itemsKey(openPlaylist.id), {
    snapshot_id: openPlaylist.snapshot_id,
    entries: playlistEntries,
    next: nextPage.playlistItems,
  });
}, 2000);

const saveUiSoon = debounce(
  () =>
    saveCache(CACHE_UI, {
      tab: $('#library-view').dataset.tab,
      view: currentView,
      playlistId: openPlaylist?.id ?? null,
    }),
  800,
);

// Põe na tela a biblioteca guardada. Devolve false se não havia nada salvo.
function applyLibrarySnapshot(data) {
  if (!data?.me) return false;
  me = data.me;
  $('#user-name').textContent = me.display_name ?? me.id;
  likedTracks = data.liked.items;
  likedTotal = data.liked.total;
  nextPage.tracks = data.liked.next;
  for (const track of likedTracks) likedStatus.set(track.uri, true);
  playlists = data.playlists.items;
  playlistsTotal = data.playlists.total;
  nextPage.playlists = data.playlists.next;
  themePlaylists.length = 0;
  themePlaylists.push(...data.playlists.themes);
  renderLiked();
  renderPlaylists();
  return true;
}

// Antes de aplicar as listas novas do Spotify, esvazia as do cache (senão duplicaria).
function resetLibraryState() {
  likedTracks = [];
  likedTotal = 0;
  playlists = [];
  playlistsTotal = 0;
  themePlaylists.length = 0;
  pinsPlaylist = null;
  nextPage.tracks = null;
  nextPage.playlists = null;
}

// Volta pra aba e pra playlist de quando o app foi fechado.
async function restoreUi(ui) {
  if (!ui) return;
  const playlist = ui.playlistId && playlists.find((p) => p.id === ui.playlistId);
  if (playlist) await safely(() => openPlaylistView(playlist));
  // O painel [config] não é um bom lugar pra reabrir o app.
  if (ui.tab && ui.tab !== 'config') showTab(ui.tab);
}

// ---------- Ajudantes ----------

// Roda uma ação mostrando erros na tela em vez de quebrar em silêncio.
async function safely(fn) {
  try {
    await fn();
  } catch (err) {
    console.error(err);
    if (err.status === 401) return sessionExpired();
    showNotice(err.message);
  }
}

// Sair da conta apaga também a cópia local da biblioteca (é de quem estava logado).
async function forgetEverything() {
  logout();
  await Promise.all([dropCache(CACHE_LIBRARY), dropCache(CACHE_UI)]);
}

async function sessionExpired() {
  await forgetEverything();
  location.replace(`${APP_ROOT}?expirou=1`);
}

const isOwner = (p) => p.owner?.id === me?.id;
// Dá pra mexer nas músicas se a playlist é sua ou colaborativa.
const canEditItems = (p) => isOwner(p) || p.collaborative;

// Número de músicas da playlist (desde fev/2026 o campo é "items"; "tracks" é o antigo).
const trackCount = (p) => p.items?.total ?? p.tracks?.total ?? 0;

function setTrackCount(p, total) {
  if (p.items) p.items.total = total;
  else if (p.tracks) p.tracks.total = total;
  else p.items = { total };
}

// Arquivos locais não podem ser curtidos, adicionados nem tocados pela API.
const isLocal = (track) => track.is_local || track.uri?.startsWith('spotify:local:');

// ---------- Linhas das listas ----------

// Linha de música em colunas: # | título | artista | tempo, e os botões de ação.
function trackRow(track, number, onPlay, extra = []) {
  const li = el('li', 'row');
  trackOfRow.set(li, track);
  // Texto usado pelo filtro "/texto": título, artistas e álbum, sem acentos.
  li.dataset.search = fold(
    [track.name, ...(track.artists ?? []).map((a) => a.name), track.album?.name ?? ''].join(' '),
  );
  const btn = el('button', 'item');
  btn.type = 'button';
  btn.dataset.uri = track.uri;
  // Texto completo como dica (pra quem desliga animações e o título não rola).
  btn.title = [track.name, track.artists?.map((a) => a.name).join(', '), track.album?.name]
    .filter(Boolean)
    .join(' · ');
  if (playingUris.includes(track.uri)) btn.classList.add('playing');
  btn.addEventListener('click', () => {
    if (li.dataset.longPressed) return void delete li.dataset.longPressed; // foi toque longo
    selectTrack(null); // clicou = tocou; a "selecionada" passa a ser a que toca
    onPlay();
  });
  attachLongPress(li, track.name);
  // Chegou pelo teclado (Tab/setas): vira a música selecionada (pro :add).
  btn.addEventListener('focus', () => {
    if (usingKeyboard) selectTrack(li, track);
  });
  btn.addEventListener('keydown', (e) => moveWithArrows(e, li));
  btn.append(
    el('span', 'col-num', String(number)),
    el('span', 'col-title', track.name),
    el('span', 'col-artist', track.artists?.map((a) => a.name).join(', ') ?? ''),
    el('span', 'col-album', track.album?.name ?? ''),
    el('span', 'col-time', formatDuration(track.duration_ms)),
  );

  const actions = el('span', 'row-actions');
  if (!isLocal(track)) {
    actions.append(
      heartButton(track),
      actionButton('Adicionar a uma playlist', '+', () => safely(() => addToPlaylist(track))),
    );
  }
  actions.append(...extra);
  li.append(btn, actions);
  return li;
}

// Setas ↑↓ andam entre as músicas visíveis da lista; Enter toca (é um botão).
// ↓ na última música carrega a próxima página e continua descendo.
async function moveWithArrows(e, li) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const step = (from) => {
    let target = from;
    do {
      target = e.key === 'ArrowDown' ? target.nextElementSibling : target.previousElementSibling;
    } while (target?.hidden);
    return target;
  };
  let target = step(li);
  if (!target && e.key === 'ArrowDown') {
    // A lista é redesenhada ao carregar: guarda a posição pra achar a linha nova.
    const list = li.parentElement;
    const index = [...list.children].indexOf(li);
    await safely(loadMore);
    const same = list.children[index];
    target = same ? step(same) : null;
  }
  focusRow(target);
}

// Foca uma linha e marca a música como selecionada.
function focusRow(li) {
  if (!li) return;
  li.querySelector('.item')?.focus();
  selectTrack(li, trackOfRow.get(li));
}

// ---------- Toque longo (celular): menu com ♥, + e - ----------

// Segurar o dedo ~0,5s numa música (ou clique direito no PC) abre o menu de ações.
function attachLongPress(li, title) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  li.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    startX = e.clientX;
    startY = e.clientY;
    timer = setTimeout(() => {
      timer = null;
      li.dataset.longPressed = '1';
      openRowMenu(li, title);
    }, 500);
  });
  // Arrastou o dedo (rolando a lista): não é toque longo.
  li.addEventListener('pointermove', (e) => {
    if (timer && Math.hypot(e.clientX - startX, e.clientY - startY) > 10) cancel();
  });
  li.addEventListener('pointerup', cancel);
  li.addEventListener('pointercancel', cancel);
  li.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    cancel();
    openRowMenu(li, title);
  });
}

// O menu reaproveita os botões da própria linha (♥, +, -), que ficam escondidos no celular.
function openRowMenu(li, title) {
  const menu = $('#row-menu');
  if (menu.open) return;
  const actions = [...li.querySelectorAll('.row-actions .row-action')];
  if (!actions.length) return;
  $('#row-menu-title').textContent = title;
  $('#row-menu-list').replaceChildren(
    ...actions.map((action) => {
      const item = el('button', 'lib-item');
      item.type = 'button';
      item.classList.toggle('selected', action.classList.contains('liked'));
      item.append(el('span', 'row-menu-icon', action.textContent), el('span', 'lib-name', action.getAttribute('aria-label')));
      item.addEventListener('click', () => {
        menu.close();
        action.click();
      });
      const row = el('li');
      row.append(item);
      return row;
    }),
  );
  menu.showModal();
}

function selectTrack(li, track) {
  document.querySelectorAll('.row.kb-selected').forEach((r) => r.classList.remove('kb-selected'));
  li?.classList.add('kb-selected');
  selectedTrack = li ? track : null;
}

function actionButton(label, text, onClick, className = '') {
  const btn = el('button', `row-action ${className}`, text);
  btn.type = 'button';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.addEventListener('click', onClick);
  return btn;
}

function heartButton(track) {
  const btn = actionButton('Curtir', '♥', () => safely(() => toggleLike(track)), 'heart');
  btn.dataset.uri = track.uri;
  paintHeart(btn);
  return btn;
}

// Coração: apagado = não curtida; na cor de destaque = curtida.
function paintHeart(btn) {
  const liked = likedStatus.get(btn.dataset.uri) === true;
  btn.classList.toggle('liked', liked);
  btn.setAttribute('aria-pressed', String(liked));
  const label = liked ? 'Remover das curtidas' : 'Curtir';
  btn.setAttribute('aria-label', label);
  btn.title = label;
}

// ---------- Músicas curtidas ----------

function renderLiked() {
  $('#tracks-list').replaceChildren(
    ...likedTracks.map((track, i) => trackRow(track, i + 1, () => safely(() => playLiked(track)))),
  );
  $('#tracks-count').textContent = likedTotal;
  $('#tracks-more').hidden = !nextPage.tracks;
  applyFilter();
  saveLibrarySoon();
}

function addLikedPage(page) {
  for (const { track } of page.items) {
    if (!track) continue; // itens indisponíveis podem vir nulos
    likedTracks.push(track);
    likedStatus.set(track.uri, true);
  }
  likedTotal = page.total;
  nextPage.tracks = page.next;
  renderLiked();
}

// "Curtidas" (e a busca) não têm um endereço de contexto oficial na API, então mandamos
// a própria lista de músicas: algumas antes (pro "anterior") e várias depois.
const playLiked = (track) => playFromList(likedTracks, track);

function playFromList(list, track) {
  if (isLocal(track)) throw new Error('Arquivos locais não podem ser tocados por aqui.');
  const playable = list.filter((t) => !isLocal(t));
  const index = playable.indexOf(track);
  const start = Math.max(0, index - 10);
  const uris = playable.slice(start, start + 100).map((t) => t.uri);
  return playHere({ uris, offset: { position: index - start } });
}

async function toggleLike(track) {
  if (likedStatus.get(track.uri)) {
    const ok = await confirmDialog(`Remover "${track.name}" das músicas curtidas?`, 'Remover');
    if (!ok) return;
    await api.removeFromLibrary([track.uri]);
    likedStatus.set(track.uri, false);
    const before = likedTracks.length;
    likedTracks = likedTracks.filter((t) => t.uri !== track.uri);
    if (likedTracks.length < before) likedTotal--;
    showNotice('Removida das curtidas.', 'success');
  } else {
    await api.saveToLibrary([track.uri]);
    likedStatus.set(track.uri, true);
    // Curtida nova vai pro topo (é a ordem do Spotify).
    likedTracks = [track, ...likedTracks.filter((t) => t.uri !== track.uri)];
    likedTotal++;
    showNotice('Adicionada às curtidas.', 'success');
  }
  renderLiked();
  refreshHearts();
}

// Atualiza todos os corações da tela.
function refreshHearts() {
  document.querySelectorAll('.heart[data-uri]').forEach(paintHeart);
}

// Descobre quais músicas estão curtidas (a API aceita 40 por vez).
async function checkLiked(tracks) {
  const unknown = [...new Set(tracks.filter((t) => !isLocal(t)).map((t) => t.uri))].filter(
    (uri) => !likedStatus.has(uri),
  );
  for (let i = 0; i < unknown.length; i += 40) {
    const chunk = unknown.slice(i, i + 40);
    const result = await api.libraryContains(chunk);
    chunk.forEach((uri, j) => likedStatus.set(uri, Boolean(result?.[j])));
  }
  refreshHearts();
}

// ---------- Lista de playlists ----------

function renderPlaylists() {
  $('#playlists-list').replaceChildren(
    ...sortedPlaylists().map((p) => {
      const li = el('li');
      const btn = el('button', 'lib-item');
      btn.type = 'button';
      btn.classList.toggle('selected', openPlaylist?.id === p.id);
      btn.classList.toggle('pinned', isPinned(p));
      btn.title =
        `${p.name} · de ${p.owner?.display_name ?? 'desconhecido'}` + (isPinned(p) ? ' · fixada' : '');
      btn.append(el('span', 'lib-name', p.name), el('span', 'dim', String(trackCount(p))));
      btn.addEventListener('click', () => safely(() => openPlaylistView(p)));
      li.append(btn);
      return li;
    }),
  );
  $('#playlists-count').textContent = playlistsTotal;
  $('#playlists-more').hidden = !nextPage.playlists;
  saveLibrarySoon();
}

function addPlaylistsPage(page) {
  // As playlists de bastidor ("⚙ tema: …" e "⚙ fixadas") nunca aparecem nas listas.
  const items = page.items.filter(Boolean);
  themePlaylists.push(...items.filter(isThemePlaylist));
  pinsPlaylist = items.find(pins.isPinsPlaylist) ?? pinsPlaylist;
  const hidden = (p) => isThemePlaylist(p) || pins.isPinsPlaylist(p);
  playlists.push(...items.filter((p) => !hidden(p)));
  playlistsTotal = page.total - themePlaylists.length - (pinsPlaylist ? 1 : 0);
  nextPage.playlists = page.next;
  renderPlaylists();
}

async function createPlaylist() {
  const data = await playlistFormDialog({ title: '> nova playlist', askPublic: true });
  if (!data) return;
  const created = await api.createPlaylist(data);
  addCreatedPlaylist(created);
  showNotice(`Playlist "${created.name}" criada.`, 'success');
}

function addCreatedPlaylist(created) {
  playlists.unshift(created);
  playlistsTotal++;
  renderPlaylists();
}

// Carrega todas as páginas de playlists (necessário pra lista de "adicionar a…").
async function loadAllPlaylists() {
  while (nextPage.playlists) addPlaylistsPage(await api.getPlaylists(nextPage.playlists));
}

async function addToPlaylist(track) {
  await loadAllPlaylists();
  const target = await pickPlaylistDialog(playlists.filter(canEditItems), track.name);
  if (!target) return;

  await addTrackTo(target, track);
  showNotice(`Adicionada a "${target.name}".`, 'success');
}

async function addTrackTo(target, track) {
  await api.addToPlaylist(target.id, [track.uri]);
  setTrackCount(target, trackCount(target) + 1);
  renderPlaylists();
  if (openPlaylist?.id === target.id) await reloadPlaylistItems();
}

// Acha uma playlist editável pelo nome digitado (:add). Aceita começo ou parte do nome.
function findPlaylistByName(name) {
  const typed = fold(name.trim());
  const editable = playlists.filter(canEditItems);
  const exact = editable.filter((p) => fold(p.name) === typed);
  if (exact.length) return exact[0];
  let found = editable.filter((p) => fold(p.name).startsWith(typed));
  if (!found.length) found = editable.filter((p) => fold(p.name).includes(typed));
  if (found.length === 1) return found[0];
  if (!found.length) throw new Error(`playlist não encontrada: ${name}`);
  throw new Error(`mais de uma playlist combina: ${found.map((p) => p.name).join(', ')} (use tab)`);
}

// ---------- Playlists fixadas ----------

const isPinned = (playlist) => pins.isPinned(playlist.id);

// Fixadas primeiro, na ordem em que você fixou; o resto continua na ordem do Spotify.
function sortedPlaylists() {
  const order = pins.pinnedIds();
  const pinned = playlists.filter(isPinned).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return [...pinned, ...playlists.filter((p) => !isPinned(p))];
}

async function togglePinned(playlist) {
  const { pinned, full } = pins.toggle(playlist.id);
  if (full) {
    throw new Error(`no máximo ${pins.pinLimit()} playlists fixadas (a descrição do spotify é curta).`);
  }
  renderPlaylists();
  renderPinButton();
  showNotice(
    pinned ? `"${playlist.name}" fixada no topo.` : `"${playlist.name}" desafixada.`,
    'success',
  );
  // Guarda na conta pra valer nos outros aparelhos (se falhar, fica só neste).
  try {
    await pins.push();
  } catch (err) {
    console.error(err);
    showNotice('fixada só neste aparelho: o spotify não aceitou salvar a lista agora.');
  }
}

function renderPinButton() {
  if (!openPlaylist) return;
  $('#playlist-pin').textContent = isPinned(openPlaylist) ? '[desafixar]' : '[fixar]';
}

// ---------- Álbuns ----------

const albumArtists = (album) => (album.artists ?? []).map((a) => a.name).join(', ');
const albumYear = (album) => (album.release_date ?? '').slice(0, 4);

// Quais álbuns estão salvos na sua biblioteca: uri → true/false.
const albumSaved = new Map();

// Linha de álbum (nas buscas e na lista de salvos), com o ♥ de salvar/tirar.
function albumRow(album) {
  const li = el('li', 'album-row');
  li.dataset.search = fold(`${album.name} ${albumArtists(album)}`);
  const btn = el('button', 'lib-item');
  btn.type = 'button';
  const detail = [albumArtists(album), albumYear(album), `${album.total_tracks ?? '?'} músicas`]
    .filter(Boolean)
    .join(' · ');
  btn.title = `${album.name} · ${detail}`;
  btn.append(el('span', 'lib-name', album.name), el('span', 'dim', detail));
  btn.addEventListener('click', () => safely(() => openAlbumView(album)));
  const heart = actionButton('Salvar álbum', '♥', () => safely(() => toggleAlbumSaved(album)), 'heart');
  heart.dataset.albumUri = album.uri;
  paintAlbumHeart(heart);
  li.append(btn, heart);
  return li;
}

// Coração do álbum: apagado = não salvo; na cor de destaque = salvo.
function paintAlbumHeart(btn) {
  const saved = albumSaved.get(btn.dataset.albumUri) === true;
  btn.classList.toggle('liked', saved);
  btn.setAttribute('aria-pressed', String(saved));
  const label = saved ? 'Tirar da sua biblioteca' : 'Salvar na sua biblioteca';
  btn.setAttribute('aria-label', label);
  btn.title = label;
}

const refreshAlbumHearts = () => {
  document.querySelectorAll('[data-album-uri]').forEach(paintAlbumHeart);
  renderAlbumSaveButton();
};

// Pergunta ao Spotify quais destes álbuns você já salvou (até 40 por vez).
async function checkAlbumsSaved(albums) {
  const uris = albums.map((a) => a.uri).filter((uri) => uri && !albumSaved.has(uri));
  for (let i = 0; i < uris.length; i += 40) {
    const chunk = uris.slice(i, i + 40);
    const result = await api.libraryContains(chunk);
    chunk.forEach((uri, j) => albumSaved.set(uri, Boolean(result?.[j])));
  }
  refreshAlbumHearts();
}

// Salva ou tira o álbum da sua biblioteca (é o mesmo "salvar" do app do Spotify).
async function toggleAlbumSaved(album) {
  const saved = albumSaved.get(album.uri) === true;
  if (saved) {
    await api.removeFromLibrary([album.uri]);
    albumSaved.set(album.uri, false);
    savedAlbums = savedAlbums.filter((a) => a.id !== album.id);
    savedAlbumsTotal = Math.max(0, savedAlbumsTotal - 1);
    showNotice(`"${album.name}" saiu dos seus álbuns.`, 'success');
  } else {
    await api.saveToLibrary([album.uri]);
    albumSaved.set(album.uri, true);
    if (!savedAlbums.some((a) => a.id === album.id)) savedAlbums.unshift(album);
    savedAlbumsTotal++;
    showNotice(`"${album.name}" salvo na sua biblioteca.`, 'success');
  }
  if (currentView === 'albums') renderSavedAlbums();
  else $('#albums-count').textContent = savedAlbumsTotal || '';
  saveCache('albums', { items: savedAlbums, total: savedAlbumsTotal, next: nextPage.albums });
  refreshAlbumHearts();
}

// Botão de salvar/tirar do álbum aberto.
function renderAlbumSaveButton() {
  const button = $('#album-save');
  if (!openAlbum) return;
  const saved = albumSaved.get(openAlbum.uri) === true;
  button.textContent = saved ? '[- tirar da biblioteca]' : '[♥ salvar na biblioteca]';
  button.classList.toggle('danger', saved);
}

// Abre um álbum e mostra as músicas dele. O álbum nunca muda, então a lista de músicas
// fica guardada neste aparelho pra sempre: abrir de novo não custa requisição nenhuma.
async function openAlbumView(album) {
  openAlbum = album;
  albumTracks = [];
  showView('album');
  setBoxTitle($('#panel-list'), `álbum: ${album.name}`);
  $('#album-info').textContent =
    `${albumArtists(album)} · ${albumYear(album)} · ${album.total_tracks ?? '?'} músicas`;
  renderAlbumSaveButton();
  checkAlbumsSaved([album]).catch((err) => console.error(err));
  renderAlbumTracks();
  showTab('list'); // no celular, pula pra aba da lista

  const key = `album:${album.id}`;
  const saved = (await loadCache(key))?.data;
  if (openAlbum !== album) return;
  if (saved?.length) {
    albumTracks = saved;
    renderAlbumTracks();
    return checkLiked(albumTracks);
  }

  let page = await api.getAlbumTracks(album.id);
  const items = [...page.items];
  while (page.next) {
    page = await api.getAlbumTracks(album.id, page.next);
    items.push(...page.items);
  }
  if (openAlbum !== album) return;
  // As músicas do álbum vêm sem os dados do álbum: colamos de volta (capa e nome).
  albumTracks = items
    .filter(Boolean)
    .map((track) => ({ ...track, album: { id: album.id, name: album.name, images: album.images } }));
  renderAlbumTracks();
  saveCache(key, albumTracks);
  await checkLiked(albumTracks);
}

function renderAlbumTracks() {
  $('#album-items').replaceChildren(
    ...albumTracks.map((track) =>
      trackRow(track, track.track_number, () => safely(() => playInAlbum(track))),
    ),
  );
  applyFilter();
}

// Toca o álbum inteiro a partir da música escolhida (assim o "próxima" segue o álbum).
const playInAlbum = (track) =>
  playHere({ contextUri: openAlbum.uri, offset: track ? { uri: track.uri } : undefined });

// Manda o álbum todo pra uma playlist (o Spotify aceita 100 músicas por vez).
async function addAlbumToPlaylist() {
  if (!albumTracks.length) throw new Error('o álbum ainda está carregando.');
  const target = await pickPlaylistDialog(
    playlists.filter(canEditItems),
    `${openAlbum.name} · álbum inteiro (${albumTracks.length} músicas)`,
  );
  if (!target) return;
  const uris = albumTracks.filter((t) => !isLocal(t)).map((t) => t.uri);
  for (let i = 0; i < uris.length; i += 100) {
    await api.addToPlaylist(target.id, uris.slice(i, i + 100));
  }
  setTrackCount(target, trackCount(target) + uris.length);
  renderPlaylists();
  if (openPlaylist?.id === target.id) await reloadPlaylistItems();
  showNotice(`${uris.length} músicas de "${openAlbum.name}" em "${target.name}".`, 'success');
}

// Lista dos álbuns salvos na conta (fica no cache; só atualiza quando você abre a lista).
async function showSavedAlbums() {
  showView('albums');
  setBoxTitle($('#panel-list'), 'álbuns salvos');
  showTab('list');

  const saved = (await loadCache('albums'))?.data;
  if (saved?.items?.length) {
    savedAlbums = saved.items;
    savedAlbumsTotal = saved.total;
    nextPage.albums = saved.next;
    renderSavedAlbums();
  } else {
    $('#albums-status').textContent = '> carregando álbuns salvos…';
  }

  savedAlbums = [];
  addSavedAlbumsPage(await api.getSavedAlbums());
}

function addSavedAlbumsPage(page) {
  savedAlbums.push(...page.items.map((item) => item?.album).filter(Boolean));
  savedAlbumsTotal = page.total;
  nextPage.albums = page.next;
  renderSavedAlbums();
  saveCache('albums', { items: savedAlbums, total: savedAlbumsTotal, next: nextPage.albums });
}

function renderSavedAlbums() {
  // Estão na lista de salvos, então estão salvos: o ♥ já nasce aceso.
  for (const album of savedAlbums) albumSaved.set(album.uri, true);
  $('#albums-list').replaceChildren(...savedAlbums.map(albumRow));
  $('#albums-count').textContent = savedAlbumsTotal || '';
  $('#albums-status').textContent = savedAlbumsTotal
    ? `> ${savedAlbums.length} de ${savedAlbumsTotal} álbuns salvos`
    : '> nenhum álbum salvo. salve álbuns no spotify e eles aparecem aqui.';
  $('#albums-more').hidden = !nextPage.albums;
  applyFilter();
}

// ---------- Painel da direita: curtidas, playlist ou busca ----------

function showView(view) {
  currentView = view;
  if (view !== 'playlist') openPlaylist = null;
  if (view !== 'album') openAlbum = null;
  $('#liked-view').hidden = view !== 'liked';
  $('#playlist-view').hidden = view !== 'playlist';
  $('#playlist-detail').hidden = view !== 'playlist';
  $('#search-view').hidden = view !== 'search';
  $('#albums-view').hidden = view !== 'albums';
  $('#album-view').hidden = view !== 'album';
  $('#album-detail').hidden = view !== 'album';
  $('#liked-entry').classList.toggle('selected', view === 'liked');
  $('#albums-entry').classList.toggle('selected', view === 'albums');
  applyFilter();
  saveUiSoon();
}

const LIST_OF_VIEW = {
  liked: '#tracks-list',
  playlist: '#playlist-items',
  search: '#search-list',
  albums: '#albums-list',
  album: '#album-items',
};

// Filtro "/texto": esconde as linhas que não combinam (só na lista aberta, sem chamar a API).
function applyFilter() {
  const typed = fold(filterText.trim());
  for (const [view, selector] of Object.entries(LIST_OF_VIEW)) {
    for (const li of $(selector).children) {
      li.hidden = view === currentView && typed ? !li.dataset.search?.includes(typed) : false;
    }
  }
  if (!typed) return;
  const rows = [...$(LIST_OF_VIEW[currentView]).children];
  const shown = rows.filter((li) => !li.hidden).length;
  hint(`filtro "${filterText.trim()}": ${shown} de ${rows.length} (nas já carregadas) · esc limpa`);
}

function setFilter(text) {
  filterText = text;
  applyFilter();
  if (!text.trim()) hint('');
}

function clearFilter() {
  if (!filterText) return;
  filterText = '';
  applyFilter();
  hint('');
}

// Põe o foco na primeira música visível (depois do Enter no filtro ou na busca).
function focusList() {
  focusRow([...$(LIST_OF_VIEW[currentView]).children].find((li) => !li.hidden));
}

// ---------- Carregar mais (botão, :more e ↓ na última música) ----------

// Como buscar a próxima página de cada lista do painel da direita.
const MORE = {
  liked: {
    next: () => nextPage.tracks,
    load: async () => addLikedPage(await api.getSavedTracks(nextPage.tracks)),
  },
  playlist: {
    next: () => nextPage.playlistItems,
    load: async () =>
      addPlaylistItemsPage(await api.getPlaylistItems(openPlaylist.id, nextPage.playlistItems)),
  },
  search: {
    next: () => nextPage.search,
    load: async () => addSearchPage(await api.searchTracks(null, nextPage.search)),
  },
  albums: {
    next: () => nextPage.albums,
    load: async () => addSavedAlbumsPage(await api.getSavedAlbums(nextPage.albums)),
  },
  album: { next: () => null, load: async () => {} }, // o álbum já vem inteiro
};

let loadingMore = false; // evita buscar a mesma página duas vezes (↓ segurado)

// Carrega a próxima página da lista aberta. Devolve uma mensagem pro :more.
async function loadMore() {
  const more = MORE[currentView];
  if (!more.next()) return 'a lista já está completa.';
  if (loadingMore) return 'já carregando…';
  loadingMore = true;
  const list = $(LIST_OF_VIEW[currentView]);
  const before = list.children.length;
  try {
    await more.load();
  } finally {
    loadingMore = false;
  }
  const after = list.children.length;
  return `+${after - before} músicas (${after} carregadas)${more.next() ? '' : '. fim da lista.'}`;
}

// ---------- Busca "?texto" ----------

async function runSearch(query) {
  const page = await api.searchTracksAndAlbums(query);
  searchResults = [];
  searchAlbums = (page.albums?.items ?? []).filter(Boolean);
  filterText = '';
  showView('search');
  renderPlaylists(); // tira o ">" da playlist que estava aberta
  setBoxTitle($('#panel-list'), `busca: ${query}`);
  showTab('list'); // no celular, pula pra aba da lista
  addSearchPage(page);
  const total = page.tracks?.total ?? 0;
  const albums = searchAlbums.length ? `${searchAlbums.length} álbum(ns) e ` : '';
  return total || searchAlbums.length
    ? `${albums}${total} música(s). mostrando ${searchResults.length}; ↑↓ escolhe, enter toca.`
    : 'nada encontrado.';
}

function addSearchPage(page) {
  const tracks = page.tracks ?? { items: [], total: 0 };
  searchResults.push(...tracks.items.filter(Boolean));
  searchTotal = tracks.total;
  // A API só pagina até a posição 1000.
  const hasMore = tracks.next && tracks.offset + tracks.limit < api.SEARCH_MAX_OFFSET;
  nextPage.search = hasMore ? tracks.next : null;
  renderSearch();
  checkLiked(searchResults).catch((err) => console.error(err));
}

function renderSearch() {
  $('#search-list').replaceChildren(
    ...searchResults.map((track, i) =>
      trackRow(track, i + 1, () => safely(() => playFromList(searchResults, track))),
    ),
  );
  $('#search-albums').replaceChildren(...searchAlbums.map(albumRow));
  checkAlbumsSaved(searchAlbums).catch((err) => console.error(err));
  $('#search-albums-heading').hidden = !searchAlbums.length;
  $('#search-tracks-heading').hidden = !(searchAlbums.length && searchResults.length);
  $('#search-empty').hidden = searchResults.length > 0 || searchAlbums.length > 0;
  $('#search-more').hidden = !nextPage.search;
  $('#search-more').textContent = `[carregar mais] (${searchResults.length} de ${searchTotal})`;
  applyFilter();
}

// ---------- Playlist aberta ----------

function renderPlaylistHeader() {
  const p = openPlaylist;
  setBoxTitle($('#panel-list'), `lista: ${p.name}`);
  const description = decodeHtml(p.description);
  $('#playlist-description').textContent = description;
  $('#playlist-description').hidden = !description;
  $('#playlist-edit').hidden = !isOwner(p);
  renderPinButton();
  // No Spotify, "excluir" é deixar de seguir, inclusive das suas playlists.
  $('#playlist-delete').textContent = isOwner(p) ? '[excluir]' : '[deixar de seguir]';
}

async function openPlaylistView(playlist) {
  playlistEntries = [];
  nextPage.playlistItems = null;
  showView('playlist');
  openPlaylist = playlist;
  $('#playlist-note').hidden = true;
  renderPlaylistHeader();
  renderPlaylistItems();
  renderPlaylists(); // marca a playlist escolhida com ">"
  showTab('list'); // no celular, pula pra aba da lista

  // Músicas guardadas deste aparelho: aparecem na hora (e servem offline).
  const saved = (await loadCache(itemsKey(playlist.id)))?.data;
  if (openPlaylist !== playlist) return; // já saiu daqui enquanto lia o cache
  if (saved?.entries?.length) {
    playlistEntries = saved.entries;
    nextPage.playlistItems = saved.next ?? null;
    renderPlaylistItems();
    // O Spotify muda o "snapshot_id" a cada alteração. Igual e completa = nem pergunta.
    if (saved.snapshot_id === playlist.snapshot_id && saved.entries.length >= trackCount(playlist)) {
      return;
    }
  }

  let page;
  try {
    page = await api.getPlaylistItems(playlist.id);
  } catch (err) {
    // Sem internet, mas com cópia guardada: fica com ela em vez de mostrar erro.
    if (!err.status && playlistEntries.length) return console.error(err);
    // 403: o Spotify só mostra as músicas de playlists suas ou colaborativas.
    if (err.status !== 403) throw err;
    $('#playlist-note').textContent =
      'O Spotify só mostra as músicas de playlists suas ou colaborativas. ' +
      'Mas dá pra tocar esta playlist inteira no botão acima.';
    $('#playlist-note').hidden = false;
    return;
  }
  // Só mostra se o usuário ainda está nesta playlist (pode ter voltado ou aberto outra).
  if (openPlaylist !== playlist) return;
  playlistEntries = []; // troca a cópia guardada pela lista nova
  await addPlaylistItemsPage(page);
}

// Mostra as músicas curtidas no painel da direita (é o "fechar playlist").
function closePlaylistView() {
  showView('liked');
  setBoxTitle($('#panel-list'), 'lista: músicas curtidas');
  renderPlaylists();
}

function addPlaylistItemsPage(page) {
  if (!openPlaylist) return; // o usuário já saiu da playlist
  page.items.forEach((entry, i) => {
    // Desde fev/2026 a música fica em "item"; "track" é o nome antigo.
    const track = entry?.item ?? entry?.track;
    // Posição real na playlist (conta também as páginas anteriores).
    if (track) playlistEntries.push({ track, position: page.offset + i });
  });
  nextPage.playlistItems = page.next;
  setTrackCount(openPlaylist, page.total);
  renderPlaylistItems();
  renderPlaylists();
  return checkLiked(playlistEntries.map((e) => e.track));
}

// Busca as músicas de novo (depois de remover/mover), mantendo quantas já estavam carregadas.
async function reloadPlaylistItems() {
  const wanted = Math.max(playlistEntries.length, 1);
  playlistEntries = [];
  nextPage.playlistItems = null;
  let page = await api.getPlaylistItems(openPlaylist.id);
  await addPlaylistItemsPage(page);
  while (page.next && playlistEntries.length < wanted) {
    page = await api.getPlaylistItems(openPlaylist.id, page.next);
    await addPlaylistItemsPage(page);
  }
}

function renderPlaylistItems() {
  const editable = canEditItems(openPlaylist);
  saveItemsSoon();
  $('#playlist-items').replaceChildren(
    ...playlistEntries.map((entry) => {
      const extra = editable
        ? [
            actionButton('Remover da playlist', '-', () => safely(() => removeFromPlaylist(entry))),
            dragHandle(),
          ]
        : [];
      const li = trackRow(
        entry.track,
        entry.position + 1,
        () => safely(() => playInPlaylist(entry.position)),
        extra,
      );
      if (editable) {
        li.draggable = true;
        li.dataset.position = entry.position;
      }
      return li;
    }),
  );
  $('#playlist-more').hidden = !nextPage.playlistItems;
  applyFilter();
}

// Toca a playlist a partir de uma música: o resto dela segue na fila.
function playInPlaylist(position) {
  return playHere({
    contextUri: openPlaylist.uri,
    ...(position != null && { offset: { position } }),
  });
}

async function removeFromPlaylist(entry) {
  const ok = await confirmDialog(
    `Remover "${entry.track.name}" da playlist "${openPlaylist.name}"? ` +
      'Se ela aparecer mais de uma vez na playlist, todas as cópias podem sair.',
    'Remover',
  );
  if (!ok) return;
  await api.removeFromPlaylist(openPlaylist.id, entry.track.uri);
  await reloadPlaylistItems();
  showNotice('Removida da playlist.', 'success');
}

async function editPlaylist() {
  const p = openPlaylist;
  const data = await playlistFormDialog({
    title: '> editar playlist',
    name: p.name,
    description: decodeHtml(p.description),
    askPublic: false,
  });
  if (!data) return;
  await api.updatePlaylist(p.id, data);
  p.name = data.name;
  p.description = data.description;
  renderPlaylistHeader();
  renderPlaylists();
  showNotice('Playlist atualizada.', 'success');
}

async function deletePlaylist() {
  const p = openPlaylist;
  const message = isOwner(p)
    ? `Excluir "${p.name}"? No Spotify isso é "deixar de seguir": ela some da sua biblioteca, ` +
      'mas quem segue continua com ela. Dá pra recuperar em spotify.com/account/recover-playlists.'
    : `Deixar de seguir "${p.name}"? Ela sai da sua biblioteca.`;
  if (!(await confirmDialog(message, isOwner(p) ? 'Excluir' : 'Deixar de seguir'))) return;

  await api.removeFromLibrary([p.uri]);
  playlists = playlists.filter((x) => x.id !== p.id);
  playlistsTotal--;
  closePlaylistView();
  renderPlaylists();
  showNotice(`"${p.name}" saiu da sua biblioteca.`, 'success');
}

// ---------- Reordenar arrastando ----------

function dragHandle() {
  const handle = el('span', 'drag-handle', '::');
  handle.title = 'Arraste pra mudar a ordem';
  handle.setAttribute('aria-hidden', 'true');
  return handle;
}

let dragFrom = null;

function clearDropMarks() {
  document
    .querySelectorAll('.drop-before, .drop-after, .dragging')
    .forEach((n) => n.classList.remove('drop-before', 'drop-after', 'dragging'));
}

// A linha fica marcada em cima ou embaixo, conforme a metade onde o mouse está.
function dropSide(li, event) {
  const box = li.getBoundingClientRect();
  return event.clientY < box.top + box.height / 2 ? 'before' : 'after';
}

function setupDragAndDrop() {
  const list = $('#playlist-items');

  list.addEventListener('dragstart', (e) => {
    const li = e.target.closest?.('li[data-position]');
    if (!li) return;
    dragFrom = Number(li.dataset.position);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', ''); // o Firefox exige isto pra arrastar
    li.classList.add('dragging');
  });

  list.addEventListener('dragover', (e) => {
    const li = e.target.closest('li[data-position]');
    if (!li || dragFrom == null) return;
    e.preventDefault(); // permite soltar aqui
    list.querySelectorAll('.drop-before, .drop-after').forEach((n) =>
      n.classList.remove('drop-before', 'drop-after'),
    );
    li.classList.add(`drop-${dropSide(li, e)}`);
  });

  list.addEventListener('drop', (e) => {
    const li = e.target.closest('li[data-position]');
    if (!li || dragFrom == null) return;
    e.preventDefault();
    const target = Number(li.dataset.position);
    const insertBefore = dropSide(li, e) === 'before' ? target : target + 1;
    const from = dragFrom;
    clearDropMarks();
    dragFrom = null;
    // Soltar no mesmo lugar não muda nada.
    if (insertBefore === from || insertBefore === from + 1) return;
    safely(async () => {
      await api.reorderPlaylist(openPlaylist.id, from, insertBefore);
      await reloadPlaylistItems();
    });
  });

  list.addEventListener('dragend', () => {
    clearDropMarks();
    dragFrom = null;
  });
}

// ---------- Destaque da música tocando ----------

function highlightPlaying(...uris) {
  playingUris = uris.filter(Boolean);
  for (const btn of document.querySelectorAll('.item[data-uri]')) {
    btn.classList.toggle('playing', playingUris.includes(btn.dataset.uri));
  }
}

// ---------- Abas (celular) ----------

// "config" também vale no computador: o painel [config] aparece no lugar da lista.
function showTab(name) {
  const view = $('#library-view');
  if (view.dataset.tab === 'config' && name !== 'config') closeConfig();
  view.dataset.tab = name;
  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  }
  setDevicesShown(name === 'devices'); // só consulta dispositivos com o painel aberto
  if (name === 'queue') safely(refreshQueue);
  saveUiSoon();
}

// ---------- Fila ----------

let queueTrackUri = null; // música tocando quando a fila foi lida

async function refreshQueue() {
  $('#queue-status').textContent = '> lendo a fila…';
  const data = await api.getQueue();
  const current = data?.currently_playing;
  const items = (data?.queue ?? []).filter(Boolean);
  queueTrackUri = current?.uri ?? null;
  $('#queue-status').textContent = current
    ? `> tocando: ${current.name} · ${items.length} na fila`
    : '> nada tocando. a fila aparece quando algo estiver tocando.';
  $('#queue-list').replaceChildren(
    ...items.map((track, i) =>
      trackRow(track, i + 1, () =>
        showNotice('a fila é só pra consulta: o spotify não deixa pular direto pra um item. use :next.'),
      ),
    ),
  );
  checkLiked(items).catch((err) => console.error(err));
}

// Música mudou com a fila aberta: lê de novo (só quando muda, não a cada atualização).
function onTrackChange(...uris) {
  highlightPlaying(...uris);
  const now = uris[1] ?? uris[0] ?? null;
  if ($('#library-view').dataset.tab === 'queue' && now && now !== queueTrackUri) {
    queueTrackUri = now;
    safely(refreshQueue);
  }
}

// ---------- Telas ----------

function showLogin(message) {
  $('#login-view').hidden = false;
  $('#library-view').hidden = true;
  if (!message && new URLSearchParams(location.search).has('expirou')) {
    message = 'Sua sessão expirou. Entre de novo.';
  }
  if (message) {
    $('#login-msg').textContent = message;
    $('#login-msg').hidden = false;
  }
}

async function showLibrary() {
  $('#login-view').hidden = true;
  $('#library-view').hidden = false;

  initPlayer({
    onError: (msg) => showNotice(msg),
    onAuthError: sessionExpired,
    onTrackChange,
    onNoDevice: () => showTab('devices'), // sem dispositivo ativo: mostra a lista
  });
  initDevices(safely);

  initConfig(safely);
  initCmdline({
    filter: setFilter,
    clearFilter,
    focusList,
    search: async (query) => {
      try {
        return { ok: true, message: await runSearch(query) };
      } catch (err) {
        console.error(err);
        if (err.status === 401) sessionExpired();
        return { ok: false, message: err.message };
      }
    },
  });
  registerApp({
    loadMore,
    showPanel: showTab,
    showAlbums: () => safely(showSavedAlbums),
    playlistNames: () => playlists.filter(canEditItems).map((p) => p.name),
    addToPlaylist: async (name) => {
      const target = findPlaylistByName(name);
      const track = selectedTrack ?? currentTrack();
      if (!track) throw new Error('nenhuma música selecionada ou tocando.');
      if (isLocal(track)) throw new Error('arquivos locais não podem ser adicionados.');
      await addTrackTo(target, track);
      return `"${track.name}" adicionada a "${target.name}".`;
    },
    createPlaylist: async (name) => {
      const created = await api.createPlaylist({ name, isPublic: false });
      addCreatedPlaylist(created);
      return `playlist "${created.name}" criada (privada).`;
    },
  });
  setSyncStatus('> carregando temas da sua conta…');

  // Primeiro a cópia guardada neste aparelho: o app aparece pronto na hora, mesmo sem
  // internet, e volta na aba e na playlist de quando você fechou.
  const fromCache = applyLibrarySnapshot((await loadCache(CACHE_LIBRARY))?.data);
  if (fromCache) await restoreUi((await loadCache(CACHE_UI))?.data);

  // Depois pergunta ao Spotify o que mudou e substitui as listas.
  const meRequest = api.getMe();
  const libraryRequest = Promise.all([
    meRequest,
    api.getSavedTracks(),
    api.getPlaylists(),
  ]).then(([user, tracks, lists]) => {
    me = user;
    $('#user-name').textContent = me.display_name ?? me.id;
    resetLibraryState();
    addLikedPage(tracks);
    addPlaylistsPage(lists);
  });
  // Temas: as playlists "⚙ tema:" podem estar em qualquer página, então carrega todas.
  const themesRequest = libraryRequest
    .then(loadAllPlaylists)
    // As fixadas vêm da playlist escondida "⚙ fixadas" (valem em todos os aparelhos).
    .then(() => pins.sync(pinsPlaylist).then((changed) => changed && renderPlaylists()))
    .then(() => syncFromPlaylists(themePlaylists));

  // Com cache não há tela de boot nem espera: a atualização acontece por baixo.
  if (fromCache) {
    safely(() => libraryRequest).then(() => {
      // As listas foram refeitas: aponta pra nova cópia da playlist aberta.
      if (openPlaylist) openPlaylist = playlists.find((p) => p.id === openPlaylist.id) ?? openPlaylist;
      renderPlaylists();
    });
    syncThemes(themesRequest);
    return;
  }

  const boot = startBoot();
  boot.line('connecting to spotify', meRequest);
  boot.line('loading library', libraryRequest);
  boot.line('loading themes', themesRequest);

  await safely(() => libraryRequest);
  await syncThemes(themesRequest);
}

// Mostra se os temas vieram do Spotify ou só da cópia local (sem quebrar nada).
async function syncThemes(request) {
  try {
    const { failed } = await request;
    setSyncStatus(
      failed
        ? `! ${failed} tema(s) ainda só neste aparelho (o spotify recusou salvar)`
        : '> temas sincronizados com o spotify',
    );
  } catch (err) {
    console.error(err);
    if (err.status === 401) return sessionExpired();
    setSyncStatus('! spotify não respondeu: usando os temas salvos neste aparelho');
    showNotice('não deu pra carregar os temas da sua conta; usando a cópia deste aparelho.');
  }
}

// ---------- Botões ----------

$('#login-btn').addEventListener('click', () => safely(login));
$('#logout-btn').addEventListener('click', async () => {
  await forgetEverything();
  location.replace(APP_ROOT);
});
$('#notice-close').addEventListener('click', hideNotice);
$('#tracks-more').addEventListener('click', () => safely(loadMore));
$('#playlists-more').addEventListener('click', () =>
  safely(async () => addPlaylistsPage(await api.getPlaylists(nextPage.playlists))),
);
$('#playlist-create').addEventListener('click', () => safely(createPlaylist));
$('#search-more').addEventListener('click', () => safely(loadMore));
$('#liked-entry').addEventListener('click', () => {
  closePlaylistView();
  showTab('list');
});
$('#albums-entry').addEventListener('click', () => safely(showSavedAlbums));
$('#albums-more').addEventListener('click', () => safely(loadMore));
$('#album-play').addEventListener('click', () => safely(() => playInAlbum(null)));
$('#album-save').addEventListener('click', () => safely(() => toggleAlbumSaved(openAlbum)));
$('#album-add').addEventListener('click', () => safely(addAlbumToPlaylist));
$('#config-open').addEventListener('click', () => showTab('config'));
$('#queue-open').addEventListener('click', () => showTab('queue'));
$('#devices-open').addEventListener('click', () => showTab('devices'));
$('#queue-refresh').addEventListener('click', () => safely(refreshQueue));
for (const btn of document.querySelectorAll('.panel-close')) {
  btn.addEventListener('click', () => showTab('list'));
}
// Comandos rápidos (tela de toque): preenchem a linha de comando ou abrem um painel.
for (const btn of document.querySelectorAll('.quick')) {
  btn.addEventListener('click', () =>
    btn.dataset.tab ? showTab(btn.dataset.tab) : prefill(btn.dataset.insert),
  );
}
$('#config-close').addEventListener('click', () => showTab('list'));
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => showTab(tab.dataset.tab));
}
$('#playlist-play').addEventListener('click', () => safely(() => playInPlaylist(null)));
$('#playlist-pin').addEventListener('click', () => safely(() => togglePinned(openPlaylist)));
$('#playlist-edit').addEventListener('click', () => safely(editPlaylist));
$('#playlist-delete').addEventListener('click', () => safely(deletePlaylist));
$('#playlist-more').addEventListener('click', () => safely(loadMore));
setupDragAndDrop();

// ---------- Começo ----------

// PWA: o service worker só roda no site publicado. No 127.0.0.1 (desenvolvimento) ele
// atrapalharia ver as mudanças na hora, então é desligado se estiver registrado.
if ('serviceWorker' in navigator) {
  if (location.hostname === '127.0.0.1') {
    navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister()));
  } else {
    navigator.serviceWorker.register(new URL('sw.js', APP_ROOT)).catch((err) => console.error(err));
  }
}

decorateBoxes(); // desenha as bordas ┌─┐ em todos os painéis
initRoll(); // títulos compridos andam de lado pra dar pra ler
showTab('list');

if (!isLoggedIn()) {
  showLogin();
} else if (!hasAllScopes()) {
  // O app passou a pedir permissões novas: precisa entrar de novo.
  logout();
  showLogin('O app ganhou funções novas e precisa de mais permissões. Entre de novo.');
} else {
  showLibrary();
}
