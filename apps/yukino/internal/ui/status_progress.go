package ui

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/teams"
	"github.com/yukino-js/yukino/yukino/internal/todo"
)

func (m Model) visibleTasks() ([]*todo.Task, string) {
	if m.teamMgr == nil || len(m.teamMgr.ListTeams()) == 0 {
		if m.todoList == nil {
			return nil, ""
		}
		return m.todoList.List(), m.todoList.BoardID()
	}
	names := m.teamMgr.ListTeams()
	var tasks []*todo.Task
	for _, name := range names {
		store, err := m.teamMgr.GetTaskStore(name)
		if err != nil {
			continue
		}
		teamTasks, err := store.ListTasks("", "")
		if err != nil {
			continue
		}
		for _, task := range teamTasks {
			if len(names) > 1 {
				id, _ := json.Marshal([]string{name, task.ID})
				task.ID = string(id)
				task.Subject = "[" + name + "] " + task.Subject
				remap := func(ids []string) []string {
					out := make([]string, 0, len(ids))
					for _, dependency := range ids {
						encoded, _ := json.Marshal([]string{name, dependency})
						out = append(out, string(encoded))
					}
					return out
				}
				task.Blocks = remap(task.Blocks)
				task.BlockedBy = remap(task.BlockedBy)
			}
			tasks = append(tasks, task)
		}
	}
	board, _ := json.Marshal(names)
	return tasks, fmt.Sprintf("team:%s:%d", string(board), m.todoBoardGeneration)
}
func (m *Model) updateTodoCompletion() {
	var nextTeams []*teams.Team
	if m.teamMgr != nil {
		for _, name := range m.teamMgr.ListTeams() {
			nextTeams = append(nextTeams, m.teamMgr.GetTeam(name))
		}
	}
	changed := len(nextTeams) != len(m.todoTeams)
	if !changed {
		for i, team := range nextTeams {
			if team != m.todoTeams[i] {
				changed = true
				break
			}
		}
	}
	if changed {
		m.todoTeams = nextTeams
		m.todoBoardGeneration++
	}

	tasks, board := m.visibleTasks()
	var ids []string
	for _, task := range tasks {
		if task.Status != todo.StatusCompleted {
			m.todoCompletionKey = ""
			m.todoCompletionAt = time.Time{}
			return
		}
		ids = append(ids, task.ID)
	}
	if len(ids) == 0 {
		m.todoCompletionKey = ""
		m.todoCompletionAt = time.Time{}
		return
	}
	sort.Strings(ids)
	data, _ := json.Marshal(ids)
	key := board + ":" + string(data)
	if key != m.todoCompletionKey {
		m.todoCompletionKey = key
		m.todoCompletionAt = time.Now()
	}
}
func (m Model) renderTodoProgress() string {
	tasks, _ := m.visibleTasks()
	if len(tasks) == 0 {
		return ""
	}
	completed, cancelled, blocked, active := 0, 0, 0, 0
	current := ""
	for _, task := range tasks {
		switch task.Status {
		case todo.StatusCompleted:
			completed++
		case todo.StatusCancelled:
			cancelled++
		case todo.StatusBlocked:
			blocked++
		case todo.StatusInProgress:
			active++
			if current == "" {
				current = task.Subject
			}
		}
	}
	if completed == len(tasks) && !m.todoCompletionAt.IsZero() && time.Since(m.todoCompletionAt) >= 5*time.Second {
		return ""
	}
	color := Theme.Accent
	if completed == len(tasks) {
		color = Theme.Success
	}
	line := paint(todo.Progress(tasks), color)
	if cancelled > 0 {
		line += paint(fmt.Sprintf(" · %d cancelled", cancelled), Theme.Warning)
	}
	if blocked > 0 {
		line += paint(fmt.Sprintf(" · %d blocked", blocked), Theme.Warning)
	}
	if current != "" {
		line += paint(" · "+plainTerminalLine(current), Theme.Muted)
	}
	if active > 1 {
		line += paint(fmt.Sprintf(" (+%d active)", active-1), Theme.Dim)
	}
	return line
}
func (m Model) renderAgentStatus() string {
	teammates, backgroundAgents, shells := 0, 0, 0
	if m.teamMgr != nil {
		teammates = len(m.teamMgr.GetAllTeammateStates())
	}
	if m.taskMgr != nil {
		for _, task := range m.taskMgr.List() {
			if task.Status != "running" {
				continue
			}
			if task.Kind == "shell" {
				shells++
			} else {
				backgroundAgents++
			}
		}
	}
	var parts []string
	count := func(n int, singular, plural string) {
		if n > 0 {
			word := plural
			if n == 1 {
				word = singular
			}
			parts = append(parts, fmt.Sprintf("%d %s", n, word))
		}
	}
	count(teammates, "teammate", "teammates")
	count(backgroundAgents, "background subagent", "background subagents")
	count(shells, "background command", "background commands")
	if len(parts) == 0 {
		return ""
	}
	return paint("• "+strings.Join(parts, " · ")+" · ↓ on last input line to view", Theme.Dim)
}
