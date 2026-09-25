// Temas e fontes: aplicar, pré-visualizar, guardar no navegador e sincronizar
// com a conta Spotify (cada tema do usuário = uma playlist privada vazia).
import { PRESET_THEMES, DEFAULT_THEME, FONTS, DEFAULT_FONT } from './presets.js';
import * as api from './api.js';
import { decodeHtml } from './ui.js';

// Nome das playlists que guardam temas. Elas ficam escondidas das listas do app.
export const THEME_PREFIX = '⚙ tema: ';
export const isThemePlaylist = (p) => typeof p?.name === 'string' && p.name.startsWith(THEME_PREFIX);

export const COLOR_KEYS = ['bg', 'panel', 'border', 'text', 'textDim', 'accent'];
const CSS_VAR = {
  bg: '--bg',
  panel: '--panel',
  border: '--border',
  text: '--text',
  textDim: '--text-dim',
  accent: '--accent',
};
const NAME_MAX = 30; // a descrição tem limite de ~300 caracteres; um tema usa ~90

const ACTIVE_KEY = 'theme_active'; // tema e fonte escolhidos neste aparelho
const USER_KEY = 'themes_user'; // cópia local dos temas do usuário

// ---------- Guardar no navegador (sempre com try/catch: pode estar bloqueado) ----------

function readStorage(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // sem problema: só não lembra ao reabrir
  }
}

// Temas do usuário: { name, colors, font, playlistId (null = ainda não está no Spotify) }
let userThemes = readStorage(USER_KEY, []).filter((t) => t && validColors(t.colors));
let active = { theme: DEFAULT_THEME, font: DEFAULT_FONT, ...readStorage(ACTIVE_KEY, {}) };
let draft = null; // cores sendo editadas no editor (pré-visualização)

const saveUserThemes = () => writeStorage(USER_KEY, userThemes);

// ---------- Formato de texto: "v1|nome|bg,panel,border,text,textdim,accent|fonte" ----------

function normalizeColor(value) {
  const hex = String(value ?? '').trim().replace(/^#/, '').toLowerCase();
  return /^[0-9a-f]{6}$/.test(hex) ? `#${hex}` : null;
}

function validColors(colors) {
  return Boolean(colors) && COLOR_KEYS.every((k) => normalizeColor(colors[k]));
}

export function encodeTheme(theme) {
  return ['v1', theme.name, COLOR_KEYS.map((k) => theme.colors[k]).join(','), theme.font ?? DEFAULT_FONT].join('|');
}

// Lê uma linha no formato v1. Devolve o tema ou null se for inválida (sem quebrar nada).
export function decodeTheme(line) {
  const parts = String(line ?? '').trim().split('|');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const name = parts[1].trim();
  if (!name || name.length > NAME_MAX) return null;
  const values = parts[2].split(',').map(normalizeColor);
  if (values.length !== COLOR_KEYS.length || values.includes(null)) return null;
  const colors = Object.fromEntries(COLOR_KEYS.map((k, i) => [k, values[i]]));
  // Fonte desconhecida não invalida o tema: usa a padrão.
  const font = FONTS.some((f) => f.id === parts[3].trim()) ? parts[3].trim() : DEFAULT_FONT;
  return { name, colors, font };
}

// ---------- Consultas ----------

export const allThemes = () => [
  ...PRESET_THEMES.map((t) => ({ ...t, preset: true })),
  ...userThemes,
];

const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
export const findTheme = (name) => allThemes().find((t) => sameName(t.name, name.trim()));
export const findFont = (idOrLabel) => {
  const q = idOrLabel.trim().toLowerCase();
  return FONTS.find((f) => f.id === q || f.label.toLowerCase() === q || f.label.toLowerCase().startsWith(q));
};
export const activeTheme = () => findTheme(active.theme) ?? findTheme(DEFAULT_THEME);
export const activeFontId = () => active.font;
export { FONTS };

// Devolve uma mensagem de erro, ou null se o nome serve pra um tema novo.
export function nameProblem(name) {
  const n = name.trim();
  if (!n) return 'dê um nome ao tema.';
  if (n.length > NAME_MAX) return `o nome pode ter no máximo ${NAME_MAX} caracteres.`;
  if (n.includes('|')) return 'o nome não pode ter o caractere "|".';
  if (findTheme(n)) return `já existe um tema chamado "${n}".`;
  return null;
}

// ---------- Pintar a tela ----------

function paint(theme, fontId) {
  const root = document.documentElement.style;
  const vars = {};
  for (const k of COLOR_KEYS) vars[CSS_VAR[k]] = theme.colors[k];
  if (theme.cursor) vars['--cursor'] = theme.cursor;
  const font = FONTS.find((f) => f.id === fontId) ?? FONTS[0];
  vars['--font-main'] = `${font.family}, monospace`;
  vars['--font-size'] = font.size;
  vars['--font-weight'] = String(font.weight ?? 400);
  vars['--font-spacing'] = font.spacing ?? '0';

  root.removeProperty('--cursor'); // volta pro padrão (= cor do texto) se o tema não tiver
  for (const [k, v] of Object.entries(vars)) root.setProperty(k, v);

  // Avisa quem desenha em caracteres (barras ASCII) pra medir a fonte de novo.
  const notify = () => window.dispatchEvent(new Event('themechange'));
  notify();
  document.fonts?.load(`${font.size} ${font.family}`).then(notify, notify);
  return vars;
}

// Pinta o tema escolhido (ou o rascunho do editor, se houver) e guarda a escolha.
function paintActive() {
  const theme = activeTheme();
  const vars = paint(draft ? { ...theme, colors: draft } : theme, active.font);
  // "vars" também serve pro script no <head> aplicar o tema antes da página aparecer.
  if (!draft) writeStorage(ACTIVE_KEY, { theme: theme.name, font: active.font, vars });
}

// Pré-visualização (ao passar o mouse / focar). endPreview() volta ao escolhido.
export function previewTheme(name) {
  const theme = findTheme(name);
  if (theme) paint(theme, theme.font ?? active.font);
}

export function previewFont(id) {
  paint(draft ? { ...activeTheme(), colors: draft } : activeTheme(), id);
}

export const endPreview = () => paintActive();

// Editor: cores provisórias (null = descartar e voltar ao tema escolhido).
export function setDraft(colors) {
  draft = colors ? { ...colors } : null;
  paintActive();
}

// ---------- Escolher ----------

export function setTheme(name) {
  const theme = findTheme(name);
  if (!theme) return false;
  active.theme = theme.name;
  if (theme.font) active.font = theme.font; // temas do usuário trazem a fonte junto
  draft = null;
  paintActive();
  window.dispatchEvent(new Event('themeselected')); // o painel [config] se atualiza
  return true;
}

export function setFont(idOrLabel) {
  const font = findFont(idOrLabel);
  if (!font) return false;
  active.font = font.id;
  paintActive();
  window.dispatchEvent(new Event('themeselected'));
  return true;
}

// ---------- Temas do usuário (local + Spotify) ----------

// Cria a playlist privada que guarda o tema na conta.
async function createRemote(theme) {
  const created = await api.createPlaylist({
    name: THEME_PREFIX + theme.name,
    description: encodeTheme(theme),
    isPublic: false,
  });
  theme.playlistId = created.id;
  saveUserThemes();
}

// Salva um tema novo. Sempre guarda local; devolve { synced } dizendo se foi pro Spotify.
export async function saveNewTheme(name, colors) {
  const problem = nameProblem(name);
  if (problem) throw new Error(problem);
  const theme = { name: name.trim(), colors: { ...colors }, font: active.font, playlistId: null };
  userThemes.push(theme);
  saveUserThemes();
  setTheme(theme.name);
  try {
    await createRemote(theme);
    return { synced: true };
  } catch (err) {
    return { synced: false, error: err };
  }
}

// Atualiza cores e fonte de um tema do usuário (e a descrição da playlist).
export async function updateTheme(name, colors) {
  const theme = userThemes.find((t) => sameName(t.name, name));
  if (!theme) throw new Error('só dá pra editar temas criados por você.');
  theme.colors = { ...colors };
  theme.font = active.font;
  saveUserThemes();
  setTheme(theme.name);
  try {
    if (theme.playlistId) {
      await api.updatePlaylist(theme.playlistId, { description: encodeTheme(theme) });
    } else {
      await createRemote(theme);
    }
    return { synced: true };
  } catch (err) {
    return { synced: false, error: err };
  }
}

// Apaga um tema do usuário (no Spotify = deixar de seguir a playlist).
// Se o Spotify falhar, o tema NÃO é apagado (pra não sumir só de um lado).
export async function deleteTheme(name) {
  const theme = userThemes.find((t) => sameName(t.name, name));
  if (!theme) throw new Error('só dá pra apagar temas criados por você.');
  if (theme.playlistId) await api.removeFromLibrary([`spotify:playlist:${theme.playlistId}`]);
  userThemes = userThemes.filter((t) => t !== theme);
  saveUserThemes();
  if (sameName(active.theme, theme.name)) setTheme(DEFAULT_THEME);
}

// Importa uma linha "v1|...". Se o nome já existir, acrescenta um número.
export async function importTheme(line) {
  const theme = decodeTheme(line);
  if (!theme) throw new Error('linha inválida. formato: v1|nome|6 cores|fonte');
  let name = theme.name;
  for (let i = 2; nameProblem(name); i++) name = `${theme.name.slice(0, NAME_MAX - 3)}-${i}`;
  active.font = theme.font;
  const result = await saveNewTheme(name, theme.colors);
  return { ...result, name };
}

// Lê os temas das playlists "⚙ tema:" (já filtradas pelo app) e junta com a cópia local.
// O Spotify é a fonte da verdade; temas locais que nunca subiram são enviados agora.
export async function syncFromPlaylists(playlists) {
  const remote = [];
  for (const p of playlists) {
    const theme = decodeTheme(decodeHtml(p.description ?? ''));
    if (theme) {
      remote.push({ ...theme, playlistId: p.id });
    } else {
      // Descrição vazia ou inválida: usa a cópia local dessa playlist, se tiver; senão ignora.
      const local = userThemes.find((t) => t.playlistId === p.id);
      if (local) remote.push(local);
    }
  }
  const unsynced = userThemes.filter(
    (t) => !t.playlistId && !remote.some((r) => sameName(r.name, t.name)),
  );
  // Nomes repetidos no Spotify: fica o primeiro.
  userThemes = remote.filter((t, i) => remote.findIndex((r) => sameName(r.name, t.name)) === i);
  userThemes.push(...unsynced);
  saveUserThemes();

  let failed = 0;
  for (const theme of unsynced) {
    try {
      await createRemote(theme);
    } catch {
      failed++;
    }
  }
  paintActive(); // o tema escolhido pode ter mudado no Spotify
  return { failed };
}

// Aplica o tema salvo assim que o app abre.
paintActive();
