import {
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseToolArguments } from "@/llm/events.js";
import { EditFileTool } from "@/tools/edit-file.js";
import { FileStateCache } from "@/tools/file-state-cache.js";
import { ReadFileTool } from "@/tools/read-file.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(content: string) {
  const cwd = mkdtempSync(join(tmpdir(), "yukino-edit-fidelity-"));
  directories.push(cwd);
  const path = join(cwd, "file.txt");
  writeFileSync(path, content);
  const context = { cwd, fileStateCache: new FileStateCache() };
  return {
    path,
    read: () => readFileSync(path, "utf-8"),
    readTool: (range = {}) =>
      new ReadFileTool().execute(context, { file_path: path, ...range }),
    edit: (edits: unknown, escapeUnicode = false) => {
      let raw = JSON.stringify({ file_path: path, edits });
      if (escapeUnicode) {
        raw = raw.replace(
          /[\u0080-\uFFFF]/gu,
          (character) =>
            `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
        );
      }
      const parsed = parseToolArguments(raw);
      expect(parsed.parseError).toBeUndefined();
      return new EditFileTool().execute(context, parsed.arguments);
    },
  };
}

const permissionList = [
  "1. 明示ルール (deny / ask): deny または ask に一致したらすぐにその結果を返す; allow のルールはここでは終了せず、後続のサンドボックスを先に評価する",
  "2. plan モードのファイル例外: WriteFile/EditFile の対象が plan ファイルなら allow にする (読み取り専用モードで唯一の書き込み例外)",
  "3. 安全な読み取り専用コマンド: command ツール (Bash) が許可リストに一致したら allow にする",
  "4. 危険なコマンドの検査: 現在の `DANGEROUS_PATTERNS` は空の配列にしている (後述)",
  "5. サンドボックスの自動許可: OS サンドボックスが有効で `auto_allow: true` なら Bash を確認なしで実行する (deny/ask は引き続き有効)",
  "6. パスのサンドボックス: read/write のパスが許可されたルートの外なら ask を返す (bypassPermissions では省略する; 明示ルールで上書きできる)",
  "7. ルールの再評価: 最初の検査を通過した allow のルールをここで適用する",
  "8. 権限モードのマトリックスを適用する",
].join("\n");

const mailboxCode = [
  "model MailboxCode {",
  "  id         String   @id",
  "  attempts   Int      @default(0)",
  "  createdAt  DateTime @default(now())",
  "}",
  "",
  "",
].join("\n");

describe("file editing text fidelity", () => {
  it("returns identical aligned whitespace in full and partial reads and deletes a large block", async () => {
    const block =
      mailboxCode + "// aligned field  Int      @default(0)\n".repeat(63);
    const header = "// header\n".repeat(14);
    const footer = "model Repository {\n  id String @id\n}\n";
    const { readTool, edit, read } = fixture(header + block + footer);
    const full = await readTool();
    const partial = await readTool({ offset: 14, limit: 69 });
    expect(full.isError).toBe(false);
    expect(partial.isError).toBe(false);
    const numbered = block
      .slice(0, -1)
      .split("\n")
      .map((line, index) => `${String(index + 15)}\t${line}`)
      .join("\n");
    expect(full.output).toContain(numbered);
    expect(partial.output).toBe(
      `${numbered}\n[4 more lines in file. Use offset=83 to continue.]`,
    );
    const result = await edit([{ old_string: block, new_string: "" }]);
    expect(result.isError).toBe(false);
    expect(read()).toBe(header + footer);
  });

  it.each([false, true])(
    "matches the permission list after a partial read with Unicode escapes=%s",
    async (escapeUnicode) => {
      const header = "Permission overview\n".repeat(16);
      const original = header + permissionList + "\n\n## Permission modes\n";
      const { readTool, edit, read } = fixture(original);
      await readTool();
      await readTool({ offset: 10, limit: 30 });
      const replacement = permissionList + "\n9. 新しい権限レイヤーを追加する";
      const result = await edit(
        [
          { old_string: permissionList, new_string: replacement },
          {
            old_string: "## Permission modes",
            new_string: "## Permission modes explained",
          },
        ],
        escapeUnicode,
      );
      expect(result.isError).toBe(false);
      expect(read()).toBe(
        header + replacement + "\n\n## Permission modes explained\n",
      );
    },
  );

  it("refreshes the file-state gate with a partial read after an external write", async () => {
    const { path, readTool, edit, read } = fixture("before\n" + permissionList);
    await readTool();
    writeFileSync(path, "after\n" + permissionList);
    const changedTime = new Date(Date.now() + 10_000);
    utimesSync(path, changedTime, changedTime);
    expect(
      (await edit([{ old_string: permissionList, new_string: "updated" }]))
        .output,
    ).toContain("modified since last read");
    await readTool({ offset: 1, limit: 1 });
    const result = await edit([
      { old_string: permissionList, new_string: "updated" },
    ]);
    expect(result.isError).toBe(false);
    expect(read()).toBe("after\nupdated");
  });

  it("diagnoses alignment differences without applying any batch edits", async () => {
    const original = "header\n" + mailboxCode;
    const { readTool, edit, read } = fixture(original);
    await readTool();
    const result = await edit([
      { old_string: "header", new_string: "changed" },
      {
        old_string: mailboxCode
          .replace("Int      ", "Int       ")
          .replace("DateTime ", "DateTime  "),
        new_string: "",
      },
    ]);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("edits[1].old_string not found in file");
    expect(result.output).toContain("horizontal whitespace");
    expect(result.output).toContain("file line 4, column 23");
    expect(result.output).toContain("old_string line 3, column 23");
    expect(result.output).toContain("U+0020");
    expect(result.output).toContain("U+0040");
    expect(result.output).toContain("\\u0020");
    expect(read()).toBe(original);
  });

  it("locates a non-whitespace mismatch beyond a shared first line", async () => {
    const original =
      "intro\n共通の先頭行\n次の行 (Bash) `DANGEROUS_PATTERNS`\ntail\n";
    const { readTool, edit, read } = fixture(original);
    await readTool();
    const result = await edit([
      {
        old_string: "共通の先頭行\n次の行 (bash) `DANGEROUS_PATTERNS`",
        new_string: "changed",
      },
    ]);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("file line 3, column 6");
    expect(result.output).toContain("old_string line 2, column 6");
    expect(result.output).toContain("U+0062");
    expect(result.output).toContain("U+0042");
    expect(read()).toBe(original);
  });

  it("reports multiple whitespace candidates without selecting one to edit", async () => {
    const original = "a  b\na\tb\na   b\na    b\n";
    const { readTool, edit, read } = fixture(original);
    await readTool();
    const result = await edit([
      { old_string: "a b", new_string: "changed", replace_all: true },
    ]);
    expect(result.isError).toBe(true);
    expect(result.output).toContain(
      "file line 1, column 1; file line 2, column 1; file line 3, column 1",
    );
    expect(result.output).not.toContain("file line 4");
    expect(read()).toBe(original);
  });

  it("maps whitespace candidates back to source columns after collapsed runs", async () => {
    const original = "header   value\nprefix    a  b\n";
    const { readTool, edit, read } = fixture(original);
    await readTool();
    const result = await edit([{ old_string: "a b", new_string: "changed" }]);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("file line 2, column 11");
    expect(result.output).toContain("file line 2, column 13");
    expect(read()).toBe(original);
  });

  it("handles long whitespace runs without expensive fuzzy regex searches", async () => {
    const original = "header\n" + " ".repeat(100_000) + "end";
    const { readTool, edit, read } = fixture(original);
    await readTool({ limit: 1 });
    const result = await edit([
      { old_string: " missing", new_string: "changed" },
    ]);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("not found in file");
    expect(read()).toBe(original);
  });

  it("reports NBSP and tab differences with source coordinates in CRLF files", async () => {
    const original = "header\r\na\u00A0b\r\nc\td\r\n";
    const { readTool, edit, read } = fixture(original);
    await readTool();
    const result = await edit([
      { old_string: "a b\nc d", new_string: "changed" },
    ]);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("horizontal whitespace");
    expect(result.output).toContain("file line 2, column 2");
    expect(result.output).toContain("U+00A0");
    expect(read()).toBe(original);
  });

  it("counts Unicode characters and reports whole code points", async () => {
    const original = "header\na🐱\n";
    const { readTool, edit, read } = fixture(original);
    await readTool();
    const result = await edit([{ old_string: "a🐶", new_string: "changed" }]);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("file line 2, column 2");
    expect(result.output).toContain("U+1F436");
    expect(result.output).toContain("U+1F431");
    expect(read()).toBe(original);
  });

  it.each([
    ["xyz", "No matching prefix"],
    ["tail\nmissing", "end of text"],
  ])(
    "handles missing prefixes and end-of-file mismatches for %j",
    async (oldString, diagnostic) => {
      const original = "tail\n";
      const { readTool, edit, read } = fixture(original);
      await readTool();
      const result = await edit([
        { old_string: oldString, new_string: "changed" },
      ]);
      expect(result.isError).toBe(true);
      expect(result.output).toContain(diagnostic);
      expect(read()).toBe(original);
    },
  );
});
