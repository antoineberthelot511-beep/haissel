/*
 * npm run tuto:build : images du tuto d'installation iPhone.
 *
 * design/tuto-ios-v2/etape-N.webp (N = 1 à 5, 572×1024, ours compris)
 *   → frontend/images/tuto-ios/etape-N.webp, copiées telles quelles (déjà
 *   optimisées) après contrôle de leur taille. Jamais agrandies.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'design/tuto-ios-v2');
const OUT_DIR = path.join(ROOT, 'frontend/images/tuto-ios');
const STEPS = 5;
const WIDTH = 572;
const HEIGHT = 1024;

async function build() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (let n = 1; n <= STEPS; n += 1) {
    const source = path.join(SOURCE_DIR, `etape-${n}.webp`);
    if (!fs.existsSync(source)) throw new Error(`Image manquante : design/tuto-ios-v2/etape-${n}.webp`);
    const { width, height } = await sharp(source).metadata();
    if (width !== WIDTH || height !== HEIGHT) {
      throw new Error(`etape-${n}.webp : ${width}×${height} au lieu de ${WIDTH}×${HEIGHT}`);
    }
    fs.copyFileSync(source, path.join(OUT_DIR, `etape-${n}.webp`));
    console.log(`etape-${n}.webp copiée (${width}×${height})`);
  }
}

build().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
