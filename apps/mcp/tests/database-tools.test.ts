import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BSON } from "mongodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { mongodbModule } from "@/tools/mongodb/tool.js";
import { mysqlModule } from "@/tools/mysql/tool.js";
import { postgresModule } from "@/tools/postgres/tool.js";
import { redisModule } from "@/tools/redis/tool.js";
import { firstText, isolateEnv } from "./helpers.js";

const drivers = vi.hoisted(() => {
  const postgres = {
    connect: vi.fn(),
    query: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
  };
  const mysql = { query: vi.fn(), end: vi.fn() };
  const redis = {
    connect: vi.fn(),
    sendCommand: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn(),
    isOpen: false,
  };
  const mongodb = { connect: vi.fn(), db: vi.fn(), close: vi.fn() };
  return {
    postgres,
    mysql,
    redis,
    mongodb,
    createPostgres: vi.fn(function () {
      return postgres;
    }),
    createMysql: vi.fn(),
    createRedis: vi.fn(function () {
      return redis;
    }),
    createMongo: vi.fn(function () {
      return mongodb;
    }),
    mongoCommand: vi.fn(),
  };
});

vi.mock("pg", () => ({ Client: drivers.createPostgres }));
vi.mock("mysql2/promise", () => ({ createConnection: drivers.createMysql }));
vi.mock("redis", () => ({ createClient: drivers.createRedis }));
vi.mock("mongodb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("mongodb")>()),
  MongoClient: drivers.createMongo,
}));

const envKeys = [
  "POSTGRES_URL",
  "POSTGRESQL_URL",
  "DATABASE_URL",
  "MYSQL_URL",
  "REDIS_URL",
  "MONGODB_URL",
  "MONGODB_DATABASE",
];
isolateEnv(envKeys);
let client: Client;
const resultSchema = z.object({
  content: z.array(z.unknown()),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
});
async function call(name: string, args: Record<string, unknown>) {
  return resultSchema.parse(await client.callTool({ name, arguments: args }));
}

beforeEach(async () => {
  vi.clearAllMocks();
  for (const key of envKeys) delete process.env[key];
  drivers.postgres.connect.mockResolvedValue(undefined);
  drivers.postgres.end.mockResolvedValue(undefined);
  drivers.postgres.query.mockResolvedValue({
    command: "SELECT",
    rowCount: 1,
    rows: [{ value: 1 }],
    fields: [],
  });
  drivers.createMysql.mockResolvedValue(drivers.mysql);
  drivers.mysql.query.mockResolvedValue([[{ value: 1 }], []]);
  drivers.mysql.end.mockResolvedValue(undefined);
  drivers.redis.isOpen = false;
  drivers.redis.connect.mockImplementation(async () => {
    drivers.redis.isOpen = true;
  });
  drivers.redis.destroy.mockImplementation(() => {
    drivers.redis.isOpen = false;
  });
  drivers.redis.sendCommand.mockResolvedValue("OK");
  drivers.mongodb.connect.mockResolvedValue(undefined);
  drivers.mongodb.close.mockResolvedValue(undefined);
  drivers.mongodb.db.mockReturnValue({ command: drivers.mongoCommand });
  drivers.mongoCommand.mockResolvedValue({ ok: 1 });

  const server = new McpServer({ name: "test", version: "1" });
  for (const module of [
    postgresModule,
    mysqlModule,
    redisModule,
    mongodbModule,
  ])
    module.register(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "1" });
  await Promise.all([client.connect(a), server.connect(b)]);
});
afterEach(async () => {
  await client.close();
});

describe("unrestricted database tools", () => {
  it("registers all four tools without configured databases", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "mongodb_tool",
      "mysql_tool",
      "postgres_tool",
      "redis_tool",
    ]);
    for (const tool of tools)
      expect(tool.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      });
  });

  it.each([
    ["postgres_tool", { sql: "SELECT 1" }, "POSTGRES_URL"],
    ["mysql_tool", { sql: "SELECT 1" }, "MYSQL_URL"],
    ["mongodb_tool", { command: { ping: 1 } }, "MONGODB_URL"],
  ])(
    "reports missing configuration for %s without opening a connection",
    async (name, args, envName) => {
      const result = await call(name, args);
      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain(envName);
      expect(firstText(result)).toContain("connection_url");
      expect(drivers.createPostgres).not.toHaveBeenCalled();
      expect(drivers.createMysql).not.toHaveBeenCalled();
      expect(drivers.createMongo).not.toHaveBeenCalled();
    },
  );

  it("passes PostgreSQL DDL and multi-statement SQL through and returns every result", async () => {
    const sql =
      "BEGIN; CREATE TABLE example(id int); INSERT INTO example VALUES (1); SELECT * FROM example; DROP TABLE example; COMMIT;";
    drivers.postgres.query.mockResolvedValue([
      { command: "CREATE", rowCount: null, rows: [], fields: [] },
      {
        command: "SELECT",
        rowCount: 1,
        rows: [{ id: 1, large: 9007199254740993n }],
        fields: [{ name: "id", dataTypeID: 23 }],
      },
      { command: "DROP", rowCount: null, rows: [], fields: [] },
    ]);
    process.env["POSTGRES_URL"] = "postgresql://configured/db";
    const result = await call("postgres_tool", {
      sql,
      connection_url: "postgresql://override/db",
    });
    expect(result.isError).toBeUndefined();
    expect(drivers.createPostgres).toHaveBeenCalledWith(
      expect.objectContaining({ connectionString: "postgresql://override/db" }),
    );
    expect(drivers.postgres.query).toHaveBeenCalledWith(sql, []);
    const payload = JSON.parse(firstText(result));
    expect(payload).toEqual(result.structuredContent);
    expect(payload.results).toHaveLength(3);
    expect(payload.results[1]).toEqual({
      command: "SELECT",
      row_count: 1,
      rows: [{ id: 1, large: "9007199254740993" }],
      fields: [{ name: "id", data_type_id: 23 }],
    });
    expect(drivers.postgres.end).toHaveBeenCalledOnce();
  });

  it("passes PostgreSQL positional parameters without interpolation", async () => {
    process.env["DATABASE_URL"] = "postgresql://configured/db";
    const sql = "DELETE FROM example WHERE id = $1 RETURNING *";
    await call("postgres_tool", { sql, params: ["1' OR true --"] });
    expect(drivers.postgres.query).toHaveBeenCalledWith(sql, ["1' OR true --"]);
  });

  it("closes PostgreSQL after a query or connection failure and permits retry", async () => {
    drivers.postgres.query.mockRejectedValueOnce(new Error("invalid SQL"));
    const args = {
      connection_url: "postgresql://localhost/db",
      sql: "INVALID",
    };
    expect((await call("postgres_tool", args)).isError).toBe(true);
    expect(drivers.postgres.end).toHaveBeenCalledOnce();
    drivers.postgres.connect.mockRejectedValueOnce(
      new Error("connection refused"),
    );
    expect((await call("postgres_tool", args)).isError).toBe(true);
    expect(drivers.postgres.end).toHaveBeenCalledTimes(2);
    expect((await call("postgres_tool", args)).isError).toBeUndefined();
  });

  it("enables MySQL multi-statements and retains mutation headers and row sets", async () => {
    const sql =
      "INSERT INTO example VALUES (?); SELECT * FROM example; DROP TABLE example";
    const results = [
      { affectedRows: 1, insertId: "9007199254740993" },
      [{ id: 1 }],
      { affectedRows: 0 },
    ];
    drivers.mysql.query.mockResolvedValue([
      results,
      [undefined, [{ name: "id" }], undefined],
    ]);
    process.env["MYSQL_URL"] = "mysql://configured/db";
    const result = await call("mysql_tool", { sql, params: [1] });
    expect(drivers.createMysql).toHaveBeenCalledWith(
      expect.objectContaining({
        uri: "mysql://configured/db",
        multipleStatements: true,
        bigNumberStrings: true,
      }),
    );
    expect(drivers.mysql.query).toHaveBeenCalledWith(sql, [1]);
    expect(result.structuredContent?.["results"]).toEqual(results);
    expect(drivers.mysql.end).toHaveBeenCalledOnce();
  });

  it("closes MySQL after execution errors", async () => {
    drivers.mysql.query.mockRejectedValueOnce(new Error("syntax error"));
    const result = await call("mysql_tool", {
      connection_url: "mysql://localhost/db",
      sql: "INVALID",
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("syntax error");
    expect(drivers.mysql.end).toHaveBeenCalledOnce();
  });

  it("keeps Redis transaction commands in order on an isolated connection", async () => {
    const commands = [
      ["SELECT", "2"],
      ["MULTI"],
      ["SET", "key", "a b"],
      ["FLUSHDB"],
      ["EXEC"],
    ];
    drivers.redis.sendCommand
      .mockResolvedValueOnce("OK")
      .mockResolvedValueOnce("OK")
      .mockResolvedValueOnce("QUEUED")
      .mockResolvedValueOnce("QUEUED")
      .mockResolvedValueOnce(["OK", "OK"]);
    const result = await call("redis_tool", {
      commands,
      connection_url: "redis://override:6379/0",
    });
    expect(drivers.createRedis).toHaveBeenCalledWith(
      expect.objectContaining({ url: "redis://override:6379/0" }),
    );
    expect(
      drivers.redis.sendCommand.mock.calls.map(([command]) => command),
    ).toEqual(commands);
    expect(result.structuredContent).toEqual({
      results: ["OK", "OK", "QUEUED", "QUEUED", ["OK", "OK"]],
    });
    expect(drivers.redis.destroy).toHaveBeenCalledOnce();
  });

  it("normalizes RESP3 maps and returns completed replies when a Redis batch fails", async () => {
    drivers.redis.sendCommand
      .mockResolvedValueOnce(new Map([["field", "value"]]))
      .mockRejectedValueOnce(new Error("ERR invalid command"));
    const result = await call("redis_tool", {
      commands: [["HGETALL", "key"], ["INVALID"], ["FLUSHALL"]],
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      results: [{ field: "value" }],
      failed_command_index: 1,
      error: expect.stringContaining("ERR invalid command"),
    });
    expect(JSON.parse(firstText(result))).toEqual(result.structuredContent);
    expect(drivers.redis.sendCommand).toHaveBeenCalledTimes(2);
    expect(drivers.redis.destroy).toHaveBeenCalledOnce();
  });

  it("returns Redis connection errors without sending any commands", async () => {
    drivers.redis.connect.mockRejectedValueOnce(
      new Error("connection refused"),
    );
    const result = await call("redis_tool", { commands: [["PING"]] });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("connection refused");
    expect(drivers.redis.sendCommand).not.toHaveBeenCalled();
  });

  it("reports failures inside EXEC while retaining all transaction replies", async () => {
    drivers.redis.sendCommand
      .mockResolvedValueOnce("OK")
      .mockResolvedValueOnce("QUEUED")
      .mockResolvedValueOnce([new Error("WRONGTYPE")]);
    const result = await call("redis_tool", {
      commands: [["MULTI"], ["INCR", "string-key"], ["EXEC"], ["PING"]],
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      results: ["OK", "QUEUED", [{ name: "Error", message: "WRONGTYPE" }]],
      failed_command_index: 2,
    });
    expect(drivers.redis.sendCommand).toHaveBeenCalledTimes(3);
    expect(drivers.redis.destroy).toHaveBeenCalledOnce();
  });

  it("accepts arbitrary MongoDB commands and preserves BSON Extended JSON", async () => {
    const id = "507f1f77bcf86cd799439011";
    const command = {
      delete: "users",
      deletes: [{ q: { _id: { $oid: id } }, limit: 1 }],
    };
    const resultDoc = {
      ok: 1,
      cursor: {
        id: BSON.Long.fromString("9007199254740993"),
        firstBatch: [{ _id: new BSON.ObjectId(id) }],
      },
    };
    drivers.mongoCommand.mockResolvedValue(resultDoc);
    process.env["MONGODB_URL"] = "mongodb://configured/default";
    process.env["MONGODB_DATABASE"] = "configured_db";
    const result = await call("mongodb_tool", { database: "admin", command });
    expect(drivers.mongodb.db).toHaveBeenCalledWith("admin");
    const sent = drivers.mongoCommand.mock.calls[0][0];
    expect(sent.deletes[0].q._id).toBeInstanceOf(BSON.ObjectId);
    expect(sent.deletes[0].q._id.toHexString()).toBe(id);
    expect(result.structuredContent).toEqual({
      data: BSON.EJSON.serialize(resultDoc, { relaxed: false }),
    });
    expect(firstText(result)).toContain("9007199254740993");
    expect(drivers.mongodb.close).toHaveBeenCalledOnce();
  });

  it("uses the MongoDB URL's default database and cleans up server errors", async () => {
    drivers.mongoCommand.mockRejectedValueOnce(new Error("command failed"));
    const result = await call("mongodb_tool", {
      connection_url: "mongodb://override/db",
      command: { dropDatabase: 1 },
    });
    expect(drivers.mongodb.db).toHaveBeenCalledWith(undefined);
    expect(result.isError).toBe(true);
    expect(drivers.mongodb.close).toHaveBeenCalledOnce();
  });

  it("rejects malformed inputs before accessing drivers", async () => {
    expect((await call("postgres_tool", { sql: "" })).isError).toBe(true);
    expect((await call("redis_tool", { commands: [[]] })).isError).toBe(true);
    expect((await call("mongodb_tool", { command: {} })).isError).toBe(true);
    expect(drivers.createPostgres).not.toHaveBeenCalled();
    expect(drivers.createRedis).not.toHaveBeenCalled();
    expect(drivers.createMongo).not.toHaveBeenCalled();
  });
});
