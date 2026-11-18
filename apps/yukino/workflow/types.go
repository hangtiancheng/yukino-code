package workflow

// WorkflowMeta is the optional `export const meta` literal of a script.
type WorkflowMeta struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	WhenToUse   string          `json:"whenToUse,omitempty"`
	Phases      []WorkflowPhase `json:"phases,omitempty"`
}

type WorkflowPhase struct {
	Title  string `json:"title"`
	Detail string `json:"detail,omitempty"`
}

// AgentRunParams are the validated options of an agent() call.
type AgentRunParams struct {
	Prompt string         `json:"prompt"`
	Schema map[string]any `json:"schema,omitempty"`
	// SchemaRaw keeps the author-ordered JSON text of Schema for prompt
	// building (JSON.stringify semantics).
	SchemaRaw    string   `json:"-"`
	Model        string   `json:"model,omitempty"`
	MaxTokens    int      `json:"maxTokens,omitempty"`
	AgentType    string   `json:"agentType,omitempty"`
	Isolation    string   `json:"isolation,omitempty"`
	AllowedTools []string `json:"allowedTools,omitempty"`
	Label        string   `json:"label,omitempty"`
	Phase        string   `json:"phase,omitempty"`
}

// AgentProgressUpdate carries live token/tool counters for an agent.
type AgentProgressUpdate struct {
	TokenCount int
	ToolCount  int
}

// AgentRunResult is the discriminated result of one agent call.
type AgentRunResult struct {
	Kind   string `json:"kind"`
	Output any    `json:"output,omitempty"`
	Usage  *struct {
		OutputTokens int `json:"outputTokens"`
	} `json:"usage,omitempty"`
	Model      string `json:"model,omitempty"`
	ToolCount  *int   `json:"toolCount,omitempty"`
	TokenCount *int   `json:"tokenCount,omitempty"`
	Reason     string `json:"reason,omitempty"`
	Detail     string `json:"detail,omitempty"`
}

func OkResult(output any, outputTokens, tokenCount, toolCount int, model string) AgentRunResult {
	result := AgentRunResult{Kind: "ok", Output: output, Model: model}
	result.Usage = &struct {
		OutputTokens int `json:"outputTokens"`
	}{OutputTokens: outputTokens}
	result.TokenCount = &tokenCount
	result.ToolCount = &toolCount
	return result
}

func SkippedResult() AgentRunResult { return AgentRunResult{Kind: "skipped"} }

func DeadResult(reason, detail string) AgentRunResult {
	return AgentRunResult{Kind: "dead", Reason: reason, Detail: detail}
}

// JournalEntry persists one agent call result for resume replay.
type JournalEntry struct {
	Key    string         `json:"key"`
	Seq    int            `json:"seq"`
	Result AgentRunResult `json:"result"`
}

// ProgressEvent is the union of workflow progress events.
type ProgressEvent struct {
	Type         string `json:"type"`
	RunID        string `json:"runId"`
	WorkflowName string `json:"workflowName,omitempty"`
	Meta         *WorkflowMeta
	Phase        string `json:"phase,omitempty"`
	AgentID      int    `json:"agentId,omitempty"`
	Label        string `json:"label,omitempty"`
	Result       *AgentRunResult
	TokenCount   int    `json:"tokenCount,omitempty"`
	ToolCount    int    `json:"toolCount,omitempty"`
	Message      string `json:"message,omitempty"`
	Status       string `json:"status,omitempty"`
	ReturnValue  any    `json:"returnValue,omitempty"`
	Error        string `json:"error,omitempty"`
}

// WorkflowRunResult is the terminal result of a workflow run.
type WorkflowRunResult struct {
	Status      string `json:"status"`
	ReturnValue any    `json:"returnValue,omitempty"`
	Error       string `json:"error,omitempty"`
}
