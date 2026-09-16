/**
 * One stylesheet for the whole HUD, injected on first use.
 *
 * Every panel and button in the game shares these rules, so the rail, the win
 * counter and the two shop panels cannot drift apart visually. The look is
 * taken from the reference art: heavy white display type with a thick dark
 * rim, saturated gradient tiles with a chunky border, and a red badge when
 * something is waiting to be collected.
 */
let injected = false;

export const injectHudStyles = (): void => {
  if (injected) return;
  injected = true;

  const style = document.createElement('style');
  style.textContent = `
:root {
  /* ONE number scales the whole left rail, so the column grows together. */
  --aoe-rail: 78px;
  --aoe-ink: #05080e;
  /*
   * THE FACILITY'S OWN COLOURS, and the HUD wears them.
   *
   * Lime is the machine, cyan is the readout, magenta is the warning and the
   * glass is the dark everything sits on. Every panel, tile and figure in the
   * interface is built from these four, which is what stops the UI looking
   * like a different product from the world behind it.
   */
  --aoe-lime: #d8ff3a;
  --aoe-cyan: #00e5ff;
  --aoe-warn: #ff2fd0;
  --aoe-glass: rgba(6, 12, 20, 0.9);
  --aoe-steel: #141b28;
  --aoe-steel-lit: #1e2839;
  --aoe-hair: rgba(216, 255, 58, 0.5);
  --aoe-mono: ui-monospace, "SF Mono", "Cascadia Mono", "Consolas",
    "Roboto Mono", monospace;
}

/*
 * THE INTERFACE TYPEFACE, and it is a technical one.
 *
 * Bahnschrift is the DIN-derived face Windows ships and DIN Alternate is its
 * Apple counterpart, so the vast majority of players get a squared, engineered
 * letterform with no download and no layout shift. The fallbacks step down
 * through the narrow grotesques before landing on the system sans.
 *
 * Arial Black - what the previous interface used - is a poster face. It is the
 * single most legible signal that a HUD came from somewhere else.
 */
.aoe-font {
  font-family: "Bahnschrift", "DIN Alternate", "Roboto Condensed",
    "Segoe UI Semibold", system-ui, sans-serif;
  font-weight: 600;
  letter-spacing: 0.04em;
}

/*
 * A LIT READOUT, not an outlined cartoon figure.
 *
 * The problem every HUD over a 3D scene has to solve is that white text over a
 * bright platform disappears. The old answer was an eight-offset ink rim,
 * which solves it and makes every number look like a sticker. This solves it
 * with a tight dark halo plus a faint bloom of the figure's own colour, which
 * is what a backlit panel actually does - readable over lime deck plate and
 * over black pit alike, and it belongs to the machine.
 */
.aoe-outline {
  color: #fff;
  text-shadow:
    0 0 3px rgba(0, 0, 0, 0.95),
    0 0 8px rgba(0, 0, 0, 0.75),
    0 0 16px rgba(0, 229, 255, 0.28);
}

/* ---- Wins, upper centre ------------------------------------------------- */
/*
 * THE WINS TALLY: a clearance counter in a chamfered housing.
 *
 * Same housing language as the telemetry block at the bottom of the screen and
 * the rail down the side, because they are three readouts on one machine - and
 * a HUD whose three parts are three different visual ideas is the single
 * clearest sign the interface was assembled rather than designed.
 */
.aoe-wins {
  position: fixed;
  top: max(10px, env(safe-area-inset-top, 0px));
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 20px 6px 14px;
  background: var(--aoe-glass);
  border: 1px solid var(--aoe-hair);
  clip-path: polygon(
    12px 0, 100% 0, 100% calc(100% - 12px), calc(100% - 12px) 100%, 0 100%, 0 12px
  );
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.5);
  pointer-events: none;
  user-select: none;
  z-index: 22;
}
.aoe-wins__icon {
  width: clamp(32px, 3.6vw, 50px);
  height: clamp(32px, 3.6vw, 50px);
}
.aoe-wins__icon .aoe-icon {
  width: 100%;
  height: 100%;
  object-fit: contain;
  filter: drop-shadow(0 4px 6px rgba(0, 0, 0, 0.45));
}
/*
 * The tally itself: tabular figures with a warm bloom.
 *
 * Amber because it is the one WARM signal in a building lit in lime and
 * magenta, and a reward the player is counting should not look like a
 * diagnostic. Bloom rather than a cartoon outline: this is a lit display.
 */
.aoe-wins__value {
  font-family: var(--aoe-mono);
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  font-size: clamp(20px, 2.6vw, 34px);
  line-height: 1;
  color: #ffb545;
  text-shadow: 0 0 6px rgba(255, 157, 31, 0.9), 0 0 18px rgba(255, 157, 31, 0.35);
}
.aoe-wins--pop .aoe-wins__value { animation: aoe-pop 520ms ease-out; }
@keyframes aoe-pop {
  0% { transform: scale(1); }
  35% { transform: scale(1.22); }
  100% { transform: scale(1); }
}

/* ---- Left rail ---------------------------------------------------------- */
.aoe-rail {
  position: fixed;
  /*
   * A real gutter, not a hairline.
   *
   * Nothing hangs off the side of a tile any more - the key cap sits inside
   * the plate - so this is simply the margin the rail is read against, and it
   * still has to clear a phone's rounded corner.
   */
  left: max(18px, env(safe-area-inset-left, 0px));
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  gap: 14px;
  z-index: 21;
  user-select: none;
}
/*
 * A RAIL TILE: a chamfered steel plate with a lit edge.
 *
 * The gradient tiles the previous interface used were rounded, saturated and
 * glossy - the visual language of a mobile puzzle game, and the single loudest
 * thing on screen in a room made of dark metal. These are plates: flat, dark,
 * cut at two corners, and lit only along the edge, so the icon is the brightest
 * part of the control rather than its background.
 */
.aoe-tile {
  position: relative;
  width: var(--aoe-rail);
  height: var(--aoe-rail);
  /*
   * THE BUTTON ITSELF CARRIES NOTHING AND CLIPS NOTHING.
   *
   * The chamfered plate used to be drawn on this element, with a clip-path
   * cutting its corners - and a clip-path clips DESCENDANTS. Everything a rail
   * tile hangs outside its own box was therefore invisible: the key cap on the
   * corner, the name under it and the alert pip. The plate now lives on the
   * ::before pseudo-element, which is clipped on its own and clips nothing
   * else. NO BACKTICKS ANYWHERE IN THIS FILE: the stylesheet is a template
   * literal, and one would end it.
   */
  border: 0;
  background: none;
  display: grid;
  place-items: center;
  cursor: pointer;
  padding: 0;
  transition: transform 110ms ease;
}
/* The plate: chamfered, lit along the edge, and BEHIND everything else. */
.aoe-tile::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 0;
  border: 1px solid var(--aoe-hair);
  border-color: inherit;
  background: linear-gradient(160deg, var(--aoe-steel-lit), var(--aoe-steel));
  clip-path: polygon(
    14px 0, 100% 0, 100% calc(100% - 14px), calc(100% - 14px) 100%, 0 100%, 0 14px
  );
  box-shadow: 0 6px 14px rgba(0, 0, 0, 0.5), inset 0 0 20px rgba(216, 255, 58, 0.05);
  transition: box-shadow 140ms ease;
}
/* The icon, the key cap, the name and the pip all sit ON the plate. */
.aoe-tile > * {
  position: relative;
  z-index: 1;
}
.aoe-tile:hover::before {
  box-shadow: 0 6px 14px rgba(0, 0, 0, 0.5), inset 0 0 26px rgba(216, 255, 58, 0.22);
}
.aoe-tile:hover { transform: scale(1.06); }
.aoe-tile:active { transform: scale(0.97); }
.aoe-tile .aoe-icon {
  width: 74%;
  height: 74%;
  object-fit: contain;
  /* The art carries its own outline, so it needs a drop shadow rather than a
   * stroke to lift it off the gradient behind it. */
  filter: drop-shadow(0 3px 3px rgba(0, 0, 0, 0.35));
  pointer-events: none;
}
/*
 * THE DESIGNATION: a stencilled strip on the bottom edge of the plate.
 *
 * IT CARRIES ITS OWN BACKGROUND, and that is the whole point of it. Set as
 * bare glyphs with only a soft shadow it was drawn straight onto whatever the
 * world happened to be behind the rail - a lit floor, a magenta wall strip,
 * the next tile's own steel - and at eight pixels of tracked-out monospace
 * that is unreadable against roughly half the hangar. An opaque chip makes the
 * contrast a property of the control instead of a property of the room.
 *
 * It hangs in the gutter between two plates rather than on top of the one
 * below: opaque, so it reads whatever is behind it, and tucked far enough up
 * that it is plainly attached to ITS tile and not the next one.
 */
.aoe-tile__label {
  position: absolute;
  left: 50%;
  bottom: -9px;
  transform: translateX(-50%);
  padding: 1px 6px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(4, 9, 15, 0.94);
  font-family: var(--aoe-mono);
  font-size: clamp(8px, 0.95vw, 10px);
  line-height: 12px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--aoe-lime);
  text-shadow: 0 0 6px rgba(0, 0, 0, 0.9);
  white-space: nowrap;
  pointer-events: none;
}
/*
 * THE KEY CAP: which key opens this panel, INSIDE the top-right corner.
 *
 * Inside, because a cap hung off the corner is a chip floating in the room -
 * it needs the rail pushed in to fit, it collides with the world behind it,
 * and it does not read as part of the button it belongs to. The top right is
 * the one corner of the plate that is free: the chamfers cut the top left and
 * the bottom right, the label owns the bottom edge and the alert pip owns the
 * bottom-right outside.
 *
 * Small and quiet - a hairline chip in the facility's own lime, sized to the
 * one character it carries. It is a HINT rather than a label, so it must never
 * compete with the icon it sits over.
 */
.aoe-tile__key {
  position: absolute;
  right: 4px;
  top: 4px;
  min-width: 17px;
  height: 15px;
  padding: 0 3px;
  box-sizing: border-box;
  border: 1px solid rgba(216, 255, 58, 0.45);
  border-radius: 0;
  background: rgba(4, 9, 15, 0.9);
  color: var(--aoe-lime);
  font-family: var(--aoe-mono);
  font-size: 10px;
  line-height: 13px;
  text-align: center;
  letter-spacing: 0;
  pointer-events: none;
}
/* Touch has no keyboard, so the mobile layout keeps exactly what it had. */
body.aoe-touch-mode .aoe-tile__key { display: none; }

/*
 * The alert pip: something is available behind this plate.
 *
 * A magenta warning lamp, and it PULSES. Magenta is the facility's own warning
 * colour - the wall strips, the pillar caps - so a player already reads it as
 * "look here" before they have opened a single panel.
 */
.aoe-tile__badge {
  position: absolute;
  right: -7px;
  bottom: -7px;
  width: 22px;
  height: 22px;
  border: 1px solid rgba(255, 47, 208, 0.9);
  border-radius: 0;
  clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%);
  background: var(--aoe-warn);
  color: #16000f;
  font-family: var(--aoe-mono);
  font-size: 12px;
  line-height: 22px;
  text-align: center;
  display: none;
  animation: aoe-pip 1.4s ease-in-out infinite;
}
@keyframes aoe-pip {
  0%, 100% { box-shadow: 0 0 6px rgba(255, 47, 208, 0.6); }
  50% { box-shadow: 0 0 16px rgba(255, 47, 208, 1); }
}
.aoe-tile--ready .aoe-tile__badge { display: block; }
.aoe-tile--locked { filter: saturate(0.45) brightness(0.78); }

/*
 * ONE accent per tile, carried on the EDGE and the icon rather than the face.
 *
 * Four saturated gradient squares down the side of the screen were the single
 * biggest thing making this look like a different game from the world behind
 * it. A dark plate with a coloured edge is still instantly tellable apart at a
 * glance, and it belongs to the building.
 */
/*
 * The border colour is set on the BUTTON and inherited by the plate, so each
 * tile still states its accent once - and the icon, which draws in
 * currentColor, takes the matching text colour from the same rule.
 */
.aoe-tile--rebirth { border-color: rgba(255, 47, 208, 0.75); color: #ff7ae0; }
.aoe-tile--mech { border-color: rgba(216, 255, 58, 0.8); color: var(--aoe-lime); }
.aoe-tile--trail { border-color: rgba(0, 229, 255, 0.75); color: var(--aoe-cyan); }
.aoe-tile--audio { border-color: rgba(255, 181, 69, 0.75); color: #ffb545; }
.aoe-tile--rebirth .aoe-tile__label { color: #ff7ae0; }
.aoe-tile--trail .aoe-tile__label { color: var(--aoe-cyan); }
.aoe-tile--audio .aoe-tile__label { color: #ffb545; }
/* Muted: the tile stays lit enough to find, and plainly off. */
.aoe-tile--off { filter: saturate(0.25) brightness(0.7); }
.aoe-tile--off .aoe-icon { opacity: 0.55; }

/* ---- The Rebirth panel ---------------------------------------------------
 * A BEFORE and AFTER pair with an arrow between them, as the reference art
 * frames it: the two things a rebirth changes, side by side, so the trade is
 * legible at a glance instead of buried in a paragraph.
 */
.aoe-rb {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 14px 12px;
  margin-bottom: 16px;
}
.aoe-rb__card {
  display: grid;
  place-items: center;
  padding: 16px 10px;
  border-radius: 0;
  border: 1px solid rgba(255, 255, 255, 0.16);
  clip-path: polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px);
  font-family: var(--aoe-mono);
  font-variant-numeric: tabular-nums;
  font-size: clamp(15px, 1.9vw, 24px);
  color: #ffffff;
  /* The figure is the point of the card, so it never wraps and never clips:
   * it shrinks to fit instead, the same rule the world signs follow. */
  white-space: nowrap;
  overflow: hidden;
  text-shadow: 0 0 10px rgba(0, 0, 0, 0.8);
}
/*
 * ONE COLOUR PER ROW, and the two rows are deliberately far apart on the
 * wheel. A rebirth trades two different things at once, and a player scanning
 * the panel should be able to follow either trade across the arrow without
 * reading a word: blue is what you move at, pink is how far you can climb.
 */
.aoe-rb__card--speed {
  background: linear-gradient(180deg, rgba(0, 229, 255, 0.28), rgba(0, 229, 255, 0.07));
  border-color: rgba(0, 229, 255, 0.55);
  color: #b6f4ff;
}
.aoe-rb__card--level {
  background: linear-gradient(180deg, rgba(255, 47, 208, 0.28), rgba(255, 47, 208, 0.07));
  border-color: rgba(255, 47, 208, 0.55);
  color: #ffc0f2;
}
/*
 * The arrow is a chunky WHITE chevron, not a tinted one.
 *
 * It sits between two saturated cards on a mid-grey ground, and anything less
 * than white disappears into one or the other. The dark drop is what keeps it
 * off the ground colour, and it is the same ink every card is outlined in.
 */
.aoe-rb__arrow {
  width: 0;
  height: 0;
  justify-self: center;
  border-top: 16px solid transparent;
  border-bottom: 16px solid transparent;
  border-left: 20px solid var(--aoe-lime);
  filter: drop-shadow(0 0 8px rgba(216, 255, 58, 0.8));
}
/*
 * The rebirth console reads MAGENTA throughout.
 *
 * Every other panel in the game lists things you can buy; this one is the
 * irreversible one. It gets the facility's warning colour on its head, its
 * frame and its cost line, so the one modal a player can regret is the one
 * modal that does not look like the others.
 */
.aoe-panel--rebirth .aoe-panel__box {
  border-color: rgba(255, 47, 208, 0.5);
  box-shadow: 0 22px 60px rgba(0, 0, 0, 0.72), inset 0 0 60px rgba(255, 47, 208, 0.07);
}
.aoe-panel--rebirth .aoe-panel__body {
  padding: 18px;
}
/*
 * The cost, and it is the loudest text on the panel after the title.
 *
 * This is the one irreversible button in the game. A player who has not read
 * this line has not been told what they are about to spend, so it is sized to
 * be read rather than sized to fit between two controls.
 */
.aoe-rb__warn {
  margin: 0 0 14px;
  text-align: center;
  font-family: var(--aoe-mono);
  font-weight: 700;
  font-size: clamp(15px, 1.8vw, 21px);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--aoe-warn);
  text-shadow: 0 0 12px rgba(255, 47, 208, 0.55);
}
/*
 * The readiness track: an empty conduit that FILLS, drawn as segments.
 *
 * The same segmented idea as the reactor gauge on the telemetry block, because
 * they measure the same journey - one to the next level, one to the next
 * rebirth - and two different gauge designs for two views of one number is
 * precisely the incoherence this overhaul is about. Repeating gradients rather
 * than DOM cells, since nothing here needs to be addressed individually.
 */
.aoe-rb__bar {
  position: relative;
  height: 34px;
  border-radius: 0;
  border: 1px solid var(--aoe-hair);
  clip-path: polygon(9px 0, 100% 0, 100% calc(100% - 9px), calc(100% - 9px) 100%, 0 100%, 0 9px);
  background-color: rgba(0, 0, 0, 0.55);
  background-image: repeating-linear-gradient(
    90deg,
    rgba(216, 255, 58, 0.09) 0 12px,
    rgba(0, 0, 0, 0) 12px 15px
  );
  overflow: hidden;
  margin-bottom: 16px;
}
.aoe-rb__fill {
  height: 100%;
  background-color: rgba(216, 255, 58, 0.55);
  background-image: repeating-linear-gradient(
    90deg,
    rgba(216, 255, 58, 0.95) 0 12px,
    rgba(0, 0, 0, 0.35) 12px 15px
  );
  box-shadow: 0 0 18px rgba(216, 255, 58, 0.5);
  transition: width 220ms ease-out;
}
/*
 * The figure is DARK, and it has to be: it sits over the striped track far
 * more often than over the green fill, because a player reads this panel while
 * they are still short of the cap.
 */
.aoe-rb__barlabel {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-family: var(--aoe-mono);
  font-variant-numeric: tabular-nums;
  font-size: clamp(13px, 1.5vw, 18px);
  letter-spacing: 0.1em;
  color: #ffffff;
  text-shadow: 0 0 4px rgba(0, 0, 0, 0.95), 0 0 10px rgba(0, 0, 0, 0.8);
}
/*
 * The one button, and it is GREEN.
 *
 * The shared .aoe-action rule is already the green every confirm button in
 * the game uses, so this only sizes it. Backticks are deliberately absent:
 * these rules live inside a template literal and one closes it.
 *
 * It used to be overridden to purple, which made this the single panel where
 * "go" was not the colour "go" is everywhere else.
 */
.aoe-rb__go {
  font-size: clamp(18px, 2.2vw, 27px);
  padding: 15px;
}
/*
 * Ineligible is a DIMMED GREEN, not the shared grey.
 *
 * Everywhere else in the game a disabled action goes grey, which is right for
 * a shop row you might never buy. This button is the panel's whole purpose and
 * the player is always going to press it eventually, so it stays the colour it
 * will be - and the label says what is still missing, which grey never could.
 */
.aoe-rb__go:disabled {
  background: linear-gradient(180deg, #58e06a, #2fae42);
  filter: saturate(0.32) brightness(0.82);
}
@media (prefers-reduced-motion: reduce) {
  .aoe-rb__fill { transition: none; }
}

/* ---- The Bloxity account chip -------------------------------------------
 * Top RIGHT: the Wins counter owns the top centre and the rail owns the left,
 * and this is the only corner left that a player is not already reading.
 */
.aoe-account {
  position: fixed;
  top: 12px;
  right: 12px;
  z-index: 23;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}
.aoe-account__row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px 4px 4px;
  border: 1px solid var(--aoe-hair);
  border-radius: 0;
  clip-path: polygon(0 0, 100% 0, 100% calc(100% - 9px), calc(100% - 9px) 100%, 0 100%);
  background: var(--aoe-glass);
}
.aoe-account__pfp {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 2px solid var(--aoe-ink);
  object-fit: cover;
}
.aoe-account__name {
  font-size: clamp(12px, 1.2vw, 15px);
  color: #ffffff;
  max-width: 22vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.aoe-account__note {
  font-size: clamp(10px, 1vw, 13px);
  color: #ffffff;
  opacity: 0.6;
}
.aoe-account__actions {
  display: flex;
  gap: 6px;
}
.aoe-account__btn,
.aoe-account__login {
  cursor: pointer;
  border: 1px solid rgba(0, 229, 255, 0.6);
  border-radius: 0;
  clip-path: polygon(7px 0, 100% 0, 100% calc(100% - 7px), calc(100% - 7px) 100%, 0 100%, 0 7px);
  padding: 6px 11px;
  font-family: var(--aoe-mono);
  font-size: clamp(10px, 1vw, 12px);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: #b6f4ff;
  background: rgba(0, 229, 255, 0.14);
}
.aoe-account__login {
  border-color: rgba(255, 181, 69, 0.7);
  background: rgba(255, 181, 69, 0.16);
  color: #ffd9a0;
  padding: 8px 15px;
}
.aoe-account__btn:hover,
.aoe-account__login:hover { filter: brightness(1.1); }
/* Touch keeps the chip but drops the row of buttons to a single tap target's
 * worth of width, so it never crowds the jump button. */
body.aoe-touch-mode .aoe-account__name { max-width: 30vw; }

/* ---- Friends and Bux rows ----------------------------------------------- */
.aoe-friend {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 4px;
  border-bottom: 1px solid rgba(216, 255, 58, 0.14);
}
.aoe-friend:last-of-type { border-bottom: none; }
.aoe-friend__pfp {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 2px solid var(--aoe-ink);
  object-fit: cover;
  flex: none;
}
.aoe-friend__name {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
  flex: 1 1 auto;
  min-width: 0;
}
.aoe-friend__name b,
.aoe-friend__name small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.aoe-friend__name small { opacity: 0.6; }
.aoe-friend__status {
  font-size: 12px;
  opacity: 0.75;
  flex: none;
}
.aoe-friend__invite,
.aoe-bux__buy {
  cursor: pointer;
  flex: none;
  border: 1px solid rgba(216, 255, 58, 0.7);
  border-radius: 0;
  clip-path: polygon(7px 0, 100% 0, 100% calc(100% - 7px), calc(100% - 7px) 100%, 0 100%, 0 7px);
  padding: 6px 12px;
  color: var(--aoe-lime);
  font: inherit;
  font-family: var(--aoe-mono);
  font-size: 11px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  background: rgba(216, 255, 58, 0.14);
}
.aoe-friend__invite:disabled,
.aoe-bux__buy:disabled { filter: saturate(0.3) brightness(0.85); cursor: default; }

.aoe-bux {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 4px;
  border-bottom: 1px solid rgba(216, 255, 58, 0.14);
}
.aoe-bux:last-of-type { border-bottom: none; }
.aoe-bux__text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
  flex: 1 1 auto;
}
.aoe-bux__text small { opacity: 0.65; }
.aoe-bux__buy {
  border-color: rgba(255, 181, 69, 0.7);
  background: rgba(255, 181, 69, 0.16);
  color: #ffd9a0;
}

.aoe-panel--friends .aoe-panel__head,
.aoe-panel--bux .aoe-panel__head {
  background: linear-gradient(180deg, rgba(0, 229, 255, 0.16), rgba(0, 229, 255, 0));
  border-bottom-color: rgba(0, 229, 255, 0.5);
}

/* ---- The FPS readout, from the portal's show_fps setting ----------------- */
.aoe-fps {
  position: fixed;
  left: 12px;
  top: 12px;
  z-index: 23;
  font-family: var(--aoe-mono);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  letter-spacing: 0.08em;
  color: var(--aoe-lime);
  text-shadow: 0 0 4px rgba(0, 0, 0, 0.95), 0 0 10px rgba(216, 255, 58, 0.4);
  pointer-events: none;
}
.aoe-fps[hidden] { display: none; }

/* ---- Panels ------------------------------------------------------------- */
.aoe-panel {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(6, 10, 18, 0.55);
  z-index: 40;
}
.aoe-panel[hidden] { display: none; }
/*
 * A PANEL is a console that has slid open, not a dialog box.
 *
 * Dark glass, a lime hairline, chamfered corners and a scanline wash - the
 * same housing as the telemetry block and the rail tiles. The previous panels
 * were white cards with rounded corners, which is the one thing in the
 * interface that could not have belonged to this world under any lighting.
 */
.aoe-panel__box {
  width: min(600px, 94vw);
  max-height: 84vh;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--aoe-hair);
  border-radius: 0;
  background-color: var(--aoe-glass);
  background-image: repeating-linear-gradient(
    0deg,
    rgba(255, 255, 255, 0.022) 0 1px,
    rgba(255, 255, 255, 0) 1px 4px
  );
  clip-path: polygon(
    22px 0, 100% 0, 100% calc(100% - 22px), calc(100% - 22px) 100%, 0 100%, 0 22px
  );
  box-shadow: 0 22px 60px rgba(0, 0, 0, 0.72), inset 0 0 50px rgba(216, 255, 58, 0.05);
  overflow: hidden;
}
.aoe-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
  color: #fff;
  font-family: var(--aoe-mono);
  font-weight: 700;
  font-size: 20px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  border-bottom: 1px solid var(--aoe-hair);
  background: linear-gradient(180deg, rgba(216, 255, 58, 0.13), rgba(216, 255, 58, 0));
}
/*
 * THE REBIRTH HEADER IS NOT A COLOURED BAR.
 *
 * Every other panel gets a tinted strip that names it. This one is a plain
 * continuation of the plate, with the supplied rebirth mark beside a big
 * outlined title - which is what the art shows, and what makes the panel read
 * as a single moulded object rather than as a dialog with a title bar.
 */
.aoe-panel--rebirth .aoe-panel__head {
  background: linear-gradient(180deg, rgba(255, 47, 208, 0.16), rgba(255, 47, 208, 0));
  border-bottom-color: rgba(255, 47, 208, 0.5);
}
.aoe-panel--rebirth .aoe-panel__title {
  flex: 1;
  text-align: center;
  font-size: clamp(26px, 3.4vw, 40px);
  color: #ffffff;
  text-shadow:
    3px 0 0 var(--aoe-ink), -3px 0 0 var(--aoe-ink),
    0 3px 0 var(--aoe-ink), 0 -3px 0 var(--aoe-ink),
    2px 2px 0 var(--aoe-ink), -2px 2px 0 var(--aoe-ink),
    2px -2px 0 var(--aoe-ink), -2px -2px 0 var(--aoe-ink);
}
/*
 * The mark, and it is SUPPLIED ART used at its real aspect ratio: the height
 * is driven and the width left automatic, the same rule every icon in this
 * project follows.
 */
.aoe-panel__mark {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
}
.aoe-panel__mark .aoe-icon {
  height: clamp(34px, 4vw, 52px);
  width: auto;
  filter: drop-shadow(0 3px 5px rgba(0, 0, 0, 0.4));
}
.aoe-panel--trail .aoe-panel__head {
  background: linear-gradient(180deg, rgba(0, 229, 255, 0.16), rgba(0, 229, 255, 0));
  border-bottom-color: rgba(0, 229, 255, 0.5);
}
.aoe-panel--mech .aoe-panel__head {
  background: linear-gradient(180deg, rgba(216, 255, 58, 0.16), rgba(216, 255, 58, 0));
}
.aoe-panel__close {
  border: 1px solid rgba(255, 47, 208, 0.8);
  border-radius: 0;
  clip-path: polygon(7px 0, 100% 0, 100% calc(100% - 7px), calc(100% - 7px) 100%, 0 100%, 0 7px);
  background: rgba(255, 47, 208, 0.16);
  color: #ff7ae0;
  width: 34px;
  height: 34px;
  font-size: 15px;
  cursor: pointer;
  transition: background-color 120ms ease;
}
.aoe-panel__close:hover { background: rgba(255, 47, 208, 0.35); }
.aoe-panel__body {
  padding: 16px 18px 20px;
  overflow-y: auto;
  color: #c6d4e4;
  font-family: var(--aoe-mono);
  font-size: 13px;
  letter-spacing: 0.02em;
}
.aoe-panel__note { margin-bottom: 12px; line-height: 1.5; }
.aoe-panel__note b { font-size: 16px; }

/*
 * THE COMMIT CONTROL: a lit bar across the foot of a console.
 *
 * Lime, because lime is what this facility uses for "powered, go" everywhere
 * else - the platforms, the lamps, the bay frames. A green button from a
 * different kit would be the one control in the game whose colour meant
 * nothing.
 */
.aoe-action {
  width: 100%;
  padding: 15px;
  border: 1px solid rgba(216, 255, 58, 0.85);
  border-radius: 0;
  clip-path: polygon(
    12px 0, 100% 0, 100% calc(100% - 12px), calc(100% - 12px) 100%, 0 100%, 0 12px
  );
  background: linear-gradient(180deg, rgba(216, 255, 58, 0.3), rgba(216, 255, 58, 0.09));
  color: var(--aoe-lime);
  font-family: var(--aoe-mono);
  font-weight: 700;
  font-size: 17px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  cursor: pointer;
  transition: background-color 130ms ease;
}
.aoe-action:hover:not(:disabled) {
  background: linear-gradient(180deg, rgba(216, 255, 58, 0.5), rgba(216, 255, 58, 0.16));
}
.aoe-action:disabled {
  border-color: rgba(140, 160, 180, 0.4);
  background: rgba(140, 160, 180, 0.09);
  color: #7f8c9c;
  cursor: not-allowed;
}

/* ---- Shop rows ---------------------------------------------------------- */
/*
 * A SHOP ROW is a manifest line, and the panel is an inventory readout.
 *
 * White cards on a white list is a phone app. A dark line with a lit left edge
 * is the same information in the language of the rest of the game, and it
 * gives the three states somewhere obvious to live: an unowned frame's edge is
 * dark, an owned one's is lime, and the equipped one is lit right across.
 */
.aoe-row {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 10px 12px;
  margin-bottom: 7px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-left: 3px solid rgba(255, 255, 255, 0.18);
  border-radius: 0;
  background: rgba(255, 255, 255, 0.035);
  color: #d4e0ee;
}
.aoe-row--owned {
  border-left-color: var(--aoe-lime);
  background: rgba(216, 255, 58, 0.07);
}
.aoe-row--equipped {
  border-color: rgba(0, 229, 255, 0.55);
  border-left-color: var(--aoe-cyan);
  background: rgba(0, 229, 255, 0.11);
  box-shadow: inset 0 0 22px rgba(0, 229, 255, 0.12);
}
/*
 * The swatch is the trail's or the frame's actual colour, so it stays a plain
 * lit chip: a chamfer and a glow of its own hue, and nothing else competing
 * with the one thing it exists to show.
 */
.aoe-row__swatch {
  width: 30px;
  height: 30px;
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 0;
  clip-path: polygon(7px 0, 100% 0, 100% calc(100% - 7px), calc(100% - 7px) 100%, 0 100%, 0 7px);
  /* The swatch's own colour is an inline background, so the lift comes from a
   * neutral inner highlight rather than from currentColor - which here is the
   * ROW's text colour and would ring every chip in the same pale blue. */
  box-shadow: inset 0 0 9px rgba(255, 255, 255, 0.3), 0 0 10px rgba(0, 0, 0, 0.55);
  flex: none;
}
.aoe-row__text { flex: 1; min-width: 0; }
.aoe-row__name {
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #ffffff;
}
.aoe-row__meta {
  opacity: 0.66;
  font-size: 11px;
  letter-spacing: 0.08em;
}
.aoe-row__buy {
  border: 1px solid rgba(255, 181, 69, 0.8);
  border-radius: 0;
  clip-path: polygon(9px 0, 100% 0, 100% calc(100% - 9px), calc(100% - 9px) 100%, 0 100%, 0 9px);
  padding: 9px 14px;
  background: linear-gradient(180deg, rgba(255, 181, 69, 0.3), rgba(255, 181, 69, 0.1));
  color: #ffd9a0;
  font: inherit;
  font-family: var(--aoe-mono);
  font-weight: 700;
  font-size: 12px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 120ms ease;
}
.aoe-row__buy:hover:not(:disabled) {
  background: linear-gradient(180deg, rgba(255, 181, 69, 0.5), rgba(255, 181, 69, 0.18));
}
.aoe-row__buy:disabled {
  border-color: rgba(140, 160, 180, 0.35);
  background: rgba(140, 160, 180, 0.08);
  color: #78848f;
  cursor: not-allowed;
}

/* ---- Speed-gain popups -------------------------------------------------- */
/*
 * Deliberately BELOW the HUD in the stacking order (the bar is 20, the rail 21,
 * the Wins counter 22). Popups are spawned inside a band that already misses
 * all three, and sitting under them means even a mis-tuned band can never
 * cover a figure the player needs to read.
 */
.aoe-pops {
  position: fixed;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
  z-index: 19;
}
.aoe-pop {
  --aoe-pop-tilt: 0deg;
  --aoe-pop-scale: 1;
  position: absolute;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  opacity: 0;
  will-change: transform, opacity;
}
.aoe-pop[hidden] { display: none; }
.aoe-pop__icon {
  /* Supplied art. Driving the HEIGHT and leaving the width automatic is what
   * keeps the real aspect ratio exact at every clamp step; setting both is how
   * a supplied icon gets squashed. */
  height: clamp(36px, 4.2vw, 60px);
  width: auto;
  filter: drop-shadow(0 3px 5px rgba(0, 0, 0, 0.45));
}
/* The gain itself, in the same lit cyan the telemetry readout uses. */
.aoe-pop__value {
  font-family: var(--aoe-mono);
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  font-size: clamp(15px, 1.9vw, 26px);
  line-height: 1;
  color: #eafcff;
  text-shadow:
    0 0 4px rgba(0, 0, 0, 0.95),
    0 0 10px rgba(0, 229, 255, 0.85),
    0 0 22px rgba(0, 229, 255, 0.4);
}
.aoe-pop--run { animation: aoe-pop-float 1150ms ease-out forwards; }
@keyframes aoe-pop-float {
  0% {
    opacity: 0;
    transform: translate(-50%, -50%) rotate(var(--aoe-pop-tilt))
      scale(calc(var(--aoe-pop-scale) * 0.6));
  }
  16% {
    opacity: 1;
    transform: translate(-50%, -54%) rotate(var(--aoe-pop-tilt))
      scale(calc(var(--aoe-pop-scale) * 1.1));
  }
  30% {
    opacity: 1;
    transform: translate(-50%, -62%) rotate(var(--aoe-pop-tilt))
      scale(var(--aoe-pop-scale));
  }
  100% {
    opacity: 0;
    transform: translate(-50%, -125%) rotate(var(--aoe-pop-tilt))
      scale(var(--aoe-pop-scale));
  }
}

/* Touch controls own the bottom corners; the rail lifts clear of them. */
body.aoe-touch-mode .aoe-rail { --aoe-rail: 62px; }

@media (prefers-reduced-motion: reduce) {
  .aoe-tile, .aoe-wins--pop .aoe-wins__value { transition: none; animation: none; }
  /* The popup still has to appear and go away, so it fades in place rather
   * than not animating at all. */
  .aoe-pop--run { animation: aoe-pop-fade 1150ms ease-out forwards; }
  @keyframes aoe-pop-fade {
    0% { opacity: 0; transform: translate(-50%, -50%); }
    15%, 65% { opacity: 1; transform: translate(-50%, -50%); }
    100% { opacity: 0; transform: translate(-50%, -50%); }
  }
}

/* A narrow window has less room either side, so the band tightens with it. */
@media (max-width: 760px) {
  .aoe-pop__icon { height: clamp(30px, 6vw, 44px); }
  .aoe-pop__value { font-size: clamp(14px, 3vw, 22px); }
}

/*
 * A PHONE ON ITS SIDE.
 *
 * (orientation: landscape) and (max-height: 500px) is the one query every
 * rule for it is scoped to, and every rule is ALSO scoped to touch mode, so a
 * short desktop window is never restyled.
 *
 * The problem this solves is not smallness, it is SHAPE. A landscape phone has
 * about 240 usable pixels of height and seven hundred of width: a rail of four
 * stacked tiles is 290 tall and simply does not fit, and the telemetry block's
 * portrait offset - lifted 128px to clear thumb controls that sit along the
 * bottom of a PORTRAIT screen - put it in the middle of the picture. Shrinking
 * everything would not have fixed either; the layout has to change shape.
 *
 * Two facts drive all of it, and both are published by the touch layer rather
 * than guessed at here: the stick's radius and the action button's size. The
 * bottom corners belong to those two, the top belongs to the HUD, and the band
 * between them is what everything else is measured against.
 */
@media (orientation: landscape) and (max-height: 500px) {
  /* The space the left thumb owns, measured from the left edge. */
  body.aoe-touch-mode {
    --aoe-stick-zone: calc(
      26px + env(safe-area-inset-left, 0px) + var(--aoe-stick-radius, 64px) * 2
    );
    --aoe-jump-zone: calc(24px + env(safe-area-inset-right, 0px) + var(--aoe-jump-size, 88px));
  }

  /*
   * THE RAIL LIES DOWN WHEN THE SCREEN IS TOO SHORT TO STAND IT UP.
   *
   * Four stacked tiles are 200 tall and the stick owns the bottom-left corner,
   * so on a short landscape phone a vertical rail has nowhere to be: it ran off
   * the top and the bottom of the screen AND sat on top of the stick, which is
   * what was reported. Wrapped into a ROW along the top strip it clears the
   * stick by the height of the picture and uses space that is otherwise dead.
   *
   * The column is still the rail's real shape, and the rule below restores it
   * the moment there is height for it. The threshold is not a taste: a tile is
   * 44, four of them with three 8px gaps is 200, the stick's radius is
   * clamp(46px, 0.15 * vmin, 84px) and in landscape vmin IS the height - so
   * the column fits exactly when h - 56 - 0.3h is at least 200, which is 366.
   * 380 is that figure with a margin.
   */
  body.aoe-touch-mode .aoe-rail {
    --aoe-rail: 44px;
    top: max(10px, env(safe-area-inset-top, 0px));
    left: max(10px, env(safe-area-inset-left, 0px));
    transform: none;
    gap: 8px;
    flex-wrap: wrap;
    /* One tile tall, so every tile wraps into its own column: a row. */
    max-height: var(--aoe-rail);
  }
  /*
   * The designations go. They are wider than the plates they name, so in a row
   * they would run into each other - and four distinctly coloured icons in the
   * corner of a phone screen are not ambiguous. They return in portrait and on
   * desktop, where there is room for them.
   */
  body.aoe-touch-mode .aoe-tile__label { display: none; }
  body.aoe-touch-mode .aoe-tile__badge {
    width: 16px;
    height: 16px;
    right: -5px;
    bottom: -5px;
    font-size: 11px;
    line-height: 14px;
  }

  /* The tally, trimmed: it shares the top strip with the rail. */
  body.aoe-touch-mode .aoe-wins {
    top: max(6px, env(safe-area-inset-top, 0px));
    gap: 6px;
    padding: 3px 12px 4px 9px;
  }
  body.aoe-touch-mode .aoe-wins__icon { width: 26px; height: 26px; }
  body.aoe-touch-mode .aoe-wins__value { font-size: 19px; }

  /* The frame counter sits under the rail rather than on top of it. */
  body.aoe-touch-mode .aoe-fps { top: auto; bottom: 6px; left: 50%; transform: translateX(-50%); }

  /*
   * The Speed-gain popups float in the band between the tally and the
   * telemetry block, which on a screen this short is most of the picture.
   */
  body.aoe-touch-mode .aoe-pop__icon { height: 26px; }
  body.aoe-touch-mode .aoe-pop__value { font-size: 15px; }

  /* Panels get the whole screen; a modal on a 240px-tall viewport cannot
   * afford the usual margins. */
  body.aoe-touch-mode .aoe-panel__box { max-height: 92vh; }
}

/*
 * THE PORTAL'S CORNER, RESERVED.
 *
 * Bloxity draws its own bar over the top-left of an embedded frame - account,
 * menu, chat - and it is outside this document, so it cannot be measured from
 * in here and it will not move for us. The band below is a RESERVATION, sized
 * generously against the bar Bloxity ships, and nothing the game owns goes
 * under it.
 *
 * Only the top-LEFT is taken. The Wins housing is centred and the account
 * button is at the right, so neither is affected - and off-portal the class is
 * absent and none of this applies.
 */
body.aoe-portal-embedded {
  --aoe-portal-top: 58px;
  --aoe-portal-left: 248px;
}

/*
 * EMBEDDED AND SHORT: the rail crosses to the top-RIGHT.
 *
 * On a landscape phone inside the portal the left edge is gone twice over -
 * the portal's bar has the top of it and the steering stick has the bottom -
 * and what is between them is not enough to put a row of controls in without
 * crowding one or the other. Dropping the rail just under the bar left it
 * fourteen pixels off the stick, which is not a gap anybody can aim inside.
 *
 * The top-right strip is the one piece of the screen nothing else claims: the
 * Wins housing is centred, the account button is a short chip above, and the
 * action button is far below at the bottom. The rail goes there, still a row,
 * and clears everything by tens of pixels rather than by ten.
 *
 * The height it switches back at is arithmetic, like the other one: under the
 * bar the column would have h - 58 - 6 - 26 - 0.3h - 20 to live in and needs
 * 200, so it fits from 443 up. 450 is that with a margin.
 */
@media (orientation: landscape) and (max-height: 449px) {
  body.aoe-portal-embedded.aoe-touch-mode .aoe-rail {
    left: auto;
    right: max(10px, env(safe-area-inset-right, 0px));
    /* Under the account chip, which is the only thing above it. */
    top: 50px;
    flex-wrap: wrap;
    max-height: var(--aoe-rail);
  }
}
/* Narrow as well: a row of four would reach the centred tally. */
@media (orientation: landscape) and (max-height: 449px) and (max-width: 560px) {
  body.aoe-portal-embedded.aoe-touch-mode .aoe-rail {
    max-height: calc(var(--aoe-rail) * 2 + 8px);
  }
}
/*
 * Embedded and tall enough for the column: it stays on the left where it
 * belongs, and simply starts below the portal's band.
 */
@media (orientation: landscape) and (min-height: 450px) and (max-height: 500px) {
  body.aoe-portal-embedded.aoe-touch-mode .aoe-rail {
    top: calc(var(--aoe-portal-top) + 12px);
  }
}

/*
 * THE TALLY DROPS BELOW THE BAR ON A NARROW SCREEN.
 *
 * It is centred, so on a wide screen it is nowhere near the portal's corner -
 * but the band is 248 across, and a housing centred on a 480-wide phone starts
 * at 207. It reached into it by forty pixels. Below about 560 the two cannot
 * both have that strip, so the tally takes the line under it and stays
 * centred, which is where it is meant to be.
 *
 * Not scoped to landscape: a portrait phone is narrower still and has exactly
 * the same collision.
 */
@media (max-width: 580px) {
  body.aoe-portal-embedded .aoe-wins {
    top: calc(var(--aoe-portal-top) + 6px);
  }
}

/*
 * Tall enough to stand the rail back up: it is a COLUMN down the left again,
 * which is where it belongs and where a returning player looks for it.
 */
@media (orientation: landscape) and (min-height: 380px) and (max-height: 500px) {
  body.aoe-touch-mode .aoe-rail {
    flex-wrap: nowrap;
    max-height: none;
  }
}

/*
 * NARROW as well as short: the row does not fit beside the tally either.
 *
 * A row of four is 200 wide and the Wins housing is centred on the same strip,
 * so below about 500 the two meet in the middle - three pixels of overlap at
 * 480, which is a collision like any other. Two by two is 96 wide and clears
 * it with room to spare, and there is height for a second rank precisely
 * because this branch only runs on screens too short for the full column.
 *
 * 520 rather than 500: the tally grows with the number in it.
 */
@media (orientation: landscape) and (max-height: 379px) and (max-width: 520px) {
  body.aoe-touch-mode .aoe-rail {
    max-height: calc(var(--aoe-rail) * 2 + 8px);
  }
}
`;
  document.head.appendChild(style);
};

/**
 * The HUD icons, as supplied in `assets/ui/`.
 *
 * Served straight from the repo-level assets folder through Vite's publicDir,
 * exactly as the player model is - so there is no duplicate copy inside the
 * client workspace. They are the artwork from the reference screenshots, which
 * is why they are images rather than the hand-drawn SVGs they replaced: a
 * traced approximation of a piece of art you already have is a worse version
 * of it.
 *
 * `alt` is deliberately empty - each one sits inside a control that already
 * carries its own accessible name.
 */
const icon = (file: string): string =>
  `<img class="aoe-icon" src="/ui/${file}" alt="" draggable="false">`;

/*
 * The speaker is drawn rather than loaded.
 *
 * The other three are SUPPLIED ART and are used as they are; there is no
 * supplied speaker, and adding an image for a shape that is four straight
 * lines would be the one place in this project where a file bought nothing.
 */
const SPEAKER =
  '<svg class="aoe-icon" viewBox="0 0 24 24" aria-hidden="true">' +
  '<path fill="currentColor" d="M4 9h3.2L12 4.6v14.8L7.2 15H4z"/>' +
  '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'd="M15.6 8.6a4.6 4.6 0 0 1 0 6.8M18.4 5.8a8.4 8.4 0 0 1 0 12.4"/>' +
  '</svg>';

/**
 * The mech tile's icon, drawn rather than supplied.
 *
 * The asset set has no robot in it, and this is four rectangles - shoulders, a
 * torso and two legs, with the hollow where a head would be left EMPTY, which
 * is the whole silhouette of this game. An image file for that shape would be
 * the one place in this project where a download bought nothing.
 */
const MECH =
  '<svg class="aoe-icon" viewBox="0 0 24 24" aria-hidden="true">' +
  '<path fill="currentColor" d="M3 7h4v7H3zM17 7h4v7h-4z"/>' +
  '<path fill="currentColor" d="M8.5 6h7v9h-7z"/>' +
  '<path fill="currentColor" d="M9 16h2.2v5H9zM12.8 16H15v5h-2.2z"/>' +
  '<path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
  'd="M10 4.2h4"/>' +
  '</svg>';

export const ICONS = {
  trophy: icon('trophy.png'),
  rebirth: icon('rebirth.png'),
  trail: icon('trail.png'),
  mech: MECH,
  audio: SPEAKER,
} as const;
