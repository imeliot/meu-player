# Meu Player (Spotify)

Player pessoal que usa a Web API do Spotify. Sem backend: login com PKCE.

## Rodar

1. Cole seu Client ID em `js/config.js`.
2. No [Spotify Dashboard](https://developer.spotify.com/dashboard), cadastre a Redirect URI
   `http://127.0.0.1:5173/callback` (exatamente assim).
3. Na pasta do projeto:

   ```sh
   python3 -m http.server 5173 --bind 127.0.0.1
   ```

4. Abra http://127.0.0.1:5173 (use `127.0.0.1`, não `localhost`).

## Online (GitHub Pages)

Cada `git push` na branch `main` publica o site sozinho (`.github/workflows/deploy.yml`).
Endereço: `https://<usuario>.github.io/<repo>/`. No Dashboard do Spotify ficam cadastradas
as duas Redirect URIs: a local acima e `https://<usuario>.github.io/<repo>/callback/`
(com a barra no final).

O app é um PWA: dá pra instalar pelo navegador. O service worker (`sw.js`) guarda só os
arquivos do app, nunca dados do Spotify, e fica desligado no `127.0.0.1`.

## Arquivos

- `index.html` — página principal (login + biblioteca)
- `callback/index.html` — página para onde o Spotify volta depois do login
- `js/presets.js` — **temas e fontes fixos** (edite à mão pra criar presets)
- `css/theme.css` — valores padrão de cores, fontes e medidas
- `fonts/` — VT323 e Departure Mono (licença SIL OFL), guardadas no projeto pra funcionar offline
- `css/style.css` — layout
- `js/config.js` — Client ID, Redirect URI e permissões (scopes)
- `js/auth.js` — login PKCE e renovação do token
- `js/api.js` — chamadas à Web API
- `js/player.js` — player: toca no navegador (Web Playback SDK) ou controla outro aparelho (Web API, modo remoto)
- `js/devices.js` — painel de dispositivos (transferir a música)
- `js/ui.js` — peças de interface (bordas ┌─┐, avisos, janelas)
- `js/boot.js` — tela de boot
- `js/cover.js` — capa do álbum pixelada
- `js/roll.js` — títulos compridos andam de lado (letreiro) pra dar pra ler
- `js/themes.js` — aplica temas, guarda no navegador e sincroniza com a conta (playlists "⚙ tema:")
- `js/settings.js` — painel [config] (temas e fontes)
- `js/cmdline.js` — linha de comando (atalhos `/` e `:`, histórico, Tab, filtro e busca)
- `js/commands.js` — comandos `:play`, `:add`, `:theme`… (digite `:help` no app)
- `js/app.js` — monta a tela, toca e gerencia playlists
