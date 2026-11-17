package todo

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

const MaxWriteItems = 200

var taskIDPattern = regexp.MustCompile(`^[1-9]\d*$`)

type WriteInput struct {
	Todos     []map[string]any
	DeleteIDs []string
}
type WriteOptions struct {
	Actor         string
	ValidateOwner func(string) error
	CreateTask    func(*Task)
}

func taskIDNumber(id string) float64 { n, _ := strconv.ParseFloat(id, 64); return n }
func stringIDs(value any) ([]string, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var ids []string
	if err := json.Unmarshal(data, &ids); err != nil || ids == nil {
		return nil, errors.New("Expected an array of task IDs")
	}
	for _, id := range ids {
		if !taskIDPattern.MatchString(id) {
			return nil, fmt.Errorf("Invalid task ID: %s", id)
		}
	}
	return ids, nil
}
func ParseWrite(input map[string]any) (WriteInput, error) {
	var result WriteInput
	for key := range input {
		if key != "todos" && key != "deleteIds" {
			return result, fmt.Errorf("Unrecognized key: %s", key)
		}
	}
	if value, exists := input["deleteIds"]; exists {
		ids, err := stringIDs(value)
		if err != nil {
			return result, err
		}
		if len(ids) > MaxWriteItems {
			return result, errors.New("deleteIds exceeds 200 items")
		}
		result.DeleteIDs = ids
	}
	if value, exists := input["todos"]; exists {
		data, err := json.Marshal(value)
		if err != nil {
			return result, err
		}
		if err := json.Unmarshal(data, &result.Todos); err != nil || result.Todos == nil {
			return result, errors.New("todos must be an array of task edits")
		}
		if len(result.Todos) > MaxWriteItems {
			return result, errors.New("todos exceeds 200 items")
		}
		for _, fields := range result.Todos {
			if fields == nil {
				return result, errors.New("Expected a task edit")
			}
			for key, value := range fields {
				switch key {
				case "id":
					id, ok := value.(string)
					if !ok || !taskIDPattern.MatchString(id) {
						return result, errors.New("Invalid task ID")
					}
				case "subject":
					text, ok := value.(string)
					if !ok || strings.TrimSpace(text) == "" {
						return result, errors.New("Task subject must not be empty")
					}
					fields[key] = strings.TrimSpace(text)
				case "description", "owner":
					if _, ok := value.(string); !ok {
						return result, fmt.Errorf("%s must be a string", key)
					}
				case "status":
					status, ok := value.(string)
					if !ok || !slices.Contains([]string{"pending", "in_progress", "completed", "blocked", "cancelled"}, status) {
						return result, errors.New("Invalid task status")
					}
				case "priority":
					priority, ok := value.(string)
					if !ok || !slices.Contains([]string{"high", "medium", "low"}, priority) {
						return result, errors.New("Invalid task priority")
					}
				case "metadata":
					if _, ok := value.(map[string]any); !ok {
						return result, errors.New("metadata must be an object")
					}
				case "blocks", "blockedBy":
					if _, err := stringIDs(value); err != nil {
						return result, err
					}
				default:
					return result, fmt.Errorf("Unrecognized task key: %s", key)
				}
			}
			if _, hasID := fields["id"]; !hasID && fields["subject"] == nil {
				return result, errors.New("New tasks require a subject")
			}
		}
	}
	return result, nil
}
func assignTaskFields(task *Task, fields map[string]any) error {
	data, err := json.Marshal(fields)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, task)
}
func validateTask(task *Task) error {
	if task == nil || !taskIDPattern.MatchString(task.ID) || strings.TrimSpace(task.Subject) == "" || task.Blocks == nil || task.BlockedBy == nil || task.Metadata == nil {
		return errors.New("Invalid task")
	}
	if !slices.Contains([]TaskStatus{StatusPending, StatusInProgress, StatusCompleted, StatusBlocked, StatusCancelled}, task.Status) {
		return errors.New("Invalid task status")
	}
	if task.Priority != "" && !slices.Contains([]string{"high", "medium", "low"}, task.Priority) {
		return errors.New("Invalid task priority")
	}
	for _, ids := range [][]string{task.Blocks, task.BlockedBy} {
		for _, id := range ids {
			if !taskIDPattern.MatchString(id) {
				return errors.New("Invalid dependency ID")
			}
		}
	}
	task.Subject = strings.TrimSpace(task.Subject)
	return nil
}
func ApplyWrite(current []*Task, nextID int, input WriteInput, options WriteOptions) ([]*Task, int, error) {
	original := map[string]*Task{}
	for _, task := range current {
		original[task.ID] = task
	}
	tasks := CloneTasks(current)
	byID := map[string]*Task{}
	for _, task := range tasks {
		byID[task.ID] = task
	}
	fail := func(err error) ([]*Task, int, error) { return nil, 0, err }
	assertOwner := func(task *Task) error {
		if options.Actor != "" && task.Owner != "" && task.Owner != options.Actor {
			return fmt.Errorf("Task #%s is already claimed by '%s'", task.ID, task.Owner)
		}
		return nil
	}
	deleted := map[string]bool{}
	for _, id := range input.DeleteIDs {
		if deleted[id] {
			return fail(errors.New("Duplicate task IDs in deleteIds"))
		}
		deleted[id] = true
		task := byID[id]
		if task == nil {
			return fail(fmt.Errorf("Task #%s not found", id))
		}
		if err := assertOwner(task); err != nil {
			return fail(err)
		}
		delete(byID, id)
	}
	tasks = slices.DeleteFunc(tasks, func(task *Task) bool { return deleted[task.ID] })
	for _, task := range tasks {
		task.Blocks = slices.DeleteFunc(task.Blocks, func(id string) bool { return deleted[id] })
		task.BlockedBy = slices.DeleteFunc(task.BlockedBy, func(id string) bool { return deleted[id] })
	}
	edits := map[string]map[string]any{}
	order := []string{}
	for _, edit := range input.Todos {
		id, supplied := edit["id"].(string)
		previous := original[id]
		if supplied && previous == nil {
			return fail(fmt.Errorf("Task #%s not found", id))
		}
		if !supplied {
			id = strconv.Itoa(nextID)
			nextID++
		}
		if _, exists := edits[id]; exists || deleted[id] {
			return fail(fmt.Errorf("Duplicate task ID: %s", id))
		}
		edits[id] = edit
		order = append(order, id)
		if previous != nil {
			if err := assertOwner(previous); err != nil {
				return fail(err)
			}
		}
		if owner, _ := edit["owner"].(string); owner != "" {
			if options.Actor != "" && owner != options.Actor {
				return fail(errors.New("Only the leader can assign tasks to other teammates"))
			}
			if options.ValidateOwner != nil {
				if err := options.ValidateOwner(owner); err != nil {
					return fail(err)
				}
			}
		}
		task := byID[id]
		if previous == nil {
			task = &Task{ID: id, Status: StatusPending, Blocks: []string{}, BlockedBy: []string{}, Metadata: map[string]any{}}
			if options.CreateTask != nil {
				options.CreateTask(task)
			}
			tasks = append(tasks, task)
			byID[id] = task
		}
		if options.Actor != "" && edit["status"] == "in_progress" {
			if previous != nil && (previous.Status == StatusCompleted || previous.Status == StatusCancelled) {
				return fail(fmt.Errorf("Task #%s is already %s; reopen it as pending first", id, previous.Status))
			}
			task.Owner = options.Actor
		}
		fields := map[string]any{}
		for key, value := range edit {
			if key != "id" && key != "metadata" && key != "blocks" && key != "blockedBy" {
				fields[key] = value
			}
		}
		if err := assignTaskFields(task, fields); err != nil {
			return fail(err)
		}
		if metadata, ok := edit["metadata"].(map[string]any); ok {
			for key, value := range metadata {
				if value == nil {
					delete(task.Metadata, key)
				} else {
					task.Metadata[key] = value
				}
			}
		}
		if err := validateTask(task); err != nil {
			return fail(err)
		}
	}
	for _, id := range order {
		edit := edits[id]
		task := byID[id]
		if _, exists := edit["blocks"]; exists {
			for _, otherID := range task.Blocks {
				other := byID[otherID]
				if other == nil {
					return fail(fmt.Errorf("Task #%s not found", otherID))
				}
				other.BlockedBy = slices.DeleteFunc(other.BlockedBy, func(value string) bool { return value == id })
			}
			task.Blocks = []string{}
		}
		if _, exists := edit["blockedBy"]; exists {
			for _, otherID := range task.BlockedBy {
				other := byID[otherID]
				if other == nil {
					return fail(fmt.Errorf("Task #%s not found", otherID))
				}
				other.Blocks = slices.DeleteFunc(other.Blocks, func(value string) bool { return value == id })
			}
			task.BlockedBy = []string{}
		}
	}
	for _, id := range order {
		edit := edits[id]
		for _, field := range []string{"blocks", "blockedBy"} {
			value, exists := edit[field]
			if !exists {
				continue
			}
			refs, _ := stringIDs(value)
			for _, otherID := range refs {
				if otherID != id && (original[otherID] == nil || deleted[otherID]) {
					return fail(fmt.Errorf("Unknown dependency: task #%s does not exist before this call", otherID))
				}
				from, to := id, otherID
				if field == "blockedBy" {
					from, to = otherID, id
				}
				if from == to {
					return fail(fmt.Errorf("Task #%s cannot depend on itself", from))
				}
				blocker, blocked := byID[from], byID[to]
				if blocker == nil || blocked == nil {
					return fail(fmt.Errorf("Unknown dependency: #%s → #%s", from, to))
				}
				if !slices.Contains(blocker.Blocks, to) {
					blocker.Blocks = append(blocker.Blocks, to)
				}
				if !slices.Contains(blocked.BlockedBy, from) {
					blocked.BlockedBy = append(blocked.BlockedBy, from)
				}
			}
		}
	}
	for _, id := range order {
		for _, field := range []string{"blocks", "blockedBy"} {
			value, exists := edits[id][field]
			if !exists {
				continue
			}
			requested, _ := stringIDs(value)
			wanted := map[string]bool{}
			for _, id := range requested {
				wanted[id] = true
			}
			actual := byID[id].Blocks
			if field == "blockedBy" {
				actual = byID[id].BlockedBy
			}
			if len(actual) != len(wanted) {
				return fail(fmt.Errorf("Conflicting dependency edits for task #%s", id))
			}
			for _, id2 := range actual {
				if !wanted[id2] {
					return fail(fmt.Errorf("Conflicting dependency edits for task #%s", id))
				}
			}
		}
	}
	if err := ValidateDependencies(tasks); err != nil {
		return fail(err)
	}
	for _, task := range tasks {
		if task.Status != StatusInProgress {
			continue
		}
		blockers := UnresolvedDependencies(task, tasks)
		if len(blockers) > 0 {
			return fail(fmt.Errorf("Task #%s is blocked by: %s", task.ID, strings.Join(blockers, ", ")))
		}
		if options.Actor != "" && edits[task.ID] != nil && task.Owner == "" {
			return fail(errors.New("An in-progress teammate task must have an owner"))
		}
	}
	if options.Actor != "" {
		var busy []*Task
		for _, task := range tasks {
			if task.Owner == options.Actor && task.Status == StatusInProgress {
				busy = append(busy, task)
			}
		}
		if len(busy) > 1 {
			return fail(fmt.Errorf("Teammate '%s' is already working on task #%s", options.Actor, busy[0].ID))
		}
	}
	return tasks, nextID, nil
}
func UnresolvedDependencies(task *Task, tasks []*Task) []string {
	completed := map[string]bool{}
	for _, task := range tasks {
		completed[task.ID] = task.Status == StatusCompleted
	}
	var blockers []string
	for _, id := range task.BlockedBy {
		if !completed[id] {
			blockers = append(blockers, id)
		}
	}
	return blockers
}
func ValidateDependencies(tasks []*Task) error {
	byID := map[string]*Task{}
	for _, task := range tasks {
		if task == nil {
			return errors.New("Invalid task")
		}
		if byID[task.ID] != nil {
			return fmt.Errorf("Duplicate task ID: %s", task.ID)
		}
		byID[task.ID] = task
	}
	for _, task := range tasks {
		for _, field := range []string{"blocks", "blockedBy"} {
			ids := task.Blocks
			if field == "blockedBy" {
				ids = task.BlockedBy
			}
			seen := map[string]bool{}
			for _, id := range ids {
				if seen[id] {
					return fmt.Errorf("Duplicate dependencies for task #%s", task.ID)
				}
				seen[id] = true
				if id == task.ID {
					return fmt.Errorf("Task #%s cannot depend on itself", id)
				}
				other := byID[id]
				if other == nil {
					return fmt.Errorf("Unknown dependency: task #%s does not exist", id)
				}
				reciprocal := other.BlockedBy
				if field == "blockedBy" {
					reciprocal = other.Blocks
				}
				if !slices.Contains(reciprocal, task.ID) {
					return fmt.Errorf("Inconsistent dependency between task #%s and #%s", task.ID, id)
				}
			}
		}
	}
	visiting, visited := map[string]bool{}, map[string]bool{}
	var visit func(*Task) error
	visit = func(task *Task) error {
		if visiting[task.ID] {
			return errors.New("Task dependencies contain a cycle")
		}
		if visited[task.ID] {
			return nil
		}
		visiting[task.ID] = true
		for _, id := range task.Blocks {
			if err := visit(byID[id]); err != nil {
				return err
			}
		}
		delete(visiting, task.ID)
		visited[task.ID] = true
		return nil
	}
	for _, task := range tasks {
		if err := visit(task); err != nil {
			return err
		}
	}
	return nil
}
