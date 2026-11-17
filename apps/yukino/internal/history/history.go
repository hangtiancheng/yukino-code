package history

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/yukino-js/yukino/yukino/internal/logger"
	"github.com/yukino-js/yukino/yukino/internal/storage"
	"github.com/yukino-js/yukino/yukino/internal/utils"
)

const (
	MaxHistoryEntries     = 10_000
	CompactAfterRecords   = 20_000
	ActivityFileName      = "activity.jsonl"
	InvalidProjectMessage = "Activity project key does not match its working directory."
)

var (
	projectKeyRe = regexp.MustCompile(`^[a-f0-9]{64}$`)
	sessionIDRe  = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
)

var validSources = map[string]bool{"cli": true, "ws": true, "print": true, "sdk": true}

type ProjectInfo struct {
	ProjectKey string `json:"projectKey"`
	Cwd        string `json:"cwd"`
	CreatedAt  int64  `json:"createdAt"`
}

type InputEntry struct {
	Type        string  `json:"type"`
	ID          string  `json:"id"`
	Timestamp   int64   `json:"timestamp"`
	Cwd         string  `json:"cwd"`
	SessionID   *string `json:"sessionId"`
	Source      string  `json:"source"`
	Text        string  `json:"text"`
	CommandName *string `json:"commandName"`
}

type InputOptions struct {
	Cwd         string
	SessionID   *string
	Source      string
	Text        string
	CommandName *string
}

type CommandUsage struct {
	UsageCount int   `json:"usageCount"`
	LastUsedAt int64 `json:"lastUsedAt"`
}

type ActivityState struct {
	Projects          map[string]ProjectInfo  `json:"projects"`
	Inputs            []InputEntry            `json:"inputs"`
	CommandUsage      map[string]CommandUsage `json:"commandUsage"`
	commandUsageOrder []string
}

type projectRecord struct {
	Type       string `json:"type"`
	ProjectKey string `json:"projectKey"`
	Cwd        string `json:"cwd"`
	CreatedAt  int64  `json:"createdAt"`
}

type checkpointRecord struct {
	Type         string                  `json:"type"`
	Projects     map[string]ProjectInfo  `json:"projects"`
	Inputs       []InputEntry            `json:"inputs"`
	CommandUsage map[string]CommandUsage `json:"commandUsage"`
}

type loadedActivity struct {
	signature     string
	state         ActivityState
	recordCount   int
	completeBytes int64
}

var (
	cacheMu        sync.Mutex
	cachedActivity = map[string]*loadedActivity{}
	log            = logger.CreateChildLogger("history")
)

func emptyState() ActivityState {
	return ActivityState{
		Projects:     map[string]ProjectInfo{},
		Inputs:       []InputEntry{},
		CommandUsage: map[string]CommandUsage{},
	}
}

func activityFilePath() string {
	return storage.YukinoPath(ActivityFileName)
}

func fileSignature(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	return platformFileSignature(path, info), nil
}

func validateProjectFields(project ProjectInfo) error {
	if !projectKeyRe.MatchString(project.ProjectKey) {
		return errors.New("invalid projectKey")
	}
	if !filepath.IsAbs(project.Cwd) {
		return errors.New("cwd must be absolute")
	}
	if project.CreatedAt < 0 || project.CreatedAt > 9007199254740991 {
		return errors.New("invalid createdAt")
	}
	return nil
}

func validateProject(key string, project ProjectInfo) error {
	if err := validateProjectFields(project); err != nil {
		return err
	}
	if key != project.ProjectKey {
		return errors.New(InvalidProjectMessage)
	}
	canonical, err := utils.CanonicalPath(project.Cwd, 0)
	if err != nil {
		return err
	}
	if actual, err := storage.ProjectKey(canonical); err != nil || actual != key {
		return errors.New(InvalidProjectMessage)
	}
	return nil
}

func applyRecord(state ActivityState, raw []byte) (ActivityState, error) {
	var head struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &head); err != nil {
		return state, err
	}
	var usageOrder []string
	if head.Type == "checkpoint" {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &fields); err != nil {
			return state, err
		}
		var err error
		usageOrder, err = objectKeys(fields["commandUsage"])
		if err != nil {
			return state, err
		}
	}
	normalized, err := normalizeActivityNumbers(raw, head.Type)
	if err != nil {
		return state, err
	}
	raw = normalized
	switch head.Type {
	case "checkpoint":
		if err := validateCheckpointShape(raw); err != nil {
			return state, err
		}
		var record checkpointRecord
		if err := json.Unmarshal(raw, &record); err != nil {
			return state, err
		}
		next := emptyState()
		for key, project := range record.Projects {
			if err := validateProject(key, project); err != nil {
				log.Error(map[string]any{"err": err}, "parse activity project failed")
				continue
			}
			next.Projects[key] = project
		}
		next.Inputs = record.Inputs
		next.CommandUsage = record.CommandUsage
		next.commandUsageOrder = usageOrder
		return next, nil
	case "project":
		if err := validateProjectShape(raw, true); err != nil {
			return state, err
		}
		var record projectRecord
		if err := json.Unmarshal(raw, &record); err != nil {
			return state, err
		}
		project := ProjectInfo{ProjectKey: record.ProjectKey, Cwd: record.Cwd, CreatedAt: record.CreatedAt}
		if err := validateProject(record.ProjectKey, project); err != nil {
			return state, err
		}
		if _, exists := state.Projects[record.ProjectKey]; !exists {
			state.Projects[record.ProjectKey] = project
		}
		return state, nil
	case "input":
		if err := validateInputShape(raw); err != nil {
			return state, err
		}
		var record InputEntry
		if err := json.Unmarshal(raw, &record); err != nil {
			return state, err
		}
		if err := validateInput(record); err != nil {
			return state, err
		}
		state.Inputs = append(state.Inputs, record)
		if len(state.Inputs) > MaxHistoryEntries {
			state.Inputs = state.Inputs[len(state.Inputs)-MaxHistoryEntries:]
		}
		if record.CommandName != nil {
			if _, exists := state.CommandUsage[*record.CommandName]; !exists {
				state.commandUsageOrder = append(state.commandUsageOrder, *record.CommandName)
			}
			entry := state.CommandUsage[*record.CommandName]
			entry.UsageCount++
			if record.Timestamp > entry.LastUsedAt {
				entry.LastUsedAt = record.Timestamp
			}
			state.CommandUsage[*record.CommandName] = entry
		}
		return state, nil
	}
	return state, fmt.Errorf("unknown activity record type %q", head.Type)
}

func validateInput(record InputEntry) error {
	if !inputIDPattern.MatchString(record.ID) {
		return errors.New("invalid input id")
	}
	if record.Timestamp < 0 || record.Timestamp > 9007199254740991 {
		return errors.New("negative timestamp")
	}
	if !filepath.IsAbs(record.Cwd) {
		return errors.New("cwd must be absolute")
	}
	if record.SessionID != nil && !sessionIDRe.MatchString(*record.SessionID) {
		return errors.New("invalid sessionId")
	}
	if !validSources[record.Source] {
		return fmt.Errorf("invalid source %q", record.Source)
	}
	if record.Type != "input" {
		return errors.New("invalid input type")
	}
	if record.Text == "" {
		return errors.New("text must not be empty")
	}
	if record.CommandName != nil && *record.CommandName == "" {
		return errors.New("commandName must not be empty")
	}
	return nil
}

func readActivity(filePath string) (*loadedActivity, error) {
	if _, err := os.Stat(filePath); err != nil {
		if os.IsNotExist(err) {
			return &loadedActivity{state: emptyState()}, nil
		}
		return nil, err
	}
	current, err := fileSignature(filePath)
	if err != nil {
		return nil, err
	}
	cacheMu.Lock()
	cached, ok := cachedActivity[filePath]
	cacheMu.Unlock()
	if ok && cached.signature == current {
		return cached, nil
	}
	content, err := storage.ReadPrivateFileSync(filePath)
	if err != nil {
		return nil, err
	}
	completeBytes := int64(strings.LastIndex(string(content), "\n")) + 1
	state := emptyState()
	recordCount := 0
	for _, line := range strings.Split(string(content[:completeBytes]), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		recordCount++
		next, err := applyRecord(state, []byte(line))
		if err != nil {
			log.Error(map[string]any{"err": err}, "parse activity record failed")
			continue
		}
		state = next
	}
	signature, err := fileSignature(filePath)
	if err != nil {
		return nil, err
	}
	loaded := &loadedActivity{
		signature:     signature,
		state:         state,
		recordCount:   recordCount,
		completeBytes: completeBytes,
	}
	cacheMu.Lock()
	cachedActivity[filePath] = loaded
	cacheMu.Unlock()
	return loaded, nil
}

func writeCheckpoint(filePath string, loaded *loadedActivity) error {
	tempPath := fmt.Sprintf("%s.%d.%s.tmp", filePath, os.Getpid(), uuid.NewString())
	record := checkpointRecord{
		Type:         "checkpoint",
		Projects:     loaded.state.Projects,
		Inputs:       loaded.state.Inputs,
		CommandUsage: loaded.state.CommandUsage,
	}
	data, err := marshalCheckpoint(record, loaded.state.commandUsageOrder)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	defer os.Remove(tempPath)
	if err := storage.WritePrivateFileSync(tempPath, data, os.O_WRONLY|os.O_CREATE|os.O_TRUNC); err != nil {
		return err
	}
	if err := os.Rename(tempPath, filePath); err != nil {
		return err
	}
	loaded.recordCount = 1
	info, err := os.Stat(filePath)
	if err != nil {
		return err
	}
	loaded.completeBytes = info.Size()
	return nil
}

func updateActivity(buildRecords func(state ActivityState) ([][]byte, error), compact bool) error {
	if err := storage.MkdirPrivateSync(storage.GetYukinoDir()); err != nil {
		return err
	}
	filePath := activityFilePath()
	return storage.WithFileSyncLock(filePath, func() (resultErr error) {
		defer func() {
			if resultErr != nil {
				cacheMu.Lock()
				delete(cachedActivity, filePath)
				cacheMu.Unlock()
			}
		}()
		loaded, err := readActivity(filePath)
		if err != nil {
			return err
		}
		records, err := buildRecords(loaded.state)
		if err != nil {
			return err
		}
		if info, err := os.Stat(filePath); err == nil && info.Size() != loaded.completeBytes {
			f, err := storage.OpenPrivateFile(filePath, os.O_WRONLY|os.O_APPEND)
			if err != nil {
				return err
			}
			truncateErr := f.Truncate(loaded.completeBytes)
			closeErr := f.Close()
			if truncateErr != nil {
				return truncateErr
			}
			if closeErr != nil {
				return closeErr
			}
		} else if err != nil && !os.IsNotExist(err) {
			return err
		}
		if len(records) > 0 {
			var content []byte
			for _, record := range records {
				content = append(content, record...)
				content = append(content, '\n')
			}
			if err := storage.AppendPrivateFileSync(filePath, content); err != nil {
				return err
			}
			for _, record := range records {
				next, err := applyRecord(loaded.state, record)
				if err != nil {
					return err
				}
				loaded.state = next
			}
			loaded.recordCount += len(records)
			loaded.completeBytes += int64(len(content))
		}
		if compact || loaded.recordCount >= CompactAfterRecords {
			if err := writeCheckpoint(filePath, loaded); err != nil {
				if len(records) == 0 {
					return err
				}
				log.Error(map[string]any{"err": err}, "compact activity failed")
			}
		}
		if _, err := os.Stat(filePath); err == nil {
			signature, err := fileSignature(filePath)
			if err != nil {
				return err
			}
			loaded.signature = signature
			cacheMu.Lock()
			cachedActivity[filePath] = loaded
			cacheMu.Unlock()
		}
		return nil
	})
}

func projectRecords(cwd string, state ActivityState) ([][]byte, error) {
	key, err := storage.ProjectKey(cwd)
	if err != nil {
		return nil, err
	}
	if _, exists := state.Projects[key]; exists {
		return nil, nil
	}
	record := projectRecord{
		Type:       "project",
		Cwd:        cwd,
		ProjectKey: key,
		CreatedAt:  time.Now().UnixMilli(),
	}
	data, err := json.Marshal(record)
	if err != nil {
		return nil, err
	}
	return [][]byte{data}, nil
}

func RegisterProject(cwd string) error {
	canonical, err := utils.CanonicalPath(cwd, 0)
	if err != nil {
		return err
	}
	return updateActivity(func(state ActivityState) ([][]byte, error) {
		return projectRecords(canonical, state)
	}, false)
}

func RecordInput(options InputOptions) (InputEntry, error) {
	canonical, err := utils.CanonicalPath(options.Cwd, 0)
	if err != nil {
		return InputEntry{}, err
	}
	if options.SessionID != nil {
		value := *options.SessionID
		options.SessionID = &value
	}
	if options.CommandName != nil {
		value := *options.CommandName
		options.CommandName = &value
	}
	entry := InputEntry{
		Type:        "input",
		ID:          uuid.NewString(),
		Timestamp:   time.Now().UnixMilli(),
		Cwd:         canonical,
		SessionID:   options.SessionID,
		Source:      options.Source,
		Text:        options.Text,
		CommandName: options.CommandName,
	}
	if err := validateInput(entry); err != nil {
		return InputEntry{}, err
	}
	data, err := json.Marshal(entry)
	if err != nil {
		return InputEntry{}, err
	}
	err = updateActivity(func(state ActivityState) ([][]byte, error) {
		records, err := projectRecords(canonical, state)
		if err != nil {
			return nil, err
		}
		return append(records, data), nil
	}, false)
	if err != nil {
		return InputEntry{}, err
	}
	return entry, nil
}

func queryState(read func(state ActivityState)) error {
	filePath := activityFilePath()
	if _, err := os.Stat(filePath); err != nil {
		if !os.IsNotExist(err) {
			return err
		}
		read(emptyState())
		return nil
	}
	return storage.WithFileSyncLock(filePath, func() error {
		loaded, err := readActivity(filePath)
		if err != nil {
			return err
		}
		read(loaded.state)
		return nil
	})
}

func LoadInputs() ([]InputEntry, error) {
	inputs := []InputEntry{}
	err := queryState(func(state ActivityState) {
		for _, input := range state.Inputs {
			if input.SessionID != nil {
				value := *input.SessionID
				input.SessionID = &value
			}
			if input.CommandName != nil {
				value := *input.CommandName
				input.CommandName = &value
			}
			inputs = append(inputs, input)
		}
	})
	return inputs, err
}

func LoadInputTexts() ([]string, error) {
	inputs, err := LoadInputs()
	if err != nil {
		return nil, err
	}
	texts := []string{}
	for _, input := range inputs {
		if len(texts) == 0 || texts[len(texts)-1] != input.Text {
			texts = append(texts, input.Text)
		}
	}
	return texts, nil
}

func GetCommandUsage() (CommandUsageSnapshot, error) {
	usage := CommandUsageSnapshot{Entries: map[string]CommandUsage{}}
	err := queryState(func(state ActivityState) {
		for name, entry := range state.CommandUsage {
			usage.Entries[name] = entry
		}
		usage.Order = jsObjectOrder(state.commandUsageOrder)
	})
	return usage, err
}

func ListProjects() ([]ProjectInfo, error) {
	projects := []ProjectInfo{}
	err := queryState(func(state ActivityState) {
		for _, project := range state.Projects {
			projects = append(projects, project)
		}
	})
	sort.Slice(projects, func(i, j int) bool { return projects[i].ProjectKey < projects[j].ProjectKey })
	return projects, err
}

func CompactActivity() error {
	return updateActivity(func(state ActivityState) ([][]byte, error) {
		return nil, nil
	}, true)
}
