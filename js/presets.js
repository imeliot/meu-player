// PRESETS: temas e fontes fixos do app. Pode editar à mão.
//
// Cada tema tem as 6 cores do app (formato #rrggbb):
//   bg      → fundo da página        panel   → fundo dos painéis
//   border  → bordas ┌─┐            text    → texto normal
//   textDim → texto secundário        accent  → destaque (">", botões ativos)
// Opcionais: cursor (cor do cursor piscando; padrão = text)
//            font   (id de uma fonte abaixo; se faltar, mantém a fonte atual)
//
// Pra criar um preset novo, copie um bloco { ... }, mude o nome e as cores.
// Os nomes precisam ser únicos (é o que se digita em ":theme <nome>").

export const PRESET_THEMES = [
  {
    name: 'claude', // padrão
    colors: {
      bg: '#262624',
      panel: '#30302e',
      border: '#4a4945',
      text: '#f5f4ef',
      textDim: '#a6a39a',
      accent: '#d97757',
    },
  },
  {
    name: 'phosphor', // monitor antigo de fósforo verde
    colors: {
      bg: '#070b07',
      panel: '#0c140d',
      border: '#1d3a21',
      text: '#39ff6a',
      textDim: '#1f9e43',
      accent: '#c8ffd6',
    },
  },
  {
    name: 'amber', // monitor antigo âmbar
    colors: {
      bg: '#0b0804',
      panel: '#150f08',
      border: '#3d2b10',
      text: '#ffb000',
      textDim: '#a86f00',
      accent: '#ffe0a0',
    },
  },
  {
    name: 'umbreon', // azul-marinho, destaque amarelo, cursor vermelho
    colors: {
      bg: '#0b1024',
      panel: '#121a38',
      border: '#2b3766',
      text: '#e9edf8',
      textDim: '#8e98bd',
      accent: '#f5c518',
    },
    cursor: '#e5383b',
  },
];

// O primeiro tema da lista é o padrão.
export const DEFAULT_THEME = PRESET_THEMES[0].name;

// FONTES: todas guardadas em fonts/ (as @font-face estão em css/theme.css).
// size = tamanho em que a fonte fica nítida:
//   VT323 → múltiplos de 25px | Departure Mono → múltiplos de 11px | JetBrains Mono → qualquer
export const FONTS = [
  { id: 'vt323', label: 'VT323', family: "'VT323'", size: '25px' },
  { id: 'departure', label: 'Departure Mono', family: "'Departure Mono'", size: '22px' },
  { id: 'jetbrains', label: 'JetBrains Mono', family: "'JetBrains Mono'", size: '18px' },
];

export const DEFAULT_FONT = FONTS[0].id;
