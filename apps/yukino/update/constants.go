package update

import "regexp"

const (
	PackageName    = "@yukino.js/yukino"
	PackageURL     = "https://registry.npmjs.org/@yukino.js%2Fyukino"
	NPMRegistryURL = "https://registry.npmjs.org/"
	DefaultDistTag = "latest"

	RegistryFetchTimeoutMS       = 10_000
	PackageManagerQueryTimeoutMS = 10_000

	InstallationNotFoundError  = "Could not locate the Yukino installation."
	UnmanagedInstallationError = "This Yukino installation is not managed by global npm, yarn, or pnpm. " +
		"Update the source checkout or reinstall using yukino-code/install.sh or yukino-code/install.ps1."
)

var VersionPattern = regexp.MustCompile(`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*))?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$`)
