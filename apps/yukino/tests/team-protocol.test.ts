/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { FileMailMessage } from "@/teams/file-mailbox.js";
import { TeamManager } from "@/teams/index.js";
import {
  MSG_PLAN_APPROVAL_REQUEST,
  MSG_PLAN_APPROVAL_RESPONSE,
  MSG_SHUTDOWN_REQUEST,
  MSG_SHUTDOWN_RESPONSE,
  approved,
  isShutdownRequest,
  newRequestId,
  planApprovalRequest,
  planApprovalResponse,
  shutdownRequest,
  shutdownResponse,
} from "@/teams/protocol.js";
import { SendMessageTool } from "@/teams/tools.js";

const plain = (from: string, text: string): FileMailMessage => ({
  from,
  text,
  timestamp: new Date().toISOString(),
});

describe("shutdown negotiation", () => {
  test("recognizes a shutdown request", () => {
    const req = shutdownRequest("lead", "wrap up");
    expect(req.type).toBe(MSG_SHUTDOWN_REQUEST);
    expect(req.requestId).toBeTruthy();
    expect(isShutdownRequest(req)).toBe(true);

    // Plain-text prefixes must also be recognized, since pane teammates may be older-version processes
    expect(isShutdownRequest(plain("lead", "[shutdown] stop"))).toBe(true);
    expect(
      isShutdownRequest(plain("lead", "keep working on the auth module")),
    ).toBe(false);
  });

  test("the response carries the request id and the stance", () => {
    const req = shutdownRequest("lead", "wrap up");
    const yes = shutdownResponse("alice", req.requestId ?? "", true, "done");
    expect(approved(yes)).toBe(true);
    expect(yes.requestId).toBe(req.requestId);
    expect(yes.type).toBe(MSG_SHUTDOWN_RESPONSE);

    const no = shutdownResponse(
      "alice",
      req.requestId ?? "",
      false,
      "still running tests",
    );
    expect(approved(no)).toBe(false);

    // With no stance expressed, treat it as disagreement, not as a nod
    expect(approved(plain("alice", ""))).toBe(false);
  });
});

describe("plan approval", () => {
  test("a request and a response round-trip", () => {
    const req = planApprovalRequest(
      "alice",
      "1. Read the auth package first\n2. Extract the interface",
    );
    expect(req.type).toBe(MSG_PLAN_APPROVAL_REQUEST);
    expect(req.text).toContain("Extract the interface");

    const rej = planApprovalResponse(
      "lead",
      req.requestId ?? "",
      false,
      "don't touch the handler layer",
    );
    expect(approved(rej)).toBe(false);
    expect(rej.text).toBe("don't touch the handler layer");
    expect(rej.requestId).toBe(req.requestId);
  });
});

describe("serialization", () => {
  test("fields survive a serialization round-trip", () => {
    const req = shutdownRequest("lead", "wrap up");
    const resp = shutdownResponse(
      "alice",
      req.requestId ?? "",
      false,
      "not done yet",
    );

    expect(resp.type).toBe(MSG_SHUTDOWN_RESPONSE);
    expect(resp.requestId).toBe(req.requestId);
    expect(resp.approve).toBe(false);
  });

  test("request ids do not repeat", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(newRequestId());
    }
    expect(seen.size).toBe(200);
  });
});

// The teams directory lives at <home>/.yukino/teams, so the tests redirect the
// entire home directory to a temp dir to avoid leaving residue in the real ~/.yukino/teams.
describe("SendMessage delivers structured messages", () => {
  let origHome: string | undefined;
  let origUserProfile: string | undefined;

  beforeEach(() => {
    origHome = process.env.HOME;
    origUserProfile = process.env.USERPROFILE;
    const tmp = mkdtempSync(join(tmpdir(), "yukino-home-"));
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
  });
  afterEach(() => {
    if (origHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = origHome;
    }
    if (origUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = origUserProfile;
    }
  });

  const setup = () => {
    const mgr = new TeamManager(mkdtempSync(join(tmpdir(), "yukino-team-")));
    const team = mgr.create("squad");
    team.addMember("alice");
    return { mgr, team };
  };

  test("delivers an approval response carrying the request id and stance to the teammate's mailbox", async () => {
    const { mgr, team } = setup();
    const tool = new SendMessageTool(mgr, "lead");

    const res = await tool.execute(
      {
        workDir: ".",
      },
      {
        to: "alice",
        content: "don't touch the handler layer",
        type: MSG_PLAN_APPROVAL_RESPONSE,
        request_id: "req-abc",
        approve: false,
      },
    );
    expect(res.isError).toBe(false);

    const [msg] = team.getMember("alice")?.mailbox.receiveSync() ?? [];
    expect(msg?.type).toBe(MSG_PLAN_APPROVAL_RESPONSE);
    expect(msg?.requestId).toBe("req-abc");
    expect(msg?.approve).toBe(false);
    expect(msg?.text).toBe("don't touch the handler layer");
  });

  test("a shutdown request carries an acknowledgement-capable request id", async () => {
    const { mgr, team } = setup();
    const tool = new SendMessageTool(mgr, "lead");

    await tool.execute(
      {
        workDir: process.cwd(),
      },
      {
        to: "alice",
        content: "wrap up",
        type: MSG_SHUTDOWN_REQUEST,
      },
    );

    const [msg] = team.getMember("alice")?.mailbox.receiveSync() ?? [];
    expect(isShutdownRequest(msg)).toBe(true);
    expect(msg?.requestId).toBeTruthy();
  });

  test("errors and does not deliver when an approval response lacks a request id or stance", async () => {
    const { mgr, team } = setup();
    const tool = new SendMessageTool(mgr, "lead");

    const res = await tool.execute(
      {
        workDir: process.cwd(),
      },
      {
        to: "alice",
        content: "ok",
        type: MSG_PLAN_APPROVAL_RESPONSE,
        approve: true,
      },
    );
    expect(res.isError).toBe(true);
    expect(team.getMember("alice")?.mailbox.receiveSync()).toHaveLength(0);
  });
});
