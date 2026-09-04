export interface Actions {
  moveX: number;
  moveY: number;
  lookX: number;
  lookY: number;
  sprint: boolean;
  crouch: boolean;
  jump: boolean;
  jumpPressed: boolean;
  attack: boolean;
  attackPressed: boolean;
  grab: boolean;
  grabPressed: boolean;
  grabReleased: boolean;
  kick: boolean;
  kickPressed: boolean;
  shove: boolean;
  shovePressed: boolean;
  drop: boolean;
  dropPressed: boolean;
  bandage: boolean;
  ignite: boolean;
  ignitePressed: boolean;
  pausePressed: boolean;
}

const EMPTY: Actions = {
  moveX: 0,
  moveY: 0,
  lookX: 0,
  lookY: 0,
  sprint: false,
  crouch: false,
  jump: false,
  jumpPressed: false,
  attack: false,
  attackPressed: false,
  grab: false,
  grabPressed: false,
  grabReleased: false,
  kick: false,
  kickPressed: false,
  shove: false,
  shovePressed: false,
  drop: false,
  dropPressed: false,
  bandage: false,
  ignite: false,
  ignitePressed: false,
  pausePressed: false,
};

const GAME_CODES = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ShiftLeft",
  "ShiftRight",
  "Space",
  "KeyC",
  "KeyE",
  "KeyF",
  "KeyG",
  "KeyQ",
  "KeyR",
  "KeyV",
  "KeyT",
  "Escape",
  "ControlLeft",
]);

function radial(x: number, y: number, dz = 0.16): { x: number; y: number } {
  const m = Math.hypot(x, y);
  if (m < dz) return { x: 0, y: 0 };
  const scale = (m - dz) / (1 - dz) / m;
  return { x: x * scale, y: y * scale };
}

export function isTouchDevice() {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
}

export class Input {
  keys = new Set<string>();
  injected: string[] | null = null;
  private prev = { ...EMPTY };
  mouseDx = 0;
  mouseDy = 0;
  locked = false;
  lookSens = 0.0022;
  lookTouchSens = 0.0074;
  invertY = false;
  enabled = false;
  hudControls = false;
  private padAwake = false;
  private pointerIds = new Map<number, { role: "joy" | "look" | "btn"; x: number; y: number; sx: number; sy: number; btn?: string }>();
  joyX = 0;
  joyY = 0;
  lookTouchX = 0;
  lookTouchY = 0;
  heldButtons = new Set<string>();
  canvas: HTMLElement;
  onLock?: (locked: boolean) => void;

  constructor(canvas: HTMLElement) {
    this.canvas = canvas;
    this.onKey = this.onKey.bind(this);
    this.onMouse = this.onMouse.bind(this);
    this.onPointer = this.onPointer.bind(this);
    this.onBlur = this.onBlur.bind(this);
    this.onLockChange = this.onLockChange.bind(this);
    window.addEventListener("keydown", this.onKey);
    window.addEventListener("keyup", this.onKey);
    window.addEventListener("blur", this.onBlur);
    document.addEventListener("visibilitychange", this.onBlur);
    document.addEventListener("pointerlockchange", this.onLockChange);
    canvas.addEventListener("mousemove", this.onMouse);
    canvas.addEventListener("mousedown", this.onMouse);
    canvas.addEventListener("mouseup", this.onMouse);
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("pointerdown", this.onPointer, { passive: false });
    canvas.addEventListener("pointermove", this.onPointer, { passive: false });
    canvas.addEventListener("pointerup", this.onPointer);
    canvas.addEventListener("pointercancel", this.onPointer);
    canvas.addEventListener("lostpointercapture", this.onPointer);
  }

  dispose() {
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener("keyup", this.onKey);
    window.removeEventListener("blur", this.onBlur);
    document.removeEventListener("visibilitychange", this.onBlur);
    document.removeEventListener("pointerlockchange", this.onLockChange);
    this.canvas.removeEventListener("mousemove", this.onMouse);
    this.canvas.removeEventListener("mousedown", this.onMouse);
    this.canvas.removeEventListener("mouseup", this.onMouse);
    this.canvas.removeEventListener("pointerdown", this.onPointer);
    this.canvas.removeEventListener("pointermove", this.onPointer);
    this.canvas.removeEventListener("pointerup", this.onPointer);
    this.canvas.removeEventListener("pointercancel", this.onPointer);
    this.canvas.removeEventListener("lostpointercapture", this.onPointer);
  }

  requestLock() {
    if (this.locked) return;
    if (isTouchDevice()) return;
    this.canvas.requestPointerLock?.();
  }

  setKeys(codes: string[]) {
    this.injected = codes;
  }

  setHudControls(on: boolean) {
    this.hudControls = on;
    if (!on) {
      this.joyX = 0;
      this.joyY = 0;
    }
  }

  setStick(x: number, y: number) {
    this.joyX = Math.max(-1, Math.min(1, x));
    this.joyY = Math.max(-1, Math.min(1, y));
  }

  addLook(dx: number, dy: number) {
    this.lookTouchX += dx;
    this.lookTouchY += dy;
  }

  private onLockChange() {
    this.locked = document.pointerLockElement === this.canvas;
    this.onLock?.(this.locked);
  }

  private onBlur() {
    this.keys.clear();
    this.mouseDx = 0;
    this.mouseDy = 0;
    this.joyX = 0;
    this.joyY = 0;
    this.lookTouchX = 0;
    this.lookTouchY = 0;
    this.pointerIds.clear();
    this.heldButtons.clear();
  }

  private onKey(e: KeyboardEvent) {
    if (!this.enabled && e.type === "keydown") return;
    if (e.type === "keydown") {
      this.keys.add(e.code);
      if (GAME_CODES.has(e.code)) e.preventDefault();
    } else {
      this.keys.delete(e.code);
    }
  }

  private onMouse(e: MouseEvent) {
    if (!this.enabled) return;
    if (e.type === "mousemove" && this.locked) {
      this.mouseDx += e.movementX;
      this.mouseDy += e.movementY;
    }
    if (e.type === "mousedown") {
      if (e.button === 0) this.heldButtons.add("attack");
      if (e.button === 2) this.heldButtons.add("grab");
    }
    if (e.type === "mouseup") {
      if (e.button === 0) this.heldButtons.delete("attack");
      if (e.button === 2) this.heldButtons.delete("grab");
    }
  }

  private onPointer(e: PointerEvent) {
    if (!this.enabled) return;
    if (e.pointerType === "mouse") return;
    if (this.hudControls) return;
    if (e.type === "pointerdown" || e.type === "pointermove") e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (e.type === "pointerdown") {
      const role: "joy" | "look" = x < rect.width * 0.42 ? "joy" : "look";
      this.pointerIds.set(e.pointerId, { role, x, y, sx: x, sy: y });
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    } else if (e.type === "pointermove") {
      const p = this.pointerIds.get(e.pointerId);
      if (!p) return;
      if (p.role === "joy") {
        const dx = (x - p.sx) / 72;
        const dy = (y - p.sy) / 72;
        const v = radial(dx, dy, 0.08);
        this.joyX = Math.max(-1, Math.min(1, v.x));
        this.joyY = Math.max(-1, Math.min(1, -v.y));
      } else if (p.role === "look") {
        this.lookTouchX += e.movementX || x - p.x;
        this.lookTouchY += e.movementY || y - p.y;
        p.x = x;
        p.y = y;
      }
    } else {
      const p = this.pointerIds.get(e.pointerId);
      if (p?.role === "joy") {
        this.joyX = 0;
        this.joyY = 0;
      }
      this.pointerIds.delete(e.pointerId);
    }
  }

  pressVirtual(btn: string, down: boolean) {
    if (down) this.heldButtons.add(btn);
    else this.heldButtons.delete(btn);
  }

  sample(): Actions {
    const held = this.injected ? new Set(this.injected) : this.keys;
    const down = (c: string) => held.has(c);
    let moveX = 0;
    let moveY = 0;
    if (down("KeyD") || down("ArrowRight")) moveX += 1;
    if (down("KeyA") || down("ArrowLeft")) moveX -= 1;
    if (down("KeyW") || down("ArrowUp")) moveY += 1;
    if (down("KeyS") || down("ArrowDown")) moveY -= 1;
    moveX += this.joyX;
    moveY += this.joyY;
    const pads = typeof navigator !== "undefined" ? navigator.getGamepads?.() ?? [] : [];
    for (const pad of pads) {
      if (!pad) continue;
      const any = pad.buttons.some((b) => b.pressed);
      if (any) this.padAwake = true;
      if (!this.padAwake) continue;
      const st = radial(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
      moveX += st.x;
      moveY += -st.y;
      const look = radial(pad.axes[2] ?? 0, pad.axes[3] ?? 0, 0.22);
      this.mouseDx += look.x * 14;
      this.mouseDy += look.y * 14;
      if (pad.buttons[0]?.pressed) this.heldButtons.add("jump");
      if (pad.buttons[2]?.pressed) this.heldButtons.add("attack");
      if (pad.buttons[5]?.pressed || pad.buttons[7]?.pressed) this.heldButtons.add("grab");
      if (pad.buttons[1]?.pressed) this.heldButtons.add("kick");
      if (pad.buttons[4]?.pressed || pad.buttons[10]?.pressed) this.heldButtons.add("sprint");
      if (pad.buttons[9]?.pressed) this.heldButtons.add("pause");
    }
    const mag = Math.hypot(moveX, moveY);
    if (mag > 1) {
      moveX /= mag;
      moveY /= mag;
    }
    const lookX = this.mouseDx * this.lookSens + this.lookTouchX * this.lookTouchSens;
    const lookY = (this.mouseDy * this.lookSens + this.lookTouchY * this.lookTouchSens) * (this.invertY ? -1 : 1);
    this.mouseDx = 0;
    this.mouseDy = 0;
    this.lookTouchX = 0;
    this.lookTouchY = 0;

    const attack = this.heldButtons.has("attack");
    const grab = this.heldButtons.has("grab") || down("KeyQ");
    const jump = down("Space") || this.heldButtons.has("jump");
    const kick = down("KeyF") || this.heldButtons.has("kick");
    const shove = down("KeyE") || this.heldButtons.has("shove");
    const drop = down("KeyG") || this.heldButtons.has("drop");
    const ignite = down("KeyR") || this.heldButtons.has("ignite");
    const pause = down("Escape") || this.heldButtons.has("pause");
    const sprint = down("ShiftLeft") || down("ShiftRight") || this.heldButtons.has("sprint");

    const a: Actions = {
      moveX,
      moveY,
      lookX,
      lookY,
      sprint,
      crouch: down("KeyC") || down("ControlLeft") || this.heldButtons.has("crouch"),
      jump,
      jumpPressed: jump && !this.prev.jump,
      attack,
      attackPressed: attack && !this.prev.attack,
      grab,
      grabPressed: grab && !this.prev.grab,
      grabReleased: !grab && this.prev.grab,
      kick,
      kickPressed: kick && !this.prev.kick,
      shove,
      shovePressed: shove && !this.prev.shove,
      drop,
      dropPressed: drop && !this.prev.drop,
      bandage: down("KeyT") || this.heldButtons.has("bandage"),
      ignite,
      ignitePressed: ignite && !this.prev.ignite,
      pausePressed: pause && !this.prev.pausePressed,
    };
    this.prev = { ...a, pausePressed: pause };
    if (this.heldButtons.has("jump") && !down("Space") && !this.hudControls) this.heldButtons.delete("jump");
    if (this.heldButtons.has("pause")) this.heldButtons.delete("pause");
    return a;
  }
}
