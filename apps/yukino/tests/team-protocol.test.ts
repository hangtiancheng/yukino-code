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
    const req = shutdownRequest("leader", "wrap up");
    expect(req.type).toBe(MSG_SHUTDOWN_REQUEST);
    expect(req.requestId).toBeTruthy();
    expect(isShutdownRequest(req)).toBe(true);

    // The leader's stop path also sends plain-text shutdown controls.
    expect(isShutdownRequest(plain("leader", "[shutdown] stop"))).toBe(true);
    expect(
      isShutdownRequest(plain("leader", "keep working on the auth module")),
    ).toBe(false);
  });

  test("the response carries the request id and the stance", () => {
    const req = shutdownRequest("leader", "wrap up");
    const yes = shutdownResponse("alice", req.requestId ?? "", true, "done");
    expect(yes.approve).toBe(true);
    expect(yes.requestId).toBe(req.requestId);
    expect(yes.type).toBe(MSG_SHUTDOWN_RESPONSE);

    const no = shutdownResponse(
      "alice",
      req.requestId ?? "",
      false,
      "still running tests",
    );
    expect(no.approve).toBe(false);
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

    const response = planApprovalResponse(
      "leader",
      req.requestId ?? "",
      "automatically approved",
    );
    expect(response.approve).toBe(true);
    expect(response.text).toBe("automatically approved");
    expect(response.requestId).toBe(req.requestId);
  });
});

describe("serialization", () => {
  test("fields survive a serialization round-trip", () => {
    const req = shutdownRequest("leader", "wrap up");
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

  test("does not expose manual teammate plan approvals", async () => {
    const { mgr, team } = setup();
    const tool = new SendMessageTool(mgr);
    expect(JSON.stringify(tool.schema())).not.toContain(
      MSG_PLAN_APPROVAL_RESPONSE,
    );
    const result = await tool.execute(
      { cwd: "." },
      {
        to: "alice",
        content: "approved",
        type: MSG_PLAN_APPROVAL_RESPONSE,
        request_id: "req-abc",
        approve: true,
      },
    );
    expect(result.isError).toBe(true);
    expect(team.getMember("alice")?.mailbox.unreadCount()).toBe(0);
  });

  test("a shutdown request carries an acknowledgement-capable request id", async () => {
    const { mgr, team } = setup();
    const tool = new SendMessageTool(mgr, "leader");

    await tool.execute(
      {
        cwd: process.cwd(),
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

  test("delivers a structured teammate response to the leader mailbox", async () => {
    const { mgr, team } = setup();
    const tool = new SendMessageTool(mgr, "alice");

    const res = await tool.execute(
      { cwd: process.cwd() },
      {
        to: "leader",
        content: "ready",
        type: MSG_SHUTDOWN_RESPONSE,
        request_id: "req-abc",
        approve: true,
      },
    );

    expect(res.isError).toBe(false);
    const [msg] = team.leaderMailbox.receiveSync();
    expect(msg).toMatchObject({
      from: "alice",
      text: "ready",
      type: MSG_SHUTDOWN_RESPONSE,
      requestId: "req-abc",
      approve: true,
    });
  });
});
