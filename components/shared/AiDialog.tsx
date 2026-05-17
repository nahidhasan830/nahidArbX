"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

interface AiDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  loading?: boolean;
  loadingSkeleton?: React.ReactNode;
  error?: string | null;
  errorTitle?: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  maxWidth?: string;
  maxHeight?: string;
  className?: string;
}

/**
 * Reusable dialog shell for AI-related workflows.
 *
 * Provides consistent sizing, loading skeletons, error alerts,
 * and a standard footer with a Cancel button.
 */
export function AiDialog({
  open,
  onOpenChange,
  title,
  description,
  loading = false,
  loadingSkeleton,
  error,
  errorTitle = "Something went wrong",
  children,
  footer,
  maxWidth = "max-w-3xl",
  maxHeight = "max-h-[85vh]",
  className,
}: AiDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "overflow-hidden flex flex-col",
          maxWidth,
          maxHeight,
          className,
        )}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <div className="flex-1 overflow-auto">
          {loading && (
            loadingSkeleton ?? (
              <div className="space-y-2 p-1">
                <Skeleton className="h-6 w-3/4" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            )
          )}

          {!loading && error && (
            <Alert>
              <AlertTitle>{errorTitle}</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {!loading && !error && children}
        </div>

        <DialogFooter>
          {footer ?? (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
