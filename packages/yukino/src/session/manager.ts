import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  realpathSync,
  unlinkSync,
  type Stats,
  openSync,
  rmSync,
} from "node:fs";
import { dirname } from "node:path";

import type { Message } from "@/conversation/index.js";
import { registerProject } from "@/history/index.js";
import {
  BRANCH_SUMMARY,
  SESSION_NOT_FOUND,
  SESSION_RUNTIME_STATE,
  UNKNOWN_SESSION_ENTRY,
  UNSAFE_TOOL_BOUNDARY,
} from "@/session/constants.js";
import {
  appendDocumentRecords,
  createSessionHeader,
  countSessionDocumentBytes,
  sessionJsonlChunks,
  getDocumentTree,
  getEntryPath,
  getSessionFilePath,
  hydrateMessage,
  makeArtifact,
  messageEntry,
  messageToKeptRecord,
  pendingToolIds,
  readSessionDocument,
  rebuildFromSession,
  serializeDocument,
  SessionConflictError,
  validateDocument,
  type BranchSummaryPayload,
  type RestoredMessage,
  type SessionDocument,
  type SessionEntry,
  type SessionMessage,
  type SessionMetadata,
  type SessionRecord,
  type SessionRuntimeState,
  type SessionTreeNode,
} from "@/session/records.js";
import {
  parseSessionImportStream,
  sessionExportStream,
  sessionImportFileBytes,
  writeSessionExportFile,
  type SessionStreamOptions,
} from "@/session/stream.js";
import {
  buildLocalDiagnostics,
  copySessionDocument,
  parseSessionImport,
  prepareSessionExport,
  renderSessionHtml,
  sessionTransferContext,
  type LocalDiagnosticsOptions,
  type SessionExportOptions,
} from "@/session/transfer.js";
import { writeAllSync } from "@/storage/file-io.js";
import { mkdirPrivateSync, openPrivateFileSync } from "@/storage/private.js";
import { withFileSyncLock } from "@/teams/file-lock.js";
import { contentToText } from "@/utils/index.js";
import { canonicalPath } from "@/utils/paths.js";

export interface SessionCreateOptions {
  persist?: boolean;
}

/** Storage and tree navigation only: never constructs an Agent or starts recorded work. */
export class SessionManager {
  readonly id: string;
  readonly cwd: string;
  readonly persistent: boolean;
  readonly initialInput?: string;
  private document: SessionDocument;

  private constructor(
    cwd: string,
    document: SessionDocument,
    persistent: boolean,
    initialInput?: string,
  ) {
    this.cwd = canonicalPath(cwd);
    this.id = document.header.sessionId;
    this.document = document;
    this.persistent = persistent;
    this.initialInput = initialInput;
  }

  static create(
    cwd: string,
    options: SessionCreateOptions = {},
  ): SessionManager {
    const document = validateDocument(createSessionHeader(), []);
    return SessionManager.publish(cwd, document, options.persist !== false);
  }

  static open(cwd: string, sessionId: string): SessionManager {
    const path = getSessionFilePath(cwd, sessionId);
    const document = withFileSyncLock(path, () => readSessionDocument(path));
    if (!document) {
      throw new Error(SESSION_NOT_FOUND);
    }
    if (document.header.sessionId !== sessionId) {
      throw new Error("Session header identity does not match its filename.");
    }
    return new SessionManager(cwd, document, true);
  }

  static import(cwd: string, serialized: string): SessionManager {
    // All schema, tree, tool, artifact and size checks precede any filesystem publication.
    const document = parseSessionImport(serialized);
    return SessionManager.publish(cwd, document, true);
  }

  static async importStream(
    cwd: string,
    source: AsyncIterable<Uint8Array>,
    options: SessionStreamOptions = {},
  ): Promise<SessionManager> {
    const document = await parseSessionImportStream(source, options);
    options.signal?.throwIfAborted();
    return SessionManager.publish(cwd, document, true, undefined, options);
  }

  /** Validates in memory; the host must approve destination/trust before publication. */
  static async stageImportStream(
    cwd: string,
    source: AsyncIterable<Uint8Array>,
    options: SessionStreamOptions = {},
  ): Promise<{
    manager: SessionManager;
    publish(): SessionManager;
    discard(): void;
  }> {
    const document = await parseSessionImportStream(source, options);
    options.signal?.throwIfAborted();
    const manager = new SessionManager(cwd, document, false);
    const path = canonicalPath(getSessionFilePath(manager.cwd, manager.id));
    let published: Stats | undefined;
    let parent: Stats | undefined;
    return {
      manager,
      publish() {
        if (published) {
          throw new Error("Session import has already been published");
        }
        const result = SessionManager.publish(
          cwd,
          document,
          true,
          undefined,
          options,
        );
        published = lstatSync(path);
        parent = lstatSync(dirname(path));
        return result;
      },
      discard() {
        if (!published || !parent) {
          return;
        }
        const named = lstatSync(path, { throwIfNoEntry: false });
        const directory = lstatSync(dirname(path));
        if (
          !named ||
          !named.isFile() ||
          named.isSymbolicLink() ||
          named.nlink !== 1 ||
          named.dev !== published.dev ||
          named.ino !== published.ino ||
          directory.dev !== parent.dev ||
          directory.ino !== parent.ino ||
          realpathSync(dirname(path)) !== dirname(path)
        ) {
          throw new Error("Refusing to discard a replaced imported session");
        }
        unlinkSync(path);
        published = undefined;
      },
    };
  }

  static importFile(
    cwd: string,
    filePath: string,
    options: SessionStreamOptions = {},
  ): Promise<SessionManager> {
    return SessionManager.importStream(
      cwd,
      sessionImportFileBytes(filePath, options),
      options,
    );
  }

  private static publish(
    cwd: string,
    document: SessionDocument,
    persistent: boolean,
    input?: string,
    options: SessionStreamOptions = {},
  ): SessionManager {
    options.signal?.throwIfAborted();
    countSessionDocumentBytes(document);
    const manager = new SessionManager(cwd, document, persistent, input);
    if (!persistent) {
      return manager;
    }
    const path = getSessionFilePath(manager.cwd, manager.id);
    mkdirPrivateSync(dirname(path));
    withFileSyncLock(path, () => {
      const temporary = `${path}.${randomUUID()}.publish-tmp`;
      let created = false;
      try {
        const fd = openPrivateFileSync(temporary, "wx");
        created = true;
        try {
          for (const chunk of sessionJsonlChunks(document)) {
            options.signal?.throwIfAborted();
            writeAllSync(fd, chunk);
          }
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        options.signal?.throwIfAborted();
        // A hard link publishes the complete file atomically without replacing an existing identity.
        linkSync(temporary, path);
        if (process.platform !== "win32") {
          const directory = openSync(dirname(path), "r");
          try {
            fsyncSync(directory);
          } finally {
            closeSync(directory);
          }
        }
      } finally {
        if (created) {
          rmSync(temporary, { force: true });
        }
      }
    });
    registerProject(manager.cwd);
    return manager;
  }

  get leafId(): string | null {
    return this.document.leafId;
  }
  get revision(): number {
    return this.document.revision;
  }

  refresh(): void {
    if (!this.persistent) {
      return;
    }
    const path = getSessionFilePath(this.cwd, this.id);
    const document = withFileSyncLock(path, () => readSessionDocument(path));
    if (document?.header.sessionId !== this.id) {
      throw new Error(SESSION_NOT_FOUND);
    }
    this.document = document;
  }

  getEntries(): SessionEntry[] {
    return structuredClone(this.document.entries);
  }
  getTree(): SessionTreeNode[] {
    return getDocumentTree(this.document);
  }
  getActiveEntries(): SessionEntry[] {
    return structuredClone(getEntryPath(this.document));
  }
  getMessages(): RestoredMessage[] {
    return rebuildFromSession(
      getEntryPath(this.document).map((entry) =>
        hydrateMessage(entry.message, this.document.artifacts),
      ),
    );
  }

  getRuntimeState(leafId = this.leafId): SessionRuntimeState | null {
    const entry = getEntryPath(this.document, leafId).findLast(
      (item) => item.message.type === SESSION_RUNTIME_STATE,
    );
    return entry?.message.state ? structuredClone(entry.message.state) : null;
  }

  appendRuntimeState(state: SessionRuntimeState): string {
    return this.append({
      role: "system",
      type: SESSION_RUNTIME_STATE,
      content: "",
      timestamp: Date.now() / 1000,
      state,
    });
  }

  append(message: SessionMessage | Message): string {
    const record =
      "timestamp" in message
        ? message
        : { ...messageToKeptRecord(message), timestamp: Date.now() / 1000 };
    const entry = messageEntry(this.document, record);
    this.commit([
      entry,
      {
        type: "active_leaf",
        leafId: entry.entryId,
        revision: entry.revision + 1,
      },
    ]);
    return entry.entryId;
  }

  appendArtifact(bytes: Uint8Array, mimeType: string): string {
    const artifact = makeArtifact(bytes, mimeType, this.revision + 1);
    this.commit([artifact]);
    return artifact.artifactId;
  }

  resolveNavigation(entryId: string | null): {
    leafId: string | null;
    input?: string;
  } {
    let target = entryId;
    let input: string | undefined;
    if (entryId !== null) {
      const entry = this.document.entries.find(
        (item) => item.entryId === entryId,
      );
      if (!entry) {
        throw new Error(UNKNOWN_SESSION_ENTRY);
      }
      if (
        entry.message.role === "user" &&
        !entry.message.tool_results?.length &&
        !entry.message.user_bash
      ) {
        target = entry.parentId;
        input = contentToText(entry.message.content);
      }
    }
    while (pendingToolIds(this.document, target).size) {
      const children = this.document.entries.filter(
        (entry) => entry.parentId === target,
      );
      if (children.length !== 1) {
        throw new Error(UNSAFE_TOOL_BOUNDARY);
      }
      target = children[0].entryId;
    }
    return { leafId: target, ...(input === undefined ? {} : { input }) };
  }

  selectActiveLeaf(leafId: string | null): void {
    if (
      leafId !== null &&
      !this.document.entries.some((entry) => entry.entryId === leafId)
    ) {
      throw new Error(UNKNOWN_SESSION_ENTRY);
    }
    if (pendingToolIds(this.document, leafId).size) {
      throw new Error(UNSAFE_TOOL_BOUNDARY);
    }
    if (this.leafId !== leafId) {
      this.commit([
        { type: "active_leaf", leafId, revision: this.revision + 1 },
      ]);
    }
  }

  navigate(entryId: string | null): { input?: string } {
    const { leafId, input } = this.resolveNavigation(entryId);
    this.selectActiveLeaf(leafId);
    return input === undefined ? {} : { input };
  }

  appendBranchSummary(
    leafId: string | null,
    payload: BranchSummaryPayload,
  ): string {
    if (pendingToolIds(this.document, leafId).size) {
      throw new Error(UNSAFE_TOOL_BOUNDARY);
    }
    const entry = messageEntry(
      { ...this.document, leafId },
      {
        role: "system",
        type: BRANCH_SUMMARY,
        content: JSON.stringify(payload),
        timestamp: Date.now() / 1000,
      },
    );
    this.commit([
      entry,
      {
        type: "active_leaf",
        leafId: entry.entryId,
        revision: entry.revision + 1,
      },
    ]);
    return entry.entryId;
  }

  setLabel(entryId: string, label: string | null): void {
    this.commit([
      { type: "label", entryId, label, revision: this.revision + 1 },
    ]);
  }
  setName(name: string): void {
    this.setMetadata({ ...this.getMetadata(), name });
  }
  getMetadata(): SessionMetadata {
    return structuredClone(this.document.metadata);
  }
  setMetadata(metadata: SessionMetadata): void {
    this.commit([{ type: "metadata", metadata, revision: this.revision + 1 }]);
  }

  fork(userEntryId: string): SessionManager {
    const entry = this.document.entries.find(
      (item) => item.entryId === userEntryId,
    );
    if (
      entry?.message.role !== "user" ||
      entry.message.tool_results?.length ||
      entry.message.user_bash
    ) {
      throw new Error("Fork requires an ordinary user entry.");
    }
    const selected = validateDocument(this.document.header, [
      ...this.document.records,
      {
        type: "active_leaf",
        leafId: entry.parentId,
        revision: this.revision + 1,
      },
    ]);
    const portable = prepareSessionExport(
      selected,
      { scope: "active", format: "jsonl" },
      sessionTransferContext(this.cwd, selected, this.persistent),
    );
    return SessionManager.publish(
      this.cwd,
      copySessionDocument(portable, "fork"),
      this.persistent,
      contentToText(entry.message.content),
    );
  }
  clone(): SessionManager {
    const portable = prepareSessionExport(
      this.document,
      { scope: "active", format: "jsonl" },
      sessionTransferContext(this.cwd, this.document, this.persistent),
    );
    return SessionManager.publish(
      this.cwd,
      copySessionDocument(portable, "clone"),
      this.persistent,
    );
  }
  export(options: SessionExportOptions): string {
    options.signal?.throwIfAborted();
    const revision = this.revision;
    this.assertSnapshotRevision(revision);
    const portable = prepareSessionExport(
      this.document,
      options,
      sessionTransferContext(this.cwd, this.document, this.persistent),
    );
    const text =
      options.format === "html"
        ? renderSessionHtml(portable)
        : serializeDocument(portable);
    options.signal?.throwIfAborted();
    this.assertSnapshotRevision(revision);
    return text;
  }

  exportStream(options: SessionExportOptions): AsyncGenerator<Uint8Array> {
    const snapshot = this.document;
    const settings = { ...options };
    settings.signal?.throwIfAborted();
    const revision = snapshot.revision;
    this.assertSnapshotRevision(revision);
    const portable = prepareSessionExport(
      snapshot,
      settings,
      sessionTransferContext(this.cwd, snapshot, this.persistent),
    );
    return sessionExportStream(portable, settings, () => {
      this.assertSnapshotRevision(revision);
    });
  }

  async exportFile(
    filePath: string,
    options: SessionExportOptions,
  ): Promise<void> {
    const revision = this.revision;
    await writeSessionExportFile(
      filePath,
      this.exportStream(options),
      options,
      () => {
        this.assertSnapshotRevision(revision);
      },
    );
  }

  private assertSnapshotRevision(expected: number): void {
    if (this.revision !== expected) {
      throw new SessionConflictError(expected, this.revision);
    }
    if (this.persistent) {
      const path = getSessionFilePath(this.cwd, this.id);
      withFileSyncLock(path, () => {
        const current = readSessionDocument(path);
        if (current?.header.sessionId !== this.id) {
          throw new Error(SESSION_NOT_FOUND);
        }
        if (current.revision !== expected) {
          throw new SessionConflictError(expected, current.revision);
        }
      });
    }
  }
  diagnostics(options: LocalDiagnosticsOptions = {}): string {
    return buildLocalDiagnostics(this.document, options);
  }

  private commit(records: SessionRecord[]): void {
    if (!this.persistent) {
      const next = validateDocument(this.document.header, [
        ...this.document.records,
        ...records,
      ]);
      this.document = next;
      return;
    }
    const path = getSessionFilePath(this.cwd, this.id);
    withFileSyncLock(path, () => {
      const current = readSessionDocument(path);
      if (current?.header.sessionId !== this.id) {
        throw new Error(SESSION_NOT_FOUND);
      }
      if (current.revision !== this.revision) {
        throw new SessionConflictError(this.revision, current.revision);
      }
      this.document = appendDocumentRecords(path, current, records);
    });
  }
}
