import associations from "@renderer/assets/catppuccin-icons/associations.json";
import icons from "@renderer/assets/catppuccin-icons/icons.svg?raw";
import { folderName } from "@renderer/lib/utils";
import { cn } from "cn";

const fileNames: Readonly<Record<string, string>> = associations.fileNames;
const fileExtensions: Readonly<Record<string, string>> =
  associations.fileExtensions;
const folderNames: Readonly<Record<string, string>> = associations.folderNames;
const folderNamesExpanded: Readonly<Record<string, string>> =
  associations.folderNamesExpanded;

function findIcon(
  associations: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  return Object.hasOwn(associations, name) ? associations[name] : undefined;
}

function fileIcon(name: string): string {
  const exact = findIcon(fileNames, name);
  if (exact) {
    return exact;
  }
  for (
    let dot = name.indexOf(".");
    dot >= 0;
    dot = name.indexOf(".", dot + 1)
  ) {
    const extension = findIcon(fileExtensions, name.slice(dot + 1));
    if (extension) {
      return extension;
    }
  }
  return "_file";
}

export function FileIconDefinitions(): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute size-0"
      dangerouslySetInnerHTML={{ __html: icons }}
    />
  );
}

export function FileIcon({
  path,
  directory,
  expanded,
  root,
  className,
}: {
  path: string;
  directory?: boolean;
  expanded?: boolean;
  root?: boolean;
  className?: string;
}): React.JSX.Element {
  const name = folderName(path).toLowerCase();
  const icon = root
    ? "_root"
    : directory
      ? (findIcon(expanded ? folderNamesExpanded : folderNames, name) ??
        (expanded ? "_folder_open" : "_folder"))
      : fileIcon(name);
  return (
    <svg
      aria-hidden="true"
      className={cn("file-icon size-4 shrink-0", className)}
      viewBox="0 0 16 16"
    >
      <use href={`#catppuccin-${icon}`} />
    </svg>
  );
}
