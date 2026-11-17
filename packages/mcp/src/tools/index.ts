import { clickhouseModule } from "./clickhouse/tool.js";
import { createAppModule } from "./create-app/tool.js";
import { docsModule } from "./docs/tool.js";
import { etcdModule } from "./etcd/tool.js";
import { githubModule } from "./github/tool.js";
import { grafanaModule } from "./grafana/tool.js";
import { kafkaModule } from "./kafka/tool.js";
import { milvusModule } from "./milvus/tool.js";
import { minioModule } from "./minio/tool.js";
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
  grafanaModule,
  minioModule,
  clickhouseModule,
  etcdModule,
  milvusModule,
  kafkaModule,
];
