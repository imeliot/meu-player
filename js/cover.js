// Capa do álbum pixelada, com poucas cores, desenhada num <canvas>.
// Passos: 1) encolhe a imagem pra 24×24; 2) escolhe as N cores que melhor
// representam a capa (k-means); 3) pinta cada pixel com a cor mais próxima.
// O CSS amplia o canvas com "image-rendering: pixelated" (sem borrar).

let currentUrl = null;

// Lê um número definido no tema (ex: --cover-px: 24).
function themeNumber(name, fallback) {
  const value = parseInt(getComputedStyle(document.documentElement).getPropertyValue(name), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function clearPixelCover(canvas) {
  currentUrl = null;
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}

export function drawPixelCover(canvas, url) {
  if (url === currentUrl) return; // mesma capa: não redesenha
  currentUrl = url;

  const size = themeNumber('--cover-px', 24);
  const colors = themeNumber('--cover-colors', 6);
  canvas.width = size;
  canvas.height = size;

  const img = new Image();
  img.crossOrigin = 'anonymous'; // as capas do Spotify permitem leitura (CORS)
  img.onload = () => {
    if (url !== currentUrl) return; // a música já mudou enquanto carregava
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true; // ao encolher, a média das cores fica mais bonita
    ctx.drawImage(img, 0, 0, size, size);
    try {
      const data = ctx.getImageData(0, 0, size, size);
      reduceColors(data.data, colors);
      ctx.putImageData(data, 0, 0);
    } catch {
      // Se o navegador não deixar ler os pixels, fica só pixelada (sem reduzir cores).
    }
  };
  img.src = url;
}

// Reduz a imagem a "k" cores com k-means (poucas repetições bastam em 24×24).
function reduceColors(px, k) {
  const count = px.length / 4;
  const pixels = [];
  for (let i = 0; i < count; i++) pixels.push([px[i * 4], px[i * 4 + 1], px[i * 4 + 2]]);

  // Começa com cores espalhadas do escuro ao claro.
  const byLight = [...pixels].sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
  let centers = Array.from({ length: k }, (_, i) =>
    byLight[Math.floor(((i + 0.5) / k) * (byLight.length - 1))].slice(),
  );

  const nearest = (p) => {
    let best = 0;
    let bestDist = Infinity;
    centers.forEach((c, i) => {
      const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    return best;
  };

  for (let round = 0; round < 8; round++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (const p of pixels) {
      const s = sums[nearest(p)];
      s[0] += p[0];
      s[1] += p[1];
      s[2] += p[2];
      s[3]++;
    }
    centers = centers.map((c, i) =>
      sums[i][3] ? [sums[i][0] / sums[i][3], sums[i][1] / sums[i][3], sums[i][2] / sums[i][3]] : c,
    );
  }

  pixels.forEach((p, i) => {
    const c = centers[nearest(p)];
    px[i * 4] = Math.round(c[0]);
    px[i * 4 + 1] = Math.round(c[1]);
    px[i * 4 + 2] = Math.round(c[2]);
    px[i * 4 + 3] = 255;
  });
}
