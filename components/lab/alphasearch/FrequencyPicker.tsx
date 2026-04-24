"use client";

/**
 * Discriminated-union frequency picker (no free-form cron in v1).
 *
 * Three "kinds" — every N hours, daily at HH:00, weekly on day at HH:00.
 * Renders a live human-readable preview ("Daily at 03:00 (Asia/Dhaka)")
 * so non-technical operators see exactly what they configured.
 */

import * as React from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  describeFrequency,
  type Frequency,
} from "@/lib/optimizer/schedule-types";

const HOUR_OPTIONS = [1, 2, 4, 6, 12] as const;
const DAYS_OF_WEEK = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export interface FrequencyPickerProps {
  value: Frequency;
  onChange: (next: Frequency) => void;
  timezone: string;
}

export function FrequencyPicker({
  value,
  onChange,
  timezone,
}: FrequencyPickerProps) {
  const setKind = (kind: Frequency["kind"]) => {
    if (kind === "every_n_hours") onChange({ kind, hours: 4 });
    else if (kind === "daily") onChange({ kind, hourLocal: 3 });
    else onChange({ kind: "weekly", dayOfWeek: 0, hourLocal: 3 });
  };

  return (
    <div className="space-y-2">
      {/* Kind picker */}
      <div className="grid grid-cols-3 gap-2">
        {(["every_n_hours", "daily", "weekly"] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={`text-[11px] py-1.5 rounded-md border transition-colors ${
              value.kind === k
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border bg-muted/30 text-muted-foreground hover:bg-muted/50"
            }`}
          >
            {k === "every_n_hours"
              ? "Every N hours"
              : k === "daily"
                ? "Daily"
                : "Weekly"}
          </button>
        ))}
      </div>

      {/* Per-kind controls */}
      {value.kind === "every_n_hours" && (
        <Select
          value={String(value.hours)}
          onValueChange={(v) =>
            onChange({
              kind: "every_n_hours",
              hours: Number(v) as 1 | 2 | 4 | 6 | 12,
            })
          }
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {HOUR_OPTIONS.map((h) => (
              <SelectItem key={h} value={String(h)} className="text-xs">
                Every {h} hour{h === 1 ? "" : "s"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {value.kind === "daily" && (
        <HourPicker
          hourLocal={value.hourLocal}
          onChange={(h) => onChange({ kind: "daily", hourLocal: h })}
        />
      )}

      {value.kind === "weekly" && (
        <div className="grid grid-cols-2 gap-2">
          <Select
            value={String(value.dayOfWeek)}
            onValueChange={(v) => onChange({ ...value, dayOfWeek: Number(v) })}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DAYS_OF_WEEK.map((d, i) => (
                <SelectItem key={i} value={String(i)} className="text-xs">
                  {d}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <HourPicker
            hourLocal={value.hourLocal}
            onChange={(h) => onChange({ ...value, hourLocal: h })}
          />
        </div>
      )}

      {/* Live preview */}
      <p className="text-[11px] text-muted-foreground italic">
        → {describeFrequency(value, timezone)}
      </p>
    </div>
  );
}

function HourPicker({
  hourLocal,
  onChange,
}: {
  hourLocal: number;
  onChange: (h: number) => void;
}) {
  return (
    <Select
      value={String(hourLocal)}
      onValueChange={(v) => onChange(Number(v))}
    >
      <SelectTrigger className="h-8 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Array.from({ length: 24 }, (_, h) => (
          <SelectItem key={h} value={String(h)} className="text-xs">
            {String(h).padStart(2, "0")}:00
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
