// Linha de comando "player@spotify:~$": digitar, histórico, Tab e saída estilo terminal.
//   /texto  → filtra a lista aberta (em tempo real)
//   ?texto  → busca no Spotify (ao apertar Enter)
//   :cmd    → roda um comando (commands.js)
import { $, el } from './ui.js';
import { runCommand, completions } from './commands.js';

const HISTORY_KEY = 'cmd_history';
const HISTORY_MAX = 50;
const PROMPT = 'player@spotify:~$';

let hooks = {}; // { filter(texto), clearFilter(), search(texto) } — vêm do app

let history = [];
try {
  history = JSON.parse(localStorage.getItem(HISTORY_KEY)) ?? [];
} catch {
  // sem histórico salvo: tudo bem
}
let historyIndex = history.length; // = history.length quando não está navegando
let draftLine = ''; // o que estava digitado antes de começar a navegar no histórico
let tabCycle = null; // { options, index } enquanto aperta Tab várias vezes

const input = () => $('#cmd-input');

// ---------- Saída ----------

// Mostra o comando digitado e a resposta (substitui a saída anterior).
function print(line, message, isError) {
  const out = $('#cmd-output');
  const echo = el('span', 'dim', `${PROMPT} ${line}\n`);
  const answer = el('span', isError ? 'error-text' : null, message);
  out.replaceChildren(echo, answer);
  out.hidden = false;
  out.scrollTop = 0;
}

// Linha de dica (opções do Tab, contagem do filtro). Texto vazio esconde.
export function hint(text) {
  $('#cmd-hint').textContent = text;
  $('#cmd-hint').hidden = !text;
}

function clearOutput() {
  $('#cmd-output').hidden = true;
  hint('');
}

// ---------- Histórico ----------

function remember(line) {
  if (history.at(-1) !== line) history.push(line);
  history = history.slice(-HISTORY_MAX);
  historyIndex = history.length;
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // sem problema: só não lembra ao reabrir
  }
}

function browseHistory(step) {
  if (!history.length) return;
  if (historyIndex === history.length) draftLine = input().value;
  historyIndex = Math.min(Math.max(historyIndex + step, 0), history.length);
  input().value = historyIndex === history.length ? draftLine : history[historyIndex];
  input().setSelectionRange(input().value.length, input().value.length);
}

// ---------- Tab (autocompletar) ----------

function commonPrefix(list) {
  let prefix = list[0];
  for (const item of list) {
    while (!item.toLowerCase().startsWith(prefix.toLowerCase())) prefix = prefix.slice(0, -1);
  }
  return prefix;
}

function complete() {
  // Tab de novo: passa pra próxima opção.
  if (tabCycle) {
    tabCycle.index = (tabCycle.index + 1) % tabCycle.options.length;
    input().value = tabCycle.options[tabCycle.index];
    return;
  }
  const options = completions(input().value);
  if (!options.length) return hint('sem opções pra completar');
  if (options.length === 1) {
    input().value = options[0];
    return hint('');
  }
  // Várias opções: completa o que for comum e mostra a lista.
  const shown = options.map((o) => o.replace(/^:\S+\s+/, '').trim() || o);
  hint(`opções: ${shown.join('  ')}`);
  const prefix = commonPrefix(options);
  if (prefix.length > input().value.length) {
    input().value = prefix;
  } else {
    tabCycle = { options, index: 0 };
    input().value = options[0];
  }
}

// ---------- Enter ----------

async function submit() {
  const line = input().value.trim();
  if (!line) return leave();
  remember(line);
  input().value = '';
  tabCycle = null;

  if (line.startsWith('/')) {
    // Filtro já aplicado enquanto digitava; Enter vai pra lista filtrada.
    hooks.filter(line.slice(1));
    input().blur();
    hooks.focusList?.();
    return;
  }
  if (line.startsWith('?')) {
    const query = line.slice(1).trim();
    if (!query) return print(line, 'uso: ?texto (ex: ?chico buarque)', true);
    hint('');
    print(line, `buscando "${query}"…`);
    const result = await hooks.search(query); // { ok, message }
    print(line, result.message, !result.ok);
    if (!result.ok) return;
    input().blur();
    hooks.focusList?.();
    return;
  }
  const result = await runCommand(line);
  hint('');
  print(line, result.message, !result.ok);
}

// Sai da linha de comando: limpa o que foi digitado e o filtro.
function leave() {
  input().value = '';
  tabCycle = null;
  historyIndex = history.length;
  hooks.clearFilter();
  clearOutput();
  input().blur();
}

// ---------- Início ----------

const isTypingSomewhere = (target) =>
  target.closest?.('input, textarea, select, [contenteditable="true"]') || document.querySelector('dialog[open]');

export function initCmdline(appHooks) {
  hooks = appHooks;
  const box = input();

  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      leave();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Tab') {
      e.preventDefault(); // Tab completa em vez de sair da caixa
      complete();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      browseHistory(-1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      browseHistory(1);
    }
  });

  // Enquanto digita "/texto", filtra na hora; apagou a "/", tira o filtro.
  box.addEventListener('input', () => {
    tabCycle = null;
    historyIndex = history.length;
    const value = box.value;
    if (value.startsWith('/')) hooks.filter(value.slice(1));
    else hooks.clearFilter();
  });

  // Em qualquer lugar do app: "/", ":" ou "?" abre a linha de comando já com o caractere.
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || isTypingSomewhere(e.target)) return;
    if (['/', ':', '?'].includes(e.key)) {
      e.preventDefault();
      box.focus();
      box.value = e.key;
      if (e.key === '/') hooks.filter('');
    } else if (e.key === 'Escape') {
      hooks.clearFilter(); // Esc fora da caixa também limpa o filtro
      clearOutput();
    }
  });
}
