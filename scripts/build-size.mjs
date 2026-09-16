/**
 * Measure the browser build against the 12 MB budget.
 *
 * The budget is a hard constraint, so it is checked by a script rather than by
 * anyone remembering to look at the Vite output. Run after `npm run
 * build:client`.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../client/dist', import.meta.url));

/** Hard ceiling, in bytes. */
const BUDGET = 12 * 1024 * 1024;

const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push({ path: full.slice(dist.length + 1), size: statSync(full).size });
  }
  return out;
};

let files;
try {
  files = walk(dist);
} catch {
  console.error('client/dist not found - run `npm run build:client` first.');
  process.exit(1);
}

files.sort((a, b) => b.size - a.size);
const total = files.reduce((sum, f) => sum + f.size, 0);
const kb = (n) => `${(n / 1024).toFixed(1)} kB`;

for (const file of files) {
  console.log(`  ${kb(file.size).padStart(11)}  ${file.path.replace(/\\/g, '/')}`);
}

const percent = ((total / BUDGET) * 100).toFixed(1);
console.log(`\n  total ${(total / 1024 / 1024).toFixed(2)} MB of a 12 MB budget (${percent}%)`);

if (total > BUDGET) {
  console.error('  OVER BUDGET');
  process.exit(1);
}
