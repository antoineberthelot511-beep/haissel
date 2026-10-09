/*
 * Vérifie la syntaxe (node --check) de tous les fichiers JS du projet.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIRECTORIES = ['src', 'scripts', 'frontend', 'tests'];

function listJsFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listJsFiles(fullPath);
    return entry.name.endsWith('.js') ? [fullPath] : [];
  });
}

const files = DIRECTORIES.flatMap((dir) => listJsFiles(path.join(ROOT, dir)));
let failures = 0;

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    failures += 1;
    console.error(`✗ ${path.relative(ROOT, file)}\n${error.stderr}`);
  }
}

console.log(`Syntaxe vérifiée : ${files.length - failures}/${files.length} fichiers OK.`);
process.exitCode = failures ? 1 : 0;
