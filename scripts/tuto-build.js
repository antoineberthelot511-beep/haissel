/*
 * npm run tuto:build : images du tuto d'installation iPhone.
 *
 * - design/tuto-ios/etape-N.png (captures d'iPhone en portrait, N = 1 à 4)
 *   → frontend/images/tuto-ios/etape-N.webp (largeur 600 px, qualité 80) ;
 * - aucune capture encore : images provisoires neutres (SVG, numéro et
 *   légende de l'étape), pour que la feuille fonctionne dès maintenant ;
 * - écrit frontend/images/tuto-ios/steps.js : la liste des étapes
 *   disponibles, la seule que le carrousel affiche.
 * Les légendes viennent de frontend/tuto-ios.js (une seule source).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'design/tuto-ios');
const OUT_DIR = path.join(ROOT, 'frontend/images/tuto-ios');
const WIDTH = 600;
const HEIGHT = 1300;
const QUALITY = 80;

function captions() {
  const sandbox = {};
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'frontend/tuto-ios.js'), 'utf8'), sandbox);
  return sandbox.HaisselTuto.CAPTIONS;
}

const escapeXml = (text) => String(text).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

/** Image provisoire : cadre de téléphone neutre, numéro et légende. */
function placeholderSvg(number, caption) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img" aria-label="Étape ${number} : ${escapeXml(caption)}">
  <rect width="${WIDTH}" height="${HEIGHT}" rx="56" fill="#F1F3F8"/>
  <rect x="24" y="24" width="${WIDTH - 48}" height="${HEIGHT - 48}" rx="40" fill="#FFFFFF" stroke="#D5DAE5" stroke-width="4"/>
  <rect x="${WIDTH / 2 - 70}" y="52" width="140" height="28" rx="14" fill="#E4E8F0"/>
  <circle cx="${WIDTH / 2}" cy="520" r="96" fill="#EEF3FF"/>
  <text x="${WIDTH / 2}" y="560" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="112" font-weight="800" fill="#0B57FF">${number}</text>
  <text x="${WIDTH / 2}" y="740" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="38" font-weight="700" fill="#1A1B22">${escapeXml(caption)}</text>
  <text x="${WIDTH / 2}" y="800" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="28" fill="#565E74">Capture à venir</text>
</svg>
`;
}

async function build() {
  const list = captions();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const pngs = list.map((_, i) => path.join(SOURCE_DIR, `etape-${i + 1}.png`)).filter((file) => fs.existsSync(file));
  const files = {};

  if (pngs.length) {
    // eslint-disable-next-line global-require
    const sharp = require('sharp');
    for (let i = 0; i < list.length; i += 1) {
      const png = path.join(SOURCE_DIR, `etape-${i + 1}.png`);
      const svg = path.join(OUT_DIR, `etape-${i + 1}.svg`);
      if (fs.existsSync(svg)) fs.unlinkSync(svg);
      if (!fs.existsSync(png)) continue;
      const out = `etape-${i + 1}.webp`;
      await sharp(png).resize({ width: WIDTH, withoutEnlargement: true }).webp({ quality: QUALITY }).toFile(path.join(OUT_DIR, out));
      files[i + 1] = out;
      console.log(`✓ ${out}`);
    }
  } else {
    list.forEach((caption, i) => {
      const out = `etape-${i + 1}.svg`;
      fs.writeFileSync(path.join(OUT_DIR, out), placeholderSvg(i + 1, caption));
      files[i + 1] = out;
      console.log(`○ ${out} (provisoire : ajoute design/tuto-ios/etape-${i + 1}.png)`);
    });
  }

  fs.writeFileSync(path.join(OUT_DIR, 'steps.js'),
    `/* Généré par npm run tuto:build : étapes du tuto iPhone dont l'image existe. Ne pas modifier à la main. */\nwindow.HaisselTutoFiles = ${JSON.stringify(files)};\n`);
}

if (require.main === module) {
  build().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { build, placeholderSvg, captions };
