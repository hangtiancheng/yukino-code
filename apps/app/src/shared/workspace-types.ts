export interface FileEntry {
  path: string;
  name: string;
  directory: boolean;
}

export interface FileSnapshot {
  path: string;
  content: string;
  baseline: string;
  revision: string;
  deleted: boolean;
}

export interface FileChange {
  path: string;
  status: string;
}

export interface WorkspaceSnapshot {
  cwd: string;
  changes: FileChange[];
  branch: string | null;
}

export interface RuntimeSnapshot {
  tools: string[];
  skills: { name: string; description: string }[];
  memories: { name: string; description: string }[];
  mcpServers: string[];
  tasks: { id: string; subject: string; status: string }[];
  backgroundTasks: { id: string; name: string; status: string }[];
  teammates: { name: string; status: string }[];
  checkpoints: { id: string; text: string; timestamp: string; files: number }[];
  permissionMode: string;
}
