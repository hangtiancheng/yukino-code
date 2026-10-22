export const WORKTREE_STATE_UNVERIFIED_GUIDANCE =
  'Could not verify worktree state. Refusing to remove. Confirm with the user, then retry with discard_changes: true, or use action: "keep".';

export function buildWorktreeChangesGuidance(
  changedFiles: number,
  commits: number,
): string {
  return `Worktree has ${changedFiles} uncommitted files and ${commits} commits. Confirm with the user, then retry with discard_changes: true, or use action: "keep".`;
}

export function buildWorktreeNotice(parentCwd: string, wtPath: string): string {
  return (
    `You are working in a git worktree at: ${wtPath}\n` +
    `The parent project is at: ${parentCwd}\n` +
    `Changes made here are isolated from the parent working tree.`
  );
}
