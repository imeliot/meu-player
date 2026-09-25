// Cache local: guarda a biblioteca (curtidas e playlists) e a última tela dentro do
// próprio navegador, num banco chamado IndexedDB. Serve pra:
//  • o app abrir na hora, já com as listas, em vez de esperar o Spotify;
//  • voltar na mesma aba e na mesma playlist de quando você fechou;
//  • gastar menos requisições (o Spotify bloqueia quem pergunta demais).
//
// Nada disso é segredo: são nomes de música e de playlist. Tokens continuam fora daqui.
// Se o navegador não deixar usar o banco (aba anônima, espaço cheio), tudo continua
// funcionando: as funções devolvem null e o app busca no Spotify como antes.

const DB_NAME = 'meu-player';
const STORE = 'cache';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((err) => {
    console.error(err);
    dbPromise = null; // deixa tentar de novo depois
    return null;
  });
  return dbPromise;
}

// Executa uma operação no banco e devolve o resultado (ou null se algo falhar).
async function run(mode, action) {
  try {
    const db = await openDb();
    if (!db) return null;
    return await new Promise((resolve, reject) => {
      const req = action(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.error(err);
    return null;
  }
}

// Lê uma chave. Devolve { data, at } (at = quando foi salvo) ou null.
export const loadCache = (key) => run('readonly', (store) => store.get(key));

// Salva uma chave. structuredClone garante que só vão dados simples (nada de elementos
// da tela nem funções, que o banco recusaria).
export const saveCache = (key, data) =>
  run('readwrite', (store) => store.put({ data: structuredClone(data), at: Date.now() }, key));

export const dropCache = (key) => run('readwrite', (store) => store.delete(key));

// Chama a função no máximo uma vez a cada `ms` (evita salvar a cada tecla).
export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
