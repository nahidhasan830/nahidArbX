"use client";

import { useState } from "react";
import { Copy, Check, FileJson, ArrowRightLeft } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface JsonViewerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  requestBody?: unknown;
  responseBody?: unknown;
  metadata?: Record<string, unknown>;
}

export function JsonViewerModal({
  open,
  onOpenChange,
  title = "AI Log Details",
  requestBody,
  responseBody,
  metadata,
}: JsonViewerModalProps) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleCopy = async (data: unknown, key: string) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <FileJson className="h-5 w-5" />
            {title}
          </DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="request" className="flex-1 flex flex-col min-h-0">
          <TabsList className="flex-shrink-0">
            <TabsTrigger value="request" className="flex items-center gap-2">
              <ArrowRightLeft className="h-4 w-4" />
              Request
            </TabsTrigger>
            <TabsTrigger value="response" className="flex items-center gap-2">
              <ArrowRightLeft className="h-4 w-4 rotate-180" />
              Response
            </TabsTrigger>
            {metadata && Object.keys(metadata).length > 0 && (
              <TabsTrigger value="metadata">Metadata</TabsTrigger>
            )}
          </TabsList>

          <div className="flex-1 min-h-0 overflow-auto mt-4">
            <TabsContent value="request" className="h-full mt-0">
              <JsonPanel
                data={requestBody}
                label="Request"
                onCopy={() => handleCopy(requestBody, "request")}
                copied={copiedKey === "request"}
              />
            </TabsContent>

            <TabsContent value="response" className="h-full mt-0">
              <JsonPanel
                data={responseBody}
                label="Response"
                onCopy={() => handleCopy(responseBody, "response")}
                copied={copiedKey === "response"}
              />
            </TabsContent>

            {metadata && (
              <TabsContent value="metadata" className="h-full mt-0">
                <JsonPanel
                  data={metadata}
                  label="Metadata"
                  onCopy={() => handleCopy(metadata, "metadata")}
                  copied={copiedKey === "metadata"}
                />
              </TabsContent>
            )}
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

interface JsonPanelProps {
  data: unknown;
  label: string;
  onCopy: () => void;
  copied: boolean;
}

function JsonPanel({ data, label, onCopy, copied }: JsonPanelProps) {
  const jsonStr = data ? JSON.stringify(data, null, 2) : "No data";

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-2 flex-shrink-0">
        <span className="text-sm font-medium text-muted-foreground">
          {label}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={onCopy}
          className="h-8 gap-1"
        >
          {copied ? (
            <>
              <Check className="h-4 w-4" />
              Copied
            </>
          ) : (
            <>
              <Copy className="h-4 w-4" />
              Copy
            </>
          )}
        </Button>
      </div>
      <pre className="flex-1 overflow-auto bg-muted p-4 rounded-md text-xs font-mono leading-relaxed">
        <SyntaxHighlighter json={jsonStr} />
      </pre>
    </div>
  );
}

function SyntaxHighlighter({ json }: { json: string }) {
  const lines = json.split("\n");

  return (
    <code>
      {lines.map((line, i) => {
        const colored = line
          .replace(/"([^"]+)":/g, '<span class="text-purple-400">"$1"</span>:')
          .replace(/: "([^"]*)"/g, ': <span class="text-green-400">"$1"</span>')
          .replace(/: (\d+)/g, ': <span class="text-blue-400">$1</span>')
          .replace(
            /: (true|false|null)/g,
            ': <span class="text-orange-400">$1</span>',
          )
          .replace(/\{/g, '<span class="text-yellow-400">{"</span>')
          .replace(/\}/g, '<span class="text-yellow-400">}</span>')
          .replace(/\[/g, '<span class="text-yellow-400">["</span>')
          .replace(/\]/g, '<span class="text-yellow-400">]</span>');

        return (
          <span key={i} className="block">
            <span className="text-muted-foreground select-none w-8 inline-block text-right mr-4">
              {i + 1}
            </span>
            <span dangerouslySetInnerHTML={{ __html: colored }} />
          </span>
        );
      })}
    </code>
  );
}
