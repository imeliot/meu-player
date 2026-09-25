// Playlists fixadas no topo da lista.
//
// O app do Spotify tem "fixar" (até 5), mas a Web API não mostra nem deixa mexer nesses
// fixados. Então isto aqui é nosso: a lista de ids fica na descrição de uma playlist
// privada chamada "⚙ fixadas", do mesmo jeito que os temas. Assim o que você fixa no PC
// aparece fixado no celular. Não tem relação com o fixar do app oficial.
import * as api from './api.js';
import { decodeHtml } from './ui.js';

export const PINS_NAME = '⚙ fixadas';
export const isPinsPlaylist = (p) => p?.name === PINS_NAME;

const KEY = 'pinned_playlists';
// A descrição do Spotify aceita ~300 caracteres e cada id tem 22.
const LIMIT = 12;

let ids = load();
let remoteId = null; // id da playlist "⚙ fixadas", quando ela já existe

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(saved) ? saved.slice(0, LIMIT) : [];
  } catch {
    return [];
  }
}

function saveLocal() {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    // sem problema: só não lembra depois de fechar
  }
}

// "v1|id,id,id" — o mesmo estilo dos temas.
const encode = (list) => `v1|${list.join(',')}`;

function decode(text) {
  const [version, list] = String(text).split('|');
  if (version !== 'v1' || !list) return null;
  return list
    .split(',')
    .map((id) => id.trim())
    .filter((id) => /^[A-Za-z0-9]+$/.test(id))
    .slice(0, LIMIT);
}

export const pinnedIds = () => [...ids];
export const isPinned = (id) => ids.includes(id);
export const pinLimit = () => LIMIT;

// Fixa ou desafixa. Devolve como ficou: { pinned, full }.
export function toggle(id) {
  if (isPinned(id)) {
    ids = ids.filter((pinned) => pinned !== id);
  } else {
    if (ids.length >= LIMIT) return { pinned: false, full: true };
    ids.push(id);
  }
  saveLocal();
  return { pinned: isPinned(id), full: false };
}

// Manda a lista pro Spotify (cria a playlist escondida na primeira vez).
export async function push() {
  if (remoteId) {
    await api.updatePlaylist(remoteId, { description: encode(ids) });
    return;
  }
  if (!ids.length) return; // nada fixado ainda: não cria playlist à toa
  const created = await api.createPlaylist({
    name: PINS_NAME,
    description: encode(ids),
    isPublic: false,
  });
  remoteId = created.id;
}

// Lê as fixadas da conta. O Spotify manda; se lá não tiver nada e aqui tiver, sobe.
// Devolve true se a lista mudou (pra redesenhar a tela).
export async function sync(playlist) {
  remoteId = playlist?.id ?? null;
  const remote = playlist ? decode(decodeHtml(playlist.description ?? '')) : null;
  if (!remote) {
    if (ids.length) await push(); // ainda não existe na conta (ou descrição inválida)
    return false;
  }
  const changed = remote.join(',') !== ids.join(',');
  ids = remote;
  saveLocal();
  return changed;
}
