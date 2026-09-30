import type { SlashCommand } from "@fe/types";

interface SlashMenuProps {
  commands: SlashCommand[];
  cursor: number;
  onSelect: (index: number) => void;
  onHover: (index: number) => void;
}

export function SlashMenu({
  commands,
  cursor,
  onSelect,
  onHover,
}: SlashMenuProps) {
  if (commands.length === 0) {
    return null;
  }
  return (
    <div
      role="listbox"
      aria-label="Slash commands"
      className="absolute inset-x-5 bottom-full mb-2 max-h-64 overflow-y-auto rounded-xl border border-border bg-surface py-1 shadow-pop"
    >
      {commands.map((cmd, i) => (
        <button
          key={cmd.name}
          type="button"
          role="option"
          aria-selected={i === cursor}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(i);
          }}
          onMouseEnter={() => {
            onHover(i);
          }}
          className={`flex w-full cursor-pointer items-baseline gap-2.5 px-3.5 py-2 text-left ${
            i === cursor ? "bg-accent/8" : ""
          }`}
        >
          <span className="font-mono text-[13px] font-semibold whitespace-nowrap text-accent">
            /{cmd.name}
          </span>
          <span className="overflow-hidden text-ellipsis whitespace-nowrap text-xs text-dim">
            {cmd.description}
          </span>
        </button>
      ))}
    </div>
  );
}
