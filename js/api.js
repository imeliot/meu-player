// Funções que conversam com a Web API do Spotify.
// Endpoints conferidos na doc atual (pós-mudanças de fev/2026).
import { getAccessToken } from './auth.js';

const API = 'https://api.spotify.com/v1';

// Traduz os erros mais comuns da API pra mensagens claras.
function friendlyMessage(status, apiMessage) {
  if (status === 401) return 'Sua sessão expirou. Entre de novo.';
  if (status === 403 && /premium/i.test(apiMessage)) return 'Essa ação exige Spotify Premium.';
  if (status === 403 && /scope/i.test(apiMessage))
    return 'O login atual não tem permissão pra isso. Clique em "Sair" e entre de novo.';
  if (status === 403) return `O Spotify não permitiu essa ação. (${apiMessage})`;
  if (status === 404) return `Não encontrado. (${apiMessage})`;
  if (status === 429) return 'Muitas requisições seguidas. Espere alguns segundos e tente de novo.';
  return `Erro na API do Spotify (${status}). ${apiMessage}`;
}

// Requisição genérica com o token no cabeçalho. Aceita caminho ("/me") ou URL completa
// (a API devolve URLs prontas no campo "next" pra buscar a próxima página).
async function request(method, pathOrUrl, body) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : API + pathOrUrl;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${await getAccessToken()}`,
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) {
    // O Spotify costuma mandar { error: { status, message } } no corpo.
    const data = await res.json().catch(() => null);
    const err = new Error(friendlyMessage(res.status, data?.error?.message ?? ''));
    err.status = res.status;
    throw err;
  }
  // 204 = deu certo, mas sem conteúdo (comum nos comandos de playback).
  return res.status === 204 ? null : res.json().catch(() => null);
}

const get = (pathOrUrl) => request('GET', pathOrUrl);

// Perfil do usuário logado.
export const getMe = () => get('/me');

// Músicas curtidas — GET /me/tracks (máx. 50 por página).
export const getSavedTracks = (next) => get(next ?? '/me/tracks?limit=50');

// Playlists do usuário — GET /me/playlists (máx. 50 por página).
export const getPlaylists = (next) => get(next ?? '/me/playlists?limit=50');

// Músicas de uma playlist — GET /playlists/{id}/items (máx. 50 por página).
// Só funciona em playlists suas ou colaborativas (as outras dão 403).
export const getPlaylistItems = (id, next) => get(next ?? `/playlists/${id}/items?limit=50`);

// ---------- Gerenciar playlists ----------

// Cria playlist — POST /me/playlists (o antigo /users/{id}/playlists foi removido).
export const createPlaylist = ({ name, description, isPublic }) =>
  request('POST', '/me/playlists', { name, description, public: isPublic });

// Renomeia / muda descrição — PUT /playlists/{id}.
export const updatePlaylist = (id, { name, description }) =>
  request('PUT', `/playlists/${id}`, { name, description });

// Adiciona músicas no fim — POST /playlists/{id}/items (máx. 100 por vez).
export const addToPlaylist = (id, uris) => request('POST', `/playlists/${id}/items`, { uris });

// Remove uma música — DELETE /playlists/{id}/items (o corpo agora usa "items").
export const removeFromPlaylist = (id, uri) =>
  request('DELETE', `/playlists/${id}/items`, { items: [{ uri }] });

// Move uma música — PUT /playlists/{id}/items.
// insertBefore = posição antes da qual ela vai ficar (use o tamanho da lista pra mandar pro fim).
export const reorderPlaylist = (id, from, insertBefore) =>
  request('PUT', `/playlists/${id}/items`, { range_start: from, insert_before: insertBefore });

// ---------- Biblioteca (endpoints genéricos de 2026, máx. 40 URIs por vez) ----------

const urisParam = (uris) => `uris=${encodeURIComponent(uris.join(','))}`;

// Curtir música / seguir playlist — PUT /me/library.
export const saveToLibrary = (uris) => request('PUT', `/me/library?${urisParam(uris)}`);

// Descurtir música / deixar de seguir ("excluir") playlist — DELETE /me/library.
export const removeFromLibrary = (uris) => request('DELETE', `/me/library?${urisParam(uris)}`);

// Quais destes itens estão salvos? Devolve [true, false, ...] — GET /me/library/contains.
export const libraryContains = (uris) => get(`/me/library/contains?${urisParam(uris)}`);

// ---------- Busca ----------

// Busca músicas no catálogo — GET /search (desde fev/2026: máx. 10 por página; offset até 1000).
export const SEARCH_PAGE = 10;
export const SEARCH_MAX_OFFSET = 1000;
export const searchTracks = (query, next) =>
  get(next ?? `/search?type=track&limit=${SEARCH_PAGE}&q=${encodeURIComponent(query)}`);

// ---------- Player ----------

// Aleatório ligado/desligado — PUT /me/player/shuffle.
export const setShuffle = (deviceId, on) =>
  request('PUT', `/me/player/shuffle?state=${on}&device_id=${encodeURIComponent(deviceId)}`);

// Repetir — PUT /me/player/repeat. mode: 'off' | 'context' (lista) | 'track' (música).
export const setRepeat = (deviceId, mode) =>
  request('PUT', `/me/player/repeat?state=${mode}&device_id=${encodeURIComponent(deviceId)}`);

// Começa a tocar num dispositivo — PUT /me/player/play.
// Use contextUri (ex: playlist) OU uris (lista de músicas), e offset pra escolher a primeira.
export function play({ deviceId, contextUri, uris, offset }) {
  return request('PUT', `/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
    ...(contextUri && { context_uri: contextUri }),
    ...(uris && { uris }),
    ...(offset && { offset }),
  });
}
