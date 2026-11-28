import { readdirSync, rmdirSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { yukinoPath } from "@/storage/index.js";
import type * as PrivateStorage from "@/storage/private.js";
import { withFileSyncLock } from "@/teams/file-lock.js";

const race = vi.hoisted(() => ({ code: "", remaining: 0 }));
vi.mock("@/storage/private.js", async (importOriginal) => {
  const original = await importOriginal<typeof PrivateStorage>();
  return {
    ...original,
    mkdirPrivateSync(path: string) {
      original.mkdirPrivateSync(path);
      if (path.endsWith(".lock") && race.remaining > 0) {
        race.remaining--;
        rmdirSync(path);
        throw Object.assign(
          new Error("Lock directory changed during creation"),
          {
            code: race.code,
          },
        );
      }
    },
  };
});

describe("private lock directory creation", () => {
  it("retries when a peer removes the empty directory while it is being protected", () => {
    const path = yukinoPath("race.json");
    race.code = "ENOENT";
    race.remaining = 1;
    const operation = vi.fn(() => "saved");
    expect(withFileSyncLock(path, operation)).toBe("saved");
    expect(operation).toHaveBeenCalledOnce();
    expect(readdirSync(`${path}.lock`)).toEqual([]);
  });

  it("retains an empty lock directory across releases so contenders can create files safely", () => {
    const path = yukinoPath("stable.json");
    const directories: string[][] = [];
    for (let index = 0; index < 3; index++) {
      withFileSyncLock(path, () => {
        directories.push(readdirSync(`${path}.lock`));
      });
      expect(readdirSync(`${path}.lock`)).toEqual([]);
    }
    expect(directories.every((entries) => entries.length === 1)).toBe(true);
  });

  it("propagates protection failures instead of treating them as directory races", () => {
    race.code = "EACCES";
    race.remaining = 1;
    const operation = vi.fn(() => undefined);
    expect(() => {
      withFileSyncLock(yukinoPath("denied.json"), operation);
    }).toThrow("Lock directory changed during creation");
    expect(operation).not.toHaveBeenCalled();
  });
});
