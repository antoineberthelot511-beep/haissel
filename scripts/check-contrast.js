/*
 * Vérifie les contrastes de la palette de marque (frontend/brand.css).
 * Usage : node scripts/check-contrast.js (code 1 si un contraste est insuffisant).
 * Aussi utilisé par tests/brand.test.js.
 */
const fs = require('fs');
const path = require('path');

const MIN = 4.5;

function readPalette(file = path.join(__dirname, '../frontend/brand.css')) {
  const css = fs.readFileSync(file, 'utf8');
  const palette = {};
  for (const [, name, value] of css.matchAll(/--(brand[a-z-]*):\s*(#[0-9a-fA-F]{6})\b/g)) palette[name] = value;
  return palette;
}

function luminance(hex) {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Paires texte / fond à respecter (fonds de l'app : blanc, page claire, surfaces sombres). */
function pairs(p) {
  return [
    ['blanc sur --brand', p['brand-on'], p.brand],
    ['blanc sur --brand-strong', p['brand-on'], p['brand-strong']],
    ['--brand sur blanc', p.brand, '#FFFFFF'],
    ['--brand sur fond de page', p.brand, '#F7F8FC'],
    ['--brand sur --brand-soft', p.brand, p['brand-soft']],
    ['--brand-ink sur --brand-fixed', p['brand-ink'], p['brand-fixed']],
    ['--brand-on-dark sur noir', p['brand-on-dark'], '#000000'],
    ['--brand-on-dark sur verre sombre', p['brand-on-dark'], '#161822'],
    ['--brand-on-dark sur feuille sombre', p['brand-on-dark'], '#1C1C1E'],
  ];
}

function check(palette = readPalette()) {
  return pairs(palette).map(([label, fg, bg]) => ({ label, fg, bg, ratio: contrast(fg, bg), ok: contrast(fg, bg) >= MIN }));
}

if (require.main === module) {
  const results = check();
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.label} : ${r.ratio.toFixed(2)}:1 (${r.fg} / ${r.bg})`);
  if (results.some((r) => !r.ok)) process.exit(1);
}

module.exports = { MIN, readPalette, luminance, contrast, check };
