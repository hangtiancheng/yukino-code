package a2a

const Description = "Yukino is a terminal-based AI coding agent. It reads, edits, and creates " +
	"files, runs shell commands, and drives multi-step coding tasks from " +
	"natural language instructions."

const SkillDescription = "Executes software engineering tasks: answering questions about a codebase, " +
	"writing and refactoring code, running commands, and fixing bugs."

var SkillExamples = []string{
	"Fix the failing tests in this repository.",
	"Add a dark mode toggle to the settings page.",
}

const PermissionExtensionDescription = "Yukino permission handshake v1: INPUT_REQUIRED status.message contains permission-request data parts; send a permission-response with permissionId and decision allow, deny, or allowAlways on the same task. allowAlways persists matching project rules; it does not bypass explicit denials. Server permission_mode controls the local policy. Thinking and tool stream events are carried in status-update metadata.yukino; assistant text streams as artifact updates. Task history contains complete assistant messages. SendMessage, GetTask and ListTasks default to the last 10 history messages; historyLength: 0 omits history while preserving status.message and artifacts."
