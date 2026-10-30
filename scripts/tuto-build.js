/*
 * npm run tuto:build : images du tuto d'installation iPhone.
 *
 * design/tuto-ios-v2/etape-N.webp (N = 1 à 5, téléphones détourés, fond
 * transparent, ours compris) → frontend/images/tuto-ios/etape-N.webp.
 *
 * Les 5 images n'ont pas toutes la même taille : chacune est centrée, sans
 * agrandissement, sur un canevas transparent commun (la plus grande largeur
 * et la plus grande hauteur). Même rapport pour toutes : la place réservée
 * dans la feuille ne change pas d'une étape à l'autre. Écrit aussi la taille
 * du canevas dans frontend/images/tuto-ios/size.json (lue par les tests ;
 * tuto-ios.js et app-v2.css reprennent ces valeurs).
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'design/tuto-ios-v2');
const OUT_DIR = path.join(ROOT, 'frontend/images/tuto-ios');
const STEPS = 5;

async function build() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const sources = [];
  for (let n = 1; n <= STEPS; n += 1) {
    const file = path.join(SOURCE_DIR, `etape-${n}.webp`);
    if (!fs.existsSync(file)) throw new Error(`Image manquante : design/tuto-ios-v2/etape-${n}.webp`);
    const { width, height } = await sharp(file).metadata();
    sources.push({ n, file, width, height });
  }
  const width = Math.max(...sources.map((s) => s.width));
  const height = Math.max(...sources.map((s) => s.height));
  for (const source of sources) {
    const left = Math.floor((width - source.width) / 2);
    const top = Math.floor((height - source.height) / 2);
    await sharp(source.file)
      .extend({ left, right: width - source.width - left, top, bottom: height - source.height - top, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: 85, alphaQuality: 100 })
      .toFile(path.join(OUT_DIR, `etape-${source.n}.webp`));
    console.log(`etape-${source.n}.webp : ${source.width}×${source.height} → ${width}×${height}`);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'size.json'), `${JSON.stringify({ width, height })}\n`);
}

build().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
