"use client";

import * as React from "react";

interface CollapsibleProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
}

const Collapsible = React.forwardRef<HTMLDivElement, CollapsibleProps>(
  ({ open, onOpenChange, children, className, ...props }, ref) => {
    const [isOpen, setIsOpen] = React.useState(open ?? false);

    React.useEffect(() => {
      if (open !== undefined) {
        setIsOpen(open);
      }
    }, [open]);

    const handleToggle = () => {
      const newValue = !isOpen;
      setIsOpen(newValue);
      onOpenChange?.(newValue);
    };

    return (
      <div
        ref={ref}
        className={className}
        data-state={isOpen ? "open" : "closed"}
        {...props}
      >
        {React.Children.map(children, (child) => {
          if (React.isValidElement(child)) {
            if (child.type === CollapsibleTrigger) {
              return React.cloneElement(
                child as React.ReactElement<{ onClick?: () => void }>,
                {
                  onClick: handleToggle,
                },
              );
            }
            if (child.type === CollapsibleContent) {
              return isOpen ? child : null;
            }
          }
          return child;
        })}
      </div>
    );
  },
);
Collapsible.displayName = "Collapsible";

interface CollapsibleTriggerProps {
  asChild?: boolean;
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
}

const CollapsibleTrigger = React.forwardRef<
  HTMLButtonElement,
  CollapsibleTriggerProps
>(({ asChild, children, onClick, className, ...props }, ref) => {
  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(
      children as React.ReactElement<{ onClick?: () => void }>,
      {
        onClick,
      },
    );
  }

  return (
    <button ref={ref} onClick={onClick} className={className} {...props}>
      {children}
    </button>
  );
});
CollapsibleTrigger.displayName = "CollapsibleTrigger";

interface CollapsibleContentProps {
  children: React.ReactNode;
  className?: string;
}

const CollapsibleContent = React.forwardRef<
  HTMLDivElement,
  CollapsibleContentProps
>(({ children, className, ...props }, ref) => {
  return (
    <div ref={ref} className={className} {...props}>
      {children}
    </div>
  );
});
CollapsibleContent.displayName = "CollapsibleContent";

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
