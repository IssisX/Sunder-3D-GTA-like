import { useCallback, useEffect, useRef, useState } from "react";
import { defaultHud, type HudState } from "@/game/types";
import type { Game } from "@/game/game";
import { SunderHud } from "@/components/sunder-hud";

export function SunderApp() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Game | null>(null);
  const [hud, setHud] = useState<HudState>(defaultHud);
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState("");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let game: Game | null = null;
    let dead = false;
    const boot = async () => {
      try {
        const mod = await import("@/game/game");
        if (dead) return;
        game = new mod.Game(canvas, (h) => setHud({ ...h, whispers: [...h.whispers] }));
        gameRef.current = game;
        game.start();
        setReady(true);
      } catch (err) {
        setBootError(err instanceof Error ? err.message : "Failed to load");
      }
    };
    void boot();
    return () => {
      dead = true;
      game?.dispose();
      gameRef.current = null;
    };
  }, []);

  const onStart = useCallback(() => gameRef.current?.enter(), []);
  const onResume = useCallback(() => gameRef.current?.pause(false), []);
  const onPause = useCallback(() => gameRef.current?.pause(true), []);
  const onRestart = useCallback(() => gameRef.current?.restart(true), []);
  const onWake = useCallback(() => gameRef.current?.captureWake(), []);
  const onMute = useCallback((m: boolean) => {
    const g = gameRef.current;
    if (g) g.audio.setMuted(m);
  }, []);
  const onVirtual = useCallback((btn: string, down: boolean) => {
    gameRef.current?.input.pressVirtual(btn, down);
  }, []);
  const onStick = useCallback((x: number, y: number) => {
    gameRef.current?.input.setStick(x, y);
  }, []);
  const onLook = useCallback((dx: number, dy: number) => {
    gameRef.current?.input.addLook(dx, dy);
  }, []);
  const onTouchUi = useCallback((on: boolean) => {
    gameRef.current?.input.setHudControls(on);
  }, []);

  return (
    <div className="sunder-root relative h-[100dvh] w-full overflow-hidden bg-bg text-fg">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full touch-none"
        style={{ touchAction: "none" }}
      />
      <SunderHud
        hud={hud}
        ready={ready}
        bootError={bootError}
        onStart={onStart}
        onResume={onResume}
        onPause={onPause}
        onRestart={onRestart}
        onWake={onWake}
        onMute={onMute}
        onVirtual={onVirtual}
        onStick={onStick}
        onLook={onLook}
        onTouchUi={onTouchUi}
      />
    </div>
  );
}
