// Índice da biblioteca: uma cópia enxuta (id, nome, artistas) de todas as músicas das
// suas playlists, guardada neste aparelho. Serve pra responder na hora "essa música está
// em alguma playlist minha?" sem perguntar nada ao Spotify.
//
// Montar o índice custa uma requisição por playlist, então é feito devagar e só quando
// você pede. Depois disso é barato: o Spotify dá um "snapshot_id" que muda a cada
// alteração, então as próximas atualizações leem só as playlists que mudaram.
import * as api from './api.js';
import { loadCache, saveCache } from './cache.js';
import { fold } from './commands.js';

const KEY = 'index';
const PAUSE_MS = 700; // espaço entre playlists (o Spotify bloqueia quem pergunta demais)
const SAVE_EVERY = 10; // salva o progresso a cada N playlists (dá pra parar e continuar)

// { at: quando terminou, lists: { id: { name, snapshot, tracks: [{ uri, name, artists }] } } }
let index = null;
let stopping = false;
let building = false;

export async function loadIndex() {
  index = (await loadCache(KEY))?.data ?? null;
  return info();
}

// Resumo pra mostrar na tela (null = ainda não existe índice).
export function info() {
  if (!index) return null;
  const lists = Object.values(index.lists);
  return {
    at: index.at,
    playlists: lists.length,
    tracks: lists.reduce((total, list) => total + list.tracks.length, 0),
    building,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const slim = (track) => ({
  uri: track.uri,
  name: track.name,
  artists: (track.artists ?? []).map((a) => a.name).join(', '),
});

export const stopBuilding = () => (stopping = true);

// Monta (ou atualiza) o índice. `onProgress` recebe { done, total, name, lidas, puladas }.
// Playlists sem mudança desde a última vez são puladas sem gastar requisição.
export async function buildIndex(playlists, onProgress) {
  if (building) throw new Error('o índice já está sendo montado.');
  building = true;
  stopping = false;
  index = index ?? { at: 0, lists: {} };
  const alive = new Set(playlists.map((p) => p.id));
  // Playlists que saíram da conta somem do índice.
  for (const id of Object.keys(index.lists)) if (!alive.has(id)) delete index.lists[id];

  let read = 0;
  let skipped = 0;
  try {
    for (const [i, playlist] of playlists.entries()) {
      if (stopping) break;
      onProgress?.({ done: i, total: playlists.length, name: playlist.name, read, skipped });

      const known = index.lists[playlist.id];
      if (known && known.snapshot === playlist.snapshot_id) {
        skipped++;
        continue;
      }

      const tracks = [];
      let page = await api.getPlaylistItems(playlist.id);
      for (;;) {
        for (const entry of page.items ?? []) {
          const track = entry?.item ?? entry?.track;
          if (track?.uri) tracks.push(slim(track));
        }
        if (!page.next || stopping) break;
        await sleep(PAUSE_MS);
        page = await api.getPlaylistItems(playlist.id, page.next);
      }
      index.lists[playlist.id] = { name: playlist.name, snapshot: playlist.snapshot_id, tracks };
      read++;
      if (read % SAVE_EVERY === 0) await saveCache(KEY, index);
      await sleep(PAUSE_MS);
    }
    index.at = Date.now();
    await saveCache(KEY, index);
    return { read, skipped, stopped: stopping };
  } catch (err) {
    // 403 (playlist de outra pessoa) não deveria chegar aqui; qualquer outro erro sobe,
    // mas o que já foi lido fica guardado.
    await saveCache(KEY, index);
    throw err;
  } finally {
    building = false;
    stopping = false;
  }
}

// Procura no índice. Devolve [{ track, lists: [nomes das playlists] }], sem repetir música.
export function searchIndex(text) {
  if (!index) return null;
  const typed = fold(text.trim());
  if (!typed) return [];
  const found = new Map(); // uri → { track, lists }
  for (const list of Object.values(index.lists)) {
    for (const track of list.tracks) {
      if (!fold(`${track.name} ${track.artists}`).includes(typed)) continue;
      const entry = found.get(track.uri) ?? { track, lists: [] };
      if (!entry.lists.includes(list.name)) entry.lists.push(list.name);
      found.set(track.uri, entry);
    }
  }
  // Quem está em mais playlists aparece primeiro.
  return [...found.values()].sort((a, b) => b.lists.length - a.lists.length);
}
