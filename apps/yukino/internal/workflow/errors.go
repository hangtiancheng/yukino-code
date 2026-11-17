package workflow

import "errors"

// WorkflowError marks workflow-level failures.
type WorkflowError struct{ Message string }

func (e *WorkflowError) Error() string { return e.Message }

func NewWorkflowError(message string) error { return &WorkflowError{Message: message} }

// WorkflowAbortedError marks an aborted workflow run.
type WorkflowAbortedError struct{}

func (e *WorkflowAbortedError) Error() string { return "workflow has been aborted" }

func NewWorkflowAbortedError() error { return &WorkflowAbortedError{} }

func IsWorkflowAborted(err error) bool {
	var aborted *WorkflowAbortedError
	return errors.As(err, &aborted)
}

func IsWorkflowError(err error) bool {
	var workflowErr *WorkflowError
	return errors.As(err, &workflowErr)
}
