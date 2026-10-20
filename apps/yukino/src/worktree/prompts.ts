export function buildWorktreeNotice(parentCwd: string, wtPath: string): string {
  return (
    `You are working in a git worktree at: ${wtPath}\n` +
    `The parent project is at: ${parentCwd}\n` +
    `Changes made here are isolated from the parent working tree.`
  );
}
