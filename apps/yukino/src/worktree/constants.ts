/**
 * Allowed character set of ref names — excludes whitespace and shell
 * metacharacters. Path traversal is ruled out together with the ".." and
 * leading-slash checks in isSafeRefName.
 */
export const SAFE_REF_RE = /^[a-zA-Z0-9/._+@-]+$/;

/** Full SHA-1 (40 hex) or SHA-256 (64 hex) */
export const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export const SHARED_AGENTS_ENTRIES = ["AGENTS.md", "skills"];
