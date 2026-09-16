/**
 * Static checks on the generated course.
 *
 * The course is GENERATED from a builder table, so a tuning change can quietly
 * produce a hole nobody meant to be there or a step no player could make. This
 * walks the same arrays the renderer and the server read and fails loudly on:
 *
 *   - stages that overlap
 *   - unmarked holes in the run-up, the landings or the finish approach
 *   - gaps wider, or steps HIGHER, than one jump at that stage
 *   - hazards that sweep outside the corridor
 *   - a sinking row with no platform up at some point in its cycle
 *   - a stage that pokes through its own roof
 *   - the robot roster, the reward ladder and the hangar layout against the
 *     figures they are specified as
 *
 * THE ONE RULE EVERYTHING ELSE SERVES: there is no second airborne mechanic in
 * this game. A mech jumps and that is all it does, so every gap and every step
 * in the course has to be inside one ballistic arc at the level the stage
 * advertises. A course that fails that is not hard, it is impassable.
 *
 * Run with `npm run verify:course`. Requires `npm run build:shared` first.
 */
import {
  BALLISTIC_REACH,
  BALLISTIC_RISE,
  ROBOTS,
  COURSE,
  COURSE_HAZARDS,
  COURSE_SOLIDS,
  DISPLAYED_ROBOTS,
  MOUNT_HEIGHT,
  MOVEMENT,
  QUICKSAND,
  SINKING_SOLIDS,
  SPAWN_POSITION,
  STAGES,
  STAND_ROW,
  SURFACE_REGIONS,
  TRAINING,
  TREADMILL_COUNT,
  RUINS_ARENA,
  TREADMILL_BELT_Y,
  WIDE_AREAS,
  WIN_PAD,
  ballisticFor,
  robotForSlot,
  corridorHalfWidthAt,
  hazardReachX,
  standDeckY,
  standX,
  standZ,
  totalSpeedToReach,
  resolveMovementProfile,
  sinkingOffsetAt,
  treadmillAt,
  treadmillX,
  treadmillZ,
} from '../shared/dist/index.js';

let failures = 0;

const fail = (message) => {
  failures += 1;
  console.error(`  FAIL  ${message}`);
};

const pass = (message) => console.log(`  ok    ${message}`);

/**
 * Is this a solid a player could ever stand on?
 *
 * Everything except the roof. Used by every span and coverage check below, so
 * a ceiling cannot stand in for the floor it hangs over.
 */
const walkable = (solid) => solid.kind !== 'ceiling';

/**
 * Merge the Z spans that have SOME walkable surface anywhere in the corridor.
 *
 * Deliberately width- AND height-agnostic. A catwalk leaves the centre line
 * empty for twenty-four units but is not a jump, and half the later stages run
 * well above the floor - a test that insisted on floor level reports both as
 * unclearable holes. What actually matters is whether there is anything to
 * land on at all.
 */
const walkableSpans = () => {
  // Sinking platforms count. They are floor for most of every cycle - three
  // whole stages are made of nothing else - and leaving them out reports those
  // stages as one enormous hole no player could cross.
  //
  // CEILINGS do not. A roof spans its whole stage, so counting it would merge
  // every gap in that stage into one continuous span and this check would
  // silently stop checking anything at all.
  const spans = [...COURSE_SOLIDS.filter(walkable), ...SINKING_SOLIDS]
    .map((solid) => [solid.minZ, solid.maxZ])
    .sort((a, b) => a[0] - b[0]);

  const merged = [];
  for (const [from, to] of spans) {
    const last = merged[merged.length - 1];
    if (last && from <= last[1] + 1e-6) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
};

/** Z ranges where floor exists but not on the centre line - a catwalk. */
const narrowCrossings = () => {
  const centre = [...COURSE_SOLIDS.filter(walkable), ...SINKING_SOLIDS].filter(
    (s) => s.minX <= 0 && s.maxX >= 0,
  );
  const covered = (z) => centre.some((s) => z >= s.minZ && z <= s.maxZ);
  const found = [];
  let open = null;
  for (const [from, to] of walkableSpans()) {
    for (let z = from; z <= to; z += 1) {
      if (!covered(z)) {
        if (!open) open = [z, z];
        else open[1] = z;
      } else if (open) {
        found.push(open);
        open = null;
      }
    }
    if (open) {
      found.push(open);
      open = null;
    }
  }
  return found;
};

/**
 * What a player at a given stage can do in ONE JUMP.
 *
 * Evaluated through `ballisticFor` with the stage's own advertised level and
 * robot - the same function and the same inputs the course builder authored
 * its gaps and climbs with - so this check cannot drift from the thing it is
 * checking. No trail is assumed: a stage has to be clearable by somebody who
 * has bought none.
 */
const ballisticAtStage = (stage) => {
  const robot = robotForSlot(stage.recommendedRobot);
  const profile = resolveMovementProfile(
    stage.recommendedLevel,
    0,
    robot.moveBonus,
    robot.jumpBonus,
  );
  return ballisticFor(profile.moveSpeed, profile.jumpVelocity);
};

/**
 * The arc a LAUNCH PAD produces, if one sits on the platform before this gap.
 *
 * A pad sets vertical velocity outright, so its arc is `ballisticFor` with the
 * pad's own boost instead of the player's jump - which is exactly why the
 * launch bay can author steps no leap could make. Returns null when the
 * crossing has no pad behind it, so the ordinary rule applies.
 */
const padArcBefore = (stage, gapStart) => {
  const pad = SURFACE_REGIONS.find(
    (region) =>
      region.boost > 0 &&
      region.maxZ <= gapStart + 0.5 &&
      region.maxZ >= gapStart - 14,
  );
  if (!pad) return null;
  const robot = robotForSlot(stage.recommendedRobot);
  const profile = resolveMovementProfile(
    stage.recommendedLevel,
    0,
    robot.moveBonus,
    robot.jumpBonus,
  );
  return ballisticFor(profile.moveSpeed, pad.boost);
};

/** Every surface top at a given Z, deduplicated and sorted low to high. */
const topsAt = (z) => {
  const tops = new Set();
  for (const solid of [...COURSE_SOLIDS, ...SINKING_SOLIDS]) {
    if (z < solid.minZ - 0.01 || z > solid.maxZ + 0.01) continue;
    // Pads sit ON floor that is already counted, and a roof is not a landing.
    if (solid.kind === 'winPad' || solid.kind === 'returnPad') continue;
    if (solid.kind === 'ceiling') continue;
    tops.add(Math.round(solid.maxY * 100) / 100);
  }
  return [...tops].sort((a, b) => a - b);
};

/**
 * The STEP a crossing actually asks for.
 *
 * Not "highest far surface minus highest near surface", which was the obvious
 * definition and the wrong one: a stage with a support column in it has a
 * surface two hundred units up at every Z the column occupies, and measuring
 * against that reports every gap beside it as an impossible climb.
 *
 * A player does not aim at the highest thing on the far side. They aim at the
 * EASIEST landing - and they jump from whatever they happen to be standing on
 * below it. So for each candidate landing, the best take-off is the highest
 * near surface not above it, and the step is the smallest such difference
 * across every landing on offer. A crossing is impossible only when even the
 * easiest pairing is out of reach, which is exactly the question worth asking.
 *
 * Returns 0 when either side has nothing to measure - open air on one side is
 * a hole, and the width check is what catches those.
 */
const stepAcross = (gapStart, gapEnd) => {
  const near = topsAt(gapStart - 0.5);
  const far = topsAt(gapEnd + 0.5);
  if (near.length === 0 || far.length === 0) return 0;

  let best = Infinity;
  for (const landing of far) {
    let from = null;
    for (const takeoff of near) {
      if (takeoff <= landing + 0.01) from = takeoff;
    }
    // Nothing to jump from that is not already above this landing: dropping
    // onto it is free, so it costs nothing to reach.
    if (from === null) return 0;
    best = Math.min(best, landing - from);
  }
  return best === Infinity ? 0 : best;
};

console.log('stages');
let previousEnd = -Infinity;
for (const stage of STAGES) {
  if (stage.startZ < previousEnd - 1e-6) {
    fail(`stage ${stage.index} starts at ${stage.startZ} inside stage ${stage.index - 1}`);
  }
  previousEnd = stage.endZ;
}
if (failures === 0) pass(`${STAGES.length} stages, none overlapping`);

console.log('floor coverage');
const spans = walkableSpans();
if (spans.length === 0) {
  fail('no walkable floor at all');
} else {
  const first = spans[0];
  if (first[0] > COURSE.lobbyStartZ + 1e-6) {
    fail(
      `course does not start at the hangar back wall (${first[0]} vs ${COURSE.lobbyStartZ})`,
    );
  } else {
    pass(`floor begins at the hangar back wall (${first[0]})`);
  }

  /*
   * EVERY CROSSING MUST BE INSIDE ONE JUMP at the level its stage advertises.
   *
   * Both halves of the arc are checked, and they fail for different reasons:
   *
   *  - WIDTH past `reach` is a gap the player lands short of, every time,
   *    however well they aim.
   *  - A STEP past `rise` is worse, because no amount of speed helps: jump
   *    height is deliberately tuned to barely scale with the movement
   *    multiplier (see `resolveMovementProfile`), so a platform above the arc
   *    is above it at level 1 and at level 500 alike. That is the property the
   *    whole difficulty curve rests on and the one this script exists to
   *    protect.
   *
   * Both are measured at 92% of the real figure, so a stage authored exactly
   * at the limit still leaves the player somewhere to land rather than
   * demanding a frame-perfect launch.
   *
   * A LAUNCH PAD on the platform before the gap substitutes its own arc, which
   * is the one sanctioned way a stage may ask for more than a leap.
   */
  const MARGIN = 0.92;
  let worstWidth = null;
  let worstStep = null;
  for (let i = 0; i < spans.length - 1; i += 1) {
    const gapStart = spans[i][1];
    const gapEnd = spans[i + 1][0];
    const width = gapEnd - gapStart;
    const stage = STAGES.find((s) => gapStart >= s.startZ && gapStart <= s.endZ);
    if (!stage) continue;

    const arc = padArcBefore(stage, gapStart) ?? ballisticAtStage(stage);

    // The step up onto the far side. Negative is a drop, which is free.
    const step = stepAcross(gapStart, gapEnd);

    if (width > arc.reach * MARGIN) {
      fail(
        `gap of ${width.toFixed(1)} at z=${gapStart.toFixed(0)} ` +
          `(stage ${stage.index}) is past a ${arc.reach.toFixed(0)}-unit jump`,
      );
    }
    if (step > arc.rise * MARGIN) {
      fail(
        `step of ${step.toFixed(1)} at z=${gapStart.toFixed(0)} ` +
          `(stage ${stage.index}) is past a ${arc.rise.toFixed(1)}-unit jump`,
      );
    }

    if (!worstWidth || width / arc.reach > worstWidth.ratio) {
      worstWidth = { width, ratio: width / arc.reach, at: gapStart, stage: stage.index };
    }
    if (!worstStep || step / arc.rise > worstStep.ratio) {
      worstStep = { step, ratio: step / arc.rise, at: gapStart, stage: stage.index };
    }
  }
  if (worstWidth && worstStep) {
    pass(
      `${spans.length - 1} crossings; widest is ` +
        `${(worstWidth.ratio * 100).toFixed(0)}% of a jump (stage ${worstWidth.stage}), ` +
        `tallest step is ${(worstStep.ratio * 100).toFixed(0)}% (stage ${worstStep.stage})`,
    );
    pass(
      `a base jump reaches ${BALLISTIC_REACH.toFixed(1)} and rises ` +
        `${BALLISTIC_RISE.toFixed(1)}`,
    );
  }
}

const crossings = narrowCrossings();
pass(`${crossings.length} narrow crossings (catwalks), floor present but off-centre`);

console.log('win and return pads');
{
  let broken = 0;
  for (const stage of STAGES) {
    for (const [kind, padX, padZ, side] of [
      ['winPad', stage.winPadX, stage.winPadZ, 'left'],
      ['returnPad', stage.returnPadX, stage.returnPadZ, 'right'],
    ]) {
      const pad = COURSE_SOLIDS.find(
        (solid) => solid.kind === kind && solid.stage === stage.index - 1,
      );
      if (!pad) {
        broken += 1;
        fail(`stage ${stage.index} has no ${kind} solid`);
        continue;
      }
      if (Math.abs((pad.minZ + pad.maxZ) / 2 - padZ) > 0.01) {
        broken += 1;
        fail(`stage ${stage.index} ${kind} geometry and its Z disagree`);
      }
      // LEFT is POSITIVE X in this game - see the note in the course builder.
      // A pad on the wrong side puts the reward where the exit should be.
      if (side === 'left' && padX <= 0) {
        broken += 1;
        fail(`stage ${stage.index} win pad is not on the player's left`);
      }
      if (side === 'right' && padX >= 0) {
        broken += 1;
        fail(`stage ${stage.index} return pad is not on the player's right`);
      }
      if (Math.abs(padX) + WIN_PAD.width / 2 > COURSE.halfWidth + 0.01) {
        broken += 1;
        fail(`stage ${stage.index} ${kind} pokes through the wall`);
      }
      // And it has to be reachable: solid floor under it.
      const floor = COURSE_SOLIDS.some(
        (s) =>
          walkable(s) &&
          s.kind !== 'winPad' &&
          s.kind !== 'returnPad' &&
          s.maxY <= COURSE.floorY + 0.2 &&
          padX >= s.minX &&
          padX <= s.maxX &&
          padZ >= s.minZ &&
          padZ <= s.maxZ,
      );
      if (!floor) {
        broken += 1;
        fail(`stage ${stage.index} ${kind} has no floor under it`);
      }
    }
  }
  if (broken === 0) {
    pass(`${STAGES.length} win pads (left) and ${STAGES.length} return pads (right)`);
  }
}

console.log('stage rewards');
{
  /*
   * Stage 1 pays 5 and stage 2 pays 3, exactly as specified.
   *
   * That is the ONE step down in the whole ladder and it is deliberate: the
   * first clear is a welcome bonus, fat enough to put a new player straight
   * onto the second mech. Checked as literals rather than read from the table
   * they come from, because a test that read `STAGE_REWARDS` would pass
   * whatever that table said - which is the one thing it must not do.
   */
  const EXPECTED_HEAD = [5, 3, 8, 15, 25, 40, 60, 90];
  let broken = 0;
  for (let i = 0; i < Math.min(STAGES.length, EXPECTED_HEAD.length); i += 1) {
    if (STAGES[i].winReward !== EXPECTED_HEAD[i]) {
      broken += 1;
      fail(`stage ${STAGES[i].index} pays ${STAGES[i].winReward}, expected ${EXPECTED_HEAD[i]}`);
    }
  }
  if (broken === 0) pass(`the head of the ladder is ${EXPECTED_HEAD.join(', ')}`);

  // From stage 2 onward the curve only climbs. A later stage worth fewer Wins
  // than an earlier one would make the ladder something to farm backwards.
  let regressions = 0;
  for (let i = 2; i < STAGES.length; i += 1) {
    if (STAGES[i].winReward <= STAGES[i - 1].winReward) {
      regressions += 1;
      fail(
        `stage ${STAGES[i].index} pays ${STAGES[i].winReward}, ` +
          `no more than stage ${STAGES[i - 1].index}`,
      );
    }
  }
  if (regressions === 0) {
    pass(
      `rewards climb from stage 2 to ${STAGES[STAGES.length - 1].winReward} ` +
        `at stage ${STAGES.length}`,
    );
  }
}

console.log('respawn');
{
  /*
   * There is ONE place a player can arrive, and no stage may carry another.
   *
   * There is no checkpoint system: dying anywhere returns the player to the
   * hangar. This checks the SHAPE of that rather than the behaviour - a stage
   * that carried a respawn Z would be the first step back toward per-stage
   * respawns, and it would be caught here long before anyone noticed it in
   * play.
   */
  const strays = STAGES.filter((stage) =>
    Object.keys(stage).some((key) => /checkpoint|respawn/i.test(key)),
  );
  if (strays.length > 0) {
    fail(`${strays.length} stage(s) carry their own respawn point`);
  } else if (SPAWN_POSITION.z > COURSE.lobbyEndZ || SPAWN_POSITION.z < COURSE.lobbyStartZ) {
    fail(`the spawn at z=${SPAWN_POSITION.z} is not inside the hangar`);
  } else {
    pass(`one spawn, at z=${SPAWN_POSITION.z}, and no stage defines another`);
  }
}

console.log('difficulty ladder');
{
  /*
   * The recommended level has to climb, and it has to be REACHABLE.
   *
   * The cap is 50 before any rebirth and 25 more per rebirth after, so a stage
   * recommending level 168 is asking for five of them. That is a legitimate
   * ask at the end of a thirty-stage ladder and an absurd one in the middle,
   * which is why this prints the rebirths each stage implies rather than
   * merely checking the numbers go up.
   */
  let broken = 0;
  for (let i = 1; i < STAGES.length; i += 1) {
    if (STAGES[i].recommendedLevel <= STAGES[i - 1].recommendedLevel) {
      broken += 1;
      fail(`stage ${STAGES[i].index} recommends no more level than stage ${STAGES[i].index - 1}`);
    }
    if (STAGES[i].recommendedRobot < STAGES[i - 1].recommendedRobot) {
      broken += 1;
      fail(`stage ${STAGES[i].index} recommends an EARLIER mech than stage ${STAGES[i].index - 1}`);
    }
  }

  // The advertised Speed must be the Speed that level actually costs, or the
  // gate is telling the player two different things.
  for (const stage of STAGES) {
    const owed = totalSpeedToReach(stage.recommendedLevel);
    if (Math.abs(stage.recommendedSpeed - owed) > 1) {
      broken += 1;
      fail(
        `stage ${stage.index} advertises ${stage.recommendedSpeed} Speed for ` +
          `level ${stage.recommendedLevel}, which actually costs ${owed}`,
      );
    }
    if (robotForSlot(stage.recommendedRobot).slot !== stage.recommendedRobot) {
      broken += 1;
      fail(`stage ${stage.index} recommends mech slot ${stage.recommendedRobot}, which does not exist`);
    }
  }

  const last = STAGES[STAGES.length - 1];
  // Cap is 50, then +25 a rebirth.
  const rebirthsNeeded = Math.max(0, Math.ceil((last.recommendedLevel - 50) / 25));
  if (broken === 0) {
    pass(
      `levels ${STAGES[0].recommendedLevel}-${last.recommendedLevel} rising every stage, ` +
        `the last needing ${rebirthsNeeded} rebirth(s)`,
    );
  }
}

console.log('robots');
{
  /*
   * The roster, checked against the ladder it is specified as.
   *
   * Twelve entries, the exact Wins prices and the exact Speed rates. Literals
   * rather than a read of the table they come from, for the same reason the
   * rewards are: a test that sourced its expectations from the thing under
   * test would pass anything.
   */
  const EXPECTED = [
    { wins: 0, speed: 1 },
    { wins: 3, speed: 2 },
    { wins: 15, speed: 5 },
    { wins: 100, speed: 25 },
    { wins: 500, speed: 50 },
    { wins: 1000, speed: 75 },
    { wins: 2000, speed: 100 },
    { wins: 10000, speed: 250 },
    { wins: 25000, speed: 500 },
    { wins: 35000, speed: 750 },
    { wins: 50000, speed: 1000 },
    { wins: 100000, speed: 2000 },
  ];

  if (ROBOTS.length !== EXPECTED.length) {
    fail(`${ROBOTS.length} robots, expected ${EXPECTED.length}`);
  }
  let broken = 0;
  for (let i = 0; i < Math.min(ROBOTS.length, EXPECTED.length); i += 1) {
    const robot = ROBOTS[i];
    const want = EXPECTED[i];
    if (robot.slot !== i + 1) {
      broken += 1;
      fail(`robot ${i + 1} sits in slot ${robot.slot}`);
    }
    if (robot.winsRequired !== want.wins) {
      broken += 1;
      fail(`${robot.name} costs ${robot.winsRequired} Wins, expected ${want.wins}`);
    }
    if (robot.speedPerSecond !== want.speed) {
      broken += 1;
      fail(`${robot.name} gives +${robot.speedPerSecond} Speed, expected +${want.speed}`);
    }
  }
  for (let i = 1; i < ROBOTS.length; i += 1) {
    if (ROBOTS[i].speedPerSecond <= ROBOTS[i - 1].speedPerSecond) {
      broken += 1;
      fail(`${ROBOTS[i].name} earns no faster than ${ROBOTS[i - 1].name}`);
    }
    if (ROBOTS[i].moveBonus < ROBOTS[i - 1].moveBonus) {
      broken += 1;
      fail(`${ROBOTS[i].name} moves SLOWER than ${ROBOTS[i - 1].name}`);
    }
    if (ROBOTS[i].winsRequired <= ROBOTS[i - 1].winsRequired) {
      broken += 1;
      fail(`${ROBOTS[i].name} costs no more than ${ROBOTS[i - 1].name}`);
    }
  }

  // The owned-robot mask is a uint32, so a slot past 31 would be `1 << 31` -
  // negative in JavaScript, and silently wrong rather than an error.
  for (const robot of ROBOTS) {
    if (robot.slot > 31) {
      broken += 1;
      fail(`${robot.name} is in slot ${robot.slot}, past what the owned mask can hold`);
    }
  }

  if (broken === 0) {
    pass(
      `${ROBOTS.length} mechs, +${ROBOTS[0].speedPerSecond}/s to ` +
        `+${ROBOTS[ROBOTS.length - 1].speedPerSecond}/s, prices strictly increasing`,
    );
  }
}

console.log('the display deck');
{
  /*
   * TWO STOREYS OF FIVE, and every plinth has to be a real, distinct place.
   *
   * The deck is what the mech shop IS, so the things worth checking are that
   * the ten plinths exist as solids, that no two overlap, and that the two
   * storeys really are at different heights - a "two-storey" deck whose rows
   * shared a Y would be a very confusing single row.
   */
  const plinths = COURSE_SOLIDS.filter((s) => s.kind === 'stand');
  if (plinths.length !== DISPLAYED_ROBOTS) {
    fail(`${plinths.length} plinths, expected ${DISPLAYED_ROBOTS}`);
  } else {
    pass(`${DISPLAYED_ROBOTS} plinths, ${STAND_ROW.perDeck} to a storey`);
  }

  let broken = 0;
  for (let a = 1; a <= DISPLAYED_ROBOTS; a += 1) {
    for (let b = a + 1; b <= DISPLAYED_ROBOTS; b += 1) {
      const sameX = Math.abs(standX(a) - standX(b)) < STAND_ROW.width;
      const sameZ = Math.abs(standZ(a) - standZ(b)) < STAND_ROW.length;
      const sameY = Math.abs(standDeckY(a) - standDeckY(b)) < 1;
      if (sameX && sameZ && sameY) {
        broken += 1;
        fail(`plinths ${a} and ${b} occupy the same place`);
      }
    }
  }
  // Two claim squares must not overlap either, or walking onto one would ask
  // for the other.
  for (let a = 1; a <= DISPLAYED_ROBOTS; a += 1) {
    for (let b = a + 1; b <= DISPLAYED_ROBOTS; b += 1) {
      if (Math.abs(standX(a) - standX(b)) > STAND_ROW.claimRadius * 2) continue;
      if (Math.abs(standZ(a) - standZ(b)) > STAND_ROW.claimRadius * 2) continue;
      if (Math.abs(standDeckY(a) - standDeckY(b)) > 5) continue;
      broken += 1;
      fail(`the claim squares of plinths ${a} and ${b} overlap`);
    }
  }

  const lowerY = standDeckY(1);
  const upperY = standDeckY(DISPLAYED_ROBOTS);
  if (upperY - lowerY < MOUNT_HEIGHT * 0.5) {
    broken += 1;
    fail(`the two storeys are only ${(upperY - lowerY).toFixed(1)} apart`);
  }

  /*
   * TWO stairways, one at each end of the gallery, and every riser on both has
   * to be walkable - a tall box is a wall, because the simulation steps over a
   * kerb and not over a storey.
   *
   * Checked as two separate flights rather than as a pile of steps: a single
   * combined list would pass even if one staircase were missing half its
   * risers, which is exactly the failure worth catching.
   */
  let risers = 0;
  for (const centreZ of [STAND_ROW.stairBackZ, STAND_ROW.stairFrontZ]) {
    const flight = COURSE_SOLIDS.filter(
      (s) =>
        s.kind === 'training' &&
        s.minX >= STAND_ROW.stairMinX - 0.01 &&
        s.maxX <= STAND_ROW.stairMaxX + 0.01 &&
        Math.abs((s.minZ + s.maxZ) / 2 - centreZ) < 0.01,
    ).sort((a, b) => a.minX - b.minX);

    if (flight.length === 0) {
      broken += 1;
      fail(`there is no stair to the upper deck at z=${centreZ}`);
      continue;
    }

    let previous = COURSE.floorY;
    for (const step of flight) {
      if (step.maxY - previous > MOVEMENT.stepHeight + 1e-6) {
        broken += 1;
        fail(
          `a stair riser of ${(step.maxY - previous).toFixed(2)} at z=${centreZ} ` +
            `is past the ${MOVEMENT.stepHeight} step height`,
        );
        break;
      }
      previous = step.maxY;
    }
    if (Math.abs(previous - STAND_ROW.upperY) > 0.05) {
      broken += 1;
      fail(
        `the stair at z=${centreZ} tops out at ${previous.toFixed(2)}, ` +
          `not the deck at ${STAND_ROW.upperY}`,
      );
    }

    /*
     * AND THE TOP STEP HAS TO ARRIVE ON THE DECK.
     *
     * Reaching the right HEIGHT is not the same as reaching the floor: a
     * flight that tops out beside the gallery leaves the player standing on
     * the last step with nothing in front of them, which is exactly what
     * happened when the deck was authored to the bay row and the stairs were
     * placed outside it. So the landing is checked against a real deck solid
     * that overlaps it in Z and begins where the stair ends in X.
     */
    const landing = flight[flight.length - 1];
    const deck = COURSE_SOLIDS.find(
      (s) =>
        s.kind === 'training' &&
        Math.abs(s.maxY - STAND_ROW.upperY) < 0.01 &&
        s.minX <= landing.maxX + 0.01 &&
        s.maxX > landing.maxX + 0.5 &&
        s.minZ <= landing.minZ + 0.01 &&
        s.maxZ >= landing.maxZ - 0.01,
    );
    if (!deck) {
      broken += 1;
      fail(`the stair at z=${centreZ} does not land on the upper deck`);
    }
    risers += flight.length;
  }

  if (broken === 0) {
    pass(
      `lower deck at y=${lowerY}, upper at y=${upperY}, reached by two ` +
        `stairways of ${risers / 2} walkable risers each`,
    );
  }

  // Slots past the deck exist and are reachable only through the panel. That
  // is by design; what must not happen is a plinth quietly appearing for one.
  const panelOnly = ROBOTS.filter((r) => r.slot > DISPLAYED_ROBOTS);
  pass(`${panelOnly.length} mech(s) sold from the panel only: ${panelOnly.map((r) => r.name).join(', ')}`);
}

console.log('hazards');
for (const hazard of COURSE_HAZARDS) {
  if (hazard.kind === 'roller') {
    // A roller runs down a lane; it must stay inside the corridor for its
    // whole travel, and its lane must actually have length.
    if (hazard.fromZ <= hazard.toZ) fail(`roller at x=${hazard.x} has no lane`);
    if (Math.abs(hazard.x) + hazard.radius > COURSE.halfWidth + 0.5) {
      fail(`roller lane at x=${hazard.x} is outside the corridor`);
    }
    continue;
  }
  // Sweeper, spinner and tornado all reach `|x| + sweep + radius` at the far
  // side of their travel - a sweep and an orbit have the same extreme. What
  // they must fit inside is the corridor AT THEIR OWN Z, not the nominal
  // width: several of the later stages are arenas, and checking them against
  // 32 would condemn every arm correctly built for a wider room.
  const wall = corridorHalfWidthAt(hazard.z);
  const reach = hazardReachX(hazard);
  if (reach > wall + 0.5) {
    fail(
      `${hazard.kind} at z=${hazard.z.toFixed(0)} reaches ${reach.toFixed(1)}, ` +
        `past the ${wall} wall`,
    );
  }
}
pass(`${COURSE_HAZARDS.length} hazards, all inside the corridor`);

console.log('launch pads');
{
  /*
   * A pad has to throw the mech HIGHER than its own legs can.
   *
   * A pad that produced less lift than a jump would be a decal: the player
   * would walk over it, press space anyway, and the whole stage built around
   * it would be a normal stage with a light on the floor.
   */
  const pads = SURFACE_REGIONS.filter((region) => region.boost > 0);
  if (pads.length === 0) {
    pass('no launch pads');
  } else {
    let broken = 0;
    for (const pad of pads) {
      if (pad.boost <= MOVEMENT.jumpVelocity) {
        broken += 1;
        fail(`a launch pad boosts to ${pad.boost}, no more than a base jump`);
      }
    }
    if (broken === 0) {
      pass(`${pads.length} launch pads, all above a base jump of ${MOVEMENT.jumpVelocity}`);
    }
  }
}

console.log('sinking platforms');
{
  /*
   * Every row must be crossable AT EVERY MOMENT.
   *
   * The naive rule is "each row keeps one fixed platform", which is how some
   * rows are built but not how the pulse tiles are: there, every tile sinks
   * and the phases are spaced so a connected set is always up. A rule that
   * only knew about fixed platforms would call that unplayable while it is in
   * fact the whole design.
   *
   * So the check is the real question instead of a proxy for it: sample the
   * cycle and require that something in the row is standable at every sampled
   * instant.
   */
  const rows = new Map();
  const rowKey = (z) => Math.round(z / 4) * 4;

  for (const solid of COURSE_SOLIDS) {
    if (!walkable(solid)) continue;
    const key = `${solid.stage}:${rowKey((solid.minZ + solid.maxZ) / 2)}`;
    if (!rows.has(key)) rows.set(key, { fixed: [], sinking: [] });
    rows.get(key).fixed.push(solid.maxY);
  }
  for (const platform of SINKING_SOLIDS) {
    const key = `${platform.stage}:${rowKey((platform.minZ + platform.maxZ) / 2)}`;
    if (!rows.has(key)) rows.set(key, { fixed: [], sinking: [] });
    rows.get(key).sinking.push(platform);
  }

  // How far a platform may have dropped and still be walked onto. The mech
  // steps up `stepHeight`, so a platform lower than that from its neighbours
  // is gone as far as the player is concerned.
  const STANDABLE = MOVEMENT.stepHeight;
  let unsafe = 0;
  let sampled = 0;
  let lifts = 0;
  for (const [key, row] of rows) {
    if (row.sinking.length === 0) continue;
    // A fixed platform rescues the row only if it is at the height the row is
    // crossed at - one twenty units below is a different part of the world.
    const crossingY = Math.max(...row.sinking.map((s) => s.maxY));
    if (row.fixed.some((top) => Math.abs(top - crossingY) <= 3)) continue;

    const cycle = Math.max(...row.sinking.map((s) => s.cycle));

    /*
     * A row of ONE is a LIFT or a BEAT, not a rank to cross.
     *
     * The "something is always up" rule is the right question for a rank of
     * platforms the player walks across - if they all sink together the rank
     * is impassable. It is the wrong question for a single platform that rises
     * to meet a ledge, or for one beat of a timed sequence: those are MEANT to
     * be gone most of the time, and being gone is what the player is timing
     * against.
     *
     * What matters for a single platform is that it is genuinely rideable -
     * that it spends a real share of its cycle standable rather than flashing
     * into existence for a frame. A quarter of the cycle is the floor.
     */
    const standable = (t) =>
      row.sinking.filter((s) => sinkingOffsetAt(s, t).drop <= STANDABLE).length;

    if (row.sinking.length === 1) {
      lifts += 1;
      let up = 0;
      for (let i = 0; i < 120; i += 1) {
        if (standable((cycle * i) / 120) > 0) up += 1;
      }
      if (up / 120 < 0.25) {
        unsafe += 1;
        fail(
          `single sinking platform at row ${key} is standable for only ` +
            `${((up / 120) * 100).toFixed(0)}% of its cycle`,
        );
      }
      continue;
    }

    sampled += 1;
    let worst = null;
    for (let i = 0; i < 120; i += 1) {
      const up = standable((cycle * i) / 120);
      if (worst === null || up < worst) worst = up;
    }
    if (worst === 0) {
      unsafe += 1;
      fail(`sinking row ${key} has no platform up at some point in its cycle`);
    }
  }
  if (unsafe === 0) {
    pass(
      `${sampled} rank(s) keep a platform up through the whole cycle; ` +
        `${lifts} single lift(s)/beat(s) are rideable`,
    );
  }

  // And a platform must actually come back.
  let stuck = 0;
  for (const platform of SINKING_SOLIDS) {
    let up = false;
    let down = false;
    for (let t = 0; t < platform.cycle; t += 0.1) {
      const { drop } = sinkingOffsetAt(platform, t);
      if (drop < 0.01) up = true;
      if (drop > platform.depth * 0.9) down = true;
    }
    if (!up || !down) {
      stuck += 1;
      fail(`a sinking platform never ${up ? 'sinks' : 'returns'}`);
      break;
    }
  }
  if (stuck === 0) pass(`${SINKING_SOLIDS.length} sinking platforms all sink and return`);
}

console.log('treadmills');
{
  // Three belts, and each must be detectable from its own centre.
  let found = 0;
  for (let i = 1; i <= TREADMILL_COUNT; i += 1) {
    if (treadmillAt(treadmillX(i), TREADMILL_BELT_Y, treadmillZ(i)) === i) found += 1;
  }
  if (found !== TREADMILL_COUNT) fail(`only ${found}/${TREADMILL_COUNT} belts detect`);
  else pass(`${TREADMILL_COUNT} belts, all detected from their own centres`);

  if (TREADMILL_COUNT !== 3) fail(`${TREADMILL_COUNT} treadmills, expected 3`);

  /*
   * THE BELTS ARE IDENTICAL, and a belt pays exactly what walking pays.
   *
   * This is the one place that claim is enforced rather than merely commented.
   * There is no tier table to check any more, so what is checked is the fact
   * the absence of one rests on: `beltSpeed` IS the base run speed, which is
   * what makes "distance from the belt" and "distance from the ground" the
   * same number through the same per-stride formula.
   */
  if (TRAINING.beltSpeed !== MOVEMENT.moveSpeed) {
    fail(
      `the belt runs at ${TRAINING.beltSpeed} and a mech runs at ` +
        `${MOVEMENT.moveSpeed}: a treadmill is not equivalent to walking`,
    );
  } else {
    pass(`belts run at ${TRAINING.beltSpeed}, exactly the base run speed`);
  }
  if ('tiers' in TRAINING) {
    fail('the treadmill bay has a tier table: the belts are meant to be identical');
  } else {
    pass('no tiers, no gates and no multipliers on any belt');
  }

  // Standing off the deck must detect nothing.
  if (treadmillAt(0, 0, 0) !== 0) fail('a belt is detected in the middle of the hangar');
  else pass('no belt is detected away from the treadmill bay');

  // The bay is on the player's RIGHT, which is NEGATIVE X, and the display
  // deck is on their LEFT. Getting these the wrong way round is the one
  // layout mistake nobody notices until a screenshot.
  if (TRAINING.maxX >= 0) fail('the treadmill bay is not on the right of the hangar');
  else if (STAND_ROW.x <= 0) fail('the display deck is not on the left of the hangar');
  else pass('mech bay on the left (+X), treadmills on the right (-X)');
}

console.log('wide areas');
{
  // The sentinel's hall has to be an ARENA, not another lane - comparable to
  // the hangar rather than to the corridor.
  const arenaHalf = RUINS_ARENA.halfWidth;
  if (arenaHalf < COURSE.lobbyHalfWidth * 0.7) {
    fail(`arena half-width ${arenaHalf} is not comparable to the ${COURSE.lobbyHalfWidth} hangar`);
  } else {
    pass(
      `sentinel bay is ${arenaHalf * 2} x ` +
        `${(RUINS_ARENA.maxZ - RUINS_ARENA.minZ).toFixed(0)}`,
    );
  }

  // Every wide area needs floor all the way to its own boundary, or the clamp
  // holds the player over open air.
  for (const area of WIDE_AREAS) {
    const midZ = (area.minZ + area.maxZ) / 2;
    const edge = area.halfWidth - 0.5;
    const covered = COURSE_SOLIDS.some(
      (s) =>
        walkable(s) && edge >= s.minX && edge <= s.maxX && midZ >= s.minZ && midZ <= s.maxZ,
    );
    /*
     * A wide area's edge must be somewhere the player can BE: either floor, or
     * a killing surface that was put there on purpose. Some stages are pits
     * from wall to wall by design, and being clamped into one of those is a
     * death the stage intends - what this rule exists to catch is a clamp
     * holding someone over nothing at all.
     */
    const drowned = QUICKSAND.some(
      (q) => edge >= q.minX && edge <= q.maxX && midZ >= q.minZ && midZ <= q.maxZ,
    );
    if (!covered && !drowned) {
      fail(`wide area at z=${midZ.toFixed(0)} has neither floor nor a pit at its edge`);
    }
    if (Math.abs(corridorHalfWidthAt(midZ) - area.halfWidth) > 0.01) {
      fail(`the boundary at z=${midZ.toFixed(0)} disagrees with its own width`);
    }
  }
  pass(`${WIDE_AREAS.length} wide areas, floored to their own boundary`);
}

console.log('the roof');
{
  /*
   * Every stage has one, and it clears everything under it.
   *
   * A stage that pokes through its own ceiling is a stage whose top platform
   * cannot be stood on, and it is the kind of bug that only shows up at the
   * top of a tower nobody reaches early.
   */
  let missing = 0;
  let pierced = 0;
  for (const stage of STAGES) {
    const index = stage.index - 1;
    // A stage may have TWO ceilings: its own roof, and - in the tunnel - a low
    // tube roof that is a mechanic. The stage's roof is the higher of them.
    const roofs = COURSE_SOLIDS.filter((s) => s.kind === 'ceiling' && s.stage === index);
    if (roofs.length === 0) {
      missing += 1;
      fail(`stage ${stage.index} has no roof`);
      continue;
    }
    const roof = roofs.reduce((high, s) => (s.minY > high.minY ? s : high), roofs[0]);
    const under = [...COURSE_SOLIDS, ...SINKING_SOLIDS].filter(
      (s) => s.stage === index && walkable(s),
    );
    const top = under.reduce((high, s) => Math.max(high, s.maxY), -Infinity);
    if (top > roof.minY) {
      pierced += 1;
      fail(
        `stage ${stage.index} reaches ${top.toFixed(0)}, through its own roof ` +
          `at ${roof.minY.toFixed(0)}`,
      );
    }
    // And the headroom has to fit a pilot standing on the highest platform.
    if (roof.minY - top < MOUNT_HEIGHT) {
      fail(`stage ${stage.index} has ${(roof.minY - top).toFixed(1)} of headroom`);
    }
  }
  if (missing === 0 && pierced === 0) {
    const roofs = COURSE_SOLIDS.filter((s) => s.kind === 'ceiling');
    const lowest = Math.min(...roofs.map((s) => s.minY));
    const highest = Math.max(...roofs.map((s) => s.minY));
    pass(
      `${roofs.length} roofs (the hangar's included), from ${lowest.toFixed(0)} ` +
        `to ${highest.toFixed(0)}, none pierced`,
    );
  }
}

console.log('corridor width');
{
  // Everything past the hangar runs at the corridor width unless a wide area
  // says otherwise, and obstacles are laid out as fractions of it.
  pass(`corridor is ${COURSE.halfWidth * 2} wide`);
  const strays = COURSE_SOLIDS.filter(
    // A ROOF is deliberately wider than the corridor: it has to meet the tops
    // of the walls rather than stop short and leave a slot down each side.
    (s) =>
      s.stage >= 0 &&
      walkable(s) &&
      (s.minX < -COURSE.halfWidth - 0.01 || s.maxX > COURSE.halfWidth + 0.01),
  ).filter((s) => {
    const midZ = (s.minZ + s.maxZ) / 2;
    return corridorHalfWidthAt(midZ) <= COURSE.halfWidth + 0.01;
  });
  if (strays.length > 0) fail(`${strays.length} stage solid(s) stick out past the corridor wall`);
  else pass('no stage geometry pokes through a wall');
}

console.log('');
if (failures > 0) {
  console.error(`${failures} problem(s) found`);
  process.exit(1);
}
console.log('course OK');
