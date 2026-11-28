import { createRoot } from "@yukino.js/lit-jsx";
import "./index.css";
import { App } from "./app.tsx";
import { subscribe } from "./lib/i18n.ts";

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
subscribe(() => root.render(<App />));
