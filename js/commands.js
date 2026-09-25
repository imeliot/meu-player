// Comandos da linha de comando (":play", ":theme amber"...), ajuda e autocompletar.
// Uso: await runCommand(':theme umbreon') → { ok: true, message: 'tema: umbreon' }
import { setTheme, setFont, allThemes, FONTS } from './themes.js';
import * as player from './player.js';

// Funções que dependem da tela (playlists, música selecionada). O app registra na abertura.
const app = {
  playlistNames: () => [], // nomes das playlists onde dá pra adicionar
  addToPlaylist: async () => {}, // (nomeDaPlaylist) → mensagem
  createPlaylist: async () => {}, // (nome) → mensagem
  loadMore: async () => '', // carrega a próxima página da lista aberta → mensagem
  showPanel: () => {}, // abre um painel/aba: 'devices', 'queue'…
  showAlbums: async () => {}, // abre a lista de álbuns salvos
  searchLibrary: () => '', // procura no índice das suas playlists → mensagem
};
export function registerApp(functions) {
  Object.assign(app, functions);
}

// Tira acentos e deixa minúsculo (pra comparar "musica" com "Música").
export const fold = (text) =>
  String(text).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

const ok = (message) => ({ ok: true, message });
const fail = (message) => ({ ok: false, message });

// Cada comando: args (texto da ajuda), help, run(arg) e, opcional, options() pro Tab.
const COMMANDS = {
  play: { help: 'tocar', run: async () => (await player.resume(), ok('tocando')) },
  pause: { help: 'pausar', run: async () => (await player.pause(), ok('pausado')) },
  next: { help: 'próxima música', run: async () => (await player.nextTrack(), ok('próxima')) },
  prev: { help: 'música anterior (ou volta ao começo)', run: async () => (await player.previousTrack(), ok('anterior')) },
  shuffle: {
    help: 'liga/desliga aleatório',
    run: async () => ok(`shuffle:${(await player.toggleShuffle()) ? 'ON' : 'OFF'}`),
  },
  repeat: {
    help: 'alterna repetir (OFF → LIST → TRACK)',
    run: async () => ok(`repeat:${await player.cycleRepeat()}`),
  },
  more: { help: 'carrega mais músicas na lista aberta', run: async () => ok(await app.loadMore()) },
  add: {
    args: '<playlist>',
    help: 'adiciona a música selecionada (ou tocando) à playlist',
    options: () => app.playlistNames(),
    run: async (arg) => (arg ? ok(await app.addToPlaylist(arg)) : fail('uso: :add <playlist> (tab completa o nome)')),
  },
  new: {
    args: '<nome>',
    help: 'cria uma playlist',
    run: async (arg) => (arg ? ok(await app.createPlaylist(arg)) : fail('uso: :new <nome>')),
  },
  theme: {
    args: '<nome>',
    help: 'troca o tema',
    options: () => allThemes().map((t) => t.name),
    run: async (arg) => {
      if (!arg) return fail(`temas: ${allThemes().map((t) => t.name).join(', ')}`);
      return setTheme(arg) ? ok(`tema: ${arg}`) : fail(`tema não encontrado: ${arg}`);
    },
  },
  font: {
    args: '<nome>',
    help: 'troca a fonte',
    options: () => FONTS.map((f) => f.id),
    run: async (arg) => {
      if (!arg) return fail(`fontes: ${FONTS.map((f) => f.id).join(', ')}`);
      return setFont(arg) ? ok(`fonte: ${arg}`) : fail(`fonte não encontrada: ${arg}`);
    },
  },
  disp: {
    help: 'dispositivos: mandar a música pra outro aparelho',
    run: async () => (app.showPanel('devices'), ok('dispositivos')),
  },
  fila: { help: 'mostra a fila', run: async () => (app.showPanel('queue'), ok('fila')) },
  tudo: {
    args: '<texto>',
    help: 'procura em todas as suas playlists (o mesmo que "?texto tudo")',
    run: async (arg) => (arg ? ok(app.searchLibrary(arg)) : fail('uso: :tudo <texto>')),
  },
  alb: {
    help: 'álbuns salvos na sua conta (a busca "?texto" também mostra álbuns)',
    run: async () => (await app.showAlbums(), ok('álbuns salvos')),
  },
  mode: {
    args: '<remoto|navegador>',
    help: 'tocar neste navegador ou só controlar outro aparelho',
    options: () => ['remoto', 'navegador'],
    run: async (arg) => {
      const current = player.playerMode() === 'remote' ? 'remoto' : 'navegador';
      const wanted = fold(arg);
      if (!wanted) return ok(`modo atual: ${current}. use :mode remoto ou :mode navegador`);
      if ('remoto'.startsWith(wanted)) player.setPlayerMode('remote'); // recarrega a página
      else if ('navegador'.startsWith(wanted)) player.setPlayerMode('sdk');
      else return fail('modos: remoto, navegador');
      return ok('trocando de modo…');
    },
  },
  help: { help: 'esta ajuda', run: async () => ok(helpText()) },
};

export function helpText() {
  const rows = [
    ['/texto', 'filtra a lista aberta (esc limpa)'],
    ['?texto', 'busca músicas no spotify (enter)'],
    ...Object.entries(COMMANDS).map(([name, c]) => [`:${name}${c.args ? ` ${c.args}` : ''}`, c.help]),
  ];
  const width = Math.max(...rows.map(([cmd]) => cmd.length)) + 2;
  return [
    'comandos:',
    ...rows.map(([cmd, text]) => `  ${cmd.padEnd(width)}${text}`),
    'tab completa · ↑↓ histórico · esc sai',
    'nas listas: ↑↓ andam · enter toca · ↓ na última carrega mais',
  ].join('\n');
}

// Roda uma linha. Nunca lança erro: devolve { ok, message }.
export async function runCommand(line) {
  const match = String(line).trim().match(/^:(\S*)\s*(.*)$/);
  if (!match) return fail(`comando não encontrado: ${String(line).trim()}`);
  const [, name, arg] = match;
  const command = COMMANDS[name.toLowerCase()];
  if (!command) return fail(`comando não encontrado: ${name}`);
  try {
    return await command.run(arg.trim());
  } catch (err) {
    console.error(err);
    return fail(err.message ?? String(err));
  }
}

// Autocompletar: devolve as linhas completas possíveis pra o que já foi digitado.
export function completions(line) {
  // Só o nome do comando: ":pl" → ":play"
  const onlyName = line.match(/^:(\S*)$/);
  if (onlyName) {
    return Object.entries(COMMANDS)
      .filter(([name]) => name.startsWith(onlyName[1].toLowerCase()))
      .map(([name, c]) => `:${name}${c.args ? ' ' : ''}`);
  }
  // Argumento: ":theme um" → ":theme umbreon"
  const withArg = line.match(/^:(\S+)\s+(.*)$/);
  const command = withArg && COMMANDS[withArg[1].toLowerCase()];
  if (!command?.options) return [];
  const typed = fold(withArg[2]);
  const options = command.options();
  // Primeiro os que começam com o texto; se nenhum, os que contêm.
  let found = options.filter((o) => fold(o).startsWith(typed));
  if (!found.length) found = options.filter((o) => fold(o).includes(typed));
  return found.map((o) => `:${withArg[1].toLowerCase()} ${o}`);
}
