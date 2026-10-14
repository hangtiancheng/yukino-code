package docs

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/tools/operations"
	"golang.org/x/text/collate"
	"golang.org/x/text/language"

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
	info, err := os.Stat(dir)
	if os.IsNotExist(err) {
		return docs, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("docs path is not a directory: %s", dir)
	}
	// readdir follows a symlink used as the configured root, while its recursive
	// entries still skip symlink files and directories.
	dir, err = filepath.EvalSymlinks(dir)
	if err != nil {
		return nil, err
	}
	err = filepath.WalkDir(dir, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if os.IsNotExist(walkErr) && path == dir {
				return fs.SkipAll
			}
			return walkErr
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		if _, ok := supportedExtensions[strings.ToLower(filepath.Ext(entry.Name()))]; !ok {
			return nil
		}
		relative, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		source := filepath.ToSlash(relative)
		data, err := os.ReadFile(path)
		if err != nil {
			logger.Warn("failed to read document, preserving existing index", "source", source, logger.Err(err))
			docs = append(docs, ScannedDoc{Source: source})
			return nil
		}
		text := operations.DecodeUTF8(data)
		docs = append(docs, ScannedDoc{Source: source, Content: &text})
		return nil
	})
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	order := collate.New(language.English)
	slices.SortStableFunc(docs, func(a, b ScannedDoc) int {
		return order.CompareString(a.Source, b.Source)
	})
	return docs, nil
}
