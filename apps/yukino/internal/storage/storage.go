package storage

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"

	"github.com/yukino-js/yukino/yukino/internal/utils"
)

func GetYukinoDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, YukinoDirName)
}

func YukinoPath(segments ...string) string {
	return filepath.Join(append([]string{GetYukinoDir()}, segments...)...)
}

func SessionPath(sessionID string, segments ...string) (string, error) {
	if !SessionIDRe.MatchString(sessionID) {
		return "", errors.New(InvalidSessionIDError)
	}
	return YukinoPath(append([]string{SessionsDirName, ArtifactsDirName, sessionID}, segments...)...), nil
}

func ProjectKey(cwd string) (string, error) {
	canonical, err := utils.CanonicalPath(cwd, 0)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(canonical))
	return hex.EncodeToString(sum[:]), nil
}

func ProjectPath(cwd string, segments ...string) (string, error) {
	key, err := ProjectKey(cwd)
	if err != nil {
		return "", err
	}
	return YukinoPath(append([]string{ProjectsDirName, key}, segments...)...), nil
}

func GetSessionsDir(cwd string) (string, error) {
	key, err := ProjectKey(cwd)
	if err != nil {
		return "", err
	}
	return YukinoPath(SessionsDirName, key), nil
}
