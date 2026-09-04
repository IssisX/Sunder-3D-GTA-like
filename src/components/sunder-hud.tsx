import { useEffect, useRef, useState } from "react";
import type { HudState, Region } from "@/game/types";

const PARTS: { id: Region; d: string }[] = [
  { id: "head", d: "M18 4.5c2.4 0 4.2 1.8 4.2 3.8S20.4 12 18 12s-4.2-1.8-4.2-3.7S15.6 4.5 18 4.5z" },
  { id: "torso", d: "M12.5 13.2h11v9.2h-11z" },
  { id: "larm", d: "M8.2 13.4h3.8v10.2H8.2z" },
  { id: "rarm", d: "M24 13.4h3.8v10.2H24z" },
  { id: "lleg", d: "M13 23h4.4v9.2H13z" },
  { id: "rleg", d: "M18.6 23H23v9.2h-4.4z" },
];

type Props = {
  hud: HudState;
  ready?: boolean;
  bootError?: string;
  onStart: () => void;
  onResume: () => void;
  onPause: () => void;
  onRestart: () => void;
  onWake: () => void;
  onMute: (m: boolean) => void;
  onVirtual: (btn: string, down: boolean) => void;
  onStick: (x: number, y: number) => void;
  onLook: (dx: number, dy: number) => void;
  onTouchUi: (on: boolean) => void;
};

export function SunderHud({
  hud,
  ready = true,
  bootError = "",
  onStart,
  onResume,
  onPause,
  onRestart,
  onWake,
  onMute,
  onVirtual,
  onStick,
  onLook,
  onTouchUi,
}: Props) {
  const [muted, setMuted] = useState(false);
  const [touch, setTouch] = useState(false);
  useEffect(() => {
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    setTouch(coarse || navigator.maxTouchPoints > 0);
  }, []);

  const hurt = Object.values(hud.injuries).some((v) => v > 0.08);
  const hour =
    hud.timeOfDay > 0.78 || hud.timeOfDay < 0.2 ? "Night" : hud.timeOfDay > 0.7 ? "Dusk" : hud.timeOfDay < 0.3 ? "Dawn" : "Day";

  return (
    <div className="pointer-events-none absolute inset-0 font-sans text-fg">
      {hud.phase === "title" && <Title onStart={onStart} ready={ready} bootError={bootError} touch={touch} />}
      {hud.phase === "paused" && (
        <Pane
          title="Paused"
          body="The ford keeps moving while you wait. It will not wait kindly."
          actions={[
            { label: "Resume", onClick: onResume, primary: true },
            { label: "Start over", onClick: onRestart },
          ]}
        />
      )}
      {hud.phase === "dead" && (
        <Pane
          title="Still"
          body={hud.cause ? `You ${hud.cause}.` : "The body failed."}
          actions={[{ label: "Begin again", onClick: onRestart, primary: true }]}
        />
      )}
      {hud.phase === "captured" && (
        <Pane
          title="Taken"
          body="They bind your hands and drag you off the street. The town is still on fire somewhere behind you."
          actions={[{ label: "Wake in the shed", onClick: onWake, primary: true }]}
        />
      )}
      {hud.phase === "down" && (
        <div className="absolute inset-0 flex items-end justify-center bg-bg/40 p-8">
          <p className="font-display text-2xl tracking-tight text-fg/90">The ground has you.</p>
        </div>
      )}

      {hud.phase === "playing" && (
        <>
          <div className="absolute top-0 right-0 left-0 z-30 flex items-start justify-between p-4 pt-[max(1rem,env(safe-area-inset-top))] sm:p-6">
            <div className="flex flex-col gap-1">
              {hud.whispers.map((w) => (
                <p
                  key={w.id}
                  className="font-display text-lg leading-snug text-fg/90 sm:text-xl"
                  style={{ textShadow: "0 1px 12px rgba(12,11,10,0.8)" }}
                >
                  {w.text}
                </p>
              ))}
            </div>
            <div className="pointer-events-auto flex items-center gap-2">
              <button
                type="button"
                className="h-11 rounded-md border border-border bg-surface/80 px-3 text-sm text-muted backdrop-blur-sm hover:text-fg"
                onClick={() => {
                  setMuted((m) => {
                    onMute(!m);
                    return !m;
                  });
                }}
              >
                {muted ? "Sound off" : "Sound on"}
              </button>
              <button
                type="button"
                className="h-11 rounded-md border border-border bg-surface/80 px-3 text-sm text-muted backdrop-blur-sm hover:text-fg"
                onClick={onPause}
              >
                Pause
              </button>
            </div>
          </div>

          <div className="hud-vitals absolute bottom-0 left-0 z-20 flex items-end gap-4 p-4 sm:p-6">
            {hurt && <BodySilhouette injuries={hud.injuries} />}
            <div className="flex min-w-[9rem] flex-col gap-1.5">
              {hud.stamina < 0.95 && <Meter label="Wind" value={hud.stamina} />}
              {hud.blood < 0.97 && <Meter label="Blood" value={hud.blood} warn />}
              {hud.breath < 0.85 && <Meter label="Air" value={hud.breath} />}
              {hud.held && <p className="text-xs tracking-wide text-muted uppercase">{hud.held}</p>}
              {hud.weapon !== "fist" && (
                <p className="text-xs tracking-wide text-accent uppercase">{hud.weapon}</p>
              )}
            </div>
          </div>

          <div className="absolute bottom-0 left-1/2 hidden -translate-x-1/2 pb-5 text-center sm:block">
            {hud.hint && (
              <p className="rounded-md bg-bg/50 px-3 py-1.5 text-sm text-fg/80 backdrop-blur-sm">{hud.hint}</p>
            )}
          </div>

          <div className="absolute right-4 bottom-4 hidden flex-col items-end gap-1 pb-[env(safe-area-inset-bottom)] text-right text-xs text-muted sm:flex">
            <span className="tabular">{hour}</span>
            {hud.rain > 0.2 && <span>Rain</span>}
            {hud.hunted && <span className="text-fg">Hunted</span>}
            {hud.burning && <span className="text-ember">Burning</span>}
            {hud.wanted > 0.4 && <span>Known</span>}
          </div>

          {touch && (
            <TouchControls
              onVirtual={onVirtual}
              onStick={onStick}
              onLook={onLook}
              onTouchUi={onTouchUi}
              hint={hud.hint}
            />
          )}
        </>
      )}
    </div>
  );
}

function Meter({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="w-40">
      <div className="mb-1 flex justify-between text-[10px] tracking-widest text-muted uppercase">
        <span>{label}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-raised">
        <div
          className={`h-full ${warn ? "bg-danger" : "bg-accent"}`}
          style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }}
        />
      </div>
    </div>
  );
}

function BodySilhouette({ injuries }: { injuries: Record<Region, number> }) {
  return (
    <svg viewBox="0 0 36 36" className="h-16 w-16 opacity-90" aria-hidden>
      {PARTS.map((p) => {
        const v = injuries[p.id];
        const fill =
          v > 0.7
            ? "var(--color-danger)"
            : v > 0.35
              ? "var(--color-ember)"
              : v > 0.08
                ? "var(--color-muted)"
                : "var(--color-raised)";
        return <path key={p.id} d={p.d} fill={fill} />;
      })}
    </svg>
  );
}

function Title({
  onStart,
  ready,
  bootError,
  touch,
}: {
  onStart: () => void;
  ready: boolean;
  bootError: string;
  touch: boolean;
}) {
  return (
    <div className="pointer-events-auto absolute inset-0 flex flex-col justify-end">
      <div className="bg-gradient-to-t from-bg via-bg/80 to-transparent pt-24">
        <div className="mx-auto w-full max-w-xl px-6 pb-10 sm:pb-14">
          <p className="mb-3 text-xs tracking-[0.28em] text-muted uppercase">Harrow's Ford</p>
          <h1 className="font-display text-6xl leading-none tracking-tight text-fg sm:text-8xl">Sunder</h1>
          <p className="mt-4 max-w-md text-base leading-relaxed text-muted">
            A body in a town that burns, panics, and remembers. Shove a man into a stall. Watch the lamp fall.
          </p>
          {bootError && <p className="mt-3 text-sm text-danger">{bootError}</p>}
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={onStart}
              disabled={!ready || Boolean(bootError)}
              className="h-12 min-h-12 rounded-md bg-accent px-8 text-sm font-medium tracking-wide text-accent-fg transition-transform duration-150 hover:opacity-90 active:scale-[0.98] disabled:opacity-40"
            >
              Start
            </button>
            <p className="text-xs leading-relaxed text-subtle">
              {touch
                ? "Left stick walks. Drag the right pad to look. Strike, grab, run on the right. Folded or open — thumbs stay in the corners, off the hinge."
                : "WASD move · Shift run · Mouse look · LMB strike · RMB grab/throw · E shove · F kick · R ignite · T bind"}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Pane({
  title,
  body,
  actions,
}: {
  title: string;
  body: string;
  actions: { label: string; onClick: () => void; primary?: boolean }[];
}) {
  return (
    <div className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-bg/70 p-6 backdrop-blur-[2px]">
      <div className="w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-none sm:p-8">
        <h2 className="font-display text-4xl tracking-tight text-fg">{title}</h2>
        <p className="mt-3 text-sm leading-relaxed text-muted">{body}</p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row">
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              onClick={a.onClick}
              className={
                a.primary
                  ? "h-12 min-h-12 rounded-md bg-accent px-5 text-sm font-medium text-accent-fg"
                  : "h-12 min-h-12 rounded-md border border-border bg-raised px-5 text-sm text-fg"
              }
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function TouchControls({
  onVirtual,
  onStick,
  onLook,
  onTouchUi,
  hint,
}: {
  onVirtual: (btn: string, down: boolean) => void;
  onStick: (x: number, y: number) => void;
  onLook: (dx: number, dy: number) => void;
  onTouchUi: (on: boolean) => void;
  hint: string;
}) {
  const [coach, setCoach] = useState(true);
  useEffect(() => {
    onTouchUi(true);
    const t = window.setTimeout(() => setCoach(false), 7000);
    return () => {
      onTouchUi(false);
      onStick(0, 0);
      window.clearTimeout(t);
    };
  }, [onStick, onTouchUi]);

  return (
    <>
      <LookPad onLook={onLook} />
      <div className="touch-left pointer-events-none absolute bottom-0 left-0 z-20 p-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] pl-[max(0.75rem,env(safe-area-inset-left))]">
        <Stick onStick={onStick} />
      </div>
      <div className="touch-right pointer-events-none absolute right-0 bottom-0 z-20 flex flex-col items-end gap-2 p-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] pr-[max(0.75rem,env(safe-area-inset-right))]">
        <div className="flex gap-2">
          <ActionBtn id="sprint" label="Run" onVirtual={onVirtual} />
          <ActionBtn id="jump" label="Jump" onVirtual={onVirtual} />
        </div>
        <div className="flex gap-2">
          <ActionBtn id="grab" label="Grab" onVirtual={onVirtual} />
          <ActionBtn id="attack" label="Strike" onVirtual={onVirtual} large />
        </div>
        <div className="flex gap-2">
          <ActionBtn id="kick" label="Kick" onVirtual={onVirtual} />
          <ActionBtn id="ignite" label="Fire" onVirtual={onVirtual} />
          <ActionBtn id="crouch" label="Duck" onVirtual={onVirtual} />
        </div>
      </div>
      {(coach || hint) && (
        <div className="touch-hint pointer-events-none absolute z-10 w-[min(22rem,70%)] -translate-x-1/2 text-center">
          <p className="rounded-md bg-bg/55 px-3 py-1.5 text-xs text-fg/80 backdrop-blur-sm">
            {hint || "Left stick walks · drag right to look"}
          </p>
        </div>
      )}
    </>
  );
}

function ActionBtn({
  id,
  label,
  onVirtual,
  large,
}: {
  id: string;
  label: string;
  onVirtual: (btn: string, down: boolean) => void;
  large?: boolean;
}) {
  const hold = {
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      onVirtual(id, true);
    },
    onPointerUp: (e: React.PointerEvent) => {
      e.preventDefault();
      onVirtual(id, false);
    },
    onPointerCancel: () => onVirtual(id, false),
    onLostPointerCapture: () => onVirtual(id, false),
  };
  return (
    <button
      type="button"
      aria-label={label}
      className={`pointer-events-auto rounded-md border border-border bg-surface/80 text-xs tracking-wide text-fg uppercase backdrop-blur-sm select-none transition-transform duration-75 active:scale-95 active:bg-raised ${
        large ? "h-16 min-h-16 min-w-16 px-4" : "h-12 min-h-12 min-w-12 px-3"
      }`}
      style={{ touchAction: "none" }}
      {...hold}
    >
      {label}
    </button>
  );
}

function Stick({ onStick }: { onStick: (x: number, y: number) => void }) {
  const baseRef = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const active = useRef(false);
  const throwR = 56;

  const apply = (clientX: number, clientY: number) => {
    const el = baseRef.current;
    if (!el) return;
    const b = el.getBoundingClientRect();
    const cx = b.left + b.width / 2;
    const cy = b.top + b.height / 2;
    let dx = clientX - cx;
    let dy = clientY - cy;
    const m = Math.hypot(dx, dy);
    if (m > throwR) {
      dx *= throwR / m;
      dy *= throwR / m;
    }
    setKnob({ x: dx, y: dy });
    const nx = dx / throwR;
    const ny = -dy / throwR;
    const mag = Math.hypot(nx, ny);
    if (mag < 0.12) onStick(0, 0);
    else {
      const s = (mag - 0.12) / 0.88;
      onStick((nx / mag) * Math.min(1, s), (ny / mag) * Math.min(1, s));
    }
  };

  const end = () => {
    active.current = false;
    setKnob({ x: 0, y: 0 });
    onStick(0, 0);
  };

  return (
    <div
      ref={baseRef}
      className="pointer-events-auto relative h-36 w-36 rounded-full border border-border bg-surface/45 select-none"
      style={{ touchAction: "none" }}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        active.current = true;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        apply(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (!active.current) return;
        e.preventDefault();
        apply(e.clientX, e.clientY);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
    >
      <div className="absolute inset-6 rounded-full border border-border/70" />
      <div
        className="absolute top-1/2 left-1/2 h-14 w-14 -translate-x-1/2 -translate-y-1/2 rounded-full border border-accent/40 bg-accent/80"
        style={{ transform: `translate(calc(-50% + ${knob.x}px), calc(-50% + ${knob.y}px))` }}
      />
    </div>
  );
}

function LookPad({ onLook }: { onLook: (dx: number, dy: number) => void }) {
  const last = useRef({ x: 0, y: 0, id: -1 });
  return (
    <div
      className="touch-look pointer-events-auto absolute top-16 right-0 bottom-0 z-10"
      style={{ touchAction: "none" }}
      onPointerDown={(e) => {
        e.preventDefault();
        last.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (last.current.id !== e.pointerId) return;
        e.preventDefault();
        const dx = e.movementX || e.clientX - last.current.x;
        const dy = e.movementY || e.clientY - last.current.y;
        last.current.x = e.clientX;
        last.current.y = e.clientY;
        if (dx || dy) onLook(dx, dy);
      }}
      onPointerUp={() => {
        last.current.id = -1;
      }}
      onPointerCancel={() => {
        last.current.id = -1;
      }}
    />
  );
}
