import { createHash, randomBytes } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import { z } from "zod";

import { COST_DIRECTORY } from "@/cost/constants.js";
import { LedgerRecordSchema } from "@/cost/types.js";
import { FILE_HISTORY_DIR_NAME } from "@/file-history/constants.js";
import {
  MAX_JSON_DEPTH,
  MAX_JSON_REFERENCES,
  SESSION_FILE_EXTENSION,
  SESSION_LEASE_SUFFIX,
  SESSION_MAINTENANCE_CONFIRMATION,
  SESSION_MAINTENANCE_LIMIT,
  SESSION_MAINTENANCE_MAX_BYTES,
  SESSION_MAINTENANCE_MAX_FILES,
  SESSION_MAINTENANCE_OPERATIONS,
  SESSION_MAINTENANCE_REFERENCED,
  SESSION_MAINTENANCE_STALE,
  SESSION_MAINTENANCE_SUFFIX,
  SESSION_MAINTENANCE_UNKNOWN,
  SESSION_MAINTENANCE_VERSION,
  SESSION_NOT_FOUND,
  SESSION_STORAGE_CHANGED,
  SHA256_RE,
} from "@/session/constants.js";
import {
  assertNoSessionRunLeasesUnderLock,
  assertSessionStoragePath,
  inspectSessionStoragePath,
  SessionStorageFingerprintSchema,
  sessionStorageIdentity,
  withSessionStorageLock,
  type SessionStorageFingerprint,
  type SessionStorageIdentity,
  type SessionStorageTarget,
} from "@/session/lease.js";
import type { SessionManager } from "@/session/manager.js";
import {
  appendDocumentRecords,
  assertBoundedJson,
  decodeArtifact,
  getSessionArtifactsDir,
  parseSessionJsonl,
  SessionConflictError,
  type SessionDocument,
  type SessionMetadata,
} from "@/session/records.js";
import {
  ARTIFACTS_DIR_NAME,
  SESSIONS_DIR_NAME,
  SESSION_ID_RE,
} from "@/storage/constants.js";
import { getYukinoDir } from "@/storage/index.js";
import { mkdirPrivateSync } from "@/storage/private.js";
import { SPILL_DIR_NAME } from "@/tool-result/constants.js";
import { canonicalPath, isPathWithin } from "@/utils/paths.js";

const PlanBodySchema = z.strictObject({
  version: z.literal(SESSION_MAINTENANCE_VERSION),
  cwd: z.string().min(1),
  storageRoot: z.string().min(1),
  projectKey: z.string().regex(SHA256_RE),
  sessionId: z.string().regex(SESSION_ID_RE),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  operation: z.enum(SESSION_MAINTENANCE_OPERATIONS),
  roots: z
    .array(z.string().min(1))
    .max(SESSION_MAINTENANCE_MAX_FILES)
    .readonly(),
  paths: z
    .array(SessionStorageFingerprintSchema.readonly())
    .max(SESSION_MAINTENANCE_MAX_FILES)
    .readonly(),
  referencePreview: z
    .array(
      z
        .strictObject({
          path: z.string().nullable(),
          artifactId: z.string().nullable(),
          bytes: z.number().int().nonnegative(),
          sha256: z.string().regex(SHA256_RE),
          sessionIds: z.array(z.string()).readonly(),
        })
        .readonly(),
    )
    .max(SESSION_MAINTENANCE_MAX_FILES)
    .readonly(),
  referenceProof: z.string().regex(SHA256_RE),
});
export const SessionMaintenancePlanSchema = PlanBodySchema.extend({
  planId: z.string().regex(SHA256_RE),
}).readonly();
export type SessionMaintenancePlan = z.infer<
  typeof SessionMaintenancePlanSchema
>;
export const SessionMaintenanceConfirmationSchema = z.strictObject({
  confirmed: z.literal(true),
  planId: z.string().regex(SHA256_RE),
});
export type SessionMaintenanceConfirmation = z.infer<
  typeof SessionMaintenanceConfirmationSchema
>;
export interface SessionMaintenanceResult {
  readonly operation: SessionMaintenancePlan["operation"];
  readonly sessionId: string;
  readonly deletedPaths: readonly string[];
  readonly deletedBytes: number;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function artifactOwner(identity: SessionStorageIdentity): string {
  return join(
    identity.storageRoot,
    relative(getYukinoDir(), getSessionArtifactsDir(identity.sessionId)),
  );
}

interface Inspection {
  paths: SessionStorageFingerprint[];
  contents: Map<string, Buffer>;
  bytes: number;
}

function inspectTree(
  identity: SessionStorageIdentity,
  path: string,
  inspection: Inspection,
): void {
  const inspected = inspectSessionStoragePath(identity.storageRoot, path);
  if (!inspected) {
    return;
  }
  inspection.paths.push(inspected.fingerprint);
  inspection.bytes += inspected.fingerprint.size;
  if (
    inspection.paths.length > SESSION_MAINTENANCE_MAX_FILES ||
    inspection.bytes > SESSION_MAINTENANCE_MAX_BYTES
  ) {
    throw new Error(SESSION_MAINTENANCE_LIMIT);
  }
  if (inspected.bytes) {
    inspection.contents.set(path, inspected.bytes);
    return;
  }
  for (const name of readdirSync(path).sort()) {
    inspectTree(identity, join(path, name), inspection);
  }
}

function documentAt(
  identity: SessionStorageIdentity,
  path: string,
): SessionDocument {
  const inspected = inspectSessionStoragePath(identity.storageRoot, path);
  if (!inspected?.bytes) {
    throw new Error(SESSION_NOT_FOUND);
  }
  const document = parseSessionJsonl(inspected.bytes.toString("utf8"));
  if (document.header.sessionId !== basename(path, SESSION_FILE_EXTENSION)) {
    throw new Error(SESSION_MAINTENANCE_UNKNOWN);
  }
  return document;
}

function stringsIn(value: unknown): string[] {
  const strings: string[] = [];
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let references = 0;
  while (pending.length) {
    const current = pending.pop();
    if (!current) {
      break;
    }
    if (++references > MAX_JSON_REFERENCES || current.depth > MAX_JSON_DEPTH) {
      throw new Error(SESSION_MAINTENANCE_LIMIT);
    }
    const item = current.value;
    if (typeof item === "string") {
      strings.push(item);
      if (isAbsolute(item)) {
        strings.push(resolve(item));
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(item);
      } catch {
        continue;
      }
      if (decoded && typeof decoded === "object") {
        assertBoundedJson(decoded, true);
        pending.push({ value: decoded, depth: current.depth + 1 });
      }
    } else if (Array.isArray(item)) {
      const children: unknown[] = item;
      for (const child of children) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
    } else if (item && typeof item === "object") {
      const values: unknown[] = Object.values(item);
      const children: unknown[] = [...Object.keys(item), ...values];
      for (const child of children) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return strings;
}

function documentStrings(document: SessionDocument): string[] {
  return stringsIn([
    document.header,
    ...document.records,
    ...[...document.artifacts.values()].map((artifact) =>
      decodeArtifact(artifact).toString("utf8"),
    ),
  ]);
}

function referencesPath(text: string, path: string): boolean {
  const rawRoot = getYukinoDir();
  const root = join(canonicalPath(dirname(rawRoot)), basename(rawRoot));
  const aliases = isPathWithin(root, path)
    ? [path, join(rawRoot, relative(root, path))]
    : [path];
  return aliases.some(
    (alias) =>
      text.includes(alias) || text.includes(JSON.stringify(alias).slice(1, -1)),
  );
}

function assertKnownOwner(
  identity: SessionStorageIdentity,
  owner: string,
): void {
  assertSessionStoragePath(identity.storageRoot, owner);
  if (!lstatSync(owner, { throwIfNoEntry: false })) {
    return;
  }
  for (const name of readdirSync(owner)) {
    if (![SPILL_DIR_NAME, FILE_HISTORY_DIR_NAME].includes(name)) {
      throw new Error(SESSION_MAINTENANCE_UNKNOWN);
    }
    const child = inspectSessionStoragePath(
      identity.storageRoot,
      join(owner, name),
    );
    if (child?.fingerprint.kind !== "directory") {
      throw new Error(SESSION_MAINTENANCE_UNKNOWN);
    }
  }
}

function referenceCatalog(
  identity: SessionStorageIdentity,
  staging?: string,
): {
  proof: string;
  references: Map<string, string[]>;
} {
  const sessions = join(identity.storageRoot, SESSIONS_DIR_NAME);
  assertSessionStoragePath(identity.storageRoot, sessions);
  const documents: { path: string; document: SessionDocument }[] = [];
  const inspection: Inspection = { paths: [], contents: new Map(), bytes: 0 };
  const catalog: string[] = [];
  for (const key of readdirSync(sessions).sort()) {
    if (key === ARTIFACTS_DIR_NAME) {
      continue;
    }
    if (!SHA256_RE.test(key)) {
      throw new Error(SESSION_MAINTENANCE_UNKNOWN);
    }
    const directory = join(sessions, key);
    const directoryInfo = inspectSessionStoragePath(
      identity.storageRoot,
      directory,
    );
    if (directoryInfo?.fingerprint.kind !== "directory") {
      throw new Error(SESSION_MAINTENANCE_UNKNOWN);
    }
    inspection.paths.push(directoryInfo.fingerprint);
    const names = readdirSync(directory).sort();
    for (const name of names) {
      const path = join(directory, name);
      if (path === staging) {
        continue;
      }
      if (name.endsWith(SESSION_FILE_EXTENSION)) {
        catalog.push(path);
        if (path !== identity.transcriptPath) {
          inspectTree(identity, path, inspection);
          const bytes = inspection.contents.get(path);
          if (!bytes) {
            throw new Error(SESSION_MAINTENANCE_UNKNOWN);
          }
          const document = parseSessionJsonl(bytes.toString("utf8"));
          if (
            document.header.sessionId !== basename(path, SESSION_FILE_EXTENSION)
          ) {
            throw new Error(SESSION_MAINTENANCE_UNKNOWN);
          }
          documents.push({ path, document });
        }
      } else if (
        !name.endsWith(`${SESSION_FILE_EXTENSION}.lock`) &&
        !name.endsWith(`${SESSION_FILE_EXTENSION}${SESSION_LEASE_SUFFIX}`)
      ) {
        throw new Error(SESSION_MAINTENANCE_UNKNOWN);
      }
    }
  }
  const references = new Map<string, string[]>();
  for (const { path, document } of documents) {
    if (document.header.sessionId === identity.sessionId) {
      throw new Error(SESSION_MAINTENANCE_REFERENCED);
    }
    references.set(path, documentStrings(document));
  }
  const artifacts = join(sessions, ARTIFACTS_DIR_NAME);
  assertSessionStoragePath(identity.storageRoot, artifacts);
  if (lstatSync(artifacts, { throwIfNoEntry: false })) {
    for (const id of readdirSync(artifacts).sort()) {
      if (!SESSION_ID_RE.test(id)) {
        throw new Error(SESSION_MAINTENANCE_UNKNOWN);
      }
      const owner = join(artifacts, id);
      if (id === identity.sessionId) {
        continue;
      }
      const documentsForOwner = documents.filter(
        (item) => item.document.header.sessionId === id,
      );
      if (!documentsForOwner.length) {
        throw new Error(SESSION_MAINTENANCE_UNKNOWN);
      }
      assertKnownOwner(identity, owner);
      const other: Inspection = { paths: [], contents: new Map(), bytes: 0 };
      inspectTree(identity, owner, other);
      inspection.paths.push(...other.paths);
      inspection.bytes += other.bytes;
      if (
        inspection.paths.length > SESSION_MAINTENANCE_MAX_FILES ||
        inspection.bytes > SESSION_MAINTENANCE_MAX_BYTES
      ) {
        throw new Error(SESSION_MAINTENANCE_LIMIT);
      }
      for (const { path } of documentsForOwner) {
        references
          .get(path)
          ?.push(
            ...stringsIn(
              [...other.contents.values()].map((bytes) =>
                bytes.toString("utf8"),
              ),
            ),
          );
      }
    }
  }
  if (staging && !catalog.includes(identity.transcriptPath)) {
    catalog.push(identity.transcriptPath);
  }
  if (
    inspection.paths.length > SESSION_MAINTENANCE_MAX_FILES ||
    inspection.bytes > SESSION_MAINTENANCE_MAX_BYTES
  ) {
    throw new Error(SESSION_MAINTENANCE_LIMIT);
  }
  return { proof: digest([catalog.sort(), inspection.paths]), references };
}

function buildPlan(
  identity: SessionStorageIdentity,
  operation: SessionMaintenancePlan["operation"],
): SessionMaintenancePlan {
  assertNoSessionRunLeasesUnderLock(identity);
  const document = documentAt(identity, identity.transcriptPath);
  const owner = artifactOwner(identity);
  assertKnownOwner(identity, owner);
  const cost = join(
    identity.storageRoot,
    COST_DIRECTORY,
    identity.projectKey,
    `${createHash("sha256").update(identity.sessionId).digest("hex")}${SESSION_FILE_EXTENSION}`,
  );
  const roots =
    operation === "delete" ? [identity.transcriptPath, owner, cost] : [owner];
  const inspection: Inspection = { paths: [], contents: new Map(), bytes: 0 };
  for (const path of roots) {
    inspectTree(identity, path, inspection);
  }
  const costBytes = inspection.contents.get(cost);
  if (costBytes) {
    const text = costBytes.toString("utf8");
    if (text && !text.endsWith("\n")) {
      throw new Error(SESSION_MAINTENANCE_UNKNOWN);
    }
    for (const [index, line] of text.split("\n").filter(Boolean).entries()) {
      const raw: unknown = JSON.parse(line);
      const record = LedgerRecordSchema.parse(raw);
      if (
        record.revision !== index + 1 ||
        (record.type === "run"
          ? record.run.sessionId
          : record.entry.sessionId) !== identity.sessionId
      ) {
        throw new Error(SESSION_MAINTENANCE_UNKNOWN);
      }
    }
  }
  const { proof, references } = referenceCatalog(identity);
  for (const texts of references.values()) {
    if (
      texts.some(
        (text) =>
          text.includes(identity.sessionId) ||
          referencesPath(text, owner) ||
          referencesPath(text, cost) ||
          referencesPath(text, identity.transcriptPath),
      )
    ) {
      throw new Error(SESSION_MAINTENANCE_REFERENCED);
    }
  }
  const ownStrings = [
    ...documentStrings(document),
    ...stringsIn(
      [...inspection.contents]
        .filter(([path]) => path !== identity.transcriptPath && path !== cost)
        .map(([, bytes]) => bytes.toString("utf8")),
    ),
  ];
  const referencePreview: z.infer<
    typeof PlanBodySchema
  >["referencePreview"][number][] = [];
  for (const entry of inspection.paths) {
    if (entry.kind !== "file" || entry.path === identity.transcriptPath) {
      continue;
    }
    const referenced = ownStrings.some((text) =>
      referencesPath(text, entry.path),
    );
    if (entry.sha256) {
      referencePreview.push({
        path: entry.path,
        artifactId: null,
        bytes: entry.size,
        sha256: entry.sha256,
        sessionIds: referenced ? [identity.sessionId] : [],
      });
    }
  }
  for (const artifact of document.artifacts.values()) {
    referencePreview.push({
      path: null,
      artifactId: artifact.artifactId,
      bytes: artifact.length,
      sha256: artifact.sha256,
      sessionIds: [identity.sessionId],
    });
  }
  let selectedRoots = roots.filter((path) =>
    inspection.paths.some((entry) => entry.path === path),
  );
  let selectedPaths = inspection.paths;
  if (operation === "cleanup") {
    const spills = join(owner, SPILL_DIR_NAME);
    selectedPaths = inspection.paths.filter((entry) =>
      isPathWithin(spills, entry.path),
    );
    selectedRoots = selectedPaths.length ? [spills] : [];
    if (
      selectedPaths.some(
        (entry) =>
          entry.kind === "file" &&
          ownStrings.some((text) => referencesPath(text, entry.path)),
      )
    ) {
      selectedPaths = selectedPaths.filter(
        (entry) =>
          entry.kind === "file" &&
          !ownStrings.some((text) => referencesPath(text, entry.path)),
      );
      selectedRoots = selectedPaths.map((entry) => entry.path);
    }
  }
  const body = PlanBodySchema.parse({
    version: SESSION_MAINTENANCE_VERSION,
    cwd: identity.cwd,
    storageRoot: identity.storageRoot,
    projectKey: identity.projectKey,
    sessionId: identity.sessionId,
    revision: document.revision,
    operation,
    roots: selectedRoots,
    paths: selectedPaths,
    referencePreview,
    referenceProof: proof,
  });
  return SessionMaintenancePlanSchema.parse({ ...body, planId: digest(body) });
}

export function planSessionMaintenance(
  target: SessionStorageTarget,
  operation: SessionMaintenancePlan["operation"],
): SessionMaintenancePlan {
  return withSessionStorageLock(target, (identity) =>
    buildPlan(identity, operation),
  );
}

function removeVerifiedTree(
  identity: SessionStorageIdentity,
  staging: string,
  original: string,
  expected: readonly SessionStorageFingerprint[],
): void {
  const inspection: Inspection = { paths: [], contents: new Map(), bytes: 0 };
  inspectTree(identity, staging, inspection);
  const remapped = inspection.paths.map((entry) => ({
    ...entry,
    path: join(original, relative(staging, entry.path)),
  }));
  if (digest(remapped) !== digest(expected)) {
    throw new Error(SESSION_STORAGE_CHANGED);
  }
  for (const entry of [...inspection.paths].reverse()) {
    const current = inspectSessionStoragePath(identity.storageRoot, entry.path);
    if (!current || digest(current.fingerprint) !== digest(entry)) {
      throw new Error(SESSION_STORAGE_CHANGED);
    }
    if (entry.kind === "directory") {
      rmdirSync(entry.path);
    } else {
      unlinkSync(entry.path);
    }
  }
}

export function executeSessionMaintenance(
  target: SessionStorageTarget,
  input: unknown,
  confirmation: unknown,
): SessionMaintenanceResult {
  assertBoundedJson(input);
  assertBoundedJson(confirmation);
  const plan = SessionMaintenancePlanSchema.parse(input);
  const confirmed =
    SessionMaintenanceConfirmationSchema.safeParse(confirmation);
  if (!confirmed.success || confirmed.data.planId !== plan.planId) {
    throw new Error(SESSION_MAINTENANCE_CONFIRMATION);
  }
  const identity = sessionStorageIdentity(target);
  if (
    plan.cwd !== identity.cwd ||
    plan.storageRoot !== identity.storageRoot ||
    plan.projectKey !== identity.projectKey ||
    plan.sessionId !== identity.sessionId
  ) {
    throw new Error(SESSION_MAINTENANCE_STALE);
  }
  return withSessionStorageLock(target, (current) => {
    const document = documentAt(current, current.transcriptPath);
    if (document.revision !== plan.revision) {
      throw new SessionConflictError(plan.revision, document.revision);
    }
    const recomputed = buildPlan(current, plan.operation);
    if (digest(recomputed) !== digest(plan)) {
      throw new Error(SESSION_MAINTENANCE_STALE);
    }
    if (!recomputed.roots.length) {
      return Object.freeze({
        operation: plan.operation,
        sessionId: plan.sessionId,
        deletedPaths: Object.freeze([]),
        deletedBytes: 0,
      });
    }
    const staging = `${current.transcriptPath}${SESSION_MAINTENANCE_SUFFIX}${randomBytes(32).toString("hex")}`;
    mkdirPrivateSync(staging);
    const moved: {
      original: string;
      path: string;
      expected: SessionStorageFingerprint[];
    }[] = [];
    try {
      for (const [index, original] of recomputed.roots.entries()) {
        assertSessionStoragePath(current.storageRoot, original);
        const path = join(staging, String(index));
        renameSync(original, path);
        assertSessionStoragePath(current.storageRoot, path);
        const expected = recomputed.paths.filter((entry) =>
          isPathWithin(original, entry.path),
        );
        moved.push({ original, path, expected });
        const inspected: Inspection = {
          paths: [],
          contents: new Map(),
          bytes: 0,
        };
        inspectTree(current, path, inspected);
        const remapped = inspected.paths.map((entry) => ({
          ...entry,
          path: join(original, relative(path, entry.path)),
        }));
        if (digest(remapped) !== digest(expected)) {
          throw new Error(SESSION_STORAGE_CHANGED);
        }
      }
      assertNoSessionRunLeasesUnderLock(current);
      if (
        referenceCatalog(current, staging).proof !== recomputed.referenceProof
      ) {
        throw new Error(SESSION_MAINTENANCE_STALE);
      }
      for (const item of moved) {
        removeVerifiedTree(current, item.path, item.original, item.expected);
      }
      rmdirSync(staging);
    } catch (error) {
      // A raced replacement is preserved in quarantine, never recursively removed.
      throw new Error(
        `${SESSION_STORAGE_CHANGED} Preserved remaining storage at ${staging}`,
        { cause: error },
      );
    }
    return Object.freeze({
      operation: plan.operation,
      sessionId: plan.sessionId,
      deletedPaths: Object.freeze(recomputed.paths.map((entry) => entry.path)),
      deletedBytes: recomputed.paths.reduce(
        (total, entry) => total + entry.size,
        0,
      ),
    });
  });
}

export function archiveSession(
  manager: SessionManager,
  expectedRevision = manager.revision,
): SessionMetadata {
  return setArchived(manager, true, expectedRevision);
}

export function unarchiveSession(
  manager: SessionManager,
  expectedRevision = manager.revision,
): SessionMetadata {
  return setArchived(manager, false, expectedRevision);
}

function setArchived(
  manager: SessionManager,
  archived: boolean,
  expectedRevision: number,
): SessionMetadata {
  if (!manager.persistent) {
    if (manager.revision !== expectedRevision) {
      throw new SessionConflictError(expectedRevision, manager.revision);
    }
    manager.setMetadata({ ...manager.getMetadata(), archived });
    return manager.getMetadata();
  }
  const metadata = withSessionStorageLock(
    { cwd: manager.cwd, sessionId: manager.id },
    (identity) => {
      const document = documentAt(identity, identity.transcriptPath);
      if (document.revision !== expectedRevision) {
        throw new SessionConflictError(expectedRevision, document.revision);
      }
      const metadata = { ...document.metadata, archived };
      appendDocumentRecords(identity.transcriptPath, document, [
        { type: "metadata", revision: document.revision + 1, metadata },
      ]);
      return metadata;
    },
  );
  manager.refresh();
  return metadata;
}
