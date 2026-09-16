# CLAUDE.md — +1 Speed Robot Escape

Permanent project rules and design constraints. Read this before changing
anything.

## What this is

A **production** browser multiplayer obby game, and the next game in the same
series as `+1 Backflip Obby Escape`, `+1 Speed Animal Escape` and
`+1 Speed Broom Escape`. Not a demo, not a prototype. "Roblox-inspired"
describes the **visual and gameplay style only**.

The gameplay differences from the previous game, and everything else in this
file follows from them:

- The player rides a **Gundam-style mech**. The ROBOT is the movement
  character; the pilot sits INSIDE ITS CHEST, in an open cockpit, with their
  head and shoulders above the canopy rim. The mech is roughly three times the
  pilot's height and the camera is framed to make that obvious.
- The broom's flight meter is **gone**. A mech walks and jumps, and there is no
  second airborne mechanic. There is no sprint either: **one gait**.
- **Speed is earned by WALKING FORWARD, and by nothing else.** Standing still
  earns zero. That is the "+1" of the title - a fixed amount per second ON THE
  MOVE - and the reason to keep running is that stopping stops the income.

## Technology (fixed)

| Layer  | Stack                                   |
| ------ | --------------------------------------- |
| Client | Three.js + TypeScript + Vite            |
| Server | Colyseus + Node.js + TypeScript         |
| Shared | TypeScript, framework-free              |
| Target | Browser / WebGL, desktop **and** mobile |
| Repo   | npm workspaces monorepo                 |

**Not used, ever:** Unity. Roblox Studio or the Roblox engine. Any other game
engine. Do not add a framework or a build tool without a concrete need.

## Hard constraints

- Final browser build must stay **under 12 MB**. It is currently ~3.1 MB, and
  1.9 MB of that is the one supplied music track. Check `npm run size:client`
  after touching any asset.
- **Progression and rewards are server-authoritative.** The client may predict
  for UI feel but never decides, computes or claims a reward.
- Desktop and mobile browsers are both first-class. No desktop-only input
  assumptions.
- **Ports are not the defaults.** The earlier games in this series occupy
  2567–2572 and 5173–5178 on the same machine. This game uses **2573** and
  **5179** so all of them can run side by side; sharing a port means whichever
  server starts first silently serves both clients. The dev script passes
  `--port 2573` explicitly, because a dev harness that hosts the client often
  exports `PORT` for its own web server and the game server would otherwise
  bind to it.

## The jump — the one airborne mechanic

- **There is ONE ground gait, and no sprint.** No Shift, no run key, no stick
  threshold: `MOVEMENT.moveSpeed` is what a mech walks at, the input carries no
  such flag and the shared step reads none. Every gap in thirty stages is
  authored against that single number through `ballisticFor`, so a second
  ground speed would not be a feature - it would be a second course.
- **Space is the only action key, and it is a JUMP.** One press, one leap.
  Holding it buys nothing more, and the latch that guarantees that lives in
  `PlayerSim.applyJump` and is **replicated**, so the client's replay derives
  exactly the same edges the server took.
- There is no meter, no hold, no double jump and no flight. Do not add one:
  every gap and every step in thirty stages is authored against the arc one
  press produces, and a second way into the air invalidates all of them.
- `MOVEMENT.jumpVelocity` and `MOVEMENT.gravity` are therefore the two most
  load-bearing numbers in the project. `ballisticFor` turns them into the
  `reach` and `rise` the course builder and `verify-course` both read, so a
  change to either is a change to every stage.
- **Jump height scales far more gently than travel speed, and it must.** A
  late-game pilot covers fourteen times the ground per leap and reaches barely
  three times the height. Width is the TEXTURE of a crossing; ELEVATION is the
  gate, and it is the only one that survives a progression curve with no speed
  cap. `verify-progression` asserts the asymmetry rather than either figure.
- **LAUNCH PADS are the one sanctioned exception**, and they are a
  `SurfaceRegion` field (`boost`) rather than a new mechanic: a pad SETS
  vertical velocity, applied once per step from the settled grounded position,
  so every mech leaves a pad at the same speed whatever it arrived doing.

## Speed — how it is earned

**BY WALKING FORWARD. THAT IS THE WHOLE LIST.**

There is no passive tick, no per-second income for existing, no jump bonus, no
distance bonus, no sprint bonus and no treadmill bonus. A player standing in
the hangar earns nothing however long they stand there, and a player holding W
against a wall earns nothing either, because the mech is not going anywhere.

- **The rate is FIXED, and it is a product of exactly three things**:
  `equipped robot's Speed/s × rebirth multiplier × trail multiplier`. Nothing
  else may enter it - not level, not how much ground was covered, not which
  belt is underfoot, and above all not a random roll. The same three facts
  always produce the same figure.
- **`speedGainPerSecond` is the ONE place that product is computed** and
  **`earnsSpeed` is the ONE place the conditions are judged**, both in
  `shared/src/config/speed.ts`. `SpeedService.credit` is the only caller and
  the only code in the game that adds to `totalSpeed`. Three competing award
  systems is exactly what this replaced.
- **Payment is rate × TIME, never rate × distance.** Time, so the figure is
  identical on a 30 Hz client and a 240 Hz one; distance would pay a faster
  mech more for the same second and make the number fluctuate with every
  acceleration.
- A step earns only if all three hold: the client asked to go **forward**
  (`moveZ > 0` - the W key), the **authoritative position actually moved** by
  more than `SPEED.movingSpeed` a second, and the movement was **possible**
  (anything past `creditSlack` is a teleport and pays nothing). The forward
  intent is read from the input the SERVER sanitised, so "was walking forward"
  and "did move forward" cannot disagree.
- **A treadmill pays exactly what walking pays**, and only while the player is
  actually running on it. The belt satisfies "the machine is walking" with the
  ground moving instead of the mech; it adds nothing on top. There are **no
  tiers, no level gates and no multipliers** on any belt, and `verify-course`
  fails if a tier table reappears.
- The level curve is `baseRequirement` 100 and `growth` 1.1, which produces
  100, 110, 121, 133, 146 — the figures on the reference art, including the
  "30 / 146" the level bar shows at level 5. Those are the specification;
  everything past them follows from the two constants.

## Rebirth, trails and mechs

- The prestige ladder is called **REBIRTH**, everywhere.
- `REBIRTH_TIERS` is the authored head (level 50 -> x1.5, level 75 -> x2) and
  `EXTENSION` continues the same pattern for ever (+25 levels, +0.5x), so a
  third rebirth is one row in a table.
- The level CAP is not a constant: it is whatever the next rebirth requires, so
  reaching the cap and unlocking a rebirth are the same moment. A cap is a
  gate, never a dead end.
- A rebirth resets the level curve — which means clearing `totalSpeed`, because
  level FOLLOWS from it — and deliberately keeps Wins, mechs and trails. It
  also returns the player to the hangar.
- **Trails** multiply ACTUAL MOVEMENT SPEED, through the shared formula's
  `extraMultiplier` and never a calculation of their own. The equipped ROBOT
  owns Speed-per-second; the two axes never cross.
- **Wins move in exactly one place**: `Wallet`. Three things want to move them
  — finishing a stage, claiming a mech and buying a trail — and they must not
  become three ways to take payment.

## The mechs

- The roster is **pure data** in `shared/src/config/robots.ts`. Adding a
  thirteenth is a new entry and nothing more: no movement code, no renderer
  branch, no server case statement.
- There is ONE generic mech builder. A scout frame and a siege walker are the
  same two dozen boxes at different sizes with different hardware bolted on.
- **NO HEAD, ever.** Every frame stops at the shoulders, and the pilot sits in
  the chest below them. That is the silhouette the whole game is built on, so
  it is a property of the builder rather than an option on it.
- **THE COCKPIT IS A SHELL, AND THE PILOT IS INSIDE IT.** `RobotGeometry`
  builds a back wall, two side walls, a floor plate, a low front dash and a
  canopy brow on A-pillars — an opening the rider is seated IN. A solid slab
  across that opening, or a rider anchored above `canopyRimY`, puts a giant
  person back on top of a small robot, which is the single design this game was
  overhauled to get rid of. `cockpitFloorY`, `canopyRimY` and `shoulderTopY`
  are derived from the shape so the seat cannot drift out of the hole.
- **The mech is BIG.** Shapes are authored at playing size (8.4–9.3 units) with
  `scale` only trimming 1.00–1.12, and `MOUNT_HEIGHT` is 9. The whole world —
  gaps, kerbs, doorways, ceilings — is measured against that figure, so
  shrinking the roster is a change to the course.
- The rider is parented to the mech's **body node**, so they inherit the walk
  bob, the lean and the roll for free. There is deliberately no per-frame "copy
  the robot's transform onto the rider" step — a copy is always a frame late
  and always slides, and "permanently sitting on the robot" has to be true at
  four hundred units a second.
- `riderSeatY` is DERIVED from the shape, once, and every `riderOffset.y` is
  `riderSeatY(shape) - RIDER_HIP_HEIGHT`. The supplied FBX puts its origin at
  the feet and its hips 1.21 units above that; authoring the seat per robot is
  how one entry ends up with its pilot buried to the knees.
- Limbs are **two segments each** with a real knee and elbow. A one-node limb
  pivots the whole leg about the hip and the "knee bend" is just more hip
  swing, which is exactly how a procedural walk gives itself away.
- Geometry is **merged per moving part and cached per robot id**, and colour
  lives in the VERTICES — so the whole roster renders with a single
  `MeshLambertMaterial`.
- The shapes are authored at PLAYING size and `scale` (1.00–1.12) only trims
  between frames. A mounted pair stands 8.4–9.3 units.
- **The palettes are BRIGHTER than the building.** The facility is near-black
  and lit by a handful of lamps; a machine painted in the room's own greys is a
  silhouette. Every frame is a saturated colour a player can name from across
  the hangar.
- **Twelve mechs, ten plinths.** The display deck is two storeys of five as
  specified; slots 11 and 12 are bought from the **Mechs** panel on the rail.
  Both routes arrive at `RobotService.claim` as the same request, and the Wins
  check is the whole authority — which is why the position check is applied
  only to robots that `hasStand`.
- Two hard ceilings on the roster: a price must fit `MAX_WINS` (the uint32 Wins
  field) and a slot must be at most 31, because `robotBit(32)` is `1 << 31`,
  which is NEGATIVE in JavaScript.

## Animation

Procedural, and required for the finished game — not a placeholder.

- `RobotAnimator` and `RiderAnimator` are the only animation state machines.
  Animation logic never goes in movement, input or networking code.
- They consume a read-only `AnimationInput` and write **only** to the robot's
  animated nodes and to the rider's bones. They must never move the mount's
  physics root, change velocity, or decide a gameplay outcome.
- **THERE ARE TWO ANIMATIONS: the WALK and the JUMP.** The walk is one cycle at
  every speed — `run` deepens it rather than replacing it, so moving faster
  reads as a longer stride. The jump's two halves are told apart by the SIGN of
  vertical velocity, not by a state machine, so the top of an arc rolls over
  smoothly instead of snapping.
- **THE MECH IS RIGID, AND THAT IS PLAYBACK RATHER THAN POSES.** The cycle is
  quantised to `GAIT.keyframes` commanded attitudes and every joint HOLDS at
  one for `GAIT.keyframeHold` of the beat before driving quickly to the next -
  `mechanical()` in `RobotAnimator`, and every joint reads from that one
  function so the whole frame changes on the same beat. Three things are
  deliberately absent and must stay absent: **no side-to-side sway** (the body
  never rotates on Z except for the small steering lean), **no idle wobble** (a
  parked mech holds its position - amplitude is zero when not moving) and **no
  squash on landing** (armour does not change shape; a landing is absorbed by
  the knees and the hip drop). Those three are what made an earlier version
  read as a person dancing.
- **The knee folds on the back half of the stride only.** `max(0, -sin)` is
  one-sided on purpose: a mech knee bends one way, and a symmetric sine folds
  it forward for half of every step.
- **The bob runs at DOUBLE the phase.** A biped's hips rise and fall on every
  footfall and there are two per stride; bobbing once per cycle reads as a limp.
- Gait phase advances with **distance**, not wall-clock time — but the cadence
  is CLAMPED (`GAIT.maxFrequency`). A late-game mech covers four hundred units
  a second, and an unclamped cycle would strobe. The sense of pace comes from
  the world going past. The FOOTSTEP SOUND is clamped the same way and for the
  same reason; change one and you have to change the other.
- The robot runs first and hands the rider its **gait phase** and its **air
  blend**, so both halves bounce to one cycle rather than to two clocks that
  drift apart.
- **The rider's walking animation never plays.** A rider whose legs cycle while
  seated is the single most obvious way a mounted character looks wrong.

## The world

- The course is **generated, not authored by hand**, from a builder table in
  `shared/src/config/course.ts`. `COURSE_SOLIDS` and `COURSE_HAZARDS` are read
  by BOTH the renderer and the collision model, so a platform the client draws
  but the server does not know about is structurally impossible.
- A stage's LENGTH is not a constant: it is whatever its builder came to.
  Stages are positioned from the **build cursor**, never from a nominal length.
- The first stage begins exactly at `lobbyEndZ`. Any gap there is an unmarked
  hole across the full width of the course.
- **Thirty stages, and every one of them is authored.** `BUILDERS` is one table
  with one entry per stage, so it is immediately obvious that none of them is a
  repeat of its neighbour. Name, difficulty word, recommended level and
  recommended MECH live in `STAGE_TUNING`, one row per stage.
- The recommended SPEED is DERIVED from the recommended level through
  `totalSpeedToReach` — the same curve the player actually levels on — and
  never written beside it.
- **The win pad is at the player's LEFT and the return pad at their RIGHT**,
  and LEFT IS POSITIVE X. The camera looks down +Z and its right is
  `(-cos yaw, sin yaw)`, which at yaw 0 is world -X. Every "left" and "right"
  in the world layout means the PLAYER's.
- The win pad banks the stage AND returns the player; the return pad only
  returns them and pays nothing. Two pads, because they answer two different
  questions and "go back" and "get paid" must not be the same button.
- Hazards are a **pure function of time** (`hazardPositionAt`), as are the
  sinking platforms (`sinkingOffsetAt`). There is no hazard state on the wire.
- The client ADVANCES its own copy of that clock between patches and re-bases
  it whenever a fresher `elapsed` arrives. Freezing it makes everything stutter
  at the patch rate.
- A **SHUTTER is a sinking platform seen from the side**, and a timed door
  needs no new primitive. A rank of shutters must OVERLAP: sized flush they
  leave a slot between neighbours and another against each wall, and a mech is
  narrow enough to run down one for the whole stage.
- `hazardZRange` and `hazardReachX` are the ONE definition of how far a hazard
  can travel. `sweep` means different things to different kinds.
- A hazard's Y is evaluated, not authored: `touchesHazard` takes the position
  first and tests the height against THAT.
- **`SurfaceRegion` changes how the mech HANDLES**, and it is read inside
  `stepPlayer` itself. Grip (polished plating), `windX`/`windZ` (conveyors) and
  `boost` (launch pads) all live there; both sides run the one formula.
- The corridor is **64 units wide** (`COURSE.halfWidth` 32), and every obstacle
  offset is written as a FRACTION of it through `lane()`.
- Places that open out are declared in **`WIDE_AREAS`**, and there is exactly
  one list.
- **A stage that comes back to the same Z twice at two different heights cannot
  exist.** The world is linear in Z: the collision buckets, the span merge and
  the verifier all assume it. A true circular spiral was tried for stage 21 and
  rejected for exactly this; the corkscrew that replaced it advances along Z
  with a swing smaller than a platform is long.
- `texturedBox` scales UVs to WORLD size, so one texture tiles across every
  solid at the same physical scale.
- World signs are **single-sided**. A double-sided panel is legible from the
  front and MIRRORED from behind.
- **Sign text is sized to FIT.** `CanvasSign` measures the string and shrinks
  until the glyphs AND their outline sit inside the panel.
- **Not one image file is used for the WORLD.** Every world texture is drawn on
  a canvas at runtime by `WorldTextures`.

## The hangar

- A large starting hangar (188 x 172): the **two-storey mech display deck** down
  the player's LEFT, open ground through the middle, the **calibration bay**
  (the treadmills) on their RIGHT, and the two command displays framing the
  course entrance ahead. Sized against a nine-unit machine rather than against
  a person — the scale of the room is what makes the mechs read as mechs.
- **The back wall carries the HANGAR DOOR**, and it is drawn in its own
  material: dark plate with amber hazard chevrons tiled at three times the
  building's scale, a centre split with lit edges, a seam light under every
  shutter segment. Drawn in the wall's own steel it vanished into the bulkhead,
  which is how the largest object in the room became invisible.
- **THE GALLERY IS A SHOWROOM.** Ten bays on two storeys, evenly spaced, every
  machine square to the deck and FACING THE ROOM, one nameplate each on its own
  board, and nothing in the volume the player looks through. The machines do
  not turn: a sweep means half the deck is always showing a shoulder, and two
  silhouettes cannot be compared if either is moving. Nothing decorative may go
  in front of a cradle.
- **TWO STAIRWAYS, one at each end of the gallery**, both climbing along +X so
  the player walks toward the machines as they rise, and both built from the
  same numbers in one loop. The single flight this replaced ran along Z behind
  the far end of the deck, which read as a staircase going sideways to nowhere
  and left half the gallery a long walk from the only way up.
- The display deck is **stepped back like stadium seating**, not stacked as a
  balcony. That choice is load-bearing twice: a balcony directly over the lower
  row would put its underside inside the head of every mech standing beneath it
  (`MOUNT_HEIGHT` is 9 and a plinth adds more), and a row hidden under an
  overhang is a row nobody in the middle of the hangar can see.
- The upper deck is reached by a **stair whose every riser is under
  `MOVEMENT.stepHeight`**, so the mech walks up it. One tall box is a wall: the
  simulation steps over a kerb and not over a storey.
- `standAt` is the ONE footprint test — the server that charges and the client
  that asks both call it. It checks **all three axes**, because the two storeys
  share their Z line: a test that ignored Y would have every player on the
  lower deck asking for the mech above and behind them every frame.
- The three treadmills are IDENTICAL and stand in a row along Z, with their
  belts running along X and their consoles at the +X end — so a runner faces
  back into the hangar. Building the belt along Z instead is what made an
  earlier game's first version read as a row of beds.
- A treadmill is not a pinned state and needs no button. `treadmillAt` derives
  it from POSITION every step on both sides.

## Look

- **A colour is a PROMISE in this game.** CYAN is where you land (hard-light
  platforms, launch pads, sensor strips, the return pad). MAGENTA is the room
  (wall strips, pillar caps). LAVENDER is what kills you. LAVA ORANGE is the
  danger below. No stage may use one for another.
- `worldVisuals.ts` is COLOUR ONLY. Every world coordinate lives in
  `@robot/shared`, so that file re-themes the entire game without moving a
  single collider.
- **THE FACILITY IS LIT.** Neon is an ACCENT, never the only source of
  visibility: floors, walls, stairs, platforms, machinery and the mech itself
  all have to be plainly readable with the glow taken away. Three lights do it
  and three is the whole rig, because every extra one is paid for by every
  fragment in the world - a cool hemisphere for the bounce, a flat ambient so
  nothing is ever pure black, and a key that gives every box a lit face and a
  shaded one.
- **Structural colour is DARK, but never black.** Deck plate, bulkheads,
  housings and girders live from about `#222a38` up; only the void and the pit
  floor go below that, because those two are meant to read as nothing at all.
  An earlier pass took every surface to near-black and the result was a room
  with the lights off: neon outlines floating in front of nothing.
- **Armour is still baked into vertex colours**, so the rig has to keep a black
  frame and a white one telling themselves apart. That is a reason for
  contrast, not for darkness: twelve machines rendered as twelve identical
  silhouettes is the failure at one end and an unlit building is the failure at
  the other.
- **EVERY STAGE IS LIT IN ITS OWN COLOUR.** `STAGE_ACCENT` in `worldVisuals.ts`
  is thirty entries, and `accentForStage` hands the colour to the lamp columns
  in that section, the wash they throw on its deck, its strip lights, its
  beacons and the trim on its gate. The architecture is deliberately identical
  the whole way down the facility; the LIGHT is what tells a player which part
  of it they are in. Lit hardware is bucketed BY COLOUR before merging, so
  thirty stages cost six draw calls and not thirty.
- **Every sign in the world is a LIT PANEL**, never a painted board: dark
  glass, a lit bezel, and text drawn with a bloom of its own colour. The bay
  nameplates, the calibration board and the command displays are all the same
  object at different sizes.
- **STAGE INDICATORS ARE FLOATING TEXT AND NOTHING ELSE.** "STAGE 1" over the
  first stage, "STAGE 2" over the second, with no panel, no frame, no jambs and
  no slab across the course. `CanvasSign` clears to transparent, so what hangs
  in the world is the glyphs and their bloom. They are hung high and face back
  down the course: an indicator that obscures the obstacle it introduces is
  worse than no indicator. Only stage 1 also says ESCAPE.
- **World type is DIN, not Arial Black**, and it is tracked out. `CanvasSign`
  and `Scoreboard` share the stack; ranked figures are monospace so the columns
  line up. A poster face on a gate is the loudest way a world says "toy".
- **Emissive is added FLAT in linear space**, on top of the vertex colour
  rather than multiplied through it. Even 0.14 lifts everything to within a
  shade of everything else. It is not a brightness knob.
- **PointLight intensity is candela**: what reaches a surface is
  `intensity / distance^2`. A "reasonable-looking" 1.5 twenty units away
  arrives as three thousandths of a lux and does nothing. The showroom lamps
  are 900 for that reason and are not a typo.
- The display deck uses **two lamps, one per storey**, not one per plinth: a
  light per plinth is ten more lights in every Lambert shader in the scene, and
  the cost is paid by every fragment in the world.

## Architecture rules

- **No god files.** Logic belongs in its module: `net`, `player`, `input`,
  `rendering`, `camera`, `animation`, `robot`, `world`, `progression`, `config`.
- Gameplay tuning is **data-driven** and lives in `shared/src/config/*`.
  Numbers the client and server must agree on go in `shared/`, never duplicated.
- `shared/` must not import `three`, `colyseus`, or anything DOM.
- The client touches `colyseus.js` only inside `client/src/net/`.
- **Movement speed has exactly one EVALUATOR**: `resolveMovementProfile` in
  `shared/src/config/movement.ts`. A new modifier is a factor fed through it,
  never a second formula.
- **Deaths are decided on the server tick**, from the position it simulated and
  the clock it owns. The client predicts a death only to start drawing the
  fall-over on the right frame.
- **THERE ARE NO CHECKPOINTS, and there must not be any.** Every placement — a
  death, a stage banked, a rebirth, a fresh join — puts the player at
  `SPAWN_POSITION` and nowhere else. `CourseRoom.placeAt` takes no position for
  exactly that reason.
- Persistence sits behind `PersistenceAdapter`. `createPersistence` is the ONLY
  place naming a concrete adapter.
- Only the DERIVING facts are persisted (Speed, Wins, owned mechs, rebirths,
  best stage). Level, movement speed and the equipped mech are recomputed on
  load through the same formulas a live session uses.

## Multiplayer

- **A room holds `MAX_PLAYERS_PER_ROOM` (15).** The matchmaker locks a full
  room and `joinOrCreate` opens another, so the sixteenth player is ROUTED
  rather than refused. `onAuth` re-checks capacity at the door.
- **`VISIBLE_REMOTE_PLAYERS` is 2, and it is a RENDERING limit.** Every player
  in the room is tracked and `apply`-ed on every patch; only the two closest to
  the local player are added to the scene and animated. A mech is two dozen
  meshes carrying a dressed Bloxity avatar and a trail ribbon, and fifteen of
  those is most of a phone's frame budget spent on players too far away to make
  out. Do NOT "optimise" this by reducing what is RECEIVED: a player who walks
  into view is already up to date, which is the whole reason there is no
  pop-in, no catch-up interpolation and no stale pose.
- The swap has **hysteresis** (`SWAP_MARGIN`). Two mechs running side by side
  are constantly a few units either side of each other, and a strict "closest
  two wins" pops one in and the other out several times a second.
- Ranking uses the remote's **authoritative** position, not `mount.root`: a
  hidden player's mount is parked wherever it left the scene, and ranking
  against that would keep somebody invisible precisely because they are
  invisible.
- Other players are **ghosted**: they do not collide. They render completely
  normally — opaque, no fade.
- Remote animation is DERIVED from authoritative state, never from an event
  stream. A jump is "was grounded, now is not". `deathCount` is a LIFETIME
  total, so it only means anything as a difference against a baseline the
  client took on FIRST sight.
- **Never transmit bone transforms or robot part transforms.**

## UI

The HUD is: **Wins** upper centre, **Rebirth**, **Mechs**, **Trails** and
**Sound** down the left rail, and **Speed** and **Level** along the bottom. The
Speed-gain popups float over the middle.

**THE HUD IS A COCKPIT INTERFACE, and every part of it is the same one.** Dark
glass over a faint grid, a lime hairline border, corner brackets, chamfered
corners cut with `clip-path`, monospace tabular figures, and a lit bloom in
place of an outline. That language belongs to the telemetry block, the rail
plates, the Wins housing, every panel, every button, the shop rows and the
touch controls alike — a HUD whose parts are several different visual ideas is
the clearest sign it was assembled from another game.

- The level meter is a **20-cell reactor gauge**, not a bar with a fill: the
  cells are skewed, the leading cell is lit differently from the filled ones,
  and the rebirth panel's readiness track is the same idea drawn with repeating
  gradients.
- The four accents are fixed: `--aoe-lime` is the machine, `--aoe-cyan` the
  readout, `--aoe-warn` (magenta) the warning and amber the reward. A rail tile
  carries its accent on the EDGE and the icon, never as a filled face.
- `hudStyles.ts` owns the one stylesheet and the inline SVG icons. The touch
  controls' stylesheet lives with `TouchControls` and speaks the same language:
  a targeting reticle for the stick, a cyan hex plate for JUMP.
- Everything shown is replicated server state. The HUD never awards, predicts
  or derives progress.
- `Panel` counts open modals and the input layer polls that count to suppress
  movement. A COUNT rather than a boolean.
- `Game.panels` is the ONE list of rail panels. "Close the others" and "close
  everything" were written out by hand in three places, and adding a fourth
  panel to two of them is how Escape stops closing one of them.
- **Speed-gain popups** are driven by an ACCUMULATOR over the replicated total,
  never by raw patches. The popup pool is a HARD CEILING, allocated once.
- `shoe.png` is the SPEED icon, `trophy.png` the Wins one, `rebirth.png` and
  `trail.png` their panels'. They are SUPPLIED ART: never regenerate one
  procedurally, and never set both dimensions in CSS — drive one and leave the
  other automatic so the real aspect ratio survives.
- **A phone on its side** is `(orientation: landscape) and (max-height: 500px)`,
  and every rule for it is scoped to that query.
- **Inside the Bloxity portal the top-left corner is not ours.**
  `body.aoe-portal-embedded` supplies `--aoe-portal-top`.
- **Every menu must be reachable with a mouse.** `MouseLook.cursorFree` is a
  real state: Escape hands the cursor back and KEEPS it back.

## The scoreboards

**TWO** world-space boards, standing either side of the course entrance: **Top
Wins on the player's LEFT** and **Top Speed on their RIGHT**. That stretch of
the hangar's far end was deliberately left empty for them and stays the only
thing there.

- `LeaderboardService` still ranks rebirths and fills all three arrays; the
  third board is simply not shown, because the entrance has two sides.
- Every figure is the SERVER's, merged from stored profiles and live
  `PlayerState`, live winning wherever both exist.
- Rebuilt on a slow timer, not per tick. The replicated arrays are
  FIXED-LENGTH and written in place.
- A row shows the player's **Bloxity name** when they are signed in, and
  otherwise the handle `handleFor` DERIVES from their id — so a standalone
  player still has a stable name and the id itself never leaves the server.
  Never show the derived `@handle` in place of a real display name.
- The board is keyed by PLAYER ID, never by the name shown.

## Audio

In `client/src/audio/`. **Four supplied files and everything else
synthesised.**

- `assets/audio/background.mp3` is the track, STREAMED through an `<audio>`
  element rather than decoded into a buffer — `decodeAudioData` would hold a
  two-minute stereo file as tens of megabytes of uncompressed samples for
  something only ever played end to end. It routes through `musicBus`, which is
  what keeps the portal's `music_volume`, the master volume and mute working.
- `jump.mp3` is the leap and `fall.mp3` is the death — falling is what death
  IS on this course. Both are fetched and decoded once; a blocked or missing
  file changes which sound plays and nothing else, because `playSample` falls
  back to the synthesised voice.
- **`robot steps.mp3` is the WALK, and it is LOOPED rather than fired per
  stride.** It is nearly three seconds of a mech walking — several footfalls,
  not one — so retriggering it on every stride would cut each step off before
  it finished. `AudioManager.setFootsteps(active, pace)` owns it: one looping
  source on the sfx bus, faded in and out so it never clicks, its playback rate
  tied to pace inside a band a recording survives being stretched over. It is
  deliberately NOT counted against `MAX_VOICES`, because that ceiling bounds
  one-shots and this one node has to last the whole walk.
- The per-stride `step` thud is the FALLBACK, used only when there is no
  recording. `PlayerAudio` asks the loop first every frame and only counts
  strides when it says no, so the two can never both be sounding.
- The supplied file's name contains a SPACE. It is percent-encoded at the point
  of use and never renamed, because the supplied files are never modified.
- **ONE context, ONE music voice.** `resume()` is idempotent and `startMusic`
  sits behind the `started` flag, so a doubled tune is impossible rather than
  merely unlikely.
- **One-shots are bounded twice**: a per-sound cooldown and a hard voice
  ceiling. A refused sound is dropped, never queued. A SAMPLED sound replaces
  itself rather than layering, because a recorded file can outlast its cooldown.
- **Only the LOCAL player makes noise.**
- Muting PAUSES the music element rather than merely silencing it.
- Nothing starts before a real user gesture.

## Bloxity

The cross-game portal: login, avatars, friends, synced settings and the Bux
currency. Exposed as `window.Legion.SDK`, loaded from a CDN script in
`index.html` BEFORE the module bundle.

- **`client/src/bloxity/Bloxity.ts` is the only file that touches
  `window.Legion`.** A missing SDK degrades to "no portal", never to a broken
  game.
- **ONE `onUserChanged`**, owned by `Bloxity`, fanned out through
  `Bloxity.onUserChanged`.
- The user object is never cached. `getUser()` is asked each time.
- **Bux are server-authoritative.** The client passes a SKU and NEVER a price.
  The webhook is `POST /bloxity/bux`; **answering 2xx is the contract**, so an
  unrecognised SKU still returns 200 and is logged. Fulfilment QUEUES through
  `BuxGrants` rather than writing, because the webhook arrives on the HTTP
  thread while the player may be live.
- **A player is drawn as their real Bloxity avatar, local and remote alike.**
  Bloxity's `player.glb` carries the twelve bone names `PlayerRig` binds.
- `AvatarDresser` is the ONE thing that decides which body a rider has, shared
  by the local player and every remote one.
- **No asset URL is built from an id.** `GET /v1/avatar/items/{id}` hands back
  an `assetPaths` object and those paths are used verbatim.
- A portrait URL is pinned to `https://static.bloxity.io/`.
- A nested Colyseus schema does NOT bubble its changes to its parent, so
  `avatar` needs its own `onChange`.

## Assets

- `assets/player/player.fbx` is the **canonical** player asset, and
  `base_rig.fbx` is byte-identical to it. **Never modify the supplied files** —
  `verify:assets` digests all eleven.
- The FBX embeds **dead absolute texture paths**; resolution is remapped
  explicitly in `client/src/config/assets.ts` and `PlayerModelLoader`.
- The FBX contains **no animation clips** — a bind-pose rig with 12 bones. All
  animation is procedural.
- The FBX declares **two skin deformers**, so FBXLoader creates two Bone
  objects per name. `PlayerRig` binds the **first** of each name.
- **Every static file lives in the repo-level `assets/`**, which Vite publishes
  as the web ROOT. There is no `client/public/`.

## Verification

Do not claim something works without running it.

- `npm run typecheck` must pass.
- `npm run verify` must pass — the course, the end-of-world barrier and the
  server's reward and purchase authority INCLUDING the rejection paths.
- `npm run verify:assets` digests the supplied files.
- `npm run verify:capacity` needs a RUNNING server, which is why it is not part
  of `verify`.
- Browser behaviour must be checked in a real browser.

When driving the game from the browser console for a test, note that the window
`blur` fired when the pane loses focus correctly clears every held key — a test
harness has to re-assert them each frame — and that a backgrounded pane
throttles `requestAnimationFrame`, so the whole game runs slowly and movement
looks broken when it is not. Front the tab first.

## Current milestone

The game is complete and playable end to end: twelve mechs on a two-storey
display deck, three identical treadmills, two scoreboards framing the entrance,
thirty authored stages, rebirth, trails, the Bloxity portal, and the
closest-player render limit.

**Not built yet, and out of scope until the milestone advances:** powers, the
free-reward chest, the buy-Speed buttons and the "2x Wins" gamepass.
