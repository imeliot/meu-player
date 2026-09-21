// Peças de interface reutilizáveis: atalhos, avisos e janelas (dialogs).

export const $ = (sel) => document.querySelector(sel);

// Cria um elemento com classe e texto (textContent evita injeção de HTML).
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// O Spotify manda a descrição das playlists com códigos HTML (ex: &#x27; no lugar de ').
// Isto converte pra texto normal, sem executar nada.
export function decodeHtml(text) {
  const box = document.createElement('textarea');
  box.innerHTML = text ?? '';
  return box.value;
}

// ---------- Bordas de caixa ┌─ título ───┐ ----------

// Traços compridos; o CSS corta o que sobrar, então servem pra qualquer tamanho.
const LINE_H = '─'.repeat(400);
const LINE_V = '│\n'.repeat(200);

// Envolve o conteúdo de cada elemento class="box" com a moldura de caracteres.
// O título vem do atributo data-title.
export function decorateBoxes(root = document) {
  for (const box of root.querySelectorAll('.box:not([data-framed])')) {
    box.dataset.framed = '';
    const body = el('div', 'box-body');
    body.append(...box.childNodes); // move o conteúdo (mantém ids e eventos)

    const top = el('div', 'box-top');
    top.setAttribute('aria-hidden', 'true');
    top.append(
      el('span', 'box-ch', '┌─'),
      el('span', 'box-title', ` ${box.dataset.title ?? ''} `),
      el('span', 'box-fill', LINE_H),
      el('span', 'box-ch', '┐'),
    );

    const mid = el('div', 'box-mid');
    const side = () => {
      const s = el('span', 'box-side', LINE_V);
      s.setAttribute('aria-hidden', 'true');
      return s;
    };
    mid.append(side(), body, side());

    const bottom = el('div', 'box-bottom');
    bottom.setAttribute('aria-hidden', 'true');
    bottom.append(el('span', 'box-ch', '└'), el('span', 'box-fill', LINE_H), el('span', 'box-ch', '┘'));

    box.replaceChildren(top, mid, bottom);
  }
}

// Troca o título embutido na borda de cima.
export function setBoxTitle(box, title) {
  box.dataset.title = title;
  const span = box.querySelector(':scope > .box-top > .box-title');
  if (span) span.textContent = ` ${title} `;
}

// ---------- Avisos (linha acima do prompt) ----------

let noticeTimer;

// kind: 'error' (fica até fechar) ou 'success' (some sozinho).
export function showNotice(message, kind = 'error') {
  $('#notice').className = `notice notice-${kind}`;
  $('#notice-text').textContent = `${kind === 'error' ? '! erro:' : '> ok:'} ${message}`;
  $('#notice').hidden = false;
  clearTimeout(noticeTimer);
  if (kind === 'success') noticeTimer = setTimeout(hideNotice, 3000);
}

export function hideNotice() {
  $('#notice').hidden = true;
}

// ---------- Janelas ----------

// Abre um <dialog> e espera ele fechar. Devolve o "returnValue"
// (o value do botão clicado; vazio se apertou Esc).
function openDialog(dialog) {
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
  });
}

// Pergunta "tem certeza?". Devolve true se confirmou.
export async function confirmDialog(message, confirmLabel = 'Confirmar') {
  $('#confirm-text').textContent = message;
  $('#confirm-ok').textContent = `[${confirmLabel.toLowerCase()}]`;
  return (await openDialog($('#confirm-dialog'))) === 'ok';
}

// Formulário de playlist (criar ou editar). Devolve os dados ou null se cancelou.
export async function playlistFormDialog({ title, name = '', description = '', askPublic }) {
  $('#pf-title').textContent = title;
  $('#pf-name').value = name;
  $('#pf-description').value = description;
  $('#pf-public').checked = false;
  $('#pf-public-row').hidden = !askPublic;

  if ((await openDialog($('#playlist-dialog'))) !== 'ok') return null;
  return {
    name: $('#pf-name').value.trim(),
    description: $('#pf-description').value.trim(),
    isPublic: $('#pf-public').checked,
  };
}

// Mostra a lista de playlists pra escolher uma. Devolve a escolhida ou null.
export async function pickPlaylistDialog(playlists, trackName) {
  $('#picker-track').textContent = trackName;
  const list = $('#picker-list');
  list.replaceChildren();

  if (!playlists.length) {
    list.append(el('li', 'dim', 'você ainda não tem playlists que possa editar.'));
  }
  for (const p of playlists) {
    const li = el('li');
    // Botão dentro de <form method="dialog">: clicar fecha a janela com value = id.
    const btn = el('button', 'lib-item');
    btn.value = p.id;
    btn.append(el('span', 'lib-name', p.name));
    li.append(btn);
    list.append(li);
  }

  const id = await openDialog($('#picker-dialog'));
  return playlists.find((p) => p.id === id) ?? null;
}
