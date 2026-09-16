/**
 * The hard end barrier, after the Level 30 finish.
 *
 * There is no wall object. The end of the world is a CLAMP on Z, applied in
 * `clampToBounds` after every substep has already integrated, and that is
 * deliberately stronger than a collider could be:
 *
 *   - it cannot be tunnelled, because it is applied to the RESULT of a move
 *     rather than tested against the path of one, so no speed outruns it;
 *   - it cannot be jumped, because it constrains Z and says nothing about Y -
 *     there is no top to clear;
 *   - it cannot be flanked, because it applies at every X;
 *   - it cannot be seen, because it is not geometry.
 *
 * This drives the real simulation at it from every direction and speed the
 * game can produce and asserts nothing ever gets past.
 */
import {
  COURSE,
  COURSE_END_Z,
  STAGES,
  WorldCollision,
  createMotion,
  resolveMovementProfile,
  stepPlayer,
} from '../shared/dist/index.js';

let failures = 0;
const fail = (m) => {
  failures += 1;
  console.log(`  FAIL  ${m}`);
};
const pass = (m) => console.log(`  ok    ${m}`);

const collision = new WorldCollision();
const last = STAGES[STAGES.length - 1];

console.log('hard end barrier');
console.log(`        finish pad z=${last.winPadZ.toFixed(0)}, barrier z=${COURSE_END_Z.toFixed(0)}`);

if (COURSE_END_Z <= last.winPadZ + 5) {
  fail(`the barrier is not clear of the finish pad (${COURSE_END_Z} vs ${last.winPadZ})`);
} else {
  pass(`the barrier is ${(COURSE_END_Z - last.winPadZ).toFixed(0)} units past the finish pad`);
}

/** Run flat out at the end of the world and report the furthest Z reached. */
const charge = (level, rebirths, offsetX, jump) => {
  const profile = resolveMovementProfile(level, rebirths, 1.6, 1.6, 1.5);
  const params = { moveMultiplier: profile.multiplier, jumpVelocity: profile.jumpVelocity };
  const motion = createMotion();
  motion.x = offsetX;
  motion.y = COURSE.floorY;
  motion.z = COURSE_END_Z - 90;

  let furthest = motion.z;
  for (let i = 0; i < 60 * 25; i += 1) {
    stepPlayer(
      motion,
      { moveX: 0, moveZ: 1, jump: jump && i % 40 === 0, sprint: true, cameraYaw: 0 },
      params,
      1 / 60,
      collision,
      {},
    );
    if (motion.z > furthest) furthest = motion.z;
  }
  return { furthest, speed: profile.moveSpeed };
};

let worst = -Infinity;
let fastest = 0;
for (const [level, rebirths] of [[1, 0], [60, 2], [160, 6], [400, 20]]) {
  for (const offsetX of [0, -31, 31]) {
    for (const jump of [false, true]) {
      const { furthest, speed } = charge(level, rebirths, offsetX, jump);
      fastest = Math.max(fastest, speed);
      worst = Math.max(worst, furthest);
      if (furthest > COURSE_END_Z + 1e-6) {
        fail(
          `level ${level}/${rebirths} rebirths at x=${offsetX}${jump ? ' jumping' : ''} ` +
            `reached z=${furthest.toFixed(2)}, past the barrier`,
        );
      }
    }
  }
}

if (failures === 0) {
  pass(`24 charges, up to ${fastest.toFixed(0)} u/s, none passed z=${COURSE_END_Z.toFixed(0)}`);
  pass(`furthest any of them reached: z=${worst.toFixed(2)}`);
}

// And the world really does end there - nothing is authored past it.
const beyond = STAGES.filter((s) => s.startZ > COURSE_END_Z);
if (beyond.length > 0) fail(`${beyond.length} stage(s) start past the barrier`);
else pass('no stage begins past the barrier');

console.log('');
console.log(failures === 0 ? 'barrier OK' : `${failures} problem(s) found`);
process.exit(failures === 0 ? 0 : 1);
