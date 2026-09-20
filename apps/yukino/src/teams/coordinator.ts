/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// CoordinatorMode narrows the Lead's toolset to pure orchestration.
//
// The dividing line is not "read" vs. "write" — it is whether a tool would flood
// the Lead's context with large volumes of content. The Lead's context must hold
// task decomposition, teammate status, and message history; once it can read files
// or run commands directly, the model will inevitably start investigating on its
// own. Thousands of lines of code pour in, and the space that should be reserved
// for orchestration is gone. That is why ReadFile / Glob / Grep / Bash are excluded:
// when code needs to be inspected, delegate to a teammate who brings back conclusions.
// The Lead digests those conclusions and writes the next specification.
//
// Task assignment to teammates is expressed through the Agent prompt rather than a
// shared task board, so TaskCreate / TaskGet / TaskList / TaskUpdate are also
// withheld from the Lead — those are for inter-teammate coordination. The Lead
// tracks progress via <task-notification> messages returned when teammates finish.
//
// TeamDelete is retained for teardown: teammates are attached to the Team, and once
// work is done there must be a way to stop them and clean up the team directory.
// TeamCreate is not here because SpawnTeammate auto-creates the specified Team if
// it does not exist — the Lead simply dispatches teammates without a separate
// team-creation step.
//
// Four-phase workflow:
// 1. Research: teammates investigate in parallel; the Lead stays hands-off
// 2. Synthesis: the Lead digests findings and writes an implementation spec
// 3. Implementation: teammates modify code per the spec and commit
// 4. Verification: teammates validate that the changes are correct
const COORDINATOR_ALLOWED_TOOLS = new Set([
  "Agent",
  "SendMessage",
  "TaskStop",
  "SyntheticOutput",
  "TeamDelete",
]);

/** Check if a tool is allowed in Coordinator Mode. */
export function isCoordinatorTool(name: string): boolean {
  return COORDINATOR_ALLOWED_TOOLS.has(name);
}

/**
 * Returns the tool-filter predicate for the Lead Agent.
 * When disabled, returns an always-true predicate; when enabled, only whitelisted
 * tools are permitted for the entire session.
 *
 * The decision is based solely on configuration, not on whether a team exists:
 * switching modes mid-session would leave stale orchestration directives in the
 * conversation history that cannot be retracted, causing the model to follow
 * outdated constraints. Configuration is authoritative from the first turn to the last.
 *
 * MCP tools are likewise excluded: fetching web pages or querying databases can
 * easily return thousands of tokens — flooding the Lead's context is no different
 * from letting it read files directly. Delegate such work to teammates.
 */
export function coordinatorToolFilter(enabled = false): (name: string) => boolean {
  if (!enabled) {
    return () => true;
  }
  return isCoordinatorTool;
}

/**
 * Determines whether Coordinator Mode is currently active; the condition is kept
 * consistent with the tool filter. The two must stay in sync — restricting tools
 * without providing guidance would leave the Lead unable to read files yet unaware
 * that it should delegate reading to a teammate.
 */
export function coordinatorActive(enabled = false): boolean {
  return enabled;
}
