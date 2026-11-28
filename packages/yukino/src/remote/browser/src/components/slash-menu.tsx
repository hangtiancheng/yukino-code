import {
  AutocompleteList,
  AutocompleteItem,
} from "#/components/ui/autocomplete.js";
import type { SlashCommand } from "#/types.js";

interface SlashMenuProps {
  commands: SlashCommand[];
  onSelect: (index: number) => void;
}

export function SlashMenu({ commands, onSelect }: SlashMenuProps) {
  return (
    <AutocompleteList
      aria-label="Slash commands"
      className="completion-menu absolute inset-x-0 bottom-full mb-2 p-1"
    >
      {commands.map((command, index) => (
        <AutocompleteItem
          className="px-2"
          key={command.name}
          value={command.name}
          onClick={() => {
            onSelect(index);
          }}
        >
          <span className="font-mono text-[13px] font-semibold whitespace-nowrap text-bright">
            /{command.name}
          </span>
          <span className="overflow-hidden text-ellipsis whitespace-nowrap text-xs text-dim">
            {command.description}
          </span>
        </AutocompleteItem>
      ))}
    </AutocompleteList>
  );
}
