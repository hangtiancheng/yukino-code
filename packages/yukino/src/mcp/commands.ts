import { UriTemplate } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import type { Variables } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import type {
  Resource,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/types.js";
import {
  ResourceSchema,
  ResourceTemplateSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { MCPExposureSchema } from "@/mcp/config.js";
import {
  MCP_COMMAND_APPLY,
  MCP_COMMAND_ARRAY_LIMIT,
  MCP_COMMAND_CANCEL,
  MCP_COMMAND_CANCELLED,
  MCP_COMMAND_DIAGNOSTIC_PHASES,
  MCP_COMMAND_EMPTY,
  MCP_COMMAND_FAILED,
  MCP_COMMAND_GLOBAL_RELOAD,
  MCP_COMMAND_HELP,
  MCP_COMMAND_INPUT_LIMIT,
  MCP_COMMAND_INVALID,
  MCP_COMMAND_INVALID_ANSWER,
  MCP_COMMAND_INVALID_OAUTH,
  MCP_COMMAND_INVALID_TEMPLATE,
  MCP_COMMAND_INVALID_URI,
  MCP_COMMAND_LABEL_LIMIT,
  MCP_COMMAND_LOOPBACK_HOSTS,
  MCP_COMMAND_NEXT,
  MCP_COMMAND_NO_RESOURCES,
  MCP_COMMAND_NO_SERVERS,
  MCP_COMMAND_NO_TEMPLATES,
  MCP_COMMAND_OAUTH_PROTOCOLS,
  MCP_COMMAND_PAGE_SIZE,
  MCP_COMMAND_READ,
  MCP_COMMAND_SELECT_RESOURCE,
  MCP_COMMAND_SELECT_SERVER,
  MCP_COMMAND_SELECT_TEMPLATE,
  MCP_COMMAND_STALE,
  MCP_COMMAND_TEMPLATE_EXPRESSION,
  MCP_COMMAND_TEMPLATE_OPERATORS,
  MCP_COMMAND_TEMPLATE_VARIABLE,
  MCP_COMMAND_TEMPLATE_VARIABLE_LIMIT,
  MCP_COMMAND_UNKNOWN_SERVER,
  MCP_COMMAND_VALUE,
  MCP_COMMAND_WAIT,
  MCP_CONNECTION_CODES,
  MCP_CONNECTION_MESSAGES,
  MCP_MAX_CURSOR_BYTES,
  MCP_MAX_PAGES,
  MCP_OAUTH_CALLBACK_TTL_MS,
  MCP_RESOURCE_URI_LIMIT,
  MCP_UNAVAILABLE_NETWORK_CODES,
  MCP_UNAVAILABLE_STDIO_CODES,
} from "@/mcp/constants.js";
import type { MCPConnectionDiagnostic } from "@/mcp/errors.js";
import type { MCPManagement } from "@/mcp/management.js";
import type { MCPManager } from "@/mcp/manager.js";
import { mcpRegistrationPreview } from "@/mcp/registration.js";
import type { MCPResourceToolResult } from "@/mcp/resources.js";
import type { Asker, Question } from "@/tools/ask-user.js";
import { cancelOnSignal } from "@/utils/cancel.js";

export interface MCPCommandContext {
  management: Pick<
    MCPManagement,
    | "connect"
    | "disconnect"
    | "reload"
    | "login"
    | "logout"
    | "listResources"
    | "readResource"
    | "setExposure"
  >;
  manager: Pick<
    MCPManager,
    "states" | "getServerConfig" | "generation" | "subscribe"
  >;
  askUser: Asker;
  signal: AbortSignal;
}

export interface MCPCommandResult {
  message: string;
  resource?: MCPResourceToolResult;
}

export const MCPCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("status"),
    server: z.string().min(1).optional(),
  }),
  z.strictObject({ action: z.literal("help") }),
  z.strictObject({
    action: z.enum([
      "connect",
      "disconnect",
      "login",
      "logout",
      "resources",
      "templates",
    ]),
    server: z.string().min(1).optional(),
  }),
  z.strictObject({ action: z.literal("reload"), server: z.string().min(1) }),
  z.strictObject({
    action: z.literal("read"),
    server: z.string().min(1).optional(),
    uri: z.string().min(1).max(MCP_RESOURCE_URI_LIMIT),
  }),
  z.strictObject({
    action: z.literal("exposure"),
    server: z.string().min(1).optional(),
    exposure: MCPExposureSchema,
    tool: z.string().min(1).optional(),
  }),
]);
export type MCPCommand = z.infer<typeof MCPCommandSchema>;

export class MCPCommandError extends Error {}
class MCPCommandCancelled extends Error {}

function fail(message: string): never {
  throw new MCPCommandError(message);
}

function display(value: string): string {
  return value.replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function quoted(value: string): string {
  return display(JSON.stringify(value));
}

function label(value: string): string {
  const text = quoted(value);
  return text.length > MCP_COMMAND_LABEL_LIMIT
    ? `${text.slice(0, MCP_COMMAND_LABEL_LIMIT)}…`
    : text;
}

function tokenize(input: string): string[] {
  const parts: string[] = [];
  let value = "";
  let quote = "";
  let started = false;
  for (let i = 0; i < input.length; i++) {
    const character = input[i];
    if (character === "\\" && quote !== "'") {
      const next = input[i + 1];
      if (next && /[\s\\"']/u.test(next)) {
        value += next;
        started = true;
        i++;
        continue;
      }
    }
    if (quote) {
      if (character === quote) {
        quote = "";
      } else {
        value += character;
      }
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/u.test(character)) {
      if (started) {
        parts.push(value);
        value = "";
        started = false;
      }
    } else {
      value += character;
      started = true;
    }
  }
  if (quote) {
    fail(MCP_COMMAND_INVALID);
  }
  if (started) {
    parts.push(value);
  }
  return parts;
}

export function parseMCPCommand(args: string | readonly string[]): MCPCommand {
  if (
    (typeof args === "string" ? args.length : args.join(" ").length) >
    MCP_COMMAND_INPUT_LIMIT
  ) {
    fail(MCP_COMMAND_INVALID);
  }
  const [action = "status", ...rest] =
    typeof args === "string" ? tokenize(args) : args;
  let command: unknown;
  switch (action) {
    case "help":
      if (rest.length !== 0) {
        fail(MCP_COMMAND_INVALID);
      }
      command = { action };
      break;
    case "status":
    case "connect":
    case "disconnect":
    case "login":
    case "logout":
    case "resources":
    case "templates":
    case "reload":
      if (rest.length > 1) {
        fail(MCP_COMMAND_INVALID);
      }
      if (action === "reload" && rest.length === 0) {
        fail(MCP_COMMAND_GLOBAL_RELOAD);
      }
      command = { action, server: rest[0] };
      break;
    case "read":
      if (rest.length !== 1 && rest.length !== 2) {
        fail(MCP_COMMAND_INVALID);
      }
      command = {
        action,
        server: rest.length === 2 ? rest[0] : undefined,
        uri: rest.at(-1),
      };
      break;
    case "exposure": {
      const explicitServer =
        rest.length >= 2 && MCPExposureSchema.safeParse(rest[1]).success;
      const offset = explicitServer ? 1 : 0;
      if (rest.length < offset + 1 || rest.length > offset + 2) {
        fail(MCP_COMMAND_INVALID);
      }
      command = {
        action,
        server: explicitServer ? rest[0] : undefined,
        exposure: rest[offset],
        tool: rest[offset + 1],
      };
      break;
    }
    default:
      fail(MCP_COMMAND_INVALID);
  }
  const parsed = MCPCommandSchema.safeParse(command);
  if (!parsed.success) {
    fail(MCP_COMMAND_INVALID);
  }
  return parsed.data;
}

function diagnosticText(diagnostic: MCPConnectionDiagnostic): string {
  const phase = MCP_COMMAND_DIAGNOSTIC_PHASES.has(diagnostic.phase)
    ? diagnostic.phase
    : "connect";
  const code = diagnostic.code;
  const knownCode =
    code &&
    (Object.values(MCP_CONNECTION_CODES).some((item) => item === code) ||
      MCP_UNAVAILABLE_NETWORK_CODES.has(code) ||
      MCP_UNAVAILABLE_STDIO_CODES.has(code))
      ? code
      : undefined;
  const status = diagnostic.httpStatus;
  const knownStatus =
    status && Number.isInteger(status) && status >= 400 && status <= 599
      ? status
      : undefined;
  const message =
    knownCode === MCP_CONNECTION_CODES.auth ||
    knownStatus === 401 ||
    knownStatus === 403
      ? MCP_CONNECTION_MESSAGES.auth
      : knownCode === MCP_CONNECTION_CODES.timeout
        ? MCP_CONNECTION_MESSAGES.timeout
        : phase === "discovery"
          ? MCP_CONNECTION_MESSAGES.discovery
          : phase === "publication"
            ? MCP_CONNECTION_MESSAGES.publication
            : MCP_CONNECTION_MESSAGES.connect;
  return `${diagnostic.transport} ${phase}${knownCode ? ` ${knownCode}` : ""}${knownStatus ? ` HTTP ${knownStatus}` : ""}: ${message}`;
}

export function formatMCPStatus(
  manager: Pick<MCPManager, "states" | "getServerConfig">,
  server?: string,
): string {
  const states = manager.states();
  if (server && !states.some((state) => state.name === server)) {
    fail(MCP_COMMAND_UNKNOWN_SERVER);
  }
  const rows = states
    .filter((state) => !server || state.name === server)
    .map((state) => {
      let enabled: unknown;
      let oauth = false;
      let transport = "unknown";
      try {
        const config = manager.getServerConfig(state.name);
        transport = config.command ? "stdio" : (config.transport ?? "http");
        const preview = mcpRegistrationPreview(config);
        enabled = preview.enabled;
        oauth = Boolean(preview.oauth);
      } catch {
        enabled = undefined;
      }
      return [
        `${quoted(state.name)}: ${state.state}; source=${state.source.scope}; owner=${quoted(state.source.owner)}; exposure=${state.exposure}; tools=${state.tools}; transport=${transport}`,
        ...(enabled === false ? ["disabled"] : []),
        ...(oauth ? ["OAuth configured; use explicit login/logout"] : []),
        ...(state.unreachableCodeMode
          ? ["CodeMode exposure is unreachable while CodeMode is disabled"]
          : []),
        ...(state.diagnostic ? [diagnosticText(state.diagnostic)] : []),
      ].join("\n  ");
    });
  return `${rows.length ? rows.join("\n") : MCP_COMMAND_NO_SERVERS}\n\n${MCP_COMMAND_HELP}`;
}

function validateURI(uri: string): string {
  if (
    !uri ||
    uri.length > MCP_RESOURCE_URI_LIMIT ||
    /[\s\u0000-\u001f\u007f{}]/u.test(uri)
  ) {
    fail(MCP_COMMAND_INVALID_URI);
  }
  try {
    const url = new URL(uri);
    if (url.protocol === "ui:" || url.username || url.password) {
      fail(MCP_COMMAND_INVALID_URI);
    }
  } catch {
    fail(MCP_COMMAND_INVALID_URI);
  }
  return uri;
}

interface TemplateVariable {
  name: string;
  explode: boolean;
  prefix?: number;
}
interface TemplateExpression {
  operator: string;
  variables: TemplateVariable[];
}

function templateExpressions(template: string): TemplateExpression[] {
  if (
    !template ||
    template.length > MCP_RESOURCE_URI_LIMIT ||
    /[{}]/u.exec(template.replace(MCP_COMMAND_TEMPLATE_EXPRESSION, ""))
  ) {
    fail(MCP_COMMAND_INVALID_TEMPLATE);
  }
  const expressions = [
    ...template.matchAll(MCP_COMMAND_TEMPLATE_EXPRESSION),
  ].map((match) => {
    const expression = match[1];
    const operator = MCP_COMMAND_TEMPLATE_OPERATORS.has(expression[0])
      ? expression[0]
      : "";
    const variables = expression
      .slice(operator.length)
      .split(",")
      .map((spec) => {
        const explode = spec.endsWith("*");
        const [name, prefixText, extra] = (
          explode ? spec.slice(0, -1) : spec
        ).split(":");
        const prefix =
          prefixText === undefined ? undefined : Number(prefixText);
        if (
          !MCP_COMMAND_TEMPLATE_VARIABLE.test(name) ||
          extra !== undefined ||
          (prefixText !== undefined &&
            (explode || !/^[1-9]\d{0,3}$/u.test(prefixText)))
        ) {
          fail(MCP_COMMAND_INVALID_TEMPLATE);
        }
        return { name, explode, prefix };
      });
    return { operator, variables };
  });
  if (
    expressions.flatMap((expression) => expression.variables).length >
    MCP_COMMAND_TEMPLATE_VARIABLE_LIMIT
  ) {
    fail(MCP_COMMAND_INVALID_TEMPLATE);
  }
  return expressions;
}

export function expandMCPResourceTemplate(
  template: string,
  parameters: Variables,
): string {
  const expressions = templateExpressions(template);
  let index = 0;
  const expanded = template.replace(MCP_COMMAND_TEMPLATE_EXPRESSION, () => {
    const { operator, variables } = expressions[index++];
    const parts = variables
      .map(({ name, explode, prefix }) => {
        const value = parameters[name];
        if (
          value === undefined ||
          (Array.isArray(value) && prefix !== undefined)
        ) {
          fail(MCP_COMMAND_INVALID_TEMPLATE);
        }
        const values = Array.isArray(value) ? value : [value];
        if (
          values.length > MCP_COMMAND_ARRAY_LIMIT ||
          values.some(
            (item) =>
              typeof item !== "string" || item.length > MCP_RESOURCE_URI_LIMIT,
          )
        ) {
          fail(MCP_COMMAND_INVALID_TEMPLATE);
        }
        const encoded = values.map((item) => {
          const text =
            prefix === undefined
              ? item
              : Array.from(item).slice(0, prefix).join("");
          const helper = new UriTemplate(
            operator === "+" || operator === "#" ? "{+value}" : "{value}",
          );
          try {
            const result = helper.expand({ value: text });
            return operator === "+" || operator === "#"
              ? result
                  .replace(/%5B|%5D/gu, (encodedCharacter) =>
                    decodeURIComponent(encodedCharacter),
                  )
                  .replace(/%25([0-9a-fA-F]{2})/gu, "%$1")
              : result.replace(
                  /[!'()*]/gu,
                  (character) =>
                    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
                );
          } catch {
            return fail(MCP_COMMAND_INVALID_TEMPLATE);
          }
        });
        if (encoded.length === 0) {
          return undefined;
        }
        if (operator === "?" || operator === "&" || operator === ";") {
          const key = name;
          const named = (item: string) =>
            operator === ";" && item === "" ? key : `${key}=${item}`;
          return explode
            ? encoded.map(named).join(operator === ";" ? ";" : "&")
            : named(encoded.join(","));
        }
        return encoded.join(
          explode && (operator === "/" || operator === ".") ? operator : ",",
        );
      })
      .filter((part) => part !== undefined);
    if (!parts.length) {
      return "";
    }
    const separator =
      operator === "?" || operator === "&"
        ? "&"
        : operator === "/" || operator === "." || operator === ";"
          ? operator
          : ",";
    const start = operator === "+" ? "" : operator;
    return start + parts.join(separator);
  });
  return validateURI(expanded);
}

const ResourcePageSchema = z.object({
  items: z.array(ResourceSchema).max(MCP_COMMAND_PAGE_SIZE),
  nextCursor: z.string().min(1).max(MCP_MAX_CURSOR_BYTES).optional(),
});
const TemplatePageSchema = z.object({
  items: z.array(ResourceTemplateSchema).max(MCP_COMMAND_PAGE_SIZE),
  nextCursor: z.string().min(1).max(MCP_MAX_CURSOR_BYTES).optional(),
});
const ParameterSchema = z.union([
  z.string().max(MCP_RESOURCE_URI_LIMIT),
  z.array(z.string().max(MCP_RESOURCE_URI_LIMIT)).max(MCP_COMMAND_ARRAY_LIMIT),
]);

export async function executeMCPCommand(
  args: string | readonly string[],
  context: MCPCommandContext,
): Promise<MCPCommandResult> {
  const { management, manager, askUser, signal } = context;
  const generation = manager.generation;
  const validate = () => {
    signal.throwIfAborted();
    if (manager.generation !== generation) {
      fail(MCP_COMMAND_STALE);
    }
  };
  const ask = async (
    question: string,
    options: Question["options"],
    ownedSignal = signal,
  ): Promise<string> => {
    validate();
    ownedSignal.throwIfAborted();
    const answer = await cancelOnSignal(
      () => askUser([{ question, options, multiSelect: false }], ownedSignal),
      ownedSignal,
    );
    ownedSignal.throwIfAborted();
    validate();
    const value = answer[question];
    if (value === undefined || value === MCP_COMMAND_CANCEL) {
      throw new MCPCommandCancelled();
    }
    return value;
  };
  const pick = async <T>(
    question: string,
    items: T[],
    describe: (item: T) => string,
    next: boolean,
  ): Promise<T | undefined> => {
    const options = items.map((item, index) => ({
      label: `${index + 1}. ${label(describe(item))}`,
    }));
    const answer = await ask(question, [
      ...options,
      ...(next ? [{ label: MCP_COMMAND_NEXT }] : []),
      { label: MCP_COMMAND_CANCEL },
    ]);
    if (next && answer === MCP_COMMAND_NEXT) {
      return undefined;
    }
    const index = options.findIndex((option) => option.label === answer);
    if (index < 0) {
      fail(MCP_COMMAND_INVALID_ANSWER);
    }
    return items[index];
  };
  const read = async (
    server: string,
    uri: string,
  ): Promise<MCPCommandResult> => {
    validate();
    const resource = await management.readResource(
      server,
      validateURI(uri),
      {},
      signal,
    );
    validate();
    return { message: display(resource.output), resource };
  };
  const confirmRead = async (
    server: string,
    uri: string,
  ): Promise<MCPCommandResult> => {
    validateURI(uri);
    const answer = await ask(
      `Read MCP resource from ${quoted(server)}?\nURI: ${quoted(uri)}`,
      [{ label: MCP_COMMAND_READ }, { label: MCP_COMMAND_CANCEL }],
    );
    if (answer !== MCP_COMMAND_READ) {
      fail(MCP_COMMAND_INVALID_ANSWER);
    }
    return read(server, uri);
  };

  try {
    validate();
    const command = parseMCPCommand(args);
    if (command.action === "help") {
      return { message: MCP_COMMAND_HELP };
    }
    if (command.action === "status") {
      return { message: formatMCPStatus(manager, command.server) };
    }
    let server = command.server;
    const states = manager.states();
    if (server === undefined) {
      if (!states.length) {
        return { message: MCP_COMMAND_NO_SERVERS };
      }
      for (
        let offset = 0;
        offset < states.length;
        offset += MCP_COMMAND_PAGE_SIZE
      ) {
        const selected = await pick(
          MCP_COMMAND_SELECT_SERVER,
          states.slice(offset, offset + MCP_COMMAND_PAGE_SIZE),
          (state) => state.name,
          offset + MCP_COMMAND_PAGE_SIZE < states.length,
        );
        if (selected) {
          server = selected.name;
          break;
        }
      }
    }
    if (!server || !states.some((state) => state.name === server)) {
      fail(MCP_COMMAND_UNKNOWN_SERVER);
    }
    validate();
    switch (command.action) {
      case "connect":
        await management.connect(server, signal);
        break;
      case "disconnect":
        await management.disconnect(server, signal);
        break;
      case "reload":
        await management.reload(server, undefined, signal);
        break;
      case "logout":
        await management.logout(server, signal);
        break;
      case "login": {
        const controller = new AbortController();
        const loginSignal = AbortSignal.any([signal, controller.signal]);
        const timer = setTimeout(() => {
          controller.abort(new MCPCommandError(MCP_COMMAND_INVALID_OAUTH));
        }, MCP_OAUTH_CALLBACK_TTL_MS);
        timer.unref();
        let active = true;
        let authorizationShown = false;
        const unsubscribe = manager.subscribe(() => {
          if (manager.generation !== generation) {
            controller.abort(new MCPCommandError(MCP_COMMAND_STALE));
          }
        });
        try {
          await cancelOnSignal(
            () =>
              management.login(
                server,
                {
                  signal: loginSignal,
                  onAuthorization: async (returnedURL, submitCallback) => {
                    if (!active || authorizationShown) {
                      fail(MCP_COMMAND_INVALID_OAUTH);
                    }
                    authorizationShown = true;
                    const url = new URL(returnedURL.href);
                    if (
                      !MCP_COMMAND_OAUTH_PROTOCOLS.has(url.protocol) ||
                      (url.protocol === "http:" &&
                        !MCP_COMMAND_LOOPBACK_HOSTS.has(url.hostname)) ||
                      url.username ||
                      url.password ||
                      url.hash ||
                      [...url.searchParams.keys()].some((key) =>
                        /secret|token|password|authorization|cookie/iu.test(
                          key,
                        ),
                      )
                    ) {
                      fail(MCP_COMMAND_INVALID_OAUTH);
                    }
                    const answer = await ask(
                      `Authorize MCP login for ${quoted(server)} by opening this URL yourself:\n${url.href}\nWait for the loopback callback, paste the full callback URL via Other, or cancel.`,
                      [
                        { label: MCP_COMMAND_WAIT },
                        { label: MCP_COMMAND_CANCEL },
                      ],
                      loginSignal,
                    ).catch((error: unknown) => {
                      if (error instanceof MCPCommandCancelled) {
                        controller.abort(error);
                      }
                      throw error;
                    });
                    loginSignal.throwIfAborted();
                    if (!active) {
                      fail(MCP_COMMAND_INVALID_OAUTH);
                    }
                    if (answer === MCP_COMMAND_WAIT) {
                      return;
                    }
                    try {
                      const callback = new URL(answer);
                      if (
                        !MCP_COMMAND_OAUTH_PROTOCOLS.has(callback.protocol) ||
                        callback.username ||
                        callback.password ||
                        callback.hash
                      ) {
                        fail(MCP_COMMAND_INVALID_OAUTH);
                      }
                      submitCallback(callback.href);
                    } catch {
                      fail(MCP_COMMAND_INVALID_OAUTH);
                    }
                  },
                },
                loginSignal,
              ),
            loginSignal,
          );
          validate();
        } finally {
          active = false;
          clearTimeout(timer);
          controller.abort();
          unsubscribe();
        }
        break;
      }
      case "read":
        return await read(server, command.uri);
      case "resources":
      case "templates": {
        const templates = command.action === "templates";
        const cursors = new Set<string>();
        let cursor: string | undefined;
        for (let pageIndex = 0; pageIndex < MCP_MAX_PAGES; pageIndex++) {
          validate();
          const raw = await management.listResources(
            server,
            { templates, cursor, limit: MCP_COMMAND_PAGE_SIZE },
            signal,
          );
          validate();
          const parsed = templates
            ? TemplatePageSchema.safeParse(raw)
            : ResourcePageSchema.safeParse(raw);
          if (!parsed.success) {
            fail(MCP_COMMAND_FAILED);
          }
          const { items, nextCursor } = parsed.data;
          if (nextCursor && cursors.has(nextCursor)) {
            fail(MCP_COMMAND_FAILED);
          }
          if (!items.length && !nextCursor) {
            return {
              message: templates
                ? MCP_COMMAND_NO_TEMPLATES
                : MCP_COMMAND_NO_RESOURCES,
            };
          }
          const selected = await pick<Resource | ResourceTemplate>(
            templates
              ? MCP_COMMAND_SELECT_TEMPLATE
              : MCP_COMMAND_SELECT_RESOURCE,
            items,
            (item) =>
              `${item.name} — ${"uriTemplate" in item ? item.uriTemplate : item.uri}`,
            Boolean(nextCursor),
          );
          if (!selected) {
            cursor = nextCursor;
            if (nextCursor) {
              cursors.add(nextCursor);
            }
            continue;
          }
          if (!("uriTemplate" in selected)) {
            return await confirmRead(server, selected.uri);
          }
          const expressions = templateExpressions(selected.uriTemplate);
          const parameters = new Map<string, string | string[]>();
          for (const name of new Set(
            expressions.flatMap((expression) =>
              expression.variables.map((variable) => variable.name),
            ),
          )) {
            const answer = await ask(
              `MCP template parameter ${quoted(name)} for ${quoted(server)}\nTemplate: ${quoted(selected.uriTemplate)}\nUse Other for a literal string or JSON string array. A quoted JSON string is also accepted.`,
              [
                { label: MCP_COMMAND_VALUE },
                { label: MCP_COMMAND_EMPTY },
                { label: MCP_COMMAND_CANCEL },
              ],
            );
            if (answer === MCP_COMMAND_VALUE) {
              fail(MCP_COMMAND_INVALID_TEMPLATE);
            }
            let value: unknown = answer === MCP_COMMAND_EMPTY ? "" : answer;
            if (answer.startsWith("[") || answer.startsWith('"')) {
              try {
                value = JSON.parse(answer);
              } catch {
                fail(MCP_COMMAND_INVALID_TEMPLATE);
              }
            }
            const parsedValue = ParameterSchema.safeParse(value);
            if (!parsedValue.success) {
              fail(MCP_COMMAND_INVALID_TEMPLATE);
            }
            parameters.set(name, parsedValue.data);
          }
          return await confirmRead(
            server,
            expandMCPResourceTemplate(
              selected.uriTemplate,
              Object.fromEntries(parameters),
            ),
          );
        }
        return fail(MCP_COMMAND_FAILED);
      }
      case "exposure": {
        const config = manager.getServerConfig(server);
        const exposure = command.tool
          ? (config.exposure ?? "deferred")
          : command.exposure;
        const rules = structuredClone(config.tool_exposure ?? []);
        if (command.tool) {
          const index = rules.findIndex((rule) => rule.tool === command.tool);
          const rule = { tool: command.tool, exposure: command.exposure };
          if (index < 0) {
            rules.push(rule);
          } else {
            rules[index] = rule;
          }
        }
        const answer = await ask(
          `Apply MCP exposure change?\nServer: ${quoted(server)}\n${command.tool ? `Tool rule: ${quoted(command.tool)}` : "Server default"}\nNew policy: ${command.exposure}\nOther tool rules are preserved; exact rules take precedence over wildcards.`,
          [{ label: MCP_COMMAND_APPLY }, { label: MCP_COMMAND_CANCEL }],
        );
        if (answer !== MCP_COMMAND_APPLY) {
          fail(MCP_COMMAND_INVALID_ANSWER);
        }
        validate();
        await management.setExposure(server, exposure, rules, signal);
        break;
      }
    }
    return {
      message: `MCP ${command.action} completed for ${quoted(server)}.`,
    };
  } catch (error) {
    if (error instanceof MCPCommandError) {
      throw error;
    }
    if (error instanceof MCPCommandCancelled || signal.aborted) {
      return { message: MCP_COMMAND_CANCELLED };
    }
    fail(MCP_COMMAND_FAILED);
  }
}
