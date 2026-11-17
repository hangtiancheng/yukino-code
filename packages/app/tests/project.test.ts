import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ProjectError, resolveProject } from "../src/main/project.ts";

void test("a removed temporary project reports an actionable error with its path kept separately", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "TestExecutorContextMappingPersistence-"),
  );
  await rm(root, { recursive: true });
  await assert.rejects(resolveProject(root), (error: unknown) => {
    assert.ok(error instanceof ProjectError);
    assert.match(error.message, /Select it again/);
    assert.doesNotMatch(error.message, /ENOENT|lstat|\/private/);
    assert.equal(error.path, root);
    assert.ok(error.cause instanceof Error && "code" in error.cause);
    assert.equal(error.cause.code, "ENOENT");
    return true;
  });
});

void test("project selection canonicalizes aliases and rejects files before switching runtimes", async () => {
  const root = await mkdtemp(join(tmpdir(), "yukino-project-"));
  try {
    const project = join(root, "project");
    const alias = join(root, "alias");
    await mkdir(project);
    await symlink(project, alias, "dir");
    assert.equal(await resolveProject(alias), await resolveProject(project));
    const file = join(root, "file");
    await writeFile(file, "text");
    await assert.rejects(resolveProject(file), /not a folder/);
    await assert.rejects(
      resolveProject(join(file, "child")),
      /Select it again/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
