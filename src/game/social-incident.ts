import type { Actor } from "./types";
import type { World } from "./world";
import { canSeeThrough, clamp, lerpAng } from "./world";
import { agentRandom, agentSpeedScale, prepareAgent } from "./agent-independence";

const ENTITY_CAP = 8192;
const INCIDENT_CAP = 8;
const INCIDENT_TTL = 11;
const HUMAN_OBSERVE_RADIUS = 9.5;
const ANIMAL_PROTECT_RADIUS = 6;
const MAX_JOINERS = 5;

export const SOCIAL_ROLE = { NONE: 0, FIGHTER: 1, SPECTATOR: 2, LEAVE: 3 } as const;
export const EDGES = { localIncidentRoles: true };
function human(a: Actor) { return a.kind === "player" || a.species === "human"; }
function beast(a: Actor) { return a.kind === "beast"; }
function hash01(v: number) { v = Math.imul(v ^ (v >>> 16), 0x7feb352d); v = Math.imul(v ^ (v >>> 15), 0x846ca68b); v = (v ^ (v >>> 16)) >>> 0; return v / 4294967296; }
function desiredYaw(dx: number, dz: number) { return Math.atan2(-dx, -dz); }

export class SocialIncidentController {
  private readonly active = new Uint8Array(INCIDENT_CAP);
  private readonly attacker = new Int32Array(INCIDENT_CAP);
  private readonly victim = new Int32Array(INCIDENT_CAP);
  private readonly started = new Float32Array(INCIDENT_CAP);
  private readonly touched = new Float32Array(INCIDENT_CAP);
  private readonly centerX = new Float32Array(INCIDENT_CAP);
  private readonly centerZ = new Float32Array(INCIDENT_CAP);
  private readonly intensity = new Float32Array(INCIDENT_CAP);
  private readonly serial = new Uint32Array(INCIDENT_CAP);
  private readonly incidentByActor = new Int16Array(ENTITY_CAP);
  private readonly role = new Uint8Array(ENTITY_CAP);
  private readonly target = new Int32Array(ENTITY_CAP);
  private readonly ringAngle = new Float32Array(ENTITY_CAP);
  private readonly ringRadius = new Float32Array(ENTITY_CAP);
  private readonly chantCd = new Float32Array(ENTITY_CAP);
  private readonly chantPulse = new Float32Array(ENTITY_CAP);
  private readonly sideSign = new Int8Array(ENTITY_CAP);
  private readonly candidateId = new Int32Array(MAX_JOINERS);
  private readonly candidateScore = new Float32Array(MAX_JOINERS);
  private serialCounter = 1;
  constructor() { this.incidentByActor.fill(-1); }
  reset() { this.active.fill(0); this.attacker.fill(0); this.victim.fill(0); this.started.fill(0); this.touched.fill(0); this.centerX.fill(0); this.centerZ.fill(0); this.intensity.fill(0); this.serial.fill(0); this.incidentByActor.fill(-1); this.role.fill(0); this.target.fill(0); this.ringAngle.fill(0); this.ringRadius.fill(0); this.chantCd.fill(0); this.chantPulse.fill(0); this.sideSign.fill(0); this.serialCounter = 1; }
  reportAggression(w: World, atk: Actor, vic: Actor, kind: "strike" | "kick" | "beast", severity: number) {
    if (!EDGES.localIncidentRoles || !atk.alive || !vic.alive || atk.id === vic.id) return;
    const existing = this.findIncident(atk.id, vic.id, w.time);
    if (existing >= 0) { this.touched[existing] = w.time; this.centerX[existing] = (atk.x + vic.x) * 0.5; this.centerZ[existing] = (atk.z + vic.z) * 0.5; this.intensity[existing] = Math.max(this.intensity[existing]!, this.incidentIntensity(atk, kind, severity)); this.ensureEndpointRoles(w, existing, atk, vic, severity); return; }
    const slot = this.allocateIncident(w); this.active[slot] = 1; this.attacker[slot] = atk.id; this.victim[slot] = vic.id; this.started[slot] = w.time; this.touched[slot] = w.time; this.centerX[slot] = (atk.x + vic.x) * 0.5; this.centerZ[slot] = (atk.z + vic.z) * 0.5; this.intensity[slot] = this.incidentIntensity(atk, kind, severity); this.serial[slot] = this.serialCounter++;
    this.ensureEndpointRoles(w, slot, atk, vic, severity); if (human(atk) && human(vic)) this.assignHumanWitnesses(w, slot, atk, vic); if (beast(vic)) this.assignProtectiveAnimal(w, slot, atk, vic);
  }
  step(w: World, dt: number) {
    const h = clamp(dt, 0, 0.1); for (let id = 0; id < ENTITY_CAP; id++) if (this.chantPulse[id] > 0) this.chantPulse[id] = Math.max(0, this.chantPulse[id]! - h);
    if (!EDGES.localIncidentRoles) { this.clearAllRoles(); return; }
    for (let slot = 0; slot < INCIDENT_CAP; slot++) { if (!this.active[slot]) continue; const atk = w.actor(this.attacker[slot]!); const vic = w.actor(this.victim[slot]!); if (atk && vic) { this.centerX[slot] = (atk.x + vic.x) * 0.5; this.centerZ[slot] = (atk.z + vic.z) * 0.5; } const age = w.time - this.touched[slot]!; if (age > INCIDENT_TTL || ((!atk || !atk.alive) && (!vic || !vic.alive) && age > 1.2)) this.expire(slot); }
    for (const a of w.actors) { if (a.kind === "player" || a.id < 0 || a.id >= ENTITY_CAP) continue; const slot = this.incidentByActor[a.id]!; if (slot < 0 || !this.active[slot]) continue; const role = this.role[a.id]!; if (role === 1) this.driveFighter(w, a); else if (role === 2) this.driveSpectator(w, a, slot, h); else if (role === 3) this.driveLeave(w, a, slot); }
  }
  roleOf(id: number) { return id >= 0 && id < ENTITY_CAP ? this.role[id]! : 0; }
  fightTarget(id: number) { return id >= 0 && id < ENTITY_CAP && this.role[id] === 1 ? this.target[id]! : 0; }
  chantLevel(id: number) { return id >= 0 && id < ENTITY_CAP ? this.chantPulse[id]! : 0; }
  activeIncidentCount() { let n = 0; for (let i = 0; i < INCIDENT_CAP; i++) if (this.active[i]) n++; return n; }
  private incidentIntensity(atk: Actor, kind: "strike" | "kick" | "beast", severity: number) { return clamp(0.32 + (atk.weapon !== "fist" ? 0.22 : 0) + (kind === "kick" ? 0.12 : kind === "beast" ? 0.18 : 0.08) + severity * 0.34, 0.2, 1.4); }
  private findIncident(a: number, b: number, now: number) { for (let i = 0; i < INCIDENT_CAP; i++) { if (!this.active[i] || now - this.touched[i]! > INCIDENT_TTL) continue; if ((this.attacker[i] === a && this.victim[i] === b) || (this.attacker[i] === b && this.victim[i] === a)) return i; } return -1; }
  private allocateIncident(w: World) { let oldest = 0, oldestTime = Infinity; for (let i = 0; i < INCIDENT_CAP; i++) { if (!this.active[i]) { this.clearSlotActors(w, i); return i; } if (this.touched[i]! < oldestTime) { oldestTime = this.touched[i]!; oldest = i; } } this.clearSlotActors(w, oldest); return oldest; }
  private clearSlotActors(w: World, slot: number) { for (const a of w.actors) if (a.id >= 0 && a.id < ENTITY_CAP && this.incidentByActor[a.id] === slot) this.clearActor(a.id); this.active[slot] = 0; }
  private expire(slot: number) { this.active[slot] = 0; for (let id = 0; id < ENTITY_CAP; id++) if (this.incidentByActor[id] === slot) this.clearActor(id); }
  private clearAllRoles() { this.active.fill(0); this.incidentByActor.fill(-1); this.role.fill(0); this.target.fill(0); this.chantCd.fill(0); this.chantPulse.fill(0); }
  private clearActor(id: number) { this.incidentByActor[id] = -1; this.role[id] = 0; this.target[id] = 0; this.chantCd[id] = 0; this.chantPulse[id] = 0; }
  private ensureEndpointRoles(w: World, slot: number, atk: Actor, vic: Actor, severity: number) { if (atk.kind !== "player" && atk.id >= 0 && atk.id < ENTITY_CAP) this.assignFighter(w, slot, atk, vic.id); if (vic.kind !== "player" && vic.id >= 0 && vic.id < ENTITY_CAP && this.role[vic.id] === 0) { if (this.victimFights(w, vic, severity)) this.assignFighter(w, slot, vic, atk.id); else this.assignLeave(w, slot, vic); } }
  private victimFights(w: World, vic: Actor, severity: number) { prepareAgent(w, vic); if (human(vic)) { if (vic.faction === "guard") return true; const drive = vic.courage * 0.38 + vic.aggression * 0.3 + vic.competence * 0.16 + vic.loyalty * 0.1 - vic.fear * 0.24 - severity * 0.05; return agentRandom(w, vic) < clamp(0.15 + drive * 0.9, 0.08, 0.9); } const base = vic.species === "bear" ? 0.92 : vic.species === "wolf" ? 0.82 : vic.species === "cow" ? 0.3 : vic.species === "pig" ? 0.12 : vic.species === "goat" ? 0.09 : 0.025; return agentRandom(w, vic) < clamp(base + vic.courage * 0.22 + vic.aggression * 0.2 + severity * 0.08 - vic.fear * 0.18, 0.02, 0.96); }
  private assignHumanWitnesses(w: World, slot: number, atk: Actor, vic: Actor) {
    this.candidateId.fill(0); this.candidateScore.fill(-Infinity); let socialCandidates = 0, localGuards = 0;
    for (const o of w.actors) { if (!o.alive || o.kind === "player" || o.species !== "human" || o.id === atk.id || o.id === vic.id) continue; const dx = this.centerX[slot]! - o.x, dz = this.centerZ[slot]! - o.z, d = Math.hypot(dx, dz); if (d > HUMAN_OBSERVE_RADIUS || !this.canObserve(w, o, this.centerX[slot]!, this.centerZ[slot]!, d)) continue; prepareAgent(w, o); const sameFaction = vic.faction !== "none" && o.faction === vic.faction; const guardDuty = o.faction === "guard" && atk.faction !== "guard"; const homeD = Math.hypot(o.homeX - vic.homeX, o.homeZ - vic.homeZ); const neighborhood = Math.exp(-homeD * 0.17); if (sameFaction && neighborhood > 0.18) socialCandidates++; if (guardDuty) localGuards++; if (sameFaction || guardDuty) { const score = (sameFaction ? 0.12 : 0) + (guardDuty ? 0.36 : 0) + o.loyalty * 0.26 + o.courage * 0.18 + o.aggression * 0.22 + neighborhood * 0.2 - o.fear * 0.22 - d * 0.025 + agentRandom(w, o) * 0.08; if (score > 0.52) this.insertCandidate(o.id, score); } }
    const roll = hash01((w.seed >>> 0) ^ Math.imul(atk.id + 17, 0x9e3779b1) ^ Math.imul(vic.id + 31, 0x85ebca6b) ^ this.serial[slot]!); let joinCap = 0; if (socialCandidates >= 1 && roll < 0.42) joinCap = 1; if (socialCandidates >= 3 && roll < 0.18) joinCap = 2; if (socialCandidates >= 5 && roll < 0.045) joinCap = Math.min(MAX_JOINERS, socialCandidates); if (localGuards > 0) joinCap = Math.max(joinCap, Math.min(3, localGuards));
    let joined = 0; for (let i = 0; i < MAX_JOINERS && joined < joinCap; i++) { const id = this.candidateId[i]!; if (!id) continue; const o = w.actor(id); if (!o?.alive) continue; this.assignFighter(w, slot, o, atk.id); joined++; }
    for (const o of w.actors) { if (!o.alive || o.kind === "player" || o.species !== "human" || o.id === atk.id || o.id === vic.id || o.id < 0 || o.id >= ENTITY_CAP || this.role[o.id] !== 0) continue; const dx = this.centerX[slot]! - o.x, dz = this.centerZ[slot]! - o.z, d = Math.hypot(dx, dz); if (d > HUMAN_OBSERVE_RADIUS || !this.canObserve(w, o, this.centerX[slot]!, this.centerZ[slot]!, d)) continue; prepareAgent(w, o); if (o.faction === "guard") { this.assignLeave(w, slot, o); continue; } const drive = 0.42 + o.courage * 0.34 - o.fear * 0.42 - this.intensity[slot]! * 0.12 + agentRandom(w, o) * 0.16; if (drive > 0.44) this.assignSpectator(w, slot, o); else this.assignLeave(w, slot, o); }
  }
  private assignProtectiveAnimal(w: World, slot: number, atk: Actor, vic: Actor) { let best: Actor | null = null, bestBond = 0; for (const o of w.actors) { if (!o.alive || o.kind !== "beast" || o.id === vic.id || o.id === atk.id || o.species !== vic.species) continue; const d = Math.hypot(o.x - vic.x, o.z - vic.z); if (d > ANIMAL_PROTECT_RADIUS) continue; const sharedHome = Math.hypot(o.homeX - vic.homeX, o.homeZ - vic.homeZ); if (sharedHome > 4.5) continue; prepareAgent(w, o); const bond = Math.exp(-sharedHome * 0.45) * 0.42 + o.loyalty * 0.22 + o.courage * 0.18 + o.aggression * 0.08 - d * 0.025; const chance = clamp(0.025 + bond * 0.16, 0.02, 0.18); if (agentRandom(w, o) < chance && bond > bestBond) { best = o; bestBond = bond; } } if (best) this.assignFighter(w, slot, best, atk.id); }
  private insertCandidate(id: number, score: number) { for (let i = 0; i < MAX_JOINERS; i++) { if (score <= this.candidateScore[i]!) continue; for (let j = MAX_JOINERS - 1; j > i; j--) { this.candidateScore[j] = this.candidateScore[j - 1]!; this.candidateId[j] = this.candidateId[j - 1]!; } this.candidateScore[i] = score; this.candidateId[i] = id; return; } }
  private assignFighter(w: World, slot: number, a: Actor, targetId: number) { if (a.id < 0 || a.id >= ENTITY_CAP) return; prepareAgent(w, a); this.incidentByActor[a.id] = slot; this.role[a.id] = 1; this.target[a.id] = targetId; this.sideSign[a.id] = agentRandom(w, a) < 0.5 ? -1 : 1; a.attackCd = Math.max(a.attackCd, agentRandom(w, a) * 0.55); }
  private assignSpectator(w: World, slot: number, a: Actor) { if (a.id < 0 || a.id >= ENTITY_CAP) return; prepareAgent(w, a); this.incidentByActor[a.id] = slot; this.role[a.id] = 2; this.target[a.id] = 0; this.ringAngle[a.id] = agentRandom(w, a) * Math.PI * 2; this.ringRadius[a.id] = 2.7 + agentRandom(w, a) * 1.25; this.chantCd[a.id] = 0.22 + agentRandom(w, a) * 0.78; this.chantPulse[a.id] = 0; }
  private assignLeave(w: World, slot: number, a: Actor) { if (a.id < 0 || a.id >= ENTITY_CAP) return; prepareAgent(w, a); this.incidentByActor[a.id] = slot; this.role[a.id] = 3; this.target[a.id] = 0; this.sideSign[a.id] = agentRandom(w, a) < 0.5 ? -1 : 1; }
  private canObserve(w: World, a: Actor, x: number, z: number, d: number) { if (d <= 3.2) return true; const dx = x - a.x, dz = z - a.z, dot = (dx * -Math.sin(a.yaw) + dz * -Math.cos(a.yaw)) / Math.max(d, 1e-5); if (d > 5.5 && dot < -0.1) return false; if (!canSeeThrough(w, a.x, a.z, x, z)) return false; return w.smoke[w.cell(x, z)]! + w.smoke[w.cell((a.x + x) * 0.5, (a.z + z) * 0.5)]! < 1.45; }
  private driveFighter(w: World, a: Actor) { const target = w.actor(this.target[a.id]!); if (!target?.alive) { this.clearActor(a.id); return; } const dx = target.x - a.x, dz = target.z - a.z, d = Math.hypot(dx, dz) || 1, nx = dx / d, nz = dz / d, desired = Math.max(0.9, a.radius + target.radius + (human(a) ? 0.58 : 0.38)); a.targetId = target.id; a.lastSeenX = target.x; a.lastSeenZ = target.z; a.lastSeenT = w.time; a.alert = 1; a.ai = human(a) ? "combat" : "hunt"; if (human(a) && !a.known.includes(target.id)) a.known.push(target.id); a.yaw = lerpAng(a.yaw, desiredYaw(nx, nz), 0.32); if (d > desired + 0.34) { a.intendX = nx; a.intendZ = nz; a.intendSpeed = (human(a) ? 4.25 : 4.8) * agentSpeedScale(a); return; } if (d < desired * 0.72) { a.intendX = -nx; a.intendZ = -nz; a.intendSpeed = 1.6 * agentSpeedScale(a); return; } const side = this.sideSign[a.id] || 1, cooldown = clamp(a.attackCd / 0.8, 0, 1); a.intendX = nx * (1 - cooldown * 0.65) + -nz * side * cooldown * 0.65; a.intendZ = nz * (1 - cooldown * 0.65) + nx * side * cooldown * 0.65; const m = Math.hypot(a.intendX, a.intendZ) || 1; a.intendX /= m; a.intendZ /= m; a.intendSpeed = (0.42 + cooldown * 1.35) * agentSpeedScale(a); }
  private driveSpectator(w: World, a: Actor, slot: number, dt: number) { const cx = this.centerX[slot]!, cz = this.centerZ[slot]!, angle = this.ringAngle[a.id]!, radius = this.ringRadius[a.id]!, tx = cx + Math.cos(angle) * radius, tz = cz + Math.sin(angle) * radius, dx = tx - a.x, dz = tz - a.z, d = Math.hypot(dx, dz); a.ai = "investigate"; a.targetId = 0; if (d > 0.38) { a.intendX = dx / d; a.intendZ = dz / d; a.intendSpeed = Math.min(2.8, 1.35 + d * 0.58) * agentSpeedScale(a); } else a.intendSpeed = 0; const lx = cx - a.x, lz = cz - a.z, ld = Math.hypot(lx, lz); if (ld > 0.05) a.yaw = lerpAng(a.yaw, desiredYaw(lx / ld, lz / ld), 0.24); if (!this.fightIsLive(w, slot) || w.time - this.started[slot]! < 0.42) return; this.chantCd[a.id] -= dt; if (this.chantCd[a.id] > 0 || Math.hypot(a.x - cx, a.z - cz) > radius + 1.6) return; this.chantPulse[a.id] = 0.56; this.chantCd[a.id] = 0.68 + agentRandom(w, a) * 0.92; w.events.push({ kind: "social:chant", x: a.x, z: a.z, a: a.id, mag: 0.68, text: "FIGHT!" }); w.emitSound(a.x, a.z, 0.62, "shout", a.id); }
  private driveLeave(w: World, a: Actor, slot: number) { const dx = a.x - this.centerX[slot]!, dz = a.z - this.centerZ[slot]!, d = Math.hypot(dx, dz) || 1; a.ai = "flee"; a.targetId = 0; a.intendX = dx / d; a.intendZ = dz / d; a.intendSpeed = 3.6 * agentSpeedScale(a); if (d > 11 || w.time - this.started[slot]! > 4.8) this.clearActor(a.id); }
  private fightIsLive(w: World, slot: number) { const atk = w.actor(this.attacker[slot]!), vic = w.actor(this.victim[slot]!); if (!atk?.alive || !vic?.alive) return false; if (atk.kind === "player") return this.role[vic.id] === 1; if (vic.kind === "player") return this.role[atk.id] === 1; return this.role[atk.id] === 1 && this.role[vic.id] === 1; }
}
export const socialIncidents = new SocialIncidentController();
