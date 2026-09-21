// Lógica da página principal: login, biblioteca, tocar e gerenciar playlists.
//
// Ideia geral: as listas ficam guardadas em variáveis (o "estado"). Depois de
// qualquer alteração, mudamos o estado e redesenhamos a lista na tela.
import { login, logout, isLoggedIn, hasAllScopes } from './auth.js';
import { APP_ROOT } from './config.js';
import * as api from './api.js';
import { initPlayer, playHere, currentTrack } from './player.js';
import { initCmdline, hint } from './cmdline.js';
import { registerApp, fold } from './commands.js';
import { startBoot } from './boot.js';
import { isThemePlaylist, syncFromPlaylists } from './themes.js';
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
const nextPage = { tracks: null, playlists: null, playlistItems: null, search: null };

let likedTracks = []; // músicas curtidas carregadas (mais recente primeiro)
let likedTotal = 0;

// Quais músicas estão curtidas: uri → true/false (usado pelos corações).
const likedStatus = new Map();

let playlists = []; // playlists carregadas (sem as de tema)
let playlistsTotal = 0;
const themePlaylists = []; // playlists "⚙ tema: …" (escondidas; viram temas no [config])

let openPlaylist = null; // playlist aberta no momento
let playlistEntries = []; // músicas dela: { track, position }

let playingUris = []; // música tocando agora (pra destacar)

// O que o painel da direita mostra: 'liked' (curtidas), 'playlist' ou 'search' (busca).
let currentView = 'liked';

let searchResults = []; // resultados da busca "?texto"
let searchTotal = 0;

let filterText = ''; // filtro "/texto" da lista aberta
let selectedTrack = null; // música escolhida pelo teclado (usada por :add)
const trackOfRow = new WeakMap(); // linha <li> → música

// A última interação foi pelo teclado? (tecla = sim; clique/toque = não)
let usingKeyboard = false;
document.addEventListener('keydown', () => (usingKeyboard = true), true);
document.addEventListener('pointerdown', () => (usingKeyboard = false), true);

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

function sessionExpired() {
  logout();
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
  if (playingUris.includes(track.uri)) btn.classList.add('playing');
  btn.addEventListener('click', () => {
    selectTrack(null); // clicou = tocou; a "selecionada" passa a ser a que toca
    onPlay();
  });
  // Chegou pelo teclado (Tab/setas): vira a música selecionada (pro :add).
  btn.addEventListener('focus', () => {
    if (usingKeyboard) selectTrack(li, track);
  });
  btn.addEventListener('keydown', (e) => moveWithArrows(e, li));
  btn.append(
    el('span', 'col-num', String(number)),
    el('span', 'col-title', track.name),
    el('span', 'col-artist', track.artists?.map((a) => a.name).join(', ') ?? ''),
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
    ...playlists.map((p) => {
      const li = el('li');
      const btn = el('button', 'lib-item');
      btn.type = 'button';
      btn.classList.toggle('selected', openPlaylist?.id === p.id);
      btn.title = `de ${p.owner?.display_name ?? 'desconhecido'}`;
      btn.append(el('span', 'lib-name', p.name), el('span', 'dim', String(trackCount(p))));
      btn.addEventListener('click', () => safely(() => openPlaylistView(p)));
      li.append(btn);
      return li;
    }),
  );
  $('#playlists-count').textContent = playlistsTotal;
  $('#playlists-more').hidden = !nextPage.playlists;
}

function addPlaylistsPage(page) {
  // As playlists que guardam temas nunca aparecem nas listas do app.
  const items = page.items.filter(Boolean);
  themePlaylists.push(...items.filter(isThemePlaylist));
  playlists.push(...items.filter((p) => !isThemePlaylist(p)));
  playlistsTotal = page.total - themePlaylists.length;
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

// ---------- Painel da direita: curtidas, playlist ou busca ----------

function showView(view) {
  currentView = view;
  if (view !== 'playlist') openPlaylist = null;
  $('#liked-view').hidden = view !== 'liked';
  $('#playlist-view').hidden = view !== 'playlist';
  $('#playlist-detail').hidden = view !== 'playlist';
  $('#search-view').hidden = view !== 'search';
  $('#liked-entry').classList.toggle('selected', view === 'liked');
  applyFilter();
}

const LIST_OF_VIEW = { liked: '#tracks-list', playlist: '#playlist-items', search: '#search-list' };

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
  const page = await api.searchTracks(query);
  searchResults = [];
  filterText = '';
  showView('search');
  renderPlaylists(); // tira o ">" da playlist que estava aberta
  setBoxTitle($('#panel-list'), `busca: ${query}`);
  showTab('list'); // no celular, pula pra aba da lista
  addSearchPage(page);
  const total = page.tracks?.total ?? 0;
  return total
    ? `${total} resultado(s). mostrando ${searchResults.length}; ↑↓ escolhe, enter toca.`
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
  $('#search-empty').hidden = searchResults.length > 0;
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

  let page;
  try {
    page = await api.getPlaylistItems(playlist.id);
  } catch (err) {
    // 403: o Spotify só mostra as músicas de playlists suas ou colaborativas.
    if (err.status !== 403) throw err;
    $('#playlist-note').textContent =
      'O Spotify só mostra as músicas de playlists suas ou colaborativas. ' +
      'Mas dá pra tocar esta playlist inteira no botão acima.';
    $('#playlist-note').hidden = false;
    return;
  }
  // Só mostra se o usuário ainda está nesta playlist (pode ter voltado ou aberto outra).
  if (openPlaylist === playlist) await addPlaylistItemsPage(page);
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
    onTrackChange: highlightPlaying,
  });

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

  const meRequest = api.getMe();
  const libraryRequest = Promise.all([
    meRequest,
    api.getSavedTracks(),
    api.getPlaylists(),
  ]).then(([user, tracks, lists]) => {
    me = user;
    $('#user-name').textContent = me.display_name ?? me.id;
    addLikedPage(tracks);
    addPlaylistsPage(lists);
  });
  // Temas: as playlists "⚙ tema:" podem estar em qualquer página, então carrega todas.
  const themesRequest = libraryRequest
    .then(loadAllPlaylists)
    .then(() => syncFromPlaylists(themePlaylists));

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
$('#logout-btn').addEventListener('click', () => {
  logout();
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
$('#config-open').addEventListener('click', () => showTab('config'));
$('#config-close').addEventListener('click', () => showTab('list'));
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => showTab(tab.dataset.tab));
}
$('#playlist-play').addEventListener('click', () => safely(() => playInPlaylist(null)));
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
