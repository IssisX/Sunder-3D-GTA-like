import React from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import { SunderApp } from "../src/components/sunder-app";

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");

createRoot(root).render(
  <React.StrictMode>
    <SunderApp />
  </React.StrictMode>,
);
