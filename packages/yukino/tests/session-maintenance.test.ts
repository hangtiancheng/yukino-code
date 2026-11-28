import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import type * as fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { COST_DIRECTORY, COST_FORMAT } from "@/cost/constants.js";
import { FILE_HISTORY_DIR_NAME } from "@/file-history/constants.js";
import {
  SESSION_LEASE_ACTIVE,
  SESSION_LEASE_SUFFIX,
  SESSION_MAINTENANCE_CONFIRMATION,
  SESSION_MAINTENANCE_REFERENCED,
  SESSION_MAINTENANCE_STALE,
  SESSION_MAINTENANCE_UNKNOWN,
  SESSION_STORAGE_CHANGED,
  SESSION_STORAGE_UNSAFE,
} from "@/session/constants.js";
import {
  acquireSessionRunLease,
  listSessionRunLeases,
  sessionStorageIdentity,
  type SessionStorageTarget,
} from "@/session/lease.js";
import {
  archiveSession,
  executeSessionMaintenance,
  planSessionMaintenance,
  SessionMaintenancePlanSchema,
  unarchiveSession,
  type SessionMaintenancePlan,
} from "@/session/maintenance.js";
import { SessionManager } from "@/session/manager.js";
import {
  getSessionArtifactsDir,
  getSessionFilePath,
  SessionConflictError,
} from "@/session/records.js";
import { getYukinoDir, projectKey } from "@/storage/index.js";
import { mkdirPrivateSync, writePrivateFileSync } from "@/storage/private.js";
import { SPILL_DIR_NAME } from "@/tool-result/constants.js";
import { canonicalPath } from "@/utils/paths.js";

const race = vi.hoisted(() => {
  let beforeRename: ((path: string) => void) | undefined;
  return { beforeRename };
});
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  return {
    ...original,
    renameSync(from: fs.PathLike, to: fs.PathLike) {
      if (typeof from === "string" && race.beforeRename) {
        const operation = race.beforeRename;
        race.beforeRename = undefined;
        operation(from);
      }
      original.renameSync(from, to);
    },
  };
});

afterEach(() => {
  race.beforeRename = undefined;
});

function session(project = "project"): {
  manager: SessionManager;
  target: SessionStorageTarget;
} {
  const cwd = join(dirname(getYukinoDir()), project);
  mkdirSync(cwd, { recursive: true });
  const manager = SessionManager.create(cwd);
  return { manager, target: { cwd, sessionId: manager.id } };
}

function spill(id: string, name: string, content = "owned output"): string {
  const path = join(getSessionArtifactsDir(id), SPILL_DIR_NAME, `${name}.txt`);
  mkdirPrivateSync(dirname(path));
  writePrivateFileSync(path, content);
  return path;
}

function execute(target: SessionStorageTarget, plan: SessionMaintenancePlan) {
  return executeSessionMaintenance(target, plan, {
    confirmed: true,
    planId: plan.planId,
  });
}

function childLease(target: SessionStorageTarget): {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  exited: Promise<void>;
} {
  const modulePath = fileURLToPath(
    new URL("../src/session/lease.ts", import.meta.url),
  );
  const source = `import { acquireSessionRunLease } from ${JSON.stringify(modulePath)};
    const handle = acquireSessionRunLease(${JSON.stringify(target)}, "background");
    process.stdout.write("ready\\n");
    process.stdin.once("data", () => { handle.release(); process.exit(0); });`;
  const child = spawn(
    process.execPath,
    [
      "--import",
      fileURLToPath(import.meta.resolve("tsx")),
      "--input-type=module",
      "-e",
      source,
    ],
    {
      cwd: target.cwd,
      env: {
        ...process.env,
        HOME: dirname(getYukinoDir()),
        TSX_TSCONFIG_PATH: fileURLToPath(
          new URL("../tsconfig.json", import.meta.url),
        ),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  let output = "";
  child.stderr.on("data", (bytes: Buffer) => {
    stderr += bytes.toString();
  });
  const ready = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.stdout.on("data", (bytes: Buffer) => {
      output += bytes.toString();
      if (output.includes("ready\n")) {
        resolve();
      }
    });
    child.once("exit", (code) => {
      if (!output.includes("ready\n")) {
        reject(new Error(`Child failed (${String(code)}): ${stderr}`));
      }
    });
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
  });
  return { child, ready, exited };
}

describe("revision-guarded session archive", () => {
  it("preserves full metadata and appends an explicit full metadata record", () => {
    const { manager } = session();
    manager.setMetadata({ name: "keep name", tags: ["one", "two"] });
    const revision = manager.revision;
    expect(archiveSession(manager, revision)).toEqual({
      name: "keep name",
      tags: ["one", "two"],
      archived: true,
    });
    expect(manager.revision).toBe(revision + 1);
    const last = readFileSync(
      getSessionFilePath(manager.cwd, manager.id),
      "utf8",
    )
      .trim()
      .split("\n")
      .at(-1);
    expect(last).toContain(
      '"metadata":{"name":"keep name","tags":["one","two"],"archived":true}',
    );
    expect(unarchiveSession(manager)).toEqual({
      name: "keep name",
      tags: ["one", "two"],
      archived: false,
    });
  });

  it("rejects stale managers without overwriting a peer's metadata", () => {
    const { manager } = session();
    const stale = SessionManager.open(manager.cwd, manager.id);
    manager.setMetadata({ name: "peer", tags: ["retained"] });
    expect(() => archiveSession(stale)).toThrow(SessionConflictError);
    expect(manager.getMetadata()).toEqual({ name: "peer", tags: ["retained"] });
    expect(archiveSession(stale, manager.revision).name).toBe("peer");
  });

  it("supports in-memory archive without creating durable state", () => {
    const cwd = join(dirname(getYukinoDir()), "ephemeral");
    mkdirSync(cwd);
    const manager = SessionManager.create(cwd, { persist: false });
    manager.setMetadata({ name: "memory", tags: ["kept"] });
    archiveSession(manager);
    unarchiveSession(manager);
    expect(manager.getMetadata()).toEqual({
      name: "memory",
      tags: ["kept"],
      archived: false,
    });
    expect(existsSync(getSessionFilePath(cwd, manager.id))).toBe(false);
  });
});

describe("confirmed session maintenance", () => {
  it("produces immutable, schema-validated exact previews and deletes only owned tmp data", () => {
    const { manager, target } = session();
    manager.appendArtifact(Buffer.from("inline"), "text/plain");
    const output = spill(manager.id, "call");
    const workspace = join(target.cwd, "keep.txt");
    writeFileSync(workspace, "workspace data");
    const cost = join(
      getYukinoDir(),
      COST_DIRECTORY,
      projectKey(target.cwd),
      `${createHash("sha256").update(manager.id).digest("hex")}.jsonl`,
    );
    mkdirPrivateSync(dirname(cost));
    writePrivateFileSync(
      cost,
      `${JSON.stringify({ format: COST_FORMAT, revision: 1, type: "run", run: { sessionId: manager.id, runId: "owned-run" } })}\n`,
    );
    const plan = planSessionMaintenance(target, "delete");
    expect(
      SessionMaintenancePlanSchema.parse(JSON.parse(JSON.stringify(plan))),
    ).toEqual(plan);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.paths)).toBe(true);
    expect(plan.paths.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(plan.referencePreview[0]?.sessionIds)).toBe(true);
    expect(
      plan.paths.find((entry) => entry.path === canonicalPath(output))?.sha256,
    ).toMatch(/^[a-f\d]{64}$/u);
    expect(
      plan.referencePreview.some(
        (entry) => entry.path === null && entry.artifactId,
      ),
    ).toBe(true);
    expect(() =>
      executeSessionMaintenance(target, plan, {
        confirmed: false,
        planId: plan.planId,
      }),
    ).toThrow(SESSION_MAINTENANCE_CONFIRMATION);
    expect(() =>
      executeSessionMaintenance(target, plan, {
        confirmed: true,
        planId: "0".repeat(64),
      }),
    ).toThrow(SESSION_MAINTENANCE_CONFIRMATION);
    const result = execute(target, plan);
    expect(result.deletedBytes).toBeGreaterThan(0);
    expect(existsSync(output)).toBe(false);
    expect(existsSync(cost)).toBe(false);
    expect(existsSync(getSessionFilePath(target.cwd, manager.id))).toBe(false);
    expect(readFileSync(workspace, "utf8")).toBe("workspace data");
    expect(() => acquireSessionRunLease(target, "foreground")).toThrow(
      "Session does not exist",
    );
  });

  it("cleans orphan spills while retaining the transcript, referenced spills, and rewind state", () => {
    const { manager, target } = session();
    const kept = spill(manager.id, "kept");
    const orphan = spill(manager.id, "orphan");
    manager.append({ role: "user", content: `Saved output: ${kept}` });
    const history = join(
      getSessionArtifactsDir(manager.id),
      FILE_HISTORY_DIR_NAME,
      "backup",
    );
    mkdirPrivateSync(dirname(history));
    writePrivateFileSync(history, "rewind data");
    const plan = planSessionMaintenance(target, "cleanup");
    expect(plan.paths.map((entry) => entry.path)).toEqual([
      canonicalPath(orphan),
    ]);
    expect(
      plan.referencePreview.find((entry) => entry.path === canonicalPath(kept))
        ?.sessionIds,
    ).toEqual([manager.id]);
    execute(target, plan);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(kept)).toBe(true);
    expect(existsSync(history)).toBe(true);
    expect(existsSync(getSessionFilePath(target.cwd, manager.id))).toBe(true);
  });

  it("removes wholly orphaned spill trees and allows empty cleanup", () => {
    const { manager, target } = session();
    const path = spill(manager.id, "orphan");
    execute(target, planSessionMaintenance(target, "cleanup"));
    expect(existsSync(dirname(path))).toBe(false);
    expect(
      execute(target, planSessionMaintenance(target, "cleanup")).deletedPaths,
    ).toEqual([]);
  });

  it("rejects stale revisions, replaced transcripts, changed artifacts, and new catalog entries", () => {
    const { manager, target } = session();
    let plan = planSessionMaintenance(target, "delete");
    manager.setMetadata({ name: "new revision" });
    expect(() => execute(target, plan)).toThrow(SessionConflictError);
    plan = planSessionMaintenance(target, "delete");
    const transcript = getSessionFilePath(target.cwd, target.sessionId);
    renameSync(transcript, `${transcript}.preserved`);
    writePrivateFileSync(transcript, readFileSync(`${transcript}.preserved`));
    unlinkSync(`${transcript}.preserved`);
    expect(() => execute(target, plan)).toThrow(SESSION_MAINTENANCE_STALE);
    const artifact = spill(manager.id, "changed", "first");
    plan = planSessionMaintenance(target, "delete");
    writePrivateFileSync(artifact, "other");
    expect(() => execute(target, plan)).toThrow(SESSION_MAINTENANCE_STALE);
    plan = planSessionMaintenance(target, "delete");
    session("other-project");
    expect(() => execute(target, plan)).toThrow(SESSION_MAINTENANCE_STALE);
    expect(existsSync(transcript)).toBe(true);
  });

  it("rejects caller-selected paths and cross-project plans without touching them", () => {
    const { target } = session();
    const other = session("other");
    const outside = join(target.cwd, "not-owned.txt");
    writeFileSync(outside, "untouched");
    const plan = planSessionMaintenance(target, "delete");
    const altered = { ...plan, roots: [outside] };
    expect(() =>
      executeSessionMaintenance(target, altered, {
        confirmed: true,
        planId: plan.planId,
      }),
    ).toThrow(SESSION_MAINTENANCE_STALE);
    expect(() => execute(other.target, plan)).toThrow(
      SESSION_MAINTENANCE_STALE,
    );
    expect(readFileSync(outside, "utf8")).toBe("untouched");
  });

  it.each(["clone", "fork", "import"] as const)(
    "preserves source provenance when deleting a %s copy",
    (operation) => {
      const { manager, target } = session();
      const sourceArtifact = spill(manager.id, "source");
      const entry = manager.append({ role: "user", content: "source input" });
      const copy =
        operation === "clone"
          ? manager.clone()
          : operation === "fork"
            ? manager.fork(entry)
            : SessionManager.import(
                manager.cwd,
                manager.export({ format: "jsonl", scope: "tree" }),
              );
      expect(() => planSessionMaintenance(target, "delete")).toThrow(
        SESSION_MAINTENANCE_REFERENCED,
      );
      const copyTarget = { cwd: copy.cwd, sessionId: copy.id };
      execute(copyTarget, planSessionMaintenance(copyTarget, "delete"));
      expect(existsSync(getSessionFilePath(manager.cwd, manager.id))).toBe(
        true,
      );
      expect(readFileSync(sourceArtifact, "utf8")).toBe("owned output");
    },
  );

  it("refuses artifact references from another canonical project", () => {
    const { manager, target } = session();
    const output = spill(manager.id, "shared");
    const peer = session("peer");
    peer.manager.append({ role: "user", content: `Shared output ${output}` });
    expect(() => planSessionMaintenance(target, "delete")).toThrow(
      SESSION_MAINTENANCE_REFERENCED,
    );
    expect(existsSync(output)).toBe(true);
  });

  it("detects external references embedded in another owner's persisted payload", () => {
    const { manager, target } = session();
    const output = spill(manager.id, "shared");
    const peer = session("peer");
    spill(
      peer.manager.id,
      "nested",
      JSON.stringify({ artifact: { path: output } }),
    );
    expect(() => planSessionMaintenance(target, "delete")).toThrow(
      SESSION_MAINTENANCE_REFERENCED,
    );
  });

  it("detects escaped structured references and lexically normalized owner paths", () => {
    const { manager, target } = session();
    const output = spill(manager.id, "shared");
    const peer = session("peer");
    peer.manager.append({
      role: "system",
      type: "custom-data",
      content: JSON.stringify({ sourceSessionId: manager.id }).replaceAll(
        manager.id,
        manager.id.replaceAll(
          /./gu,
          (character) =>
            `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
        ),
      ),
    });
    expect(() => planSessionMaintenance(target, "delete")).toThrow(
      SESSION_MAINTENANCE_REFERENCED,
    );
    const plan = planSessionMaintenance(peer.target, "delete");
    execute(peer.target, plan);
    manager.append({
      role: "user",
      content: `${dirname(output)}/child/../shared.txt`,
    });
    expect(planSessionMaintenance(target, "cleanup").paths).toEqual([]);
  });

  it("refuses unknown ownership or unparseable external transcripts", () => {
    const { manager, target } = session();
    const unknown = join(getSessionArtifactsDir(manager.id), "unknown");
    mkdirPrivateSync(unknown);
    expect(() => planSessionMaintenance(target, "delete")).toThrow(
      SESSION_MAINTENANCE_UNKNOWN,
    );
    const other = session("other");
    writePrivateFileSync(
      getSessionFilePath(other.target.cwd, other.manager.id),
      "unknown transcript\n",
    );
    expect(() => planSessionMaintenance(other.target, "delete")).toThrow();
  });

  it("refuses a canonical cost file containing a different session owner", () => {
    const { manager, target } = session();
    const cost = join(
      getYukinoDir(),
      COST_DIRECTORY,
      projectKey(target.cwd),
      `${createHash("sha256").update(manager.id).digest("hex")}.jsonl`,
    );
    mkdirPrivateSync(dirname(cost));
    writePrivateFileSync(
      cost,
      `${JSON.stringify({ format: COST_FORMAT, revision: 1, type: "run", run: { sessionId: "different", runId: "run" } })}\n`,
    );
    expect(() => planSessionMaintenance(target, "delete")).toThrow(
      SESSION_MAINTENANCE_UNKNOWN,
    );
    expect(existsSync(cost)).toBe(true);
  });
});

describe("storage link and replacement safety", () => {
  it.each(["symlink", "hardlink"] as const)(
    "refuses %s transcripts before any destructive operation",
    (kind) => {
      const { target } = session();
      const path = getSessionFilePath(target.cwd, target.sessionId);
      const preserved = join(target.cwd, "preserved");
      renameSync(path, preserved);
      if (kind === "symlink") {
        symlinkSync(preserved, path);
      } else {
        linkSync(preserved, path);
      }
      expect(() => planSessionMaintenance(target, "delete")).toThrow(
        SESSION_STORAGE_UNSAFE,
      );
      expect(() => acquireSessionRunLease(target, "vm")).toThrow(
        SESSION_STORAGE_UNSAFE,
      );
      expect(existsSync(preserved)).toBe(true);
    },
  );

  it.each(["symlink", "hardlink"] as const)(
    "refuses %s artifacts introduced after preview",
    (kind) => {
      const { manager, target } = session();
      const output = spill(manager.id, "output");
      const plan = planSessionMaintenance(target, "delete");
      const outside = join(target.cwd, "outside");
      writeFileSync(outside, "outside data");
      unlinkSync(output);
      if (kind === "symlink") {
        symlinkSync(outside, output);
      } else {
        linkSync(outside, output);
      }
      expect(() => execute(target, plan)).toThrow(SESSION_STORAGE_UNSAFE);
      expect(readFileSync(outside, "utf8")).toBe("outside data");
    },
  );

  it("refuses linked owner ancestors and a linked .yukino root", () => {
    const { manager, target } = session();
    spill(manager.id, "output");
    const owner = getSessionArtifactsDir(manager.id);
    const preserved = join(target.cwd, "owner-preserved");
    renameSync(owner, preserved);
    symlinkSync(preserved, owner);
    expect(() => planSessionMaintenance(target, "delete")).toThrow(
      SESSION_STORAGE_UNSAFE,
    );
    unlinkSync(owner);
    renameSync(preserved, owner);
    const root = getYukinoDir();
    renameSync(root, `${root}-preserved`);
    symlinkSync(`${root}-preserved`, root);
    expect(() => planSessionMaintenance(target, "delete")).toThrow(
      SESSION_STORAGE_UNSAFE,
    );
  });

  it("preserves a replacement raced into staging, even with identical content", () => {
    const { target } = session();
    const plan = planSessionMaintenance(target, "delete");
    const transcript = sessionStorageIdentity(target).transcriptPath;
    race.beforeRename = (path) => {
      expect(path).toBe(transcript);
      const bytes = readFileSync(path);
      renameSync(path, join(target.cwd, "original-preserved"));
      writePrivateFileSync(path, bytes);
    };
    expect(() => execute(target, plan)).toThrow(SESSION_STORAGE_CHANGED);
    expect(existsSync(join(target.cwd, "original-preserved"))).toBe(true);
    const quarantines = readdirSync(dirname(transcript)).filter((name) =>
      name.includes(".maintenance-"),
    );
    expect(quarantines).toHaveLength(1);
    expect(
      readFileSync(join(dirname(transcript), quarantines[0], "0"), "utf8"),
    ).toContain(target.sessionId);
  });

  it("preserves all staged sources when another session adds a reference during staging", () => {
    const { manager, target } = session();
    const output = spill(manager.id, "output");
    const peer = session("peer");
    const plan = planSessionMaintenance(target, "delete");
    race.beforeRename = () => {
      peer.manager.append({ role: "user", content: `New reference ${output}` });
    };
    expect(() => execute(target, plan)).toThrow(SESSION_STORAGE_CHANGED);
    const transcript = sessionStorageIdentity(target).transcriptPath;
    const quarantine = readdirSync(dirname(transcript)).find((name) =>
      name.includes(".maintenance-"),
    );
    if (!quarantine) {
      throw new Error("Missing quarantine");
    }
    expect(
      readFileSync(join(dirname(transcript), quarantine, "0"), "utf8"),
    ).toContain(manager.id);
    expect(
      readFileSync(
        join(
          dirname(transcript),
          quarantine,
          "1",
          SPILL_DIR_NAME,
          "output.txt",
        ),
        "utf8",
      ),
    ).toBe("owned output");
  });

  it("uses the same canonical transcript for project aliases", () => {
    const { target } = session();
    const alias = join(dirname(getYukinoDir()), "alias");
    symlinkSync(target.cwd, alias);
    expect(sessionStorageIdentity({ ...target, cwd: alias })).toEqual(
      sessionStorageIdentity(target),
    );
    const plan = planSessionMaintenance({ ...target, cwd: alias }, "delete");
    execute(target, plan);
  });
});

describe("cross-process run leases", () => {
  it("allows concurrent ownership kinds and idempotent release", () => {
    const { target } = session();
    const plan = planSessionMaintenance(target, "delete");
    const leases = ["foreground", "background", "vm", "warming"].map((kind) =>
      acquireSessionRunLease(
        target,
        kind === "foreground"
          ? "foreground"
          : kind === "background"
            ? "background"
            : kind === "vm"
              ? "vm"
              : "warming",
      ),
    );
    expect(new Set(leases.map((handle) => handle.lease.ownerToken)).size).toBe(
      4,
    );
    expect(listSessionRunLeases(target)).toHaveLength(4);
    expect(() => execute(target, plan)).toThrow(SESSION_LEASE_ACTIVE);
    for (const handle of leases) {
      handle.release();
      handle.release();
    }
    expect(listSessionRunLeases(target)).toEqual([]);
    execute(target, plan);
  });

  it("never expires a live child's lease based on timestamps and succeeds after release", async () => {
    const { target } = session();
    const plan = planSessionMaintenance(target, "delete");
    const running = childLease(target);
    try {
      await running.ready;
      const lease = listSessionRunLeases(target)[0];
      expect(lease?.pid).toBe(running.child.pid);
      if (!lease) {
        throw new Error("Missing child lease");
      }
      const path = `${getSessionFilePath(target.cwd, target.sessionId)}${SESSION_LEASE_SUFFIX}/${lease.ownerToken}.json`;
      utimesSync(path, new Date(0), new Date(0));
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(() => execute(target, plan)).toThrow(SESSION_LEASE_ACTIVE);
      expect(existsSync(path)).toBe(true);
      running.child.stdin.end("release\n");
      await running.exited;
      execute(target, plan);
    } finally {
      running.child.kill("SIGKILL");
      await running.exited;
    }
  });

  it("reclaims an actually dead child's lease without waiting for a TTL", async () => {
    const { target } = session();
    const plan = planSessionMaintenance(target, "delete");
    const running = childLease(target);
    try {
      await running.ready;
      expect(listSessionRunLeases(target)).toHaveLength(1);
      running.child.kill("SIGKILL");
      await running.exited;
      expect(listSessionRunLeases(target)).toEqual([]);
      execute(target, plan);
    } finally {
      running.child.kill("SIGKILL");
      await running.exited;
    }
  });

  it("reclaims a dead process's partial publication, but never a live process's", async () => {
    const { target } = session();
    const running = childLease(target);
    try {
      await running.ready;
      const partial = join(
        `${getSessionFilePath(target.cwd, target.sessionId)}${SESSION_LEASE_SUFFIX}`,
        `${running.child.pid}-${"a".repeat(64)}.pending`,
      );
      writePrivateFileSync(partial, '{"partial":');
      expect(() => listSessionRunLeases(target)).toThrow(SESSION_LEASE_ACTIVE);
      expect(existsSync(partial)).toBe(true);
      running.child.kill("SIGKILL");
      await running.exited;
      const handle = acquireSessionRunLease(target, "warming");
      expect(existsSync(partial)).toBe(false);
      handle.release();
      execute(target, planSessionMaintenance(target, "delete"));
    } finally {
      running.child.kill("SIGKILL");
      await running.exited;
    }
  });

  it.each(["symlink", "hardlink"] as const)(
    "refuses %s lease files without reclaiming them",
    (kind) => {
      const { target } = session();
      const handle = acquireSessionRunLease(target, "foreground");
      const path = join(
        `${getSessionFilePath(target.cwd, target.sessionId)}${SESSION_LEASE_SUFFIX}`,
        `${handle.lease.ownerToken}.json`,
      );
      const preserved = join(target.cwd, "lease-preserved");
      renameSync(path, preserved);
      if (kind === "symlink") {
        symlinkSync(preserved, path);
      } else {
        linkSync(preserved, path);
      }
      expect(() => listSessionRunLeases(target)).toThrow(
        SESSION_STORAGE_UNSAFE,
      );
      expect(() => {
        handle.release();
      }).toThrow(SESSION_STORAGE_UNSAFE);
      expect(existsSync(preserved)).toBe(true);
    },
  );

  it("refuses invalid or substituted lease ownership", () => {
    const { target } = session();
    const handle = acquireSessionRunLease(target, "foreground");
    const path = join(
      `${getSessionFilePath(target.cwd, target.sessionId)}${SESSION_LEASE_SUFFIX}`,
      `${handle.lease.ownerToken}.json`,
    );
    writePrivateFileSync(
      path,
      JSON.stringify({ ...handle.lease, sessionId: "different" }),
    );
    expect(() => {
      handle.release();
    }).toThrow();
    expect(() => listSessionRunLeases(target)).toThrow();
    expect(() => planSessionMaintenance(target, "delete")).toThrow();
    expect(existsSync(path)).toBe(true);
  });
});
