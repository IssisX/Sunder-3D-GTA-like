import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Complete the fail-closed repair and leave ordinary, directly buildable source.
await import('./repair-showcase-core.mjs');

function edit(path, before, after) {
  const source = readFileSync(path, 'utf8');
  if (!source.includes(before)) throw new Error(`Final repair precondition failed: ${path}`);
  const output = source.replace(before, after);
  writeFileSync(path, output, 'utf8');
  console.log('FINAL SOURCE', path, createHash('sha256').update(output).digest('hex'));
}

const appearance = 'src/game/body-appearance.ts';
edit(appearance,
  'export class BodyView extends CoreBodyView {',
  `const VISUAL_WEAPON_RANGES: Record<WeaponKind, readonly [number, number]> = {
  fist: [-0.5, 0.5], club: [-0.49, 0.53], board: [-0.5, 0.5],
  spear: [-0.5, 0.55], pitchfork: [-0.5, 0.635],
  knife: [-0.5, 0.52], torch: [-0.47, 0.71],
};

export class BodyView extends CoreBodyView {`);
edit(appearance,
  `  private weaponRange(kind: WeaponKind): [number, number] {
    if (kind === "club") return [-0.49, 0.53];
    if (kind === "board") return [-0.5, 0.5];
    if (kind === "spear") return [-0.5, 0.55];
    if (kind === "pitchfork") return [-0.5, 0.635];
    if (kind === "knife") return [-0.5, 0.52];
    if (kind === "torch") return [-0.47, 0.71];
    return [-0.5, 0.5];
  }

`, '');
edit(appearance, 'const range = this.weaponRange(a.weapon);',
  'const range = VISUAL_WEAPON_RANGES[a.weapon];');

const audio = 'src/game/soundscape.ts';
edit(audio, '  private lastVoice = -Infinity;',
  '  private lastVoice = -Infinity;\n  private readonly lastEvent = new Map<string, number>();');
edit(audio,
  '    const t = this.ctx.currentTime;\n    if ((kind === "shout"',
  `    const t = this.ctx.currentTime;
    const last = this.lastEvent.get(kind) ?? -Infinity;
    if (t - last < 0.035) return;
    this.lastEvent.set(kind, t);
    if ((kind === "shout"`);
edit(audio, '    this.sources.length = 0;',
  '    this.sources.length = 0;\n    this.lastEvent.clear();\n    this.richNoise = null;');

const body = readFileSync(appearance, 'utf8');
const sound = readFileSync(audio, 'utf8');
if (body.includes('this.up.') || body.includes('this.weaponRange(') ||
    sound.includes('this.noise') || sound.includes('private noise:')) {
  throw new Error('A conflicting field or per-frame range allocation survived repair');
}
console.log('SHOWCASE REPAIR COMPLETE');
