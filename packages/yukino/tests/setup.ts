import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type * as os from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, vi } from "vitest";

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof os>();
  return {
    ...original,
    homedir: () => process.env.YUKINO_TEST_HOME ?? original.homedir(),
  };
});

const homes: string[] = [];
function resetHome(): void {
  const home = mkdtempSync(join(tmpdir(), "yukino-test-home-"));
  process.env.YUKINO_TEST_HOME = home;
  homes.push(home);
}

resetHome();
beforeEach(resetHome);
afterAll(() => {
  for (const home of homes) {
    rmSync(home, { recursive: true, force: true });
  }
});
