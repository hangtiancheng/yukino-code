export const PACKAGE_NAME = "@yukino.js/yukino";
export const PACKAGE_URL = "https://registry.npmjs.org/@yukino.js%2Fyukino";
export const NPM_REGISTRY_URL = "https://registry.npmjs.org/";
export const DEFAULT_DIST_TAG = "latest";
export const REGISTRY_FETCH_TIMEOUT_MS = 10_000;
export const PACKAGE_MANAGER_QUERY_TIMEOUT_MS = 10_000;

export const INSTALLATION_NOT_FOUND_ERROR =
  "Could not locate the Yukino installation.";
export const UNMANAGED_INSTALLATION_ERROR =
  "This Yukino installation is not managed by global npm, yarn, or pnpm. " +
  "Update the source checkout or reinstall using yukino-code/install.sh or yukino-code/install.ps1.";

export const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*))?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/u;
