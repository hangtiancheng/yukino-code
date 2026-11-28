import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";

import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { mcpContentToToolOutput } from "@/mcp/client.js";
import {
  MCP_APP_URI_PREFIX,
  MCP_BASE64_PATTERN,
  MCP_RESOURCE_LIST_TOOL,
  MCP_RESOURCE_MAX_BYTES,
  MCP_RESOURCE_MAX_CONTENTS,
  MCP_RESOURCE_PREVIEW_BYTES,
  MCP_RESOURCE_READ_TOOL,
  MCP_RESOURCE_URI_LIMIT,
} from "@/mcp/constants.js";
import type { MCPManager } from "@/mcp/manager.js";
import {
  MCP_RESOURCES_DESCRIPTION,
  MCP_READ_RESOURCE_DESCRIPTION,
} from "@/mcp/prompts.js";
import type { ToolContext, ToolResult } from "@/tools/types.js";
import { ValidatedTool } from "@/tools/validated-tool.js";

export interface MCPResourceProvenance {
  serverName: string;
  uri: string;
}
export interface MCPResourceArtifact extends MCPResourceProvenance {
  id: string;
  mimeType: string;
  bytes: number;
  sha256: string;
}
export interface MCPArtifactStore {
  create(
    data: Uint8Array,
    mimeType: string,
    provenance: MCPResourceProvenance,
  ): Promise<MCPResourceArtifact>;
}

export class DirectoryMCPArtifactStore implements MCPArtifactStore {
  constructor(private readonly directory: string) {
    if (!path.isAbsolute(directory)) {
      throw new Error(
        "MCP artifact directory must be host-selected and absolute",
      );
    }
  }
  async create(
    data: Uint8Array,
    mimeType: string,
    provenance: MCPResourceProvenance,
  ): Promise<MCPResourceArtifact> {
    if (data.byteLength > MCP_RESOURCE_MAX_BYTES) {
      throw new Error("MCP resource exceeds artifact limit");
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0
    ) {
      throw new Error("MCP artifact directory is not private");
    }
    const id = randomUUID();
    const file = await open(path.join(this.directory, id), "wx", 0o600);
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    return {
      id,
      mimeType,
      bytes: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex"),
      ...provenance,
    };
  }
}

export interface MCPResourceToolResult extends ToolResult {
  resourceArtifacts: MCPResourceArtifact[];
}
export async function previewMCPResource(
  serverName: string,
  result: ReadResourceResult,
  store: MCPArtifactStore,
  signal?: AbortSignal,
): Promise<MCPResourceToolResult> {
  if (result.contents.length > MCP_RESOURCE_MAX_CONTENTS) {
    throw new Error("Too many MCP resource content entries");
  }
  let total = 0;
  const entries = result.contents.map((content) => {
    if (
      !content.uri ||
      content.uri.length > MCP_RESOURCE_URI_LIMIT ||
      content.uri.startsWith(MCP_APP_URI_PREFIX)
    ) {
      throw new Error("MCP Apps resources require the dedicated Apps host");
    }
    const text =
      "text" in content && typeof content.text === "string"
        ? content.text
        : undefined;
    const blob =
      "blob" in content && typeof content.blob === "string"
        ? content.blob
        : undefined;
    if (text === undefined && blob === undefined) {
      throw new Error("Invalid MCP resource content");
    }
    if (
      blob !== undefined &&
      (blob.length > Math.ceil(MCP_RESOURCE_MAX_BYTES / 3) * 4 ||
        !MCP_BASE64_PATTERN.test(blob))
    ) {
      throw new Error("Invalid or oversized MCP resource blob");
    }
    const data =
      text === undefined
        ? Buffer.from(blob ?? "", "base64")
        : Buffer.from(text, "utf8");
    total += data.byteLength;
    if (total > MCP_RESOURCE_MAX_BYTES) {
      throw new Error("MCP resource exceeds total byte limit");
    }
    return {
      content,
      text,
      data,
      mimeType:
        content.mimeType ??
        (text === undefined ? "application/octet-stream" : "text/plain"),
    };
  });
  const raw: unknown[] = [];
  const artifacts: MCPResourceArtifact[] = [];
  let previewBytes = 0;
  for (const { content, text, data, mimeType } of entries) {
    signal?.throwIfAborted();
    const artifact = await store.create(data, mimeType, {
      serverName,
      uri: content.uri,
    });
    artifacts.push(artifact);
    raw.push({
      type: "text",
      text: `Resource ${content.uri}; artifact ${artifact.id}; ${mimeType}; ${data.byteLength} bytes; sha256 ${artifact.sha256}`,
    });
    if (text !== undefined) {
      const budget = Math.max(0, MCP_RESOURCE_PREVIEW_BYTES - previewBytes);
      const preview = data.subarray(0, budget).toString("utf8");
      previewBytes += Buffer.byteLength(preview);
      raw.push({
        type: "text",
        text:
          preview +
          (data.byteLength > budget
            ? "\n[preview truncated; full content in host artifact]"
            : ""),
      });
    } else if (
      mimeType.startsWith("image/") &&
      data.byteLength <= MCP_RESOURCE_PREVIEW_BYTES
    ) {
      raw.push({ type: "image", data: data.toString("base64"), mimeType });
    } else {
      raw.push({
        type: "text",
        text: "[binary/image content stored in host artifact; not executed]",
      });
    }
  }
  signal?.throwIfAborted();
  return {
    ...(await mcpContentToToolOutput(raw)),
    isError: false,
    resourceArtifacts: artifacts,
  };
}

const MCPResourcesToolInputSchema = z.strictObject({
  server: z.string(),
  templates: z.boolean().optional(),
});

export class MCPResourcesTool extends ValidatedTool<
  z.output<typeof MCPResourcesToolInputSchema>
> {
  name = MCP_RESOURCE_LIST_TOOL;
  description = MCP_RESOURCES_DESCRIPTION;
  category = "read" as const;
  constructor(private manager: MCPManager) {
    super();
  }
  parameters() {
    return MCPResourcesToolInputSchema;
  }

  protected async executeValidated(
    ctx: ToolContext,
    args: z.output<typeof MCPResourcesToolInputSchema>,
  ): Promise<ToolResult> {
    const client = this.manager.getClient(args.server);
    if (!client || !this.manager.canReadResources(args.server, this.name)) {
      return { output: "MCP resources unavailable", isError: true };
    }
    const result =
      args.templates === true
        ? await client.listResourceTemplates({ signal: ctx.abortSignal })
        : await client.listResources({ signal: ctx.abortSignal });
    return { output: JSON.stringify(result), isError: false };
  }
}
const MCPReadResourceToolInputSchema = z.strictObject({
  server: z.string(),
  uri: z.string(),
});

export class MCPReadResourceTool extends ValidatedTool<
  z.output<typeof MCPReadResourceToolInputSchema>
> {
  name = MCP_RESOURCE_READ_TOOL;
  description = MCP_READ_RESOURCE_DESCRIPTION;
  category = "read" as const;
  constructor(
    private manager: MCPManager,
    private store: MCPArtifactStore,
  ) {
    super();
  }
  parameters() {
    return MCPReadResourceToolInputSchema;
  }

  protected async executeValidated(
    ctx: ToolContext,
    args: z.output<typeof MCPReadResourceToolInputSchema>,
  ): Promise<ToolResult> {
    if (
      args.uri.startsWith(MCP_APP_URI_PREFIX) ||
      args.uri.length > MCP_RESOURCE_URI_LIMIT
    ) {
      return {
        output: "A bounded non-Apps MCP resource URI is required",
        isError: true,
      };
    }
    const client = this.manager.getClient(args.server);
    if (!client || !this.manager.canReadResources(args.server, this.name)) {
      return { output: "MCP resources unavailable", isError: true };
    }
    const generation = this.manager.generation;
    const resource = await client.readResource(args.uri, ctx.abortSignal);
    if (
      generation !== this.manager.generation ||
      !this.manager.canReadResources(args.server)
    ) {
      throw new Error("MCP resource access revoked");
    }
    return previewMCPResource(
      args.server,
      resource,
      this.store,
      ctx.abortSignal,
    );
  }
}
