// Login com Spotify usando Authorization Code + PKCE (sem client secret).
// Doc: https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow
import { CLIENT_ID, REDIRECT_URI, SCOPES } from './config.js';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const STORAGE_KEY = 'spotify_token';

// Gera um texto aleatório seguro (usado como "code verifier" e "state").
function randomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values, (v) => chars[v % chars.length]).join('');
}

// SHA-256 + base64url: transforma o verifier no "code challenge".
async function makeChallenge(verifier) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

// Passo 1: manda o usuário pra tela de login do Spotify.
export async function login() {
  const verifier = randomString(64);
  const state = randomString(16);
  sessionStorage.setItem('pkce_verifier', verifier);
  sessionStorage.setItem('pkce_state', state);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: await makeChallenge(verifier),
    scope: SCOPES.join(' '),
    state,
  });
  window.location.href = `https://accounts.spotify.com/authorize?${params}`;
}

// Passo 2: na página /callback, troca o "code" recebido por um token.
export async function handleCallback() {
  const params = new URLSearchParams(window.location.search);
  const error = params.get('error');
  if (error) throw new Error(`Login cancelado ou negado: ${error}`);

  const code = params.get('code');
  const state = params.get('state');
  if (!code || state !== sessionStorage.getItem('pkce_state')) {
    throw new Error('Resposta de login inválida. Tente entrar de novo.');
  }

  const token = await requestToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: sessionStorage.getItem('pkce_verifier'),
  });
  sessionStorage.removeItem('pkce_verifier');
  sessionStorage.removeItem('pkce_state');
  return token;
}

// Faz o POST no endpoint de token e salva o resultado.
async function requestToken(body) {
  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
  } catch (cause) {
    throw new Error('Sem internet (ou o Spotify não respondeu). Tente de novo.', { cause });
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    // Só "invalid_grant" quer dizer que o login acabou de verdade (acesso removido, senha
    // trocada…). Qualquer outra falha (Spotify fora do ar, limite de requisições) passa
    // sozinha: não pode deslogar ninguém.
    const expired = body.grant_type === 'refresh_token' && data?.error === 'invalid_grant';
    const err = new Error(
      expired ? 'Sua sessão expirou. Entre de novo.' : `O Spotify não renovou o login agora (${res.status}). Tente de novo.`,
    );
    if (expired) err.status = 401;
    throw err;
  }
  const data = await res.json();

  const saved = loadToken();
  const token = {
    access_token: data.access_token,
    // Às vezes o refresh não devolve um refresh_token novo: aí mantemos o antigo.
    refresh_token: data.refresh_token ?? saved?.refresh_token,
    // Guardamos quando expira (com 60s de folga).
    expires_at: Date.now() + (data.expires_in - 60) * 1000,
    // Permissões pedidas no login (pra saber se o app passou a pedir mais).
    scopes:
      body.grant_type === 'authorization_code' ? SCOPES.join(' ') : (saved?.scopes ?? ''),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(token));
  return token;
}

function loadToken() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

export function isLoggedIn() {
  return Boolean(loadToken()?.refresh_token);
}

// false se o app passou a pedir permissões que o login atual não tem
// (aí é preciso entrar de novo).
export function hasAllScopes() {
  const granted = (loadToken()?.scopes ?? '').split(' ');
  return SCOPES.every((s) => granted.includes(s));
}

export function logout() {
  localStorage.removeItem(STORAGE_KEY);
}

function notLoggedIn() {
  const err = new Error('Não está logado.');
  err.status = 401;
  return err;
}

// Renovação em andamento: quem pedir um token enquanto ela roda espera a mesma.
let refreshing = null;

// Devolve um access token válido, renovando automaticamente se expirou.
// `rejected` = token que o Spotify acabou de recusar (401): força uma renovação.
export async function getAccessToken(rejected) {
  const token = loadToken();
  if (!token) throw notLoggedIn();
  if (Date.now() < token.expires_at && token.access_token !== rejected) return token.access_token;

  // Cada refresh_token só vale UMA vez (o Spotify manda outro na resposta). Se duas
  // requisições renovassem juntas, a segunda usaria um refresh_token já gasto e o
  // Spotify responderia "sessão expirada". Por isso só uma renovação por vez.
  refreshing ??= refreshOnce(token.access_token).finally(() => (refreshing = null));
  return refreshing;
}

async function refreshOnce(staleToken) {
  const run = async () => {
    // Outra aba do app pode ter renovado enquanto esta esperava a vez.
    const token = loadToken();
    if (!token) throw notLoggedIn();
    if (token.access_token !== staleToken && Date.now() < token.expires_at) return token.access_token;
    const fresh = await requestToken({
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token,
      client_id: CLIENT_ID,
    });
    return fresh.access_token;
  };
  // navigator.locks: uma renovação por vez mesmo entre abas (ex: site + app instalado).
  return navigator.locks ? navigator.locks.request('spotify-token-refresh', run) : run();
}
