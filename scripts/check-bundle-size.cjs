const fs = require('node:fs');
const path = require('node:path');

const DIST_ASSETS_DIR = path.resolve('dist/assets');
const MAX_BUNDLE_KIB = 3000;

if (!fs.existsSync(DIST_ASSETS_DIR)) {
  console.error(`Bundle budget check failed: ${DIST_ASSETS_DIR} does not exist.`);
  process.exit(1);
}

// The build emits one modern bundle (no legacy variant); the largest script
// chunk is what the budget applies to.
const scripts = fs.readdirSync(DIST_ASSETS_DIR).filter((fileName) => /\.m?js$/.test(fileName));

if (scripts.length === 0) {
  console.error('Bundle budget check failed: no script chunks were generated in dist/assets.');
  process.exit(1);
}

const largest = scripts
  .map((fileName) => ({ fileName, sizeKiB: fs.statSync(path.join(DIST_ASSETS_DIR, fileName)).size / 1024 }))
  .sort((left, right) => right.sizeKiB - left.sizeKiB)[0];

console.log(`Bundle budget: ${largest.fileName} = ${largest.sizeKiB.toFixed(2)} KiB (limit ${MAX_BUNDLE_KIB} KiB)`);

if (largest.sizeKiB > MAX_BUNDLE_KIB) {
  console.error(`Bundle budget exceeded by ${(largest.sizeKiB - MAX_BUNDLE_KIB).toFixed(2)} KiB.`);
  process.exit(1);
}
