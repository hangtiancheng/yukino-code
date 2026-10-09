import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, test, expect, beforeEach, afterEach } from "vitest";

import { TeamManager } from "@/teams/index.js";
import { NameRegistry, getNameRegistry } from "@/teams/registry.js";
import { SharedTaskStore } from "@/teams/shared-task.js";
import {
  TeamTaskCreateTool,
  TeamTaskGetTool,
  TeamTaskListTool,
  TeamTaskUpdateTool,
} from "@/teams/task-tools.js";

// The teams directory lives at <home>/.yukino/teams, so the tests redirect the
// entire home directory to a temp dir to avoid leaving residue in the real
// ~/.yukino/teams. os.homedir() reads USERPROFILE on Windows and HOME on other
// platforms, so set both.
let realHome: string | undefined;
let realUserProfile: string | undefined;

beforeEach(() => {
  realHome = process.env.HOME;
  realUserProfile = process.env.USERPROFILE;
  const tmp = mkdtempSync(join(tmpdir(), "yukino-home-"));
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
});
afterEach(() => {
  if (realHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = realHome;
  }
  if (realUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = realUserProfile;
  }
});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "yukino-teams-"));
}

describe("NameRegistry", () => {
  test("resolves by name and by id, unknown returns undefined", () => {
    const reg = new NameRegistry();
    reg.register("reviewer", "agent-7");
    expect(reg.resolve("reviewer")).toBe("agent-7");
    expect(reg.resolve("agent-7")).toBe("agent-7");
    expect(reg.resolve("ghost")).toBeUndefined();
  });

  test("unregister removes mapping", () => {
    const reg = new NameRegistry();
    reg.register("reviewer", "agent-7");
    reg.unregister("reviewer");
    expect(reg.resolve("reviewer")).toBeUndefined();
  });
});

describe("SharedTaskStore", () => {
  test("create assigns string ids and pending status", () => {
    const store = new SharedTaskStore(join(tempDir(), "tasks.json"));
    const t1 = store.create("first", "", "", [], [], "leader");
    const t2 = store.create("second", "desc", "alice", [], [], "leader");
    expect(t1.id).toBe("1");
    expect(t2.id).toBe("2");
    expect(t1.status).toBe("pending");
    expect(t2.owner).toBe("alice");
  });

  test("get and list with filters", () => {
    const store = new SharedTaskStore(join(tempDir(), "tasks.json"));
    store.create("a", "", "alice", [], [], "");
    const b = store.create("b", "", "bob", [], [], "");
    store.update(b.id, { status: "completed" });
    expect(store.get("999")).toBeUndefined();
    expect(store.listTasks().length).toBe(2);
    expect(store.listTasks("completed").length).toBe(1);
    expect(store.listTasks(undefined, "alice").length).toBe(1);
    expect(store.listTasks("completed", "alice").length).toBe(0);
  });

  test("update changes fields and dedups dependencies", () => {
    const store = new SharedTaskStore(join(tempDir(), "tasks.json"));
    const t = store.create("task", "", "", [], [], "");
    const blockerTarget = store.create("dependent");
    const updated = store.update(t.id, {
      status: "in_progress",
      owner: "carol",
      addBlocks: [blockerTarget.id],
    });
    expect(updated?.status).toBe("in_progress");
    expect(updated?.blocks).toEqual(["2"]);
    const again = store.update(t.id, { addBlocks: [blockerTarget.id] });
    expect(again?.blocks).toEqual(["2"]);
    expect(store.update("nope", { status: "completed" })).toBeUndefined();
  });

  test("persists across instances and reloads latest", () => {
    const path = join(tempDir(), "tasks.json");
    const s1 = new SharedTaskStore(path);
    s1.create("persisted", "", "", [], [], "leader");
    const s2 = new SharedTaskStore(path);
    expect(s2.listTasks().length).toBe(1);
    s2.create("from-teammate", "", "", [], [], "bob");
    expect(s1.get("2")?.subject).toBe("from-teammate");
  });

  test("initEmpty clears and resets ids", () => {
    const store = new SharedTaskStore(join(tempDir(), "tasks.json"));
    store.create("x", "", "", [], [], "");
    store.initEmpty();
    expect(store.listTasks().length).toBe(0);
    expect(store.create("y", "", "", [], [], "").id).toBe("1");
  });
});

describe("team task tools", () => {
  let mgr: TeamManager;

  beforeEach(() => {
    getNameRegistry().clear();
    mgr = new TeamManager(tempDir());
    mgr.create("my-team");
  });

  test("create team initializes an empty shared store", () => {
    expect(mgr.getTaskStore("my-team").listTasks().length).toBe(0);
  });

  test("create → list → update → get flow shares one board", async () => {
    const create = new TeamTaskCreateTool(mgr, "my-team", "leader");
    const list = new TeamTaskListTool(mgr, "my-team");
    const update = new TeamTaskUpdateTool(mgr, "my-team");
    const get = new TeamTaskGetTool(mgr, "my-team");
    const ctx = { cwd: process.cwd() };

    const created = await create.execute(ctx, {
      subject: "build parser",
      description: "implement parser",
    });
    expect(created.isError).toBe(false);
    expect(created.output).toContain("Task #1");
    mgr.get("my-team")?.addMember("alice");
    await update.execute(ctx, { taskId: "1", owner: "alice" });

    const listed = await list.execute();
    expect(listed.output).toContain("build parser");
    expect(listed.output).toContain("(alice)");

    const updated = await update.execute(ctx, {
      taskId: "1",
      status: "completed",
    });
    expect(updated.output).toContain("completed");

    const got = await get.execute(ctx, { taskId: "1" });
    expect(JSON.parse(got.output)).toMatchObject({
      status: "completed",
      owner: "alice",
    });

    expect(list.schema().input_schema).toMatchObject({ properties: {} });
  });

  test("update rejects invalid status", async () => {
    const ctx = { cwd: process.cwd() };
    await new TeamTaskCreateTool(mgr, "my-team").execute(ctx, {
      subject: "t",
      description: "",
    });
    const r = await new TeamTaskUpdateTool(mgr, "my-team").execute(ctx, {
      taskId: "1",
      status: "done",
    });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("status");
  });

  test("tools reject invalid dependency input atomically and support cancelled/deleted", async () => {
    const ctx = { cwd: process.cwd() };
    const create = new TeamTaskCreateTool(mgr, "my-team");
    const update = new TeamTaskUpdateTool(mgr, "my-team");
    const list = new TeamTaskListTool(mgr, "my-team");
    expect(
      (
        await create.execute(ctx, {
          subject: "future",
          description: "",
          blocks: ["2"],
        })
      ).isError,
    ).toBe(true);
    expect(mgr.getTaskStore("my-team").listTasks()).toEqual([]);
    expect(
      (await create.execute(ctx, { subject: "first", description: "" }))
        .isError,
    ).toBe(false);
    expect(
      (await create.execute(ctx, { subject: "second", description: "" }))
        .isError,
    ).toBe(false);
    expect(
      (await update.execute(ctx, { taskId: "2", addBlockedBy: ["1"] })).isError,
    ).toBe(false);
    for (const dependencies of [["missing"], [42], ["2"]]) {
      expect(
        (
          await update.execute(ctx, {
            taskId: "1",
            status: "completed",
            addBlockedBy: dependencies,
          })
        ).isError,
      ).toBe(true);
      expect(mgr.getTaskStore("my-team").get("1")?.status).toBe("pending");
    }
    expect(
      (await update.execute(ctx, { taskId: "2", status: "cancelled" })).isError,
    ).toBe(false);
    expect((await list.execute()).output).toContain("[cancelled]");
    expect(
      (await update.execute(ctx, { taskId: "2", status: "deleted" })).isError,
    ).toBe(false);
    expect(mgr.getTaskStore("my-team").get("1")?.blocks).toEqual([]);
  });

  test("delete team unregisters members", async () => {
    const team = mgr.get("my-team");
    team?.addMember("alice");
    getNameRegistry().register("alice", "alice");
    await mgr.delete("my-team");
    expect(mgr.get("my-team")).toBeUndefined();
    expect(getNameRegistry().resolve("alice")).toBeUndefined();
  });
});
