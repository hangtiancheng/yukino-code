import { createAppModule } from "./create-app/tool.js";
import { docsModule } from "./docs/tool.js";
import { githubModule } from "./github/tool.js";
import { mongodbModule } from "./mongodb/tool.js";
import { mysqlModule } from "./mysql/tool.js";
import { postgresModule } from "./postgres/tool.js";
import { prometheusModule } from "./prometheus/tool.js";
import { redisModule } from "./redis/tool.js";
import type { ToolModule } from "./types.js";

export const modules: ToolModule[] = [
  createAppModule,
  docsModule,
  githubModule,
  postgresModule,
  mysqlModule,
  redisModule,
  mongodbModule,
  prometheusModule,
];
