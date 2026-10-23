import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, test, expect, beforeEach, afterEach } from "vitest";

import { TeamManager } from "@yukino.js/teams";
import { NameRegistry, getNameRegistry } from "@yukino.js/teams/registry.js";
import { SharedTaskStore } from "@yukino.js/teams/shared-task.js";
import { TeamTodoWriteTool } from "@yukino.js/teams/task-tools.js";
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
    const t1 = store
      .write(
        {
          todos: [
            {
              subject: "first",
              description: "",
              owner: "",
              blocks: [],
              blockedBy: [],
            },
          ],
        },
        { createdBy: "leader" },
      )
      .slice(-1)[0];
    const t2 = store
      .write(
        {
          todos: [
            {
              subject: "second",
              description: "desc",
              owner: "alice",
              blocks: [],
              blockedBy: [],
            },
          ],
        },
        { createdBy: "leader" },
      )
      .slice(-1)[0];
    expect(t1.id).toBe("1");
    expect(t2.id).toBe("2");
    expect(t1.status).toBe("pending");
    expect(t2.owner).toBe("alice");
  });
  test("get and list with filters", () => {
    const store = new SharedTaskStore(join(tempDir(), "tasks.json"));
    store.write(
      {
        todos: [
          {
            subject: "a",
            description: "",
            owner: "alice",
            blocks: [],
            blockedBy: [],
          },
        ],
      },
      { createdBy: "" },
    );
    const b = store
      .write(
        {
          todos: [
            {
              subject: "b",
              description: "",
              owner: "bob",
              blocks: [],
              blockedBy: [],
            },
          ],
        },
        { createdBy: "" },
      )
      .slice(-1)[0];
    store.write({ todos: [{ id: b.id, ...{ status: "completed" } }] });
    expect(store.get("999")).toBeUndefined();
    expect(store.listTasks().length).toBe(2);
    expect(store.listTasks("completed").length).toBe(1);
    expect(store.listTasks(undefined, "alice").length).toBe(1);
    expect(store.listTasks("completed", "alice").length).toBe(0);
  });
  test("update changes fields and dedups dependencies", () => {
    const store = new SharedTaskStore(join(tempDir(), "tasks.json"));
    const t = store
      .write(
        {
          todos: [
            {
              subject: "task",
              description: "",
              owner: "",
              blocks: [],
              blockedBy: [],
            },
          ],
        },
        { createdBy: "" },
      )
      .slice(-1)[0];
    const blockerTarget = store
      .write({ todos: [{ subject: "dependent" }] })
      .slice(-1)[0];
    const updated = store
      .write({
        todos: [
          {
            id: t.id,
            ...{
              status: "in_progress",
              owner: "carol",
              blocks: [blockerTarget.id],
            },
          },
        ],
      })
      .find((task) => task.id === t.id);
    expect(updated?.status).toBe("in_progress");
    expect(updated?.blocks).toEqual(["2"]);
    const again = store
      .write({ todos: [{ id: t.id, ...{ blocks: [blockerTarget.id] } }] })
      .find((task) => task.id === t.id);
    expect(again?.blocks).toEqual(["2"]);
    expect(() =>
      store.write({ todos: [{ id: "999", status: "completed" }] }),
    ).toThrow("not found");
  });
  test("persists across instances and reloads latest", () => {
    const path = join(tempDir(), "tasks.json");
    const s1 = new SharedTaskStore(path);
    s1.write(
      {
        todos: [
          {
            subject: "persisted",
            description: "",
            owner: "",
            blocks: [],
            blockedBy: [],
          },
        ],
      },
      { createdBy: "leader" },
    );
    const s2 = new SharedTaskStore(path);
    expect(s2.listTasks().length).toBe(1);
    s2.write(
      {
        todos: [
          {
            subject: "from-teammate",
            description: "",
            owner: "",
            blocks: [],
            blockedBy: [],
          },
        ],
      },
      { createdBy: "bob" },
    );
    expect(s1.get("2")?.subject).toBe("from-teammate");
  });
  test("initEmpty clears and resets ids", () => {
    const store = new SharedTaskStore(join(tempDir(), "tasks.json"));
    store.write(
      {
        todos: [
          {
            subject: "x",
            description: "",
            owner: "",
            blocks: [],
            blockedBy: [],
          },
        ],
      },
      { createdBy: "" },
    );
    store.initEmpty();
    expect(store.listTasks().length).toBe(0);
    expect(
      store
        .write(
          {
            todos: [
              {
                subject: "y",
                description: "",
                owner: "",
                blocks: [],
                blockedBy: [],
              },
            ],
          },
          { createdBy: "" },
        )
        .slice(-1)[0].id,
    ).toBe("1");
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
    const create = new TeamTodoWriteTool(mgr, "my-team", "leader");
    const list = new TeamTodoWriteTool(mgr, "my-team");
    const update = new TeamTodoWriteTool(mgr, "my-team");
    const get = new TeamTodoWriteTool(mgr, "my-team");
    const ctx = { cwd: process.cwd() };
    const created = await create.execute(ctx, {
      todos: [
        {
          subject: "build parser",
          description: "implement parser",
        },
      ],
    });
    expect(created.isError).toBe(false);
    expect(JSON.parse(created.output)).toMatchObject({ todos: [{ id: "1" }] });
    mgr.get("my-team")?.addMember("alice");
    await update.execute(ctx, { todos: [{ id: "1", owner: "alice" }] });
    const listed = await list.execute({ cwd: process.cwd() }, {});
    expect(listed.output).toContain("build parser");
    expect(JSON.parse(listed.output)).toMatchObject({
      todos: [{ owner: "alice" }],
    });
    const updated = await update.execute(ctx, {
      todos: [
        {
          id: "1",
          status: "completed",
        },
      ],
    });
    expect(updated.output).toContain("completed");
    const got = await get.execute(ctx, {});
    expect(JSON.parse(got.output)).toMatchObject({
      todos: [{ status: "completed", owner: "alice" }],
    });
    expect(list.schema().input_schema.properties).toHaveProperty("todos");
  });
  test("update rejects invalid status", async () => {
    const ctx = { cwd: process.cwd() };
    await new TeamTodoWriteTool(mgr, "my-team").execute(ctx, {
      todos: [
        {
          subject: "t",
          description: "",
        },
      ],
    });
    const r = await new TeamTodoWriteTool(mgr, "my-team").execute(ctx, {
      todos: [
        {
          id: "1",
          status: "done",
        },
      ],
    });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("status");
  });
  test("tools reject invalid dependency input atomically and support cancelled/deleted", async () => {
    const ctx = { cwd: process.cwd() };
    const create = new TeamTodoWriteTool(mgr, "my-team");
    const update = new TeamTodoWriteTool(mgr, "my-team");
    const list = new TeamTodoWriteTool(mgr, "my-team");
    expect(
      (
        await create.execute(ctx, {
          todos: [
            {
              subject: "future",
              description: "",
              blocks: ["2"],
            },
          ],
        })
      ).isError,
    ).toBe(true);
    expect(mgr.getTaskStore("my-team").listTasks()).toEqual([]);
    expect(
      (
        await create.execute(ctx, {
          todos: [{ subject: "first", description: "" }],
        })
      ).isError,
    ).toBe(false);
    expect(
      (
        await create.execute(ctx, {
          todos: [{ subject: "second", description: "" }],
        })
      ).isError,
    ).toBe(false);
    expect(
      (await update.execute(ctx, { todos: [{ id: "2", blockedBy: ["1"] }] }))
        .isError,
    ).toBe(false);
    for (const dependencies of [["missing"], [42], ["2"]]) {
      expect(
        (
          await update.execute(ctx, {
            todos: [
              {
                id: "1",
                status: "completed",
                blockedBy: dependencies,
              },
            ],
          })
        ).isError,
      ).toBe(true);
      expect(mgr.getTaskStore("my-team").get("1")?.status).toBe("pending");
    }
    expect(
      (await update.execute(ctx, { todos: [{ id: "2", status: "cancelled" }] }))
        .isError,
    ).toBe(false);
    expect((await list.execute({ cwd: process.cwd() }, {})).output).toContain(
      "cancelled",
    );
    expect((await update.execute(ctx, { deleteIds: ["2"] })).isError).toBe(
      false,
    );
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
