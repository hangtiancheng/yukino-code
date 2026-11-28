export const PROJECT_DIR_NAME = ".yukino";
export const PROJECT_CONFIG_FILENAME = "config.yaml";
export const PROJECT_PROMPTS_DIR = "prompts";
export const PROJECT_SKILLS_DIR = ".agents/skills";
export const PROJECT_WORKFLOWS_DIR = "workflows";
export const TRUST_DIR_NAME = "project-trust";
export const TRUST_VERSION = 1;
export const MAX_RESOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_RESOURCE_FILES = 2048;
export const ESM_EXTENSIONS = new Set([".js", ".mjs"]);
export const ENV_REFERENCE_RE =
  /\$\{([A-Za-z_]\w*)(?::-([^}]*))?\}|\$([A-Za-z_]\w*)/gu;
export const SAFE_CHILD_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "SYSTEMROOT",
  "WINDIR",
];
export const RESOURCE_KINDS = ["prompts", "skills", "workflow"] as const;
export const PROJECT_NOT_TRUSTED_ERROR =
  "Project resources are not trusted or have been disposed.";
export const PROJECT_CHANGED_ERROR =
  "Project execution declarations changed; resolve project trust again.";
export const UNSAFE_PROJECT_PATH_ERROR =
  "Project resources must be regular files/directories within the canonical project, without symlinks.";
export const UNSAFE_TRUST_PATH_ERROR =
  "Project trust storage must not contain symlinks or non-private state.";
export const CREDENTIAL_REFERENCE_ERROR =
  "Project environment references may use only explicit project values or safe subprocess variables; global credentials are not available.";
export const MAX_TRUST_RECORD_BYTES = 4096;
export const PROJECT_ID_RE = /^[a-f0-9]{64}$/u;
export const PROJECT_ERRORS = {
  providerMissing: "Selected provider does not exist.",
  providerRequired: "A model/endpoint override requires a configured provider.",
  duplicateResource: "Duplicate named project resource.",
  invalidMcp: "Invalid project MCP server.",
  invalidMcpUrl: "Invalid project MCP URL.",
  unsafeMcpUrl: "Project MCP URL must be HTTP(S) without embedded credentials.",
  duplicateProvider: "Duplicate project provider selection.",
  incompleteProvider:
    "Project provider selection requires a known provider or a complete target.",
  boundedFile: "Project resource is not a bounded regular file.",
  tooManyFiles: "Too many project resources.",
  invalidCwd: "Project cwd must be a directory.",
  duplicateExtension: "Duplicate project extension name.",
  extensionPathRequired: "Enabled project extensions require a path.",
  esmRequired: "Project extensions require an existing .js or .mjs ESM file.",
  extensionNameConflict:
    "Extension MCP name conflicts with an existing resource.",
  extensionDisabled: "Extensions may not register disabled resources.",
  extensionOwnership: "Extensions can only unregister their own MCP resources.",
  activateRequired: "Project ESM extensions must export activate(context).",
  disposeRequired: "Extension activate must return a disposer or { dispose }.",
  cleanupFailed: "Project resource cleanup failed.",
} as const;
