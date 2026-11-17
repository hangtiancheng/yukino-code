package plan_file

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/yukino-js/yukino/yukino/internal/storage"
	"github.com/yukino-js/yukino/yukino/internal/utils"
)

const (
	PlansDirName          = "plans"
	PlanFileExt           = ".md"
	OutsideStorageMessage = "current plan path is outside plan storage"
)

type Owner interface {
	CurrentPlanPath() string
	SetPlanFilePath(string)
}

func plansDir() string {
	return storage.YukinoPath(PlansDirName)
}

func isPlanInStorage(planPath string) bool {
	abs, err := filepath.Abs(planPath)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(plansDir(), abs)
	if err != nil {
		return false
	}
	return rel != "" && rel != "." && !strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel)
}

func CreatePlanPath() (string, error) {
	dir := plansDir()
	if err := storage.MkdirPrivateSync(dir); err != nil {
		return "", err
	}
	path := filepath.Join(dir, utils.GenerateSlug()+PlanFileExt)
	if err := storage.WritePrivateFileSync(path, nil, os.O_WRONLY|os.O_CREATE|os.O_EXCL); err != nil {
		return "", err
	}
	return path, nil
}

func GetOrCreatePlanPath(owner Owner) (string, error) {
	currentPlanPath := owner.CurrentPlanPath()
	if currentPlanPath != "" {
		if _, err := os.Stat(currentPlanPath); err == nil && isPlanInStorage(currentPlanPath) {
			return currentPlanPath, nil
		}
	}
	path, err := CreatePlanPath()
	if err != nil {
		return "", err
	}
	owner.SetPlanFilePath(path)
	return path, nil
}

func ResetPlanPath(owner Owner) {
	owner.SetPlanFilePath("")
}

func PlanExists(owner Owner) bool {
	currentPlanPath := owner.CurrentPlanPath()
	if currentPlanPath == "" {
		return false
	}
	if _, err := os.Stat(currentPlanPath); err != nil {
		return false
	}
	return isPlanInStorage(currentPlanPath)
}

func LoadPlan(owner Owner) (string, error) {
	currentPlanPath := owner.CurrentPlanPath()
	if currentPlanPath == "" {
		return "", nil
	}
	if _, err := os.Stat(currentPlanPath); err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	data, err := storage.ReadPrivateFileSync(currentPlanPath)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func SavePlan(owner Owner, content string) error {
	path, err := GetOrCreatePlanPath(owner)
	if err != nil {
		return err
	}
	return storage.WritePrivateFileSync(path, []byte(content), os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
}

func GetCurrentPlanPath(owner Owner) string {
	return owner.CurrentPlanPath()
}
