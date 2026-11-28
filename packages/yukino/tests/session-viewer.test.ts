import { createHash } from "node:crypto";

import { load } from "cheerio";
import { describe, expect, it } from "vitest";

import {
  MAX_SESSION_DEPTH,
  MAX_SESSION_STRING_BYTES,
  SESSION_EXPORT_CSP,
  SESSION_TRANSPORT_CHUNK_BYTES,
  SESSION_TRANSPORT_TEXT_CHARS,
} from "@/session/constants.js";
import {
  createSessionHeader,
  makeArtifact,
  sessionUtf8Chunks,
  validateDocument,
  type SessionRecord,
} from "@/session/records.js";
import {
  renderSessionHtml,
  sessionHtmlParts,
  SESSION_VIEWER_SCRIPT,
} from "@/session/transfer.js";

function entry(
  id: string,
  parentId: string | null,
  content: string,
  revision: number,
): SessionRecord {
  return {
    type: "message",
    entryId: id,
    parentId,
    timestamp: 1,
    revision,
    message: { role: "user", content, timestamp: 1 },
  };
}

describe("fixed offline session viewer", () => {
  it("pins exact script bytes and keeps transcript, labels, URLs and executable attachments inert", () => {
    const attack =
      '</script><script>globalThis.transcriptExecuted=true</script><img src="https://invalid.example" onerror="attack()"><a href="javascript:attack()">bad</a>';
    const artifact = makeArtifact(Buffer.from(attack), "text/html", 1);
    const svg = makeArtifact(
      Buffer.from('<svg onload="attack()"></svg>'),
      "image/svg+xml",
      2,
    );
    const png = makeArtifact(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1WQAAAAASUVORK5CYII=",
        "base64",
      ),
      "image/png",
      3,
    );
    const document = validateDocument(createSessionHeader(), [
      artifact,
      svg,
      png,
      entry(
        "root",
        null,
        `text\n\`\`\`typescript\n${attack}\n\`\`\`\n\`\`\`diff\n@@ hunk\n-old\n+new\n\`\`\``,
        4,
      ),
      { type: "label", entryId: "root", label: attack, revision: 5 },
      { type: "active_leaf", leafId: "root", revision: 6 },
    ]);
    const html = renderSessionHtml(document);
    const page = load(html);
    expect(page("script")).toHaveLength(1);
    expect(page("script").text()).toBe(SESSION_VIEWER_SCRIPT);
    expect(SESSION_EXPORT_CSP).toContain(
      `script-src 'sha256-${createHash("sha256").update(SESSION_VIEWER_SCRIPT).digest("base64")}'`,
    );
    expect(SESSION_EXPORT_CSP).not.toMatch(
      /script-src[^;]*unsafe|unsafe-eval/u,
    );
    expect(SESSION_EXPORT_CSP).toContain("connect-src 'none'");
    expect(SESSION_EXPORT_CSP).toContain("script-src-attr 'none'");
    expect(SESSION_VIEWER_SCRIPT).not.toMatch(
      /innerHTML|outerHTML|insertAdjacentHTML|\beval\s*\(|\bFunction\s*\(|fetch\s*\(|XMLHttpRequest|WebSocket/u,
    );
    expect(
      page("iframe,object,embed,link,svg,[onerror],[onclick],[onload]"),
    ).toHaveLength(0);
    expect(page("img")).toHaveLength(1);
    expect(page("img").attr("src")).toMatch(/^data:image\/png;base64,/u);
    expect(
      page("a")
        .toArray()
        .every((node) => page(node).attr("href")?.startsWith("#")),
    ).toBe(true);
    expect(page("article").text()).toContain(attack);
    expect(
      page(".code-label")
        .map((_, node) => page(node).text())
        .get(),
    ).toEqual(["typescript", "diff"]);
    expect(page(".diff-add").text()).toBe("+new\n");
    expect(page(".diff-remove").text()).toBe("-old\n");
    expect(page(".diff-meta").text()).toBe("@@ hunk\n");
  });

  it("streams long unbroken code/diff and maximum-depth branches without recursion or whole strings", () => {
    const records: SessionRecord[] = [];
    for (let index = 0; index < MAX_SESSION_DEPTH; index++) {
      records.push(
        entry(
          `e-${index}`,
          index ? `e-${index - 1}` : null,
          index
            ? "branch"
            : `\`\`\`diff\n+${"雪🙂<&>".repeat(150_000)}\n\`\`\``,
          index + 1,
        ),
      );
    }
    records.push({
      type: "active_leaf",
      leafId: `e-${MAX_SESSION_DEPTH - 1}`,
      revision: records.length + 1,
    });
    const document = validateDocument(createSessionHeader(), records);
    let bytes = 0;
    let rows = 0;
    let largestPart = 0;
    for (const part of sessionHtmlParts(document)) {
      largestPart = Math.max(largestPart, part.length);
      if (part.startsWith('<li class="tree-row"')) {
        rows++;
      }
    }
    for (const chunk of sessionUtf8Chunks(sessionHtmlParts(document))) {
      expect(chunk.byteLength).toBeLessThanOrEqual(
        SESSION_TRANSPORT_CHUNK_BYTES,
      );
      expect(() =>
        new TextDecoder("utf-8", { fatal: true }).decode(chunk),
      ).not.toThrow();
      bytes += chunk.byteLength;
    }
    expect(rows).toBe(MAX_SESSION_DEPTH);
    expect(largestPart).toBeLessThanOrEqual(SESSION_TRANSPORT_TEXT_CHARS * 6);
    expect(bytes).toBeGreaterThan(MAX_SESSION_STRING_BYTES);
    expect(() => renderSessionHtml(document)).toThrow("string byte limit");
  });

  it("derives parent/leaf and origin/schema distinctions from the validated tree", () => {
    const document = validateDocument(createSessionHeader(), [
      entry("root", null, "root", 1),
      {
        type: "message",
        entryId: "old",
        parentId: "root",
        timestamp: 1,
        revision: 2,
        message: {
          role: "assistant",
          content: "old",
          timestamp: 1,
          historical: true,
          cost: { amount: 1 },
        },
      },
      entry("new", "root", "new", 3),
      {
        type: "message",
        entryId: "schema",
        parentId: "new",
        revision: 4,
        timestamp: 1,
        message: {
          role: "system",
          type: "session_runtime_state",
          content: "",
          timestamp: 1,
          state: {
            provider: {
              name: "local",
              model: "local",
              protocol: "openai",
              endpointFingerprint: "a".repeat(64),
            },
            thinking: "off",
            tools: [],
            discovered: [],
          },
        },
      },
      { type: "active_leaf", leafId: "schema", revision: 5 },
    ]);
    const page = load(renderSessionHtml(document));
    expect(
      page("[data-tree-entry]")
        .map((_, node) => page(node).attr("data-tree-entry"))
        .get(),
    ).toEqual(["root", "old", "new", "schema"]);
    expect(page('[data-tree-entry="schema"]').attr("data-parent")).toBe("new");
    expect(page('[data-tree-entry="schema"]').attr("data-depth")).toBe("2");
    expect(page('[data-tree-entry="old"]').attr("data-current")).toBe("false");
    expect(page("#entry-old").attr("data-origin")).toBe("historical");
    expect(page("#entry-schema").attr("data-kind")).toBe("schema");
    expect(
      page("#viewer-branch option")
        .map((_, node) => page(node).attr("value"))
        .get(),
    ).toEqual(["", "old", "schema"]);
    expect(page("#entry-old").text()).toContain(
      "historical usage, not a new charge",
    );
    expect(page('[data-tree-entry="root"] button').attr("aria-expanded")).toBe(
      "true",
    );
  });
});
