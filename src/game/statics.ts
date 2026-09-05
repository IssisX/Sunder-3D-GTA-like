/**
 * Structural statics: what each support actually carries, and when a carried
 * element can no longer be held up.
 *
 * The load model this replaces divided a building's total mass by the number of
 * standing supports. That number has no position in it, so it could not express
 * the only structural question a player actually asks: *which* post, and does it
 * matter where the weight is. Cutting a corner post raised the load on the
 * diagonally opposite post exactly as much as on its neighbours, and a beam
 * dropped on one side of a roof loaded the far side identically.
 *
 * A support group carrying a rigid element is the classic eccentric bearing
 * problem: reactions must balance the load in force AND in moment about both
 * horizontal axes. With equal-stiffness supports that has a closed form -- a
 * linear pressure distribution over the support group -- and it degenerates
 * exactly to `W/n` when the load sits at the group's centroid, which is why the
 * calibration of the uniform model survives this change untouched.
 *
 * Units: masses in kg throughout, in a uniform gravity field, so a reaction in
 * kg is proportional to the force it stands for. Positions in m, world frame.
 */

/** Outcome of asking a support group to hold one load. */
export const HELD = 0;
/** The load lies outside what the live supports can balance: it tips off. */
export const TIPPED = 1;
/** Nothing is left to hold it. */
export const UNSUPPORTED = 2;

/** Reactions below this are treated as lift-off, kg. */
const TENSION_EPS = 1e-6;
/** Support-group spread below this is a degenerate (line or point) group, m^2. */
const SPREAD_EPS = 1e-4;
/**
 * How far off a degenerate group's own line a load may sit and still be called
 * held, m. A roof balanced on two posts in a line is standing on a knife edge;
 * within this it is teetering, beyond it it has gone over.
 */
const TIP_TOL = 0.12;

const active = new Uint8Array(64);

/**
 * Reactions of `n` supports carrying mass `W` applied at (loadX, loadZ).
 *
 * Solves R_i = W * (1/k + a*(x_i - xbar) + b*(z_i - zbar)) for the a, b that
 * balance the load's moment about the live group's centroid, then drops any
 * support the solution puts in tension and re-solves -- a support can push up
 * and cannot pull down, so a negative reaction means that corner has lifted off
 * rather than that it is holding on. Converges in at most `n` passes.
 *
 * `out[i]` receives support i's reaction in kg; dropped supports receive 0.
 * Returns HELD, TIPPED or UNSUPPORTED.
 */
export function solveReactions(
  sx: Float64Array,
  sz: Float64Array,
  live: Uint8Array,
  n: number,
  loadX: number,
  loadZ: number,
  W: number,
  out: Float64Array,
): number {
  if (n <= 0 || n > active.length) return UNSUPPORTED;
  // Every non-HELD exit clears `out`: a caller accumulating reactions across
  // several loads must never pick up the partial solution of a load that
  // turned out not to be carried at all.
  const bail = (code: number) => {
    for (let i = 0; i < n; i++) out[i] = 0;
    return code;
  };
  let k = 0;
  for (let i = 0; i < n; i++) {
    active[i] = live[i] ? 1 : 0;
    out[i] = 0;
    if (active[i]) k++;
  }
  if (k === 0) return UNSUPPORTED;
  if (!(W > 0)) return HELD;

  for (let pass = 0; pass < n; pass++) {
    // Centroid and second moments of the still-active group.
    let cx = 0;
    let cz = 0;
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      cx += sx[i]!;
      cz += sz[i]!;
    }
    cx /= k;
    cz /= k;

    let Sxx = 0;
    let Szz = 0;
    let Sxz = 0;
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      const dx = sx[i]! - cx;
      const dz = sz[i]! - cz;
      Sxx += dx * dx;
      Szz += dz * dz;
      Sxz += dx * dz;
    }
    const ex = loadX - cx;
    const ez = loadZ - cz;

    // Moment coefficients from the 2x2 second-moment system. A group spread in
    // only one direction (two posts, or a row) has a null direction: it can
    // resolve no moment across its own line, so a load off that line tips.
    let a = 0;
    let b = 0;
    const det = Sxx * Szz - Sxz * Sxz;
    if (det > SPREAD_EPS * SPREAD_EPS) {
      a = (ex * Szz - ez * Sxz) / det;
      b = (ez * Sxx - ex * Sxz) / det;
    } else if (Sxx + Szz > SPREAD_EPS) {
      // Degenerate: resolve the lever along the group's own axis, and require
      // the load to sit near that axis or it goes over the side.
      const ux = Sxx >= Szz ? 1 : 0;
      const uz = Sxx >= Szz ? 0 : 1;
      // Principal axis of a symmetric 2x2, closed form.
      const tr = Sxx + Szz;
      const diff = Math.sqrt(Math.max(0, (Sxx - Szz) * (Sxx - Szz) + 4 * Sxz * Sxz));
      const lam = (tr + diff) * 0.5;
      let px = Sxz;
      let pz = lam - Sxx;
      const pm = Math.hypot(px, pz);
      if (pm > 1e-9) {
        px /= pm;
        pz /= pm;
      } else {
        px = ux;
        pz = uz;
      }
      const along = ex * px + ez * pz;
      const across = ex * -pz + ez * px;
      if (Math.abs(across) > TIP_TOL) return bail(TIPPED);
      if (lam > SPREAD_EPS) {
        a = (along / lam) * px;
        b = (along / lam) * pz;
      }
    } else {
      // A single point (or coincident posts): it can carry the load only if the
      // load is essentially over it.
      if (Math.hypot(ex, ez) > TIP_TOL) return bail(TIPPED);
    }

    let worst = -1;
    let worstR = 0;
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      const r = W * (1 / k + a * (sx[i]! - cx) + b * (sz[i]! - cz));
      out[i] = r;
      if (r < -TENSION_EPS && r < worstR) {
        worstR = r;
        worst = i;
      }
    }
    if (worst < 0) return HELD;

    // That corner is being lifted, not loaded. Drop it and redistribute.
    active[worst] = 0;
    out[worst] = 0;
    k--;
    if (k === 0) return bail(TIPPED);
  }
  return HELD;
}
