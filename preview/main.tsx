/**
 * Standalone preview entry.
 *
 * The game is entirely client-side -- no router, no server functions, no
 * database -- so it can be built as one self-contained HTML file that runs
 * anywhere. This entry exists only to mount it without the app shell; the game
 * code itself is the same code the full app runs.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SunderApp } from "@/components/sunder-app";
import "./preview.css";

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <StrictMode>
      <SunderApp />
    </StrictMode>,
  );
}
