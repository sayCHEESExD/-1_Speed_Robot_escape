/** Normalised, device-agnostic input snapshot consumed by the player controller. */
export interface InputState {
  /** -1 (left) .. 1 (right), camera-relative. */
  moveX: number;
  /** -1 (back) .. 1 (forward), camera-relative. */
  moveZ: number;
  /**
   * The jump control (Space, or the on-screen JUMP button), HELD.
   *
   * Still called `jump` because it is the same wire field and the same key,
   * but a robot does not hop: held it launches and then flies, released it
   * does nothing at all. It is a LEVEL rather than an edge for that reason -
   * an edge here would be a press the simulation never saw, because the
   * simulation is what edge-detects it - see `PlayerSim.applyJump`.
   */
  jump: boolean;
}

export const createInputState = (): InputState => ({
  moveX: 0,
  moveZ: 0,
  jump: false,
});
