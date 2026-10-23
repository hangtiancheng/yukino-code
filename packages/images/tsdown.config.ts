import { definePkgBuild } from "@yukino.js/build-config";

// image-worker.js is a plain-JS worker spawned at runtime via
// `new URL("./image-worker.js", import.meta.url)` — build it as its own
// entry so it lands next to worker.js in dist/.
export default definePkgBuild({
  entry: ["src/**/*.ts", "src/image-worker.js"],
});
