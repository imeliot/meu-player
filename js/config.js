// Configurações do app. Troque o CLIENT_ID pelo do seu app no Spotify Dashboard.
export const CLIENT_ID = '9b8bfb705f29494f841912fe541fcef1';

// Endereço da pasta do app (termina com "/"), calculado a partir deste arquivo (js/config.js):
//   local:  http://127.0.0.1:5173/
//   online: https://<usuario>.github.io/<repo>/
export const APP_ROOT = new URL('../', import.meta.url).href;

// Endereço pra onde o Spotify volta depois do login. Precisa ser IGUAL a um dos
// cadastrados no Dashboard do Spotify (cada letra e barra conta).
//   local:  o de sempre (o servidor do Python completa a barra final sozinho)
//   online: termina com "/" porque é a pasta callback/, que existe de verdade no site
export const REDIRECT_URI =
  location.hostname === '127.0.0.1'
    ? 'http://127.0.0.1:5173/callback'
    : new URL('callback/', APP_ROOT).href;

// Permissões pedidas no login. Já incluímos as das fases futuras
// pra não precisar logar de novo depois.
export const SCOPES = [
  // Perfil (o Web Playback SDK exige estes dois)
  'user-read-private',
  'user-read-email',
  // Playlists: ler e editar
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-private',
  'playlist-modify-public',
  'ugc-image-upload', // trocar capa de playlist
  // Biblioteca (músicas curtidas etc.): ler e editar
  'user-library-read',
  'user-library-modify',
  // Os endpoints /me/library (2026) também listam estes (seguir/deixar de seguir)
  'user-follow-read',
  'user-follow-modify',
  // Tocar música (fases futuras)
  'streaming',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
];
