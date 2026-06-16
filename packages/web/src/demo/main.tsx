import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "../styles.css";
import { DemoApp } from "./DemoApp";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

createRoot(root).render(
  <StrictMode>
    <DemoApp />
  </StrictMode>,
);
