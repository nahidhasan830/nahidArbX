import * as React from "react";
import { Loader2, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ButtonProps = React.ComponentProps<typeof Button>;

export type LoadingButtonProps = ButtonProps & {
  loading?: boolean;
  icon?: LucideIcon;
  iconClassName?: string;
};

function LoadingButton({
  loading = false,
  icon: Icon,
  iconClassName,
  disabled,
  children,
  ...props
}: LoadingButtonProps) {
  const Render = loading && !Icon ? Loader2 : Icon;

  return (
    <Button disabled={disabled || loading} {...props}>
      {Render ? (
        <Render className={cn(loading && "animate-spin", iconClassName)} />
      ) : null}
      {children}
    </Button>
  );
}

export { LoadingButton };
