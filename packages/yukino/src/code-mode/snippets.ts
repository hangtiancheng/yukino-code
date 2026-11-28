import type { CodeModeStart } from "@/code-mode/types.js";

export interface CodeModeVmLimits {
  memoryBytes: number;
  stackBytes: number;
  jobsPerBatch: number;
  maxOutputChars: number;
  maxBridgeChars: number;
  maxOutputItems: number;
  maxStoreChars: number;
  maxStoreValueChars: number;
  maxCalls: number;
  maxPendingCalls: number;
}

export const CODE_MODE_PRELUDE_SOURCE = String.raw`
((config) => {
  "use strict";
  const call = globalThis.__codeModeCall;
  const emit = globalThis.__codeModeOutput;
  const save = globalThis.__codeModeStore;
  const read = globalThis.__codeModeLoad;
  const stop = globalThis.__codeModeExit;
  for (const key of ["__codeModeCall", "__codeModeOutput", "__codeModeStore", "__codeModeLoad", "__codeModeExit"]) {
    delete globalThis[key];
  }
  const stringify = JSON.stringify.bind(JSON);
  const parse = JSON.parse.bind(JSON);
  const string = String;
  const ErrorType = Error;
  const getPrototypeOf = Object.getPrototypeOf;
  const objectPrototype = Object.prototype;
  const defineProperty = Object.defineProperty;
  const freeze = Object.freeze;
  const create = Object.create;
  const construct = Reflect.construct;
  const imul = Math.imul;
  const RealDate = Date;
  let clock = config.startedAt;
  let seed = config.seed >>> 0;
  const global = (name, value) => defineProperty(globalThis, name, {
    value, enumerable: true, writable: false, configurable: false,
  });
  function VirtualDate(...args) {
    if (!new.target) return new RealDate(clock).toString();
    return construct(RealDate, args.length ? args : [clock], new.target);
  }
  VirtualDate.prototype = RealDate.prototype;
  defineProperty(RealDate.prototype, "constructor", {
    value: VirtualDate, writable: false, configurable: false,
  });
  defineProperty(VirtualDate, "now", { value: () => clock });
  defineProperty(VirtualDate, "parse", { value: RealDate.parse });
  defineProperty(VirtualDate, "UTC", { value: RealDate.UTC });
  global("Date", VirtualDate);
  defineProperty(Math, "random", { configurable: false, writable: false, value: () => {
    seed = (seed + 0x6D2B79F5) >>> 0;
    let value = imul(seed ^ (seed >>> 15), seed | 1);
    value ^= value + imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }});
  for (const name of [
    "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
    "setImmediate", "clearImmediate", "queueMicrotask", "require", "process", "Buffer",
    "fetch", "XMLHttpRequest", "WebSocket", "Worker", "SharedArrayBuffer", "Atomics",
    "WeakRef", "FinalizationRegistry", "WebAssembly", "std", "os", "scriptArgs",
  ]) global(name, undefined);

  const plain = (value) => value !== null && typeof value === "object" &&
    (getPrototypeOf(value) === objectPrototype || getPrototypeOf(value) === null);
  const encode = (value) => {
    const encoded = stringify(value);
    if (encoded === undefined) throw new ErrorType("Value is not JSON serializable");
    return encoded;
  };
  const format = (value) => typeof value === "string" ? value :
    (stringify(value) ?? string(value));
  if (config.workflow) return freeze({
    advanceClock: (now) => { if (now > clock) clock = now; },
    serialize: (value) => value === undefined ? undefined : encode(value),
  });
  const declarations = parse(config.toolsJson);
  const names = create(null);
  const tools = create(null);
  const all = [];
  const namespaces = create(null);
  for (const declaration of declarations) {
    if (Object.prototype.hasOwnProperty.call(names, declaration.name)) {
      throw new ErrorType("Duplicate tool name: " + declaration.name);
    }
    names[declaration.name] = declaration;
    all.push(freeze({ name: declaration.name, description: declaration.description,
      ...(declaration.namespace ? { namespace: declaration.namespace } : {}),
      ...(declaration.source ? { source: freeze(declaration.source) } : {}),
    }));
    const invoke = (args = {}) => {
      if (!plain(args)) throw new ErrorType("Tool arguments must be a plain object");
      const encoded = encode(args);
      if (!plain(parse(encoded))) throw new ErrorType("Tool arguments must encode a JSON object");
      return call(declaration.name, encoded).then(parse);
    };
    defineProperty(tools, declaration.name, { enumerable: true, value: invoke });
    if (declaration.namespace) {
      const ns = namespaces[declaration.namespace] ?? (namespaces[declaration.namespace] = create(null));
      defineProperty(ns, declaration.name, { enumerable: true, value: invoke });
    }
  }
  for (const ns of Object.values(namespaces)) freeze(ns);
  global("namespaces", freeze(namespaces));
  global("tools", freeze(tools));
  global("ALL_TOOLS", freeze(all));
  global("describeTool", (name) => {
    if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(names, name)) {
      throw new ErrorType("Unknown tool: " + string(name));
    }
    return parse(encode(names[name]));
  });
  global("searchTools", (query, options = {}) => {
    if (typeof query !== "string" || !plain(options)) throw new ErrorType("Invalid tool search");
    const limit = options.limit ?? 5;
    if (!Number.isInteger(limit) || limit < 0) throw new ErrorType("Invalid search limit");
    const needle = query.trim().toLowerCase();
    const words = needle.split(/\s+/).filter(Boolean);
    if (options.namespace !== undefined && typeof options.namespace !== "string") throw new ErrorType("Invalid search namespace");
    if (options.source !== undefined && typeof options.source !== "string") throw new ErrorType("Invalid search source");
    const ranked = all.filter(tool =>
      (options.namespace === undefined || tool.namespace === options.namespace) &&
      (options.source === undefined || tool.source?.kind === options.source || tool.source?.id === options.source)
    ).map((tool, index) => {
      const name = tool.name.toLowerCase();
      const description = tool.description.toLowerCase();
      let score = needle === name ? 1000 : name.startsWith(needle) && needle ? 100 : 0;
      for (const word of words) {
        if (name.includes(word)) score += 20;
        if (description.includes(word)) score += 2;
      }
      return { tool, index, score };
    }).filter((entry) => !needle || entry.score > 0);
    ranked.sort((a, b) => b.score - a.score || a.index - b.index);
    return ranked.slice(0, limit).map((entry) => entry.tool);
  });
  global("text", (value) => emit(encode({ type: "text", text: format(value) })));
  global("image", (block) => {
    const value = parse(encode(block));
    if (!plain(value) || value.type !== "image" || !plain(value.source)) {
      throw new ErrorType("image() requires an existing image content block");
    }
    const source = value.source;
    let normalized;
    if (source.type === "base64" && typeof source.data === "string" &&
      ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(source.media_type)) {
      normalized = { type: "base64", media_type: source.media_type, data: source.data };
    } else throw new ErrorType("Invalid image content block");
    emit(encode({ type: "image", source: normalized }));
  });
  const console = create(null);
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    console[level] = (...values) => emit(encode({ type: "text", text: values.map(format).join(" ") }));
  }
  global("console", freeze(console));
  global("store", (key, value) => {
    if (typeof key !== "string") throw new ErrorType("Store key must be a string");
    save(key, value === undefined ? undefined : encode(value));
  });
  global("load", (key) => {
    if (typeof key !== "string") throw new ErrorType("Store key must be a string");
    const value = read(key);
    return value === undefined ? undefined : parse(value);
  });
  global("exit", () => {
    stop();
    throw new ErrorType("CodeMode exited");
  });
  return freeze({
    advanceClock: (now) => { if (now > clock) clock = now; },
    serialize: (value) => value === undefined ? undefined : encode(value),
  });
})
`;

export const CODE_MODE_SCRIPT_PREFIX = '(async () => { "use strict";\n';
export const CODE_MODE_SCRIPT_SUFFIX = "\n})()";

export function buildCodeModePrelude(start: CodeModeStart): string {
  return `${CODE_MODE_PRELUDE_SOURCE}(${JSON.stringify({
    startedAt: start.startedAt,
    seed: start.seed,
    toolsJson: JSON.stringify(start.tools),
  })})`;
}
