import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { type VariantProps } from "class-variance-authority";

import { buttonVariants } from "#/components/ui/constants.js";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "#/components/ui/tooltip.js";
import { cn } from "#/lib/utils.js";

function Button({
  className,
  variant = "unstyled",
  size = "none",
  title,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  const button = (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
  return title ? (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  ) : (
    button
  );
}

export { Button };
