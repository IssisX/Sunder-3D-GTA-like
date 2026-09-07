import * as THREE from "three";
import type { World } from "./world";
import { BODY, type PhysicalBodies } from "./body";
import { socialIncidents } from "./social-incident";

function makeFightTexture() {
  const canvas = document.createElement("canvas"); canvas.width = 384; canvas.height = 160;
  const g = canvas.getContext("2d")!; g.clearRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = "rgba(255,255,255,0.96)"; g.strokeStyle = "rgba(20,18,16,0.94)"; g.lineWidth = 10;
  g.beginPath(); g.roundRect(18, 16, 348, 112, 28); g.fill(); g.stroke();
  g.beginPath(); g.moveTo(170, 126); g.lineTo(192, 153); g.lineTo(214, 126); g.closePath(); g.fill(); g.stroke();
  g.fillStyle = "#161412"; g.font = "900 66px system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("FIGHT!", 192, 73);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.needsUpdate = true; return texture;
}

export class FightBubbleView {
  private readonly sprites = new Map<number, THREE.Sprite>();
  private readonly texture = makeFightTexture();
  constructor(private readonly scene: THREE.Scene, private readonly bodies: PhysicalBodies) {}
  sync(w: World) {
    for (const sprite of this.sprites.values()) sprite.visible = false;
    for (const a of w.actors) {
      if (!a.alive || (a.kind !== "player" && a.species !== "human")) continue;
      const pulse = socialIncidents.chantLevel(a.id); if (pulse <= 0) continue;
      const sprite = this.ensure(a.id); const rig = this.bodies.get(a);
      if (rig?.initialized) sprite.position.set(rig.x[BODY.head]!, rig.y[BODY.head]! + 0.46, rig.z[BODY.head]!);
      else sprite.position.set(a.x, a.y + a.height + 0.42, a.z);
      sprite.scale.set(1.42, 0.59, 1); (sprite.material as THREE.SpriteMaterial).opacity = Math.min(1, pulse * 3.2); sprite.visible = true;
    }
  }
  dispose() { for (const sprite of this.sprites.values()) { this.scene.remove(sprite); (sprite.material as THREE.SpriteMaterial).dispose(); } this.sprites.clear(); this.texture.dispose(); }
  private ensure(id: number) { const existing = this.sprites.get(id); if (existing) return existing; const material = new THREE.SpriteMaterial({ map: this.texture, transparent: true, depthWrite: false, depthTest: true, opacity: 1 }); const sprite = new THREE.Sprite(material); sprite.visible = false; sprite.renderOrder = 6; this.scene.add(sprite); this.sprites.set(id, sprite); return sprite; }
}
