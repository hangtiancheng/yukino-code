package workflow

import (
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

// AttachWorkflow registers the Workflow tool on the registry unless already
// present, mirroring attachWorkflow.
func AttachWorkflow(options WorkflowServiceOptions) *WorkflowService {
	if existing := GetWorkflowService(options.Registry); existing != nil {
		return existing
	}
	service := NewWorkflowService(options)
	options.Registry.Register(&WorkflowTool{Service: service})
	return service
}

// GetWorkflowService returns the service bound to the registry's Workflow
// tool, if any.
func GetWorkflowService(registry *tools.Registry) *WorkflowService {
	tool, ok := registry.Get(WorkflowToolName).(*WorkflowTool)
	if !ok || tool == nil {
		return nil
	}
	return tool.Service
}
