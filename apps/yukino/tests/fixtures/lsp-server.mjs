// @ts-check

import { appendFileSync } from "node:fs";

/**
 * @typedef {object} Position
 * @property {number} line
 * @property {number} character
 */

/**
 * @typedef {object} Range
 * @property {Position} start
 * @property {Position} end
 */

/**
 * @typedef {object} Diagnostic
 * @property {string} message
 * @property {number} [severity]
 * @property {Range} [range]
 */

/**
 * @typedef {object} TextDocumentItem
 * @property {string} uri
 * @property {string} [text]
 * @property {number} [version]
 */

/**
 * @typedef {object} DocumentState
 * @property {string | undefined} text
 * @property {number | undefined} version
 */

/**
 * @typedef {object} InitializationOptions
 * @property {string} [encoding]
 * @property {number} [delay]
 * @property {boolean} [pull]
 * @property {boolean} [silent]
 */

/**
 * @typedef {object} RequestParams
 * @property {InitializationOptions} [initializationOptions]
 * @property {TextDocumentItem} [textDocument]
 * @property {{ text: string }[]} [contentChanges]
 * @property {string} [query]
 * @property {unknown} [item]
 */

/**
 * @typedef {object} RequestMessage
 * @property {number | string} [id]
 * @property {string} [method]
 * @property {RequestParams} [params]
 * @property {unknown} [result]
 * @property {unknown} [error]
 */

/**
 * @typedef {object} OutgoingMessage
 * @property {number | string} [id]
 * @property {string} [method]
 * @property {unknown} [params]
 * @property {unknown} [result]
 * @property {unknown} [error]
 */

const logFile = process.argv[2];
if (!logFile) {
  throw new Error("missing log file path");
}
let buffer = Buffer.alloc(0);
/** @type {Map<string, DocumentState>} */
const documents = new Map();
/** @type {InitializationOptions} */
let options = {};
/** @type {unknown} */
let applyEditResult;
let shutdown = false;

/**
 * @param {OutgoingMessage} message
 */
function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(header.subarray(0, 5));
  process.stdout.write(
    Buffer.concat([header.subarray(5), body.subarray(0, 2)]),
  );
  process.stdout.write(body.subarray(2));
}
/**
 * @param {number | string | undefined} id
 * @param {unknown} result
 */
function reply(id, result) {
  send({ id, result });
}
/**
 * @param {RequestMessage} message
 */
function record(message) {
  appendFileSync(logFile, `${JSON.stringify(message)}\n`);
}

/**
 * @param {RequestMessage} message
 */
function receive(message) {
  record(message);
  const { id, method, params } = message;
  if (method === "initialize") {
    options = params?.initializationOptions ?? {};
    setTimeout(() => {
      reply(id, {
        capabilities: {
          positionEncoding: options.encoding ?? "utf-16",
          textDocumentSync: 2,
          definitionProvider: true,
          hoverProvider: true,
          documentSymbolProvider: true,
          callHierarchyProvider: true,
          ...(options.pull
            ? {
                diagnosticProvider: {
                  interFileDependencies: false,
                  workspaceDiagnostics: false,
                },
              }
            : {}),
        },
      });
    }, options.delay ?? 0);
  } else if (method === "initialized") {
    send({
      id: "server-edit",
      method: "workspace/applyEdit",
      params: { edit: { changes: {} } },
    });
    send({
      id: "server-config",
      method: "workspace/configuration",
      params: { items: [{ section: "language.example" }] },
    });
  } else if (method === undefined && id === "server-edit") {
    applyEditResult = message.result;
  } else if (
    method === "textDocument/didOpen" ||
    method === "textDocument/didChange"
  ) {
    const document = /** @type {TextDocumentItem} */ (params?.textDocument);
    documents.set(document.uri, {
      text: document.text ?? params?.contentChanges?.[0].text,
      version: document.version,
    });
    if (!options.silent) {
      send({
        method: "textDocument/publishDiagnostics",
        params: {
          uri: document.uri,
          version: (document.version ?? 0) - 1,
          diagnostics: [{ message: "stale" }],
        },
      });
      send({
        method: "textDocument/publishDiagnostics",
        params: {
          uri: document.uri,
          version: document.version,
          diagnostics: [
            {
              message: "current diagnostic🙂",
              severity: 2,
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 },
              },
            },
          ],
        },
      });
    }
  } else if (method === "workspace/symbol" && params?.query === "hang") {
    return;
  } else if (method === "workspace/symbol" && params?.query === "crash") {
    process.exit(1);
  } else if (method === "workspace/symbol" && params?.query === "bad-frame") {
    process.stdout.write("Content-Length: 20000000\r\n\r\n");
  } else if (method === "textDocument/prepareCallHierarchy") {
    reply(id, [
      {
        name: "callee",
        uri: params?.textDocument?.uri,
        kind: 12,
        data: { marker: "preserved" },
      },
    ]);
  } else if (method?.startsWith("callHierarchy/")) {
    reply(id, [{ direction: method, item: params?.item }]);
  } else if (method === "textDocument/diagnostic") {
    reply(id, { kind: "full", items: [{ message: "pull diagnostic" }] });
  } else if (
    method?.startsWith("textDocument/") ||
    method === "workspace/symbol"
  ) {
    reply(id, {
      method,
      params,
      document: documents.get(params?.textDocument?.uri ?? ""),
      applyEditResult,
    });
  } else if (method === "shutdown") {
    shutdown = true;
    reply(id, null);
  } else if (method === "exit") {
    process.exit(shutdown ? 0 : 1);
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) {
      break;
    }
    const length = Number(
      buffer
        .subarray(0, end)
        .toString()
        .match(/Content-Length: (\d+)/)?.[1],
    );
    if (buffer.length < end + 4 + length) {
      break;
    }
    const message = JSON.parse(
      buffer.subarray(end + 4, end + 4 + length).toString(),
    );
    buffer = buffer.subarray(end + 4 + length);
    receive(message);
  }
});
process.stdin.on("end", () => {
  process.exit(0);
});
