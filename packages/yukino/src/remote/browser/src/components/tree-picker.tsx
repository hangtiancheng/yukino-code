import { Modal, ModalHeader } from "#/components/modal.js";
import { PickerList } from "#/components/picker-list.js";
import { Button } from "#/components/ui/button.js";
import type { SessionTreeRow } from "#/types.js";

export function TreePicker({
  rows,
  onPick,
  onClose,
  onControl,
}: {
  rows: SessionTreeRow[];
  onControl: (command: string) => void;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal label="Session tree" onEscape={onClose}>
      <ModalHeader
        title="Session tree"
        subtitle="Search text, label or role:user. Navigation does not rewind files or restart tasks."
      />
      <div className="flex gap-3 px-5 py-2 text-xs">
        <Button
          type="button"
          onClick={() => {
            onControl("fold --all");
          }}
        >
          Fold branches
        </Button>
        <Button
          type="button"
          onClick={() => {
            onControl("unfold --all");
          }}
        >
          Unfold branches
        </Button>
        <Button
          type="button"
          onClick={() => {
            onControl("--labeled-only");
          }}
        >
          Labeled only
        </Button>
        <Button
          type="button"
          onClick={() => {
            onControl("--all-labels");
          }}
        >
          All entries
        </Button>
      </div>
      <PickerList
        items={rows.map((row) => ({
          ...row,
          meta: row.folded ? "folded" : undefined,
        }))}
        onSelect={onPick}
        onBranchToggle={(id, folded) => {
          onControl(`${folded ? "fold" : "unfold"} ${id}`);
        }}
      />
    </Modal>
  );
}
