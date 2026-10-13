package docs

import (
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/logger"
)

var supportedExtensions = map[string]struct{}{
	".md":       {},
	".markdown": {},
	".txt":      {},
}

// ScannedDoc is one file under the knowledge-base directory. A nil Content
// means the file could not be read and the previous index entry must be kept.
type ScannedDoc struct {
	Source  string
	Content *string
}

// ScanDocsDir walks dir recursively and returns supported documents sorted by
// their slash-separated path relative to dir. A missing directory yields no documents.
func ScanDocsDir(dir string) ([]ScannedDoc, error) {
	var docs []ScannedDoc
	err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if os.IsNotExist(walkErr) && path == dir {
				return fs.SkipAll
			}
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if _, ok := supportedExtensions[strings.ToLower(filepath.Ext(entry.Name()))]; !ok {
			return nil
		}
		source := filepath.ToSlash(strings.TrimPrefix(path, dir))
		source = strings.TrimPrefix(source, "/")
		data, err := os.ReadFile(path)
		if err != nil {
			logger.Warn("failed to read document, preserving existing index", "source", source, logger.Err(err))
			docs = append(docs, ScannedDoc{Source: source})
			return nil
		}
		text := string(data)
		docs = append(docs, ScannedDoc{Source: source, Content: &text})
		return nil
	})
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	slices.SortFunc(docs, func(a, b ScannedDoc) int {
		return strings.Compare(a.Source, b.Source)
	})
	return docs, nil
}
