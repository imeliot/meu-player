// Painel [config]: escolher tema e fonte (com pré-visualização), editar cores,
// salvar temas (no Spotify + cópia local) e exportar/importar como linha de texto.
import * as themes from './themes.js';
import { $, el, showNotice, confirmDialog } from './ui.js';

const LABELS = {
  bg: 'bg',
  panel: 'panel',
  border: 'border',
  text: 'text',
  textDim: 'text-dim',
  accent: 'accent',
};

let draftColors = null; // cores no editor

// ---------- Listas de temas e fontes ----------

// Liga a pré-visualização: mouse em cima ou foco do teclado mostra; saiu, volta.
function withPreview(btn, preview) {
  btn.addEventListener('pointerenter', (e) => e.pointerType === 'mouse' && preview());
  btn.addEventListener('pointerleave', (e) => e.pointerType === 'mouse' && themes.endPreview());
  btn.addEventListener('focus', preview);
  btn.addEventListener('blur', () => themes.endPreview());
}

// 6 quadradinhos com as cores do tema.
function swatches(colors) {
  const box = el('span', 'swatches');
  for (const k of themes.COLOR_KEYS) {
    const s = el('span', 'swatch');
    s.style.background = colors[k];
    box.append(s);
  }
  return box;
}

function renderThemeList() {
  const current = themes.activeTheme().name;
  $('#theme-list').replaceChildren(
    ...themes.allThemes().map((t) => {
      const btn = el('button', 'lib-item');
      btn.type = 'button';
      btn.classList.toggle('selected', t.name === current);
      const tag = t.preset ? '' : t.playlistId ? 'seu' : 'só local';
      btn.append(el('span', 'lib-name', t.name), swatches(t.colors), el('span', 'dim theme-tag', tag));
      withPreview(btn, () => themes.previewTheme(t.name));
      // Clique (ou toque no celular) escolhe o tema.
      btn.addEventListener('click', () => {
        themes.setTheme(t.name);
        refresh();
      });
      const li = el('li');
      li.append(btn);
      return li;
    }),
  );
}

function renderFontList() {
  const current = themes.activeFontId();
  $('#font-list').replaceChildren(
    ...themes.FONTS.map((f) => {
      const btn = el('button', 'lib-item');
      btn.type = 'button';
      btn.classList.toggle('selected', f.id === current);
      // O nome da fonte aparece escrito nela mesma.
      const name = el('span', 'lib-name', `${f.label}  áçõ 0123 [==>--]`);
      name.style.fontFamily = `${f.family}, monospace`;
      name.style.fontSize = `calc(${f.size} * var(--ui-scale))`; // menor no celular, como o resto
      btn.append(name);
      // Aviso honesto: se o aparelho não conseguir carregar a fonte, ela não muda nada.
      const mark = el('span', 'dim', '');
      btn.append(mark);
      document.fonts?.ready.then(() => {
        if (!fontAvailable(f.family)) mark.textContent = '(não carregou aqui)';
        checkFontsBlocked();
      });
      withPreview(btn, () => themes.previewFont(f.id));
      btn.addEventListener('click', () => {
        themes.setFont(f.id);
        refresh();
      });
      const li = el('li');
      li.append(btn);
      return li;
    }),
  );
}

// A fonte está mesmo valendo? Mede um texto nela e numa fonte que não existe: se der a
// mesma largura, ela não carregou. (document.fonts.check responde "true" mesmo quando o
// navegador está com as fontes da web desligadas, então não dá pra confiar nele.)
const measurer = document.createElement('canvas').getContext('2d');

function fontAvailable(family) {
  const text = 'mmmmiiii0123áçõ[==>--]';
  measurer.font = "20px 'fonte-que-nao-existe-zzz'";
  const fallback = measurer.measureText(text).width;
  measurer.font = `20px ${family}, 'fonte-que-nao-existe-zzz'`;
  return Math.abs(measurer.measureText(text).width - fallback) > 0.5;
}

// Nenhuma fonte carregou? O navegador está bloqueando fontes da web: aí trocar de fonte
// só muda o tamanho, porque tudo cai na fonte do sistema.
function checkFontsBlocked() {
  const none = themes.FONTS.every((f) => !fontAvailable(f.family));
  const warning = $('#font-warning');
  warning.hidden = !none;
  warning.textContent = none
    ? '! este navegador está bloqueando fontes da web: trocar de fonte só muda o tamanho. ' +
      'procure nas configurações dele a opção de permitir que as páginas usem as próprias fontes.'
    : '';
}

// ---------- Editor de cores ----------

function buildColorFields() {
  $('#color-fields').replaceChildren(
    ...themes.COLOR_KEYS.map((k) => {
      const label = el('label', 'color-field');
      const input = el('input');
      input.type = 'color';
      input.dataset.key = k;
      const hex = el('span', 'dim color-hex');
      input.addEventListener('input', () => {
        draftColors = { ...draftColors, [k]: input.value };
        hex.textContent = input.value;
        themes.setDraft(draftColors); // pré-visualiza na hora
        $('#theme-reset').disabled = false;
      });
      label.append(el('span', 'color-name', LABELS[k]), input, hex);
      return label;
    }),
  );
}

// Coloca as cores do tema escolhido nos campos (descarta o rascunho).
function loadEditor() {
  const theme = themes.activeTheme();
  draftColors = { ...theme.colors };
  for (const input of document.querySelectorAll('#color-fields input')) {
    input.value = draftColors[input.dataset.key];
    input.nextElementSibling.textContent = input.value;
  }
  $('#theme-reset').disabled = true;
  // Salvar/apagar só existe pra temas criados por você.
  $('#theme-save').hidden = Boolean(theme.preset);
  $('#theme-delete').hidden = Boolean(theme.preset);
}

// Redesenha tudo depois de uma mudança.
function refresh() {
  renderThemeList();
  renderFontList();
  loadEditor();
}

// Aviso de sincronização (sucesso ou "só local").
function reportSync(result, okMessage) {
  if (result.synced) {
    showNotice(okMessage, 'success');
  } else {
    console.error(result.error);
    showNotice(
      `${okMessage} mas não sincronizou com o spotify (${result.error?.message ?? 'erro'}). ` +
        'ele fica salvo neste aparelho e o app tenta de novo ao reabrir.',
    );
  }
}

// ---------- Ações ----------

async function saveNew() {
  const name = $('#theme-name').value;
  const problem = themes.nameProblem(name);
  if (problem) return showNotice(problem);
  const result = await themes.saveNewTheme(name, draftColors);
  $('#theme-name').value = '';
  refresh();
  reportSync(result, `tema "${name.trim()}" salvo.`);
}

async function saveChanges() {
  const name = themes.activeTheme().name;
  const result = await themes.updateTheme(name, draftColors);
  refresh();
  reportSync(result, `tema "${name}" atualizado.`);
}

async function remove() {
  const name = themes.activeTheme().name;
  const ok = await confirmDialog(
    `Apagar o tema "${name}"? A playlist que guarda ele na sua conta deixa de ser seguida.`,
    'Apagar',
  );
  if (!ok) return;
  await themes.deleteTheme(name);
  refresh();
  showNotice(`tema "${name}" apagado.`, 'success');
}

async function exportCurrent() {
  const theme = themes.activeTheme();
  const line = themes.encodeTheme({ ...theme, colors: draftColors, font: themes.activeFontId() });
  const out = $('#theme-export-line');
  out.value = line;
  out.hidden = false;
  out.select();
  try {
    await navigator.clipboard.writeText(line);
    showNotice('linha do tema copiada. cole onde quiser guardar.', 'success');
  } catch {
    showNotice('não deu pra copiar sozinho: a linha está selecionada, use ctrl+c.', 'success');
  }
}

async function importLine() {
  const line = $('#theme-import-line').value;
  const result = await themes.importTheme(line);
  $('#theme-import-line').value = '';
  refresh();
  reportSync(result, `tema "${result.name}" importado.`);
}

// ---------- Início ----------

// safely = função do app que mostra erros na tela.
export function initConfig(safely) {
  buildColorFields();
  refresh();

  $('#theme-reset').addEventListener('click', () => {
    themes.setDraft(null);
    loadEditor();
  });
  $('#theme-save-new').addEventListener('click', () => safely(saveNew));
  $('#theme-save').addEventListener('click', () => safely(saveChanges));
  $('#theme-delete').addEventListener('click', () => safely(remove));
  $('#theme-export').addEventListener('click', () => safely(exportCurrent));
  $('#theme-import').addEventListener('click', () => safely(importLine));

  // Tema/fonte trocados por fora (ex: comando :theme): atualiza o painel.
  window.addEventListener('themeselected', refresh);
}

// Ao fechar o painel, cores editadas e não salvas são descartadas.
export function closeConfig() {
  if (!draftColors) return;
  themes.setDraft(null);
  loadEditor();
}

// Mostra o estado da sincronização embaixo da lista de temas.
export function setSyncStatus(text) {
  $('#theme-sync').textContent = text;
  refresh();
}
