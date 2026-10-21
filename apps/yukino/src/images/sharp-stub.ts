import { SHARP_UNSUPPORTED } from "@/images/constants.js";

const then = (
  onFulfilled: ((value: unknown) => unknown) | null,
  onRejected: ((reason: unknown) => unknown) | null,
): unknown => {
  const error = new Error(SHARP_UNSUPPORTED);
  if (typeof onRejected === "function") {
    return onRejected(error);
  }
  throw error;
};

const chain: unknown = new Proxy(function sharpStub() {}, {
  get(_target, property) {
    if (property === "then") {
      return then;
    }
    return chain;
  },
  apply() {
    return chain;
  },
});

function sharp(): unknown {
  return chain;
}

export default sharp;
export { sharp };
