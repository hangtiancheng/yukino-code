import { useScrollFollow } from "#/hooks/use-scroll-follow.js";
import type { SlashCommand } from "#/types.js";

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
  const { listRef, setItemRef } = useScrollFollow(cursor);

  if (commands.length === 0) {
    return null;
  }
  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Slash commands"
      className="absolute inset-x-4 bottom-full mb-2 max-h-72 overflow-y-auto border-y border-rule bg-bg py-1  sm:inset-x-6"
    >
      {commands.map((cmd, i) => (
        <button
          key={cmd.name}
          ref={setItemRef(i)}
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
          className={`flex w-full cursor-pointer items-baseline gap-2.5 px-3.5 py-2 text-left transition-colors ${
            i === cursor ? "bg-accent/8" : ""
          }`}
        >
          <span className="font-mono text-[13px] font-semibold whitespace-nowrap text-bright">
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
