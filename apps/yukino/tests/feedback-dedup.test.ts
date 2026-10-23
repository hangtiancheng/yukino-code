import {
  filterDuplicateDrafts,
  issueFingerprint,
  loadFiledIssues,
  recordFiledIssues,
} from "@yukino.js/feedback/dedup.js";
import type { FiledIssueRecord } from "@yukino.js/feedback/types.js";
import { describe, expect, it } from "vitest";

const SESSION = "dedup-test-session";

function makeRecord(title: string): FiledIssueRecord {
  return {
    fingerprint: issueFingerprint(title),
    title,
    url: `https://github.com/hangtiancheng/yukino-code/issues/${String(Math.floor(Math.random() * 1000))}`,
    channel: "gh",
    createdAt: new Date().toISOString(),
  };
}

describe("issueFingerprint", () => {
  it("ignores case, punctuation and spacing", () => {
    const a = issueFingerprint("[tool] Bash retry storm!");
    const b = issueFingerprint("tool bash retry storm");
    expect(a).toBe(b);
  });

  it("keeps CJK titles distinct from different ones", () => {
    expect(issueFingerprint("沙箱拒绝后重试风暴")).toBe(
      issueFingerprint("沙箱 拒绝后 重试风暴"),
    );
    expect(issueFingerprint("沙箱拒绝后重试风暴")).not.toBe(
      issueFingerprint("权限弹窗卡死"),
    );
  });
});

describe("filed issue persistence", () => {
  it("returns [] when nothing was filed", () => {
    expect(loadFiledIssues("never-filed-session")).toEqual([]);
  });

  it("round-trips records and appends across calls", () => {
    recordFiledIssues(SESSION, [makeRecord("[tool] first issue")]);
    recordFiledIssues(SESSION, [makeRecord("[ui] second issue")]);
    const loaded = loadFiledIssues(SESSION);
    expect(loaded.map((r) => r.title)).toEqual([
      "[tool] first issue",
      "[ui] second issue",
    ]);
    expect(loaded[0].channel).toBe("gh");
  });
});

describe("filterDuplicateDrafts", () => {
  it("drops drafts matching filed records and in-batch duplicates", () => {
    const filed = [makeRecord("[tool] Bash retry storm")];
    const drafts = [
      { title: "[tool] bash retry storm!", body: "a" }, // dup of filed
      { title: "[ui] Render corruption", body: "b" },
      { title: "ui render corruption", body: "c" }, // dup within batch
      { title: "[context] Compaction loses messages", body: "d" },
    ];
    const { fresh, skipped } = filterDuplicateDrafts(drafts, filed);
    expect(skipped).toBe(2);
    expect(fresh.map((d) => d.title)).toEqual([
      "[ui] Render corruption",
      "[context] Compaction loses messages",
    ]);
  });
});
