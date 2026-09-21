// Service worker do PWA: guarda só a "casca" do app (HTML, CSS, JS, fontes e ícones),
// pra abrir rápido e mostrar a tela mesmo sem internet.
//
// NUNCA guarda nada do Spotify: login, tokens, respostas da API, músicas e capas vêm de
// outros domínios (accounts.spotify.com, api.spotify.com, *.scdn.co) e nem passam por aqui.
// Os tokens ficam no localStorage do navegador, não em cache.

// O deploy (GitHub Actions) troca 'dev' pelo código do commit: cada publicação ganha um
// cache novo e o antigo é apagado. Não mude esta linha à mão.
const VERSION = 'dev';
const CACHE = `shell-${VERSION}`;

// Arquivos da casca (relativos à pasta do app). Arquivo novo no app? Adicione aqui.
// O deploy confere se todos existem e falha se algum faltar.
const SHELL = [
  './',
  'index.html',
  'callback/index.html',
  'manifest.webmanifest',
  'css/theme.css',
  'css/style.css',
  'js/api.js',
  'js/app.js',
  'js/auth.js',
  'js/boot.js',
  'js/cmdline.js',
  'js/commands.js',
  'js/config.js',
  'js/cover.js',
  'js/player.js',
  'js/presets.js',
  'js/settings.js',
  'js/themes.js',
  'js/ui.js',
  'fonts/VT323-Regular.woff2',
  'fonts/DepartureMono-Regular.woff2',
  'fonts/JetBrainsMono-Regular.woff2',
  'icons/favicon-32.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
];

const SHELL_PATHS = new Set(SHELL.map((path) => new URL(path, self.registration.scope).pathname));

// Instalação: baixa a casca inteira pro cache novo.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

// Ativação: apaga caches de versões antigas.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith('shell-') && k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Qualquer coisa de fora (Spotify!) ou que não seja leitura: segue direto pra rede, sem cache.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Páginas (index, callback): tenta a rede primeiro pra pegar sempre a versão nova;
  // sem internet, usa a cópia guardada. A resposta da rede NÃO é guardada (o callback
  // chega com o código de login na URL).
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const cached = await caches.match(request, { ignoreSearch: true });
        return cached ?? caches.match('index.html');
      }),
    );
    return;
  }

  // CSS, JS, fontes e ícones da casca: do cache (rápido); se faltar, da rede.
  if (SHELL_PATHS.has(url.pathname)) {
    event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request)));
  }
  // O resto nem passa pelo service worker.
});
