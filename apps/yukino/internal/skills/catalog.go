package skills

import (
	"os"
	"path/filepath"
	"sort"

	"github.com/yukino-js/yukino/yukino/internal/storage"
)

func yukinoSkillsDir() string {
	return storage.YukinoPath(SkillsDirName)
}

type catalogEntry struct {
	skill         Skill
	filePath      string
	loadedMtimeMs int64
}

type dirMtime struct {
	set   bool
	mtime int64
}

// Catalog is the internal skill storage with the source file path and the file
// mtime recorded at load time, both used for hot reloading.
type Catalog struct {
	entries     map[string]*catalogEntry
	order       []string
	cwd         string
	dirModTimes map[string]dirMtime
}

func NewCatalog() *Catalog {
	return &Catalog{entries: map[string]*catalogEntry{}, dirModTimes: map[string]dirMtime{}}
}

func LoadCatalog(cwd string) *Catalog {
	catalog := NewCatalog()
	catalog.Load(cwd)
	return catalog
}

func (c *Catalog) Load(cwd string) {
	c.cwd = cwd
	c.entries = map[string]*catalogEntry{}
	c.order = nil
	c.dirModTimes = map[string]dirMtime{}
	for _, dir := range c.skillDirPaths() {
		if _, err := os.Stat(dir); err != nil {
			continue
		}
		c.scanDirectory(dir, map[string]bool{})
	}
	c.snapshotDirModTimes()
}

// NeedsReload reports whether a watched directory mtime changed (a skill
// directory or an entry inside one was added or removed).
func (c *Catalog) NeedsReload() bool {
	for dir, recorded := range c.dirModTimes {
		info, err := os.Stat(dir)
		if err != nil {
			if recorded.set {
				return true
			}
			continue
		}
		if !recorded.set || info.ModTime().UnixNano() != recorded.mtime {
			return true
		}
	}
	return false
}

func (c *Catalog) Reload() {
	c.Load(c.cwd)
}

func (c *Catalog) snapshotDirModTimes() {
	dirs := map[string]bool{}
	for _, dir := range c.skillDirPaths() {
		dirs[dir] = true
	}
	for dir := range c.dirModTimes {
		dirs[dir] = true
	}
	for dir := range dirs {
		if info, err := os.Stat(dir); err == nil {
			c.dirModTimes[dir] = dirMtime{set: true, mtime: info.ModTime().UnixNano()}
		} else {
			c.dirModTimes[dir] = dirMtime{}
		}
	}
}

func (c *Catalog) skillDirPaths() []string {
	var dirs []string
	if home, err := os.UserHomeDir(); err == nil {
		dirs = append(dirs, filepath.Join(home, AgentsDirName, SkillsDirName))
	}
	dirs = append(dirs, yukinoSkillsDir())
	if c.cwd != "" {
		dirs = append(dirs, filepath.Join(c.cwd, AgentsDirName, SkillsDirName))
	}
	return dirs
}

func (c *Catalog) scanDirectory(dir string, visited map[string]bool) {
	canonical, err := filepath.EvalSymlinks(dir)
	if err != nil {
		log.Error(map[string]any{"err": err}, "skills operation failed")
		return
	}
	if visited[canonical] {
		return
	}
	visited[canonical] = true
	info, err := os.Stat(dir)
	if err != nil {
		log.Error(map[string]any{"err": err}, "skills operation failed")
		return
	}
	c.dirModTimes[dir] = dirMtime{set: true, mtime: info.ModTime().UnixNano()}
	skillFile := filepath.Join(dir, SkillFileName)
	if _, err := os.Stat(skillFile); err == nil {
		c.loadSkill(skillFile, dir)
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		log.Error(map[string]any{"err": err}, "skills operation failed")
		return
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for _, entry := range entries {
		fullPath := filepath.Join(dir, entry.Name())
		_, hasSkill := os.Stat(filepath.Join(fullPath, SkillFileName))
		if (entry.Name()[0] == '.' || entry.Name() == "node_modules") && hasSkill != nil {
			continue
		}
		info, err := os.Stat(fullPath)
		if err != nil {
			// A broken symlink or a concurrently removed entry must not hide
			// other skills.
			log.Error(map[string]any{"err": err}, "skills operation failed")
			continue
		}
		if info.IsDir() {
			c.scanDirectory(fullPath, visited)
		}
	}
}

func (c *Catalog) statMtime(filePath string) int64 {
	info, err := os.Stat(filePath)
	if err != nil {
		log.Error(map[string]any{"err": err}, "skills operation failed")
		return 0
	}
	return info.ModTime().UnixMilli()
}

func (c *Catalog) loadSkill(filePath, sourceDir string) {
	// Stat before reading so the cached stamp never claims a version newer
	// than the body we hold; re-stat after the read so a mid-read change
	// forces a reload on next access.
	mtimeBefore := c.statMtime(filePath)
	data, err := os.ReadFile(filePath)
	if err != nil {
		log.Error(map[string]any{"err": err}, "skills operation failed")
		return
	}
	skill, _, ok := ParseSkillFile(string(data))
	if !ok {
		return
	}
	mtimeAfter := c.statMtime(filePath)
	if mtimeBefore != mtimeAfter {
		log.Debug(map[string]any{"filePath": filePath}, "skill file changed during load; will reload on next access")
	}
	skill.SourceDir = sourceDir
	if _, exists := c.entries[skill.Meta.Name]; !exists {
		c.order = append(c.order, skill.Meta.Name)
	}
	c.entries[skill.Meta.Name] = &catalogEntry{skill: skill, filePath: filePath, loadedMtimeMs: mtimeBefore}
}

func (c *Catalog) List() []SkillMeta {
	metas := make([]SkillMeta, 0, len(c.order))
	for _, name := range c.order {
		if entry, ok := c.entries[name]; ok {
			metas = append(metas, entry.skill.Meta)
		}
	}
	return metas
}

// Get returns a skill with hot reload support: the file is re-read only when
// its mtime shows it has been modified, and a failed parse retains the cached
// body.
func (c *Catalog) Get(name string) *Skill {
	entry, ok := c.entries[name]
	if !ok {
		return nil
	}
	if entry.filePath != "" && entry.loadedMtimeMs > 0 {
		info, err := os.Stat(entry.filePath)
		if err != nil {
			log.Error(map[string]any{"err": err}, "skills operation failed")
			return &entry.skill
		}
		currentMtime := info.ModTime().UnixMilli()
		if currentMtime != entry.loadedMtimeMs {
			data, err := os.ReadFile(entry.filePath)
			if err != nil {
				log.Error(map[string]any{"err": err}, "skills operation failed")
				return &entry.skill
			}
			parsed, _, ok := ParseSkillFile(string(data))
			if ok {
				if parsed.Meta.Name != name {
					c.Reload()
					if renamed, ok := c.entries[name]; ok {
						return &renamed.skill
					}
					return nil
				}
				parsed.SourceDir = entry.skill.SourceDir
				entry.skill = parsed
				entry.loadedMtimeMs = currentMtime
			}
		}
	}
	return &entry.skill
}

func (c *Catalog) Has(name string) bool {
	_, ok := c.entries[name]
	return ok
}
