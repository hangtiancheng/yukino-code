import { readFile } from "node:fs/promises";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { parentPort, workerData } from "node:worker_threads";

import { Intrinsics, JSException, QuickJS } from "quickjs-wasi";

const { start, prelude, script, limits } = workerData;
const control = new Int32Array(workerData.control);
const pending = new Map();
const deliveries = [];
const transientHandles = [];
const store = new Map(
  Object.entries(start.store).map(([key, value]) => [
    key,
    JSON.stringify(value),
  ]),
);
const toolNames = new Set(start.tools.map((tool) => tool.name));
let vm;
let controls;
let advanceClock;
let serialize;
let task;
let seq = 0;
let issued = 0;
let outputChars = 0;
let callChars = 0;
let outputItems = 0;
let fatal;
let exited = false;
let finished = false;
let ready = false;
let pumping = false;

function interrupted() {
  return (
    Atomics.load(control, 0) !== 0 ||
    Date.now() >= start.deadline ||
    fatal !== undefined ||
    exited
  );
}
function check() {
  discardTransients();
  if (Atomics.load(control, 0) !== 0) {
    throw new Error("CodeMode cancelled");
  }
  if (Date.now() >= start.deadline) {
    throw new Error("CodeMode deadline exceeded");
  }
  if (fatal !== undefined) {
    throw new Error(fatal);
  }
  if (exited) {
    throw new Error("CodeMode exited");
  }
}
function limit(message) {
  fatal = message;
  throw new Error(message);
}
function plain(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}
function string(handle) {
  if (!handle?.isString) {
    throw new Error("Invalid CodeMode bridge argument");
  }
  return handle.toString();
}
function discardTransients() {
  for (const handle of transientHandles.splice(0)) {
    handle.dispose();
  }
}
function currentStore() {
  return Object.fromEntries(
    [...store].map(([key, value]) => [key, JSON.parse(value)]),
  );
}
function errorText(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
function clean() {
  if (!vm) {
    return;
  }
  try {
    for (const deferred of pending.values()) {
      const error = vm.newError("CodeMode cancelled");
      try {
        deferred.reject(error);
      } finally {
        error.dispose();
        deferred.handle.dispose();
      }
    }
  } catch {
    // A trapped or exhausted VM is only safe to dispose; never execute cleanup jobs.
  } finally {
    pending.clear();
    discardTransients();
    task?.dispose();
    advanceClock?.dispose();
    serialize?.dispose();
    controls?.dispose();
    vm.dispose();
  }
}
function finish(ok, value, error) {
  if (finished) {
    return;
  }
  finished = true;
  deliveries.length = 0;
  parentPort.postMessage({
    type: "result",
    ok,
    during: { seq, issued },
    ...(ok
      ? { store: currentStore(), ...(value === undefined ? {} : { value }) }
      : { error: error.slice(0, limits.maxOutputChars) }),
  });
  clean();
  parentPort.close();
}
function fail(error) {
  let message;
  try {
    message =
      fatal ??
      (Date.now() >= start.deadline
        ? "CodeMode deadline exceeded"
        : errorText(error));
  } catch {
    message = "CodeMode execution failed";
  }
  if (error instanceof JSException) {
    error.dispose();
  }
  if (
    exited &&
    fatal === undefined &&
    Atomics.load(control, 0) === 0 &&
    Date.now() < start.deadline
  ) {
    finish(true);
  } else {
    finish(false, undefined, message);
  }
}

function installBridge() {
  const callbacks = {
    __codeModeCall(nameHandle, argsHandle) {
      check();
      if (start.workflow) throw new Error("VM bridge isolation violation");
      const name = string(nameHandle);
      const encoded = string(argsHandle);
      callChars += encoded.length;
      if (callChars > limits.maxBridgeChars)
        limit("CodeMode tool bridge limit exceeded");
      const args = JSON.parse(encoded);
      if (!toolNames.has(name) || !plain(args)) {
        throw new Error("Invalid CodeMode tool call");
      }
      if (issued >= limits.maxCalls) {
        limit("CodeMode call limit exceeded");
      }
      if (pending.size >= limits.maxPendingCalls)
        limit("VM pending call limit exceeded");
      const deferred = vm.newPromise();
      const id = ++issued;
      Atomics.store(control, 2, issued);
      pending.set(id, deferred);
      parentPort.postMessage({ type: "call", id, name, args });
      return deferred.handle;
    },
    __workflowCall(nameHandle, argsHandle) {
      check();
      if (!start.workflow) throw new Error("VM bridge isolation violation");
      const name = string(nameHandle);
      const encoded = string(argsHandle);
      callChars += encoded.length;
      if (callChars > limits.maxBridgeChars)
        limit("Workflow bridge limit exceeded");
      const args = JSON.parse(encoded);
      if (!["agent", "workflow", "phase", "log"].includes(name) || !plain(args))
        throw new Error("Invalid Workflow call");
      if (issued >= limits.maxCalls) limit("Workflow call limit exceeded");
      if (pending.size >= limits.maxPendingCalls)
        limit("VM pending call limit exceeded");
      const deferred = vm.newPromise();
      const id = ++issued;
      Atomics.store(control, 2, issued);
      pending.set(id, deferred);
      parentPort.postMessage({ type: "workflow_call", id, name, args });
      return deferred.handle;
    },
    __codeModeOutput(blockHandle) {
      check();
      const encoded = string(blockHandle);
      const block = JSON.parse(encoded);
      if (
        !plain(block) ||
        !(
          (block.type === "text" && typeof block.text === "string") ||
          (block.type === "image" &&
            plain(block.source) &&
            block.source.type === "base64" &&
            typeof block.source.data === "string" &&
            ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(
              block.source.media_type,
            ))
        )
      ) {
        throw new Error("Invalid CodeMode output block");
      }
      if (
        outputItems >= limits.maxOutputItems ||
        outputChars + encoded.length > limits.maxOutputChars
      ) {
        limit("CodeMode output limit exceeded");
      }
      outputItems++;
      outputChars += encoded.length;
      parentPort.postMessage({ type: "output", block });
      return vm.undefined;
    },
    __codeModeStore(keyHandle, valueHandle) {
      check();
      const key = string(keyHandle);
      const value = valueHandle?.isUndefined ? undefined : string(valueHandle);
      if (value !== undefined && value.length > limits.maxStoreValueChars) {
        limit("CodeMode store value limit exceeded");
      }
      if (value !== undefined) {
        JSON.parse(value);
      }
      const previous = store.get(key);
      if (value === undefined) {
        store.delete(key);
      } else {
        store.set(key, value);
      }
      if (JSON.stringify(currentStore()).length > limits.maxStoreChars) {
        if (previous === undefined) {
          store.delete(key);
        } else {
          store.set(key, previous);
        }
        limit("CodeMode store limit exceeded");
      }
      return vm.undefined;
    },
    __codeModeLoad(keyHandle) {
      check();
      const value = store.get(string(keyHandle));
      if (value === undefined) {
        return vm.undefined;
      }
      const handle = vm.newString(value);
      transientHandles.push(handle);
      return handle;
    },
    __codeModeExit() {
      check();
      exited = true;
      return vm.undefined;
    },
  };
  vm.withScope(() => {
    for (const [name, callback] of Object.entries(callbacks)) {
      if (
        start.workflow ? name !== "__workflowCall" : name === "__workflowCall"
      )
        continue;
      vm.setProp(vm.global, name, vm.newFunction(name, callback));
    }
  });
}

async function drain() {
  const exports = vm._getExports();
  // 3.6.2's executePendingJobs() is unbounded. Use its pinned single-job exports.
  while (exports.qjs_is_job_pending()) {
    for (
      let i = 0;
      i < limits.jobsPerBatch && exports.qjs_is_job_pending();
      i++
    ) {
      check();
      if (exports.qjs_execute_pending_job() < 0) {
        const error = vm.getException();
        try {
          throw new Error(error.toString());
        } finally {
          error.dispose();
        }
      }
      discardTransients();
    }
    check();
    await yieldTurn();
  }
  if (exited) {
    finish(true);
    return;
  }
  check();
  const state = task.promiseState;
  if (state !== 0) {
    const result = await vm.resolvePromise(task);
    const handle = "value" in result ? result.value : result.error;
    try {
      if ("error" in result) {
        const message = handle.toString();
        check();
        finish(false, undefined, message);
      } else {
        const encoded = vm.callFunction(serialize, vm.undefined, handle);
        try {
          check();
          const json = encoded.isUndefined ? undefined : encoded.toString();
          if (
            json !== undefined &&
            outputChars + json.length > limits.maxOutputChars
          ) {
            limit("CodeMode output limit exceeded");
          }
          finish(true, json === undefined ? undefined : JSON.parse(json));
        } finally {
          encoded.dispose();
          discardTransients();
        }
      }
    } finally {
      handle.dispose();
    }
    return;
  }
  if (!pending.size) {
    throw new Error(
      "CodeMode stalled: unresolved promise with no pending tool calls",
    );
  }
  parentPort.postMessage({ type: "idle", seq, issued });
}

async function pump() {
  if (!ready || pumping || finished) {
    return;
  }
  pumping = true;
  try {
    while (deliveries.length && !finished) {
      const message = deliveries.shift();
      check();
      if (
        message.type !== "deliver" ||
        message.seq !== seq + 1 ||
        !Number.isFinite(message.now) ||
        !pending.has(message.id)
      ) {
        throw new Error("Invalid CodeMode delivery");
      }
      seq = message.seq;
      Atomics.store(control, 1, seq);
      const clock = vm.newNumber(message.now);
      try {
        vm.callFunction(advanceClock, vm.undefined, clock).dispose();
      } finally {
        clock.dispose();
      }
      const deferred = pending.get(message.id);
      pending.delete(message.id);
      const outcome = message.outcome;
      const value = outcome.ok
        ? vm.newString(JSON.stringify(outcome.value))
        : vm.newError(outcome.error);
      try {
        if (start.workflow && !outcome.ok) {
          const spent = vm.newNumber(outcome.budgetSpent);
          try {
            vm.setProp(value, "budgetSpent", spent);
          } finally {
            spent.dispose();
          }
        }
        if (outcome.ok) {
          deferred.resolve(value);
        } else {
          deferred.reject(value);
        }
      } finally {
        value.dispose();
        deferred.handle.dispose();
      }
      await drain();
    }
  } catch (error) {
    fail(error);
  } finally {
    pumping = false;
  }
}

parentPort.on("message", (message) => {
  if (finished) {
    return;
  }
  deliveries.push(message);
  void pump();
});

try {
  check();
  const wasm = await readFile(
    new URL(import.meta.resolve("quickjs-wasi/quickjs.wasm")),
  );
  vm = await QuickJS.create({
    wasm,
    memoryLimit: limits.memoryBytes,
    maxStackSize: limits.stackBytes,
    timezoneOffset: 0,
    intrinsics: Intrinsics.ALL & ~Intrinsics.WEAK_REF & ~Intrinsics.PERFORMANCE,
    interruptHandler: interrupted,
  });
  if (vm.versions["quickjs-wasi"] !== "3.6.2") {
    throw new Error("CodeMode requires quickjs-wasi 3.6.2");
  }
  check();
  installBridge();
  controls = vm.evalCode(prelude, "code-mode-prelude.js");
  advanceClock = controls.getProp("advanceClock");
  serialize = controls.getProp("serialize");
  task = vm.evalCode(script, "code-mode.js");
  discardTransients();
  await drain();
  ready = true;
  await pump();
} catch (error) {
  fail(error);
}
