/**
 * Authority tests for the server's progression rules.
 *
 * These are the rules a cheating client would most like to break: awarding
 * itself a stage, banking the same stage twice, claiming a mech it has not
 * paid for, or being paid for movement it did not make. Each is exercised here
 * against the real services and the real simulation, including the REJECTION
 * paths - a test that only checks the happy path proves nothing about
 * authority.
 *
 * Run with `npm run verify:progression` (builds the server first).
 */
import {
  ROBOTS,
  MOVEMENT,
  SPEED,
  STAGES,
  STAND_ROW,
  TRAINING,
  TRAIL_TIERS,
  trailMask,
  robotForSlot,
  createMotion,
  createMovementInput,
  createSimEvents,
  maxLevelForRebirth,
  nextRebirthTier,
  rebirthMultiplier,
  resolveLevel,
  speedForNextLevel,
  totalSpeedToReach,
  resolveMovementProfile,
  standDeckY,
  standX,
  standZ,
  stepPlayer,
  WorldCollision,
} from '../shared/dist/index.js';
import { StageService } from '../server/dist/progression/StageService.js';
import { RobotService } from '../server/dist/progression/RobotService.js';
import { RebirthService } from '../server/dist/progression/RebirthService.js';
import { SpeedService } from '../server/dist/progression/SpeedService.js';
import { TrailService } from '../server/dist/progression/TrailService.js';
import { PlayerState } from '../server/dist/rooms/state/PlayerState.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = Object.is(actual, expected);
  if (!ok) {
    failures += 1;
    console.error(`  FAIL  ${label}: got ${actual}, expected ${expected}`);
  } else {
    console.log(`  ok    ${label}`);
  }
};

/** A fresh player, initialised exactly as the room does on join. */
const newPlayer = (speeds, robots) => {
  const player = new PlayerState();
  player.sessionId = 'test';
  robots.initialise(player);
  speeds.initialise(player);
  return player;
};

console.log('stage rewards');
{
  const speeds = new SpeedService();
  const robots = new RobotService();
  const stages = new StageService();
  const player = newPlayer(speeds, robots);
  stages.initialise('test');

  const stage = STAGES[0];

  // Nowhere near the pad. The server checks the position IT simulated.
  player.x = 0;
  player.y = 0;
  player.z = stage.winPadZ - 400;
  check('claim from far away is refused', stages.claim('test', player, stage.index).reason, 'not-on-pad');
  check('  wins unchanged', player.wins, 0);

  // Standing on the pad. It is a small rectangle at the LEFT of the stage
  // end, so X matters as much as Z.
  player.x = stage.winPadX;
  player.z = stage.winPadZ;
  const first = stages.claim('test', player, stage.index);
  check('claim on the pad is granted', first.granted, true);
  check('  wins credited', player.wins, stage.winReward);
  check('  best stage recorded', player.bestStage, stage.index);

  // Immediately again, from the same spot.
  const second = stages.claim('test', player, stage.index);
  check('immediate re-claim is refused', second.granted, false);

  // A stage that does not exist.
  check('unknown stage is refused', stages.claim('test', player, 999).reason, 'unknown-stage');

  // Banking a stage RETURNS the player to the arena, and running it again
  // pays again - that is how a player grinds for a better robot.
  await sleep(500);
  const third = stages.claim('test', player, stage.index);
  check('a second run of the same stage pays again', third.granted, true);
  check('  wins credited twice', player.wins, stage.winReward * 2);

  // Every configured reward, checked against the specification. Stage 1 pays a
  // single Win - a token for proving the loop works - and the ladder proper
  // starts at stage 2 and climbs from there without stepping down again.
  const expected = [1, 3, 8, 15, 25, 40, 60, 90];
  let rewardsOk = true;
  for (let i = 0; i < expected.length; i += 1) {
    if (STAGES[i].winReward !== expected[i]) rewardsOk = false;
  }
  check('stage rewards are 1/3/8/15/25/40/60/90', rewardsOk, true);
}

console.log('rebirth');
{
  const speeds = new SpeedService();
  const robots = new RobotService();
  const rebirths = new RebirthService();
  const player = newPlayer(speeds, robots);
  rebirths.sync(player);

  /*
   * THE LADDER, exactly as specified: 1x/50, 1.5x/75, 2x/100, then +0.5x and
   * +25 levels for ever.
   *
   * Checked as literals rather than read from `REBIRTH_TIERS`, because a test
   * that sourced its expectations from the table under test would pass
   * whatever that table happened to say.
   */
  check('rebirth 0 multiplier is x1', rebirthMultiplier(0), 1);
  check('rebirth 0 caps at level 50', maxLevelForRebirth(0), 50);
  check('rebirth 1 needs level 50', nextRebirthTier(0).requiredLevel, 50);
  check('rebirth 1 multiplier is x1.5', rebirthMultiplier(1), 1.5);
  check('rebirth 1 caps at level 75', maxLevelForRebirth(1), 75);
  check('rebirth 2 needs level 75', nextRebirthTier(1).requiredLevel, 75);
  check('rebirth 2 multiplier is x2', rebirthMultiplier(2), 2);
  check('rebirth 2 caps at level 100', maxLevelForRebirth(2), 100);
  // Past the authored table the pattern continues rather than stopping.
  check('rebirth 3 multiplier is x2.5', rebirthMultiplier(3), 2.5);
  check('rebirth 3 caps at level 125', maxLevelForRebirth(3), 125);

  check('level cap is the next rebirth requirement', player.maxLevel, 50);
  check('a level-1 player may not rebirth', rebirths.isEligible(player), false);
  check('  and the request is refused', rebirths.rebirth(player, speeds).ok, false);

  // Earn the cap. Wins and mechs must survive what follows.
  player.wins = 137;
  player.ownedRobots = 0b111;
  player.totalSpeed = 1e9;
  speeds.syncDerived(player);
  check('capped at level 50', player.level, 50);
  check('now eligible', rebirths.isEligible(player), true);

  const done = rebirths.rebirth(player, speeds);
  check('rebirth is granted', done.ok, true);
  check('  level reset to 1', player.level, 1);
  check('  Speed reset to 0', player.totalSpeed, 0);
  check('  rebirth count is 1', player.rebirths, 1);
  check('  cap raised to 75', player.maxLevel, 75);
  check('  Speed multiplier is x1.5', player.moveMultiplier, 1.5);
  check('  Wins survived', player.wins, 137);
  check('  mechs survived', player.ownedRobots, 0b111);
}

console.log('trails');
{
  const speeds = new SpeedService();
  const robots = new RobotService();
  const trails = new TrailService();
  const player = newPlayer(speeds, robots);
  trails.initialise(player);

  const first = TRAIL_TIERS[0];
  check('starts with no trail', player.trailSlot, 0);
  check('  and owns none', player.ownedTrails, 0);

  check('buying with no Wins is refused', trails.buy(player, first.slot, speeds).reason, 'too-poor');
  check('equipping an unowned trail is refused', trails.equip(player, first.slot, speeds).reason, 'not-owned');
  check('an unknown slot is refused', trails.buy(player, 999, speeds).reason, 'unknown-slot');

  /*
   * The FIVE tiers, exactly as specified, before anything is bought.
   *
   * Green 50/x1.5, Blue 150/x2, Yellow 500/x3, Red 2.5K/x4, Rainbow 10K/x5.
   */
  const WANT = [
    { name: 'Green Trail', cost: 50, multiplier: 1.5 },
    { name: 'Blue Trail', cost: 150, multiplier: 2 },
    { name: 'Yellow Trail', cost: 500, multiplier: 3 },
    { name: 'Red Trail', cost: 2500, multiplier: 4 },
    { name: 'Rainbow Trail', cost: 10000, multiplier: 5 },
  ];
  check('there are five trails', TRAIL_TIERS.length, WANT.length);
  let tiersOk = true;
  for (let i = 0; i < Math.min(TRAIL_TIERS.length, WANT.length); i += 1) {
    const tier = TRAIL_TIERS[i];
    const want = WANT[i];
    if (tier.name !== want.name) tiersOk = false;
    if (tier.cost !== want.cost) tiersOk = false;
    if (tier.multiplier !== want.multiplier) tiersOk = false;
  }
  check('  and they are green/blue/yellow/red/rainbow at 50-10K', tiersOk, true);

  player.wins = 20000;
  const bought = trails.buy(player, first.slot, speeds);
  check('buying with Wins is granted', bought.ok, true);
  check('  price deducted', player.wins, 20000 - first.cost);
  check('  equipped on purchase', player.trailSlot, first.slot);
  check('  movement multiplier rose', player.moveMultiplier > 1, true);

  await sleep(400);
  check('re-buying is refused', trails.buy(player, first.slot, speeds).reason, 'already-owned');

  check('taking it off is allowed', trails.equip(player, 0, speeds).ok, true);
  check('  multiplier back to base', player.moveMultiplier, 1);
}

console.log('speed is earned by WALKING FORWARD, and by nothing else');
{
  const speeds = new SpeedService();
  const robots = new RobotService();
  const player = newPlayer(speeds, robots);
  speeds.reset('test', player);

  /**
   * One second of play, as the server would credit it.
   *
   * @param forward was W held
   * @param move    units of ground actually covered in that second
   * @param belt    treadmill index, or 0 for the hangar floor
   */
  const farm = (forward, move, belt = 0, seconds = 1) => {
    player.treadmill = belt;
    const before = player.totalSpeed;
    const steps = Math.round(seconds * 60);
    for (let i = 0; i < steps; i += 1) {
      player.z += move / 60;
      speeds.credit('test', player, 1 / 60, forward);
    }
    return player.totalSpeed - before;
  };

  /*
   * STANDING STILL EARNS EXACTLY NOTHING.
   *
   * The first and most important assertion in this file. There is no automatic
   * tick, no passive income and no reward for existing: a player parked in the
   * hangar is not farming, however long they leave the game running.
   */
  check('standing still earns nothing', farm(false, 0), 0);
  check('  and holding W against a wall earns nothing', farm(true, 0), 0);
  check('  and a shove with no W earns nothing', farm(false, MOVEMENT.moveSpeed), 0);

  /*
   * WALKING FORWARD EARNS THE FIXED RATE.
   *
   * One second of travel is worth one second of the mech's rate. Not a stride
   * count, not a distance, not a roll - the same figure every time.
   */
  const rate = robotForSlot(player.robotSlot).speedPerSecond;
  const walked = farm(true, MOVEMENT.moveSpeed);
  check('walking forward earns the mech rate', Math.abs(walked - rate) < 1e-9, true);

  /*
   * AND IT IS DETERMINISTIC.
   *
   * The same conditions produce the same number, and moving FASTER does not
   * produce a bigger one: the rate is per second, not per unit travelled. This
   * is the property the whole system was rebuilt for.
   */
  const again = farm(true, MOVEMENT.moveSpeed);
  const slower = farm(true, MOVEMENT.moveSpeed * 0.5);
  const faster = farm(true, MOVEMENT.moveSpeed * 1.4);
  check('  the same second always pays the same', Math.abs(again - walked) < 1e-9, true);
  check('  covering more ground pays no more', Math.abs(faster - walked) < 1e-9, true);
  check('  covering less ground pays no less', Math.abs(slower - walked) < 1e-9, true);

  // A crawl below the moving threshold is standing still, not walking.
  check('  a crawl under the threshold pays nothing', farm(true, SPEED.movingSpeed * 0.5), 0);

  /*
   * IT ARRIVES IN WHOLE TICKS, and the tick is the mech's own figure.
   *
   * This is what the player actually sees: a +2 mech has to pay TWO in one go
   * so the popup over their head reads "+2", not a dribble of fractions that
   * happens to total two. Half a second of walking therefore pays NOTHING yet,
   * and the second half pays the lot.
   */
  const half = farm(true, MOVEMENT.moveSpeed, 0, 0.5);
  check('half a second of walking has not paid yet', half, 0);
  check('  and the next half second pays the whole tick', farm(true, MOVEMENT.moveSpeed, 0, 0.5), rate);
  const grants = [];
  for (let i = 0; i < 4; i += 1) grants.push(farm(true, MOVEMENT.moveSpeed));
  check(
    '  four seconds pay four identical ticks',
    grants.every((g) => Math.abs(g - rate) < 1e-9),
    true,
  );

  /*
   * A TREADMILL PAYS EXACTLY WHAT WALKING PAYS, AND IT PAYS FOR STANDING ON IT.
   *
   * A mech on a running deck IS walking - the belt is covering the ground
   * instead of the machine - so the bay is the one place a stationary player
   * earns, and it earns WITHOUT a key held: holding one would only walk them
   * off the rig, since nothing on a belt holds them there.
   *
   * What it pays is the ordinary rate. No belt bonus, no tier, no multiplier.
   */
  const belted = farm(false, 0, 1);
  check('standing on a belt pays exactly what walking pays', Math.abs(belted - walked) < 1e-9, true);
  check('  and holding W on one pays the same, not more', Math.abs(farm(true, 0, 1) - walked) < 1e-9, true);
  const second = farm(false, 0, 2);
  const third = farm(false, 0, 3);
  check('all three belts pay the same', Math.abs(second - third) < 1e-9, true);
  check('there is no tier table on the bay', 'tiers' in TRAINING, false);

  /*
   * THE THREE FACTORS, AND ONLY THE THREE.
   *
   * Robot, rebirth, trail. Each one is checked by changing it alone and
   * watching the figure move by exactly the factor it should.
   */
  player.treadmill = 0;

  // Granted the way the server grants one: the ownership mask plus the same
  // "ride the best you own" rule a claim goes through.
  player.ownedRobots |= 1 << (2 - 1);
  robots.equipBest(player);
  speeds.syncDerived(player);
  const onSecondMech = farm(true, MOVEMENT.moveSpeed);
  check(
    'a better mech pays its own rate',
    Math.abs(onSecondMech - robotForSlot(2).speedPerSecond) < 1e-9,
    true,
  );

  player.rebirths = 1;
  speeds.syncDerived(player);
  const rebirthed = farm(true, MOVEMENT.moveSpeed);
  check(
    'a rebirth multiplies it',
    Math.abs(rebirthed - onSecondMech * rebirthMultiplier(1)) < 1e-9,
    true,
  );

  const trailTier = TRAIL_TIERS[0];
  player.ownedTrails |= trailMask(trailTier.slot);
  player.trailSlot = trailTier.slot;
  speeds.syncDerived(player);
  const trailed = farm(true, MOVEMENT.moveSpeed);
  check(
    'a trail multiplies it',
    Math.abs(trailed - rebirthed * trailTier.multiplier) < 1e-9,
    true,
  );

  /*
   * AND NOTHING ELSE DOES.
   *
   * Level is the obvious candidate - it is in every other formula in the game -
   * so it is the one worth proving absent. A player fifty levels higher on the
   * same mech, rebirth and trail earns exactly the same Speed per second.
   */
  const beforeLevel = farm(true, MOVEMENT.moveSpeed);
  player.totalSpeed = totalSpeedToReach(40);
  speeds.syncDerived(player);
  const afterLevel = farm(true, MOVEMENT.moveSpeed);
  check('level does not change the rate', Math.abs(afterLevel - beforeLevel) < 1e-9, true);
  check(
    '  and the HUD advertises the rate that is paid',
    Math.abs(player.speedPerStep - afterLevel) < 1e-9,
    true,
  );
}

console.log('the jump');
{
  /*
   * THE ONE AIRBORNE MECHANIC, exercised against the real shared simulation.
   *
   * A mech jumps and does nothing else in the air, so the authority questions
   * are: does a held key buy exactly one leap, does a leap in mid-air buy
   * nothing, and is the arc the one the whole course was authored against?
   * Each is answered by watching what `stepPlayer` does rather than by asking
   * a service a question.
   */
  const collision = new WorldCollision();
  const motion = createMotion();
  const events = createSimEvents();
  const input = createMovementInput();
  const params = {
    moveMultiplier: 1,
    jumpVelocity: MOVEMENT.jumpVelocity,
    time: 0,
  };

  const step = (seconds, held) => {
    input.jump = held;
    const ticks = Math.round(seconds * 60);
    for (let i = 0; i < ticks; i += 1) {
      params.time += 1 / 60;
      stepPlayer(motion, input, params, 1 / 60, collision, events);
    }
  };

  check('starts on the ground', motion.grounded, true);
  const startY = motion.y;

  // One press lifts it.
  step(1 / 60, true);
  check('a press leaves the ground', motion.grounded, false);
  check('  and counts one jump', motion.jumpCount, 1);

  /*
   * HOLDING the key buys nothing more. The latch is what makes a held key one
   * leap rather than sixty, and it is the single most important line in the
   * jump: without it a player could hold space and climb for ever.
   */
  step(0.4, true);
  check('holding the key does not jump again in mid-air', motion.jumpCount, 1);

  // Let it land.
  step(3, false);
  check('it comes back down', motion.grounded, true);
  check('  and lands where it started', Math.abs(motion.y - startY) < 1e-6, true);

  // A fresh press after landing is a fresh jump.
  step(1 / 60, true);
  check('a fresh press jumps again', motion.jumpCount, 2);
  step(3, false);

  /*
   * THE ARC, and it has to be the one `ballisticFor` promises - because every
   * gap and every step in the course was authored against that function.
   *
   * Measured by watching the peak of a real jump rather than by re-deriving
   * the formula here, which would only prove the formula equals itself.
   */
  motion.jumpLatched = false;
  let peak = motion.y;
  input.jump = true;
  for (let i = 0; i < 120; i += 1) {
    params.time += 1 / 60;
    stepPlayer(motion, input, params, 1 / 60, collision, events);
    input.jump = false;
    peak = Math.max(peak, motion.y);
  }
  const expectedRise =
    (MOVEMENT.jumpVelocity * MOVEMENT.jumpVelocity) / (2 * MOVEMENT.gravity);
  check(
    `a base jump rises about ${expectedRise.toFixed(1)} units`,
    Math.abs(peak - startY - expectedRise) < 0.5,
    true,
  );

  // And jump height scales FAR more gently than travel speed, which is the
  // property the whole difficulty curve rests on: a fast player jumps further
  // and barely higher.
  const base = resolveMovementProfile(1, 0, 1, 1);
  const late = resolveMovementProfile(160, 5, 2.15, 1.26);
  const speedRatio = late.moveSpeed / base.moveSpeed;
  const heightRatio =
    (late.jumpVelocity * late.jumpVelocity) / (base.jumpVelocity * base.jumpVelocity);
  /*
   * The INVARIANT, not a magic number: height must grow FAR more slowly than
   * speed.
   *
   * Written as a ratio of ratios rather than a ceiling on either, because
   * either alone is a tuning value somebody is entitled to change. What must
   * never change is the asymmetry - a late-game mech covers fourteen times the
   * ground per jump and reaches barely three times the height, so width is
   * texture and ELEVATION is the gate. Every `riseFor` in the course rests on
   * that being true.
   */
  check('late-game travel speed runs away', speedRatio > 5, true);
  check(
    '  while jump height climbs several times more slowly',
    heightRatio * 3 < speedRatio,
    true,
  );
}

console.log('robot claiming');
{
  const speeds = new SpeedService();
  const robots = new RobotService();
  const player = newPlayer(speeds, robots);

  const second = ROBOTS.find((r) => r.slot === 2);
  /** Put the player exactly on a plinth. Two storeys, so Y matters. */
  const standOn = (slot) => {
    player.x = standX(slot);
    player.y = standDeckY(slot);
    player.z = standZ(slot);
  };

  check('starts on the free starter', player.robotSlot, 1);
  check('  owns only the starter', player.ownedRobots, 1);

  // At the plinth, but broke.
  standOn(second.slot);
  check('claim with no Wins is refused', robots.claim(player, second.slot, speeds).reason, 'too-poor');
  check('  still on the starter', player.robotSlot, 1);

  // Rich, but standing somewhere else entirely.
  player.wins = 500;
  player.x = 0;
  player.y = 0;
  player.z = 0;
  check('claim away from the plinth is refused', robots.claim(player, second.slot, speeds).reason, 'not-at-stand');
  check('  Wins not deducted', player.wins, 500);

  /*
   * And standing on the LOWER deck must not claim the mech above and behind.
   *
   * The two storeys share their Z line and differ in X and Y, so a claim test
   * that ignored either would have every player on the lower deck asking for
   * the upper mech every frame.
   */
  const upper = ROBOTS.find((r) => r.slot === 6);
  standOn(1);
  check(
    'standing on the lower deck cannot claim the upper mech',
    robots.claim(player, upper.slot, speeds).reason,
    'not-at-stand',
  );

  // Rich and in the right place.
  standOn(second.slot);
  const bought = robots.claim(player, second.slot, speeds);
  check('claim at the plinth with Wins is granted', bought.granted, true);
  check('  price deducted', player.wins, 500 - second.winsRequired);
  check('  now equipped', player.robotSlot, second.slot);
  check('  Speed rate follows the mech', player.speedPerStep, second.speedPerSecond);

  // Buying it again must not charge twice.
  await sleep(300);
  const again = robots.claim(player, second.slot, speeds);
  check('re-claiming an owned mech is refused', again.reason, 'already-owned');

  // A cheaper mech must never downgrade the equipped one.
  const winsBefore = player.wins;
  await sleep(300);
  standOn(1);
  robots.claim(player, 1, speeds);
  check('claiming the starter again does not downgrade', player.robotSlot, second.slot);
  check('  and costs nothing', player.wins, winsBefore);

  /*
   * THE PANEL-ONLY MECHS, and the reason the position check is conditional.
   *
   * Slots past the display deck have no plinth, so a position requirement
   * would make them unbuyable. They still cost Wins, and that check is the
   * whole authority - which is what makes the panel and the plinth the same
   * purchase rather than a back door.
   */
  const prototype = ROBOTS[ROBOTS.length - 1];
  player.x = 0;
  player.y = 0;
  player.z = 0;
  player.wins = 0;
  await sleep(300);
  check(
    'a panel-only mech still costs Wins',
    robots.claim(player, prototype.slot, speeds).reason,
    'too-poor',
  );
  player.wins = prototype.winsRequired;
  await sleep(300);
  const proto = robots.claim(player, prototype.slot, speeds);
  check('  and is claimable from anywhere once affordable', proto.granted, true);
  check('  price deducted', player.wins, 0);
  check('  and it is now equipped', player.robotSlot, prototype.slot);
}

console.log('speed and levels');
{
  const speeds = new SpeedService();
  const robots = new RobotService();
  const player = newPlayer(speeds, robots);

  check('starts at level 1', player.level, 1);

  /*
   * Credit honest movement: two seconds of 1/60-second steps at a plausible
   * gallop. The per-step distance has to be one the server would actually
   * observe - anything larger is a teleport by definition and pays nothing.
   *
   * A HUNDRED AND TWENTY-ONE steps, not a hundred and twenty. Speed arrives in
   * whole ticks of a second and the very first step after a spawn establishes
   * the movement baseline without paying, so two seconds of TICKS takes two
   * seconds of stepping plus that one. Getting this off by a frame is not a
   * rounding quibble - it is the difference between two ticks and one.
   */
  speeds.reset('test', player);
  const perStep = 24 / 60;
  let z = 0;
  for (let i = 0; i < 121; i += 1) {
    z += perStep;
    player.z = z;
    speeds.credit('test', player, 1 / 60, true);
  }
  check('honest movement pays', player.totalSpeed > 0, true);
  check(
    '  two seconds of it pays exactly two ticks',
    Math.abs(player.totalSpeed - robotForSlot(player.robotSlot).speedPerSecond * 2) < 1e-9,
    true,
  );

  /*
   * A TELEPORT PAYS NOTHING AT ALL.
   *
   * Five thousand units in one step is not travel, whatever the client says
   * its keys were doing, and there is no longer any passive tick underneath it
   * to collect either - so the total must not move by a single unit.
   */
  const beforeTeleport = player.totalSpeed;
  player.z = z + 5000;
  speeds.credit('test', player, 1 / 60, true);
  check('a teleport pays nothing', player.totalSpeed, beforeTeleport);

  /*
   * THE LEVEL CURVE, checked against the figures on the reference art.
   *
   * Level 3 costs 121 Speed and level 4 costs 133, which is what
   * `baseRequirement` 100 and `growth` 1.1 produce - and level 5 costs 146,
   * which is the "30 / 146" the level bar shows. These three numbers are the
   * specification; everything past them follows from the same two constants.
   */
  check('level 1 -> 2 costs 100', speedForNextLevel(1), 100);
  check('level 2 -> 3 costs 110', speedForNextLevel(2), 110);
  check('level 3 -> 4 costs 121', speedForNextLevel(3), 121);
  check('level 4 -> 5 costs 133', speedForNextLevel(4), 133);
  check('level 5 -> 6 costs 146', speedForNextLevel(5), 146);
  // And the bar's own reading follows from the same curve.
  const bar = resolveLevel(totalSpeedToReach(5) + 30, 50);
  check('30 Speed into level 5 reads 30 / 146', `${bar.into} / ${bar.required}`, '30 / 146');

  // Movement speed rises with level through the one shared formula. The cap
  // before any rebirth is level 25, so that is where a huge Speed total lands -
  // getting past it is what the rebirth ladder is FOR.
  player.totalSpeed = 4536000;
  speeds.syncDerived(player);
  check('a huge Speed total caps at the pre-rebirth level', player.level, 50);
  // The INVARIANT, not a number. The magic 2 that used to be here was a fact
  // about the linear curve and failed the moment that curve was given the
  // diminishing returns which keep a late-game mount landable. What actually
  // has to be true is that levelling makes you faster and keeps making you
  // faster - which is checkable without hard-coding how much.
  const atLevel1 = resolveMovementProfile(1, 0, 1, 1).multiplier;
  const atCap = resolveMovementProfile(50, 0, 1, 1).multiplier;
  const higher = resolveMovementProfile(100, 0, 1, 1).multiplier;
  check('level drives the replicated multiplier', player.moveMultiplier > atLevel1, true);
  check('  and it is the level cap that is driving it', player.moveMultiplier, atCap);
  check('  and a higher level is still faster', higher > atCap, true);
  check('  and the mech is still the starter', player.robotSlot, 1);
  check(
    '  the Speed rate matches the equipped mech',
    player.speedPerStep,
    robotForSlot(1).speedPerSecond,
  );
}

console.log('');
if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('progression OK');
