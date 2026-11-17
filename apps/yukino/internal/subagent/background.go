package subagent

import (
	"fmt"

	"github.com/yukino-js/yukino/yukino/internal/agent"
)

func configureBackgroundRuntime(child *agent.Agent) *TaskManager {
	manager := NewTaskManager()
	child.TaskManager = manager
	child.NotificationFn = func() ([]string, error) {
		var notifications []string
		drained, err := manager.DrainNotifications()
		if err != nil {
			return nil, err
		}
		for _, task := range drained {
			notifications = append(notifications, fmt.Sprintf("<task-notification>\n<task_id>%s</task_id>\n<status>%s</status>\n<result>%s</result>\n</task-notification>", task.ID, task.Status, task.Output))
		}
		return notifications, nil
	}
	return manager
}
