/**
 * Sanity checks on the SUPPLIED assets.
 *
 * These are the only files in the project that were authored elsewhere, and
 * none of them may be modified: a silent change - a re-export, a re-encode, a
 * well-meaning "optimisation" - should produce a loud failure here rather than
 * a character that animates wrongly or a sound that no longer fits weeks
 * later.
 *
 * Everything else the game draws and every other noise it makes is generated
 * at runtime, which is why this list is short and why it stays short.
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * Known-good digests of the assets as supplied.
 *
 * `base_rig.fbx` is byte-identical to `player.fbx` on purpose; only
 * `player.fbx` is ever loaded, and the build prunes the other from `dist`.
 */
const EXPECTED = [
  { path: 'assets/player/player.fbx', md5: '4211d040bb7098791816ad92a0accaaa' },
  { path: 'assets/player/base_rig.fbx', md5: '4211d040bb7098791816ad92a0accaaa' },
  { path: 'assets/player/green.png', md5: '67421b6f13962ead111335ff50bf58fe' },
  // The four HUD icons. Used at their real aspect ratios and never
  // regenerated - `shoe.png` is the Speed icon and the only one whose subject
  // is not obvious from its name.
  { path: 'assets/ui/trophy.png', md5: 'e57cb95031c6a5feb6142eb05b53e7c1' },
  { path: 'assets/ui/rebirth.png', md5: '022dccdad65f256a546d2a14baf7512a' },
  { path: 'assets/ui/trail.png', md5: 'fb6c8242f2f61c64569c7cce49879652' },
  { path: 'assets/ui/shoe.png', md5: 'c5305c2301b18df2d2b4f5f57ccf5fb7' },
  // The four sounds. The track is the single largest file in the build, so a
  // change to it is also the fastest way to spend the 12 MB budget - check
  // `npm run size:client` after touching it.
  //
  // `robot steps.mp3` is nearly three seconds of a mech WALKING rather than
  // one footfall, which is why the audio layer loops it instead of firing it
  // per stride. The space in its name is part of the supplied file and is
  // percent-encoded at the point of use; do not rename it.
  { path: 'assets/audio/background.mp3', md5: 'ff13ed4af40fe632cdc257a4765524dd' },
  { path: 'assets/audio/jump.mp3', md5: '77c58db6921be7b0c7a61903d38bbf30' },
  { path: 'assets/audio/fall.mp3', md5: 'a6c361490b027a8effd0ac861936a5a7' },
  { path: 'assets/audio/robot steps.mp3', md5: '4023a023528e516573e1663921432c93' },
];

let failures = 0;

for (const asset of EXPECTED) {
  const full = new URL(asset.path, `file://${root.replace(/\\/g, '/')}`);
  let bytes;
  try {
    bytes = readFileSync(full);
  } catch {
    console.error(`  FAIL  ${asset.path} is missing`);
    failures += 1;
    continue;
  }
  const digest = createHash('md5').update(bytes).digest('hex');
  const size = statSync(full).size;
  if (digest !== asset.md5) {
    console.error(`  FAIL  ${asset.path} has changed (${digest})`);
    failures += 1;
  } else {
    console.log(`  ok    ${asset.path} (${size} bytes)`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} asset problem(s). The supplied FBX must never be modified.`);
  process.exit(1);
}
console.log('\nassets OK');
