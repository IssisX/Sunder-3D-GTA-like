import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// One-shot, fail-closed source repair for the inspected showcase revision.
// The build consumes the resulting ordinary TypeScript files, not this script.
function edit(path, replacements) {
  let source = readFileSync(path, 'utf8');
  for (const [before, after] of replacements) {
    if (!source.includes(before)) throw new Error(`Repair precondition failed: ${path}: ${before.slice(0, 90)}`);
    source = source.replace(before, after);
  }
  writeFileSync(path, source, 'utf8');
  console.log('REPAIRED', path, createHash('sha256').update(source).digest('hex'));
}

edit('src/game/body-render-core.ts', [
  ['interface HumanVisual {', 'export interface HumanVisual {'],
  ['  private visuals = new Map<number, HumanVisual>();', '  private visuals = new Map<number, HumanVisual>();\n\n  protected getVisual(id: number): HumanVisual | undefined {\n    return this.visuals.get(id);\n  }'],
]);

edit('src/game/body-appearance.ts', [
  ['import { BodyView as CoreBodyView } from "./body-render-core";', 'import { BodyView as CoreBodyView, type HumanVisual } from "./body-render-core";'],
  ['/** Presentation-only compatibility with the inspected original renderer. */\ninterface HumanVisual {\n  group: THREE.Group;\n  head: THREE.Mesh; torso: THREE.Mesh; chest: THREE.Mesh; pelvis: THREE.Mesh;\n  neck: THREE.Mesh; lArm: THREE.Mesh; rArm: THREE.Mesh;\n  lLeg: THREE.Mesh; rLeg: THREE.Mesh; lHand: THREE.Mesh; rHand: THREE.Mesh;\n  lFoot: THREE.Mesh; rFoot: THREE.Mesh; weapon: THREE.Mesh;\n  mats: Record<string, THREE.MeshStandardMaterial>;\n}\n', ''],
  ['  private readonly up = new THREE.Vector3();', '  private readonly appearanceUp = new THREE.Vector3();'],
  ['  private coreVisual(id: number): HumanVisual | undefined {\n    return (this as unknown as { visuals: Map<number, HumanVisual> }).visuals.get(id);\n  }', '  private coreVisual(id: number): HumanVisual | undefined {\n    return this.getVisual(id);\n  }'],
  ['  override forget() {\n    const geometries = new Set<THREE.BufferGeometry>();\n    const materials = new Set<THREE.Material>();\n    for (const app of this.appearances.values()) {\n      app.visual.group.traverse((o) => {\n        if (!(o instanceof THREE.Mesh)) return;\n        geometries.add(o.geometry);\n        const m = o.material;\n        if (Array.isArray(m)) for (const item of m) materials.add(item);\n        else materials.add(m);\n      });\n      this.sceneView.scene.remove(app.visual.group);\n      for (const m of app.materials) materials.add(m);\n    }\n    for (const g of geometries) g.dispose();\n    for (const m of materials) m.dispose();\n    this.appearances.clear();\n    super.forget();\n  }', '  override forget() {\n    // Shared geometry survives a restart; only actor-owned resources are released.\n    for (const app of this.appearances.values()) {\n      const v = app.visual;\n      this.sceneView.scene.remove(v.group);\n      for (const limb of [v.lArm, v.rArm, v.lLeg, v.rLeg]) limb.geometry.dispose();\n      for (const m of Object.values(v.mats)) m.dispose();\n      const helmet = v.group.getObjectByName("helmet");\n      if (helmet instanceof THREE.Mesh) {\n        if (Array.isArray(helmet.material)) helmet.material.forEach(m => m.dispose());\n        else helmet.material.dispose();\n      }\n      for (const m of app.materials) m.dispose();\n    }\n    this.appearances.clear();\n    super.forget();\n  }'],
  ['  private readonly worldUp = new THREE.Vector3(0, 1, 0);', '  private readonly worldUp = new THREE.Vector3(0, 1, 0);\n  private readonly weaponOffset = new THREE.Vector3();'],
  ['    app.weapon.position.copy(v.weapon.position);\n    app.weapon.quaternion.copy(v.weapon.quaternion);\n    app.weapon.scale.set(scale, v.weapon.scale.y, scale);', '    app.weapon.position.copy(v.weapon.position);\n    app.weapon.quaternion.copy(v.weapon.quaternion);\n    // Match the actual carrier length and center. The decorative mesh cannot\n    // silently extend the physical weapon reach.\n    const range = this.weaponRange(a.weapon);\n    const span = range[1] - range[0];\n    const sy = v.weapon.scale.y / span;\n    app.weapon.scale.set(scale, sy, scale);\n    this.weaponOffset.set(0, (range[0] + range[1]) * -0.5 * sy, 0);\n    this.weaponOffset.applyQuaternion(v.weapon.quaternion);\n    app.weapon.position.add(this.weaponOffset);'],
  ['  private rebuildWeapon(a: Actor, app: Appearance, leather: THREE.Material, metal: THREE.Material, dark: THREE.Material) {', '  private weaponRange(kind: WeaponKind): [number, number] {\n    if (kind === "club") return [-0.49, 0.53];\n    if (kind === "board") return [-0.5, 0.5];\n    if (kind === "spear") return [-0.5, 0.55];\n    if (kind === "pitchfork") return [-0.5, 0.635];\n    if (kind === "knife") return [-0.5, 0.52];\n    if (kind === "torch") return [-0.47, 0.71];\n    return [-0.5, 0.5];\n  }\n\n  private rebuildWeapon(a: Actor, app: Appearance, leather: THREE.Material, metal: THREE.Material, dark: THREE.Material) {'],
]);
// Rename the entire subclass scratch field, including all uses, without
// touching the core renderer's fixed world-up vector.
{
  const path = 'src/game/body-appearance.ts';
  let source = readFileSync(path, 'utf8');
  if (!source.includes('this.up.')) throw new Error('Missing appearance-up references');
  source = source.replaceAll('this.up', 'this.appearanceUp');
  writeFileSync(path, source, 'utf8');
}

edit('src/game/soundscape.ts', [
  ['  private noise: AudioBuffer | null = null;', '  private richNoise: AudioBuffer | null = null;'],
  ['      pending++;\n      const osc = ctx.createOscillator(); osc.type = type;', '      const osc = ctx.createOscillator(); osc.type = type;'],
]);
{
  const path = 'src/game/soundscape.ts';
  let source = readFileSync(path, 'utf8');
  source = source.replaceAll('this.noise', 'this.richNoise');
  if (source.includes('private noise:') || source.includes('this.noise')) throw new Error('Audio field collision remains');
  writeFileSync(path, source, 'utf8');
}
console.log('SHOWCASE SOURCE REPAIR PASS');
