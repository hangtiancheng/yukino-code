import { chromeModule } from "./chrome/tool.js";
import { createAppModule } from "./create-app/tool.js";
import { docsModule } from "./docs/tool.js";
import { githubModule } from "./github/tool.js";
import type { ToolModule } from "./types.js";

/** All tool modules hosted by this server. Add future modules here. */
export const modules: ToolModule[] = [
  createAppModule,
  docsModule,
  chromeModule,
  githubModule,
];
