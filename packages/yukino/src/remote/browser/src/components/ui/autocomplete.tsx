import { Autocomplete as AutocompletePrimitive } from "@base-ui/react/autocomplete";
import type { ComponentProps } from "react";

import { cn } from "#/lib/utils.js";

const Autocomplete = AutocompletePrimitive.Root;
const AutocompleteInput = AutocompletePrimitive.Input;

function AutocompleteList({
  className,
  ...props
}: ComponentProps<typeof AutocompletePrimitive.List>) {
  return (
    <AutocompletePrimitive.List
      data-slot="autocomplete-list"
      className={cn(
        "max-h-72 overflow-y-auto rounded-xl border border-border bg-surface p-1.5 shadow-xl",
        className,
      )}
      {...props}
    />
  );
}
function AutocompleteItem({
  className,
  ...props
}: ComponentProps<typeof AutocompletePrimitive.Item>) {
  return (
    <AutocompletePrimitive.Item
      data-slot="autocomplete-item"
      className={cn(
        "flex w-full cursor-pointer items-baseline gap-2.5 rounded-lg px-3.5 py-2 text-left outline-none transition-colors data-highlighted:bg-accent-bg",
        className,
      )}
      {...props}
    />
  );
}
export { Autocomplete, AutocompleteInput, AutocompleteList, AutocompleteItem };
