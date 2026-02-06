"use client";

import { useState, useEffect, useMemo } from "react";
import { format } from "date-fns";
import type { NormalizedEvent, Provider } from "@/lib/types";
import type { ProviderStatus } from "@/lib/store";

interface Stats {
  rawTotal: number;
  matchedCount: number;
  unmatchedCount: number;
  storedTotal: number;
}

interface AdminData {
  events: NormalizedEvent[];
  count: number;
  providerStatus: Record<Provider, ProviderStatus>;
  providerCounts: { pslive: number; ninewickets: number };
  lastUpdate: string | null;
  stats: Stats;
}

type FilterType = "all" | "matched" | "unmatched";

const ITEMS_PER_PAGE = 20;

export default function AdminPage() {
  const [data, setData] = useState<AdminData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<FilterType>("all");

  const fetchData = async () => {
    try {
      const res = await fetch("/api/admin");
      if (!res.ok) throw new Error("Failed to fetch");
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch data");
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/admin", { method: "POST" });
      if (!res.ok) throw new Error("Failed to refresh");
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to refresh");
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000); // Poll every 10s
    return () => clearInterval(interval);
  }, []);

  // Filter events based on selection
  const filteredEvents = useMemo(() => {
    if (!data) return [];
    if (filter === "all") return data.events;
    if (filter === "matched") {
      return data.events.filter((e) => Object.keys(e.providers).length > 1);
    }
    return data.events.filter((e) => Object.keys(e.providers).length === 1);
  }, [data, filter]);

  // Reset page when filter changes
  useEffect(() => {
    setPage(1);
  }, [filter]);

  const totalPages = Math.ceil(filteredEvents.length / ITEMS_PER_PAGE);
  const paginatedEvents = filteredEvents.slice(
    (page - 1) * ITEMS_PER_PAGE,
    page * ITEMS_PER_PAGE
  );

  const formatLastFetch = (date: Date | string | null) => {
    if (!date) return "Never";
    const d = typeof date === "string" ? new Date(date) : date;
    const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    return format(d, "HH:mm:ss");
  };

  const getStatusColor = (status: string | undefined) => {
    if (status === "ok") return "bg-green-500";
    if (status === "error") return "bg-red-500";
    return "bg-yellow-500";
  };

  const getStatusTextColor = (status: string | undefined) => {
    if (status === "ok") return "text-green-600 dark:text-green-400";
    if (status === "error") return "text-red-600 dark:text-red-400";
    return "text-yellow-600 dark:text-yellow-400";
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100 dark:bg-gray-900 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 dark:border-white" />
      </div>
    );
  }

  const stats = data?.stats || {
    rawTotal: 0,
    matchedCount: 0,
    unmatchedCount: 0,
    storedTotal: 0,
  };

  return (
    <div className="min-h-screen bg-gray-100 dark:bg-gray-900 py-6">
      <div className="max-w-7xl mx-auto px-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            VenusEdge Admin
          </h1>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white rounded-lg font-medium transition-colors flex items-center gap-2"
          >
            {refreshing ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                Refreshing...
              </>
            ) : (
              "Refresh"
            )}
          </button>
        </div>

        {/* Stats Cards - 4 columns */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          {/* System Card */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
            <div className="flex items-center gap-2 mb-3">
              <span
                className={`w-3 h-3 rounded-full ${
                  data?.providerStatus?.pslive?.status === "ok" ||
                  data?.providerStatus?.ninewickets?.status === "ok"
                    ? "bg-green-500"
                    : "bg-yellow-500"
                }`}
              />
              <span className="font-semibold text-gray-900 dark:text-white">
                System
              </span>
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500 dark:text-gray-400">Status:</span>
                <span className="font-medium text-green-600 dark:text-green-400">
                  Online
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500 dark:text-gray-400">
                  Fetch Interval:
                </span>
                <span className="text-gray-700 dark:text-gray-300">5s</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500 dark:text-gray-400">
                  Providers:
                </span>
                <span className="text-gray-700 dark:text-gray-300">
                  2 active
                </span>
              </div>
            </div>
          </div>

          {/* PSLive Card */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
            <div className="flex items-center gap-2 mb-3">
              <span
                className={`w-3 h-3 rounded-full ${getStatusColor(
                  data?.providerStatus?.pslive?.status
                )}`}
              />
              <span className="font-semibold text-gray-900 dark:text-white">
                PSLive
              </span>
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500 dark:text-gray-400">Status:</span>
                <span
                  className={`font-medium ${getStatusTextColor(
                    data?.providerStatus?.pslive?.status
                  )}`}
                >
                  {data?.providerStatus?.pslive?.status?.toUpperCase() || "UNKNOWN"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500 dark:text-gray-400">
                  Last fetch:
                </span>
                <span className="text-gray-700 dark:text-gray-300">
                  {formatLastFetch(data?.providerStatus?.pslive?.lastFetch || null)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500 dark:text-gray-400">Events:</span>
                <span className="font-mono font-bold text-gray-900 dark:text-white">
                  {data?.providerCounts?.pslive?.toLocaleString() || 0}
                </span>
              </div>
            </div>
            {data?.providerStatus?.pslive?.error && (
              <div className="mt-2 text-xs text-red-600 dark:text-red-400 truncate">
                {data.providerStatus.pslive.error}
              </div>
            )}
          </div>

          {/* NineWickets Card */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
            <div className="flex items-center gap-2 mb-3">
              <span
                className={`w-3 h-3 rounded-full ${getStatusColor(
                  data?.providerStatus?.ninewickets?.status
                )}`}
              />
              <span className="font-semibold text-gray-900 dark:text-white">
                NineWickets
              </span>
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500 dark:text-gray-400">Status:</span>
                <span
                  className={`font-medium ${getStatusTextColor(
                    data?.providerStatus?.ninewickets?.status
                  )}`}
                >
                  {data?.providerStatus?.ninewickets?.status?.toUpperCase() ||
                    "UNKNOWN"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500 dark:text-gray-400">
                  Last fetch:
                </span>
                <span className="text-gray-700 dark:text-gray-300">
                  {formatLastFetch(
                    data?.providerStatus?.ninewickets?.lastFetch || null
                  )}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500 dark:text-gray-400">Events:</span>
                <span className="font-mono font-bold text-gray-900 dark:text-white">
                  {data?.providerCounts?.ninewickets?.toLocaleString() || 0}
                </span>
              </div>
            </div>
            {data?.providerStatus?.ninewickets?.error && (
              <div className="mt-2 text-xs text-red-600 dark:text-red-400 truncate">
                {data.providerStatus.ninewickets.error}
              </div>
            )}
          </div>

          {/* Matching Stats Card */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="font-semibold text-gray-900 dark:text-white">
                Matching
              </span>
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500 dark:text-gray-400">
                  Matched:
                </span>
                <span className="font-mono font-bold text-green-600 dark:text-green-400">
                  {stats.matchedCount.toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500 dark:text-gray-400">
                  Match Rate:
                </span>
                <span className="font-medium text-gray-700 dark:text-gray-300">
                  {stats.rawTotal > 0
                    ? `${Math.round(
                        (stats.matchedCount /
                          Math.min(
                            data?.providerCounts?.pslive || 1,
                            data?.providerCounts?.ninewickets || 1
                          )) *
                          100
                      )}%`
                    : "--"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500 dark:text-gray-400">
                  Unmatched:
                </span>
                <span className="font-mono text-gray-700 dark:text-gray-300">
                  {stats.unmatchedCount.toLocaleString()}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Pipeline Visualization */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4 mb-6">
          <h2 className="font-semibold text-gray-900 dark:text-white mb-4">
            Data Pipeline
          </h2>
          <div className="flex items-center justify-between gap-2 overflow-x-auto">
            {/* Raw Events */}
            <div className="flex-1 min-w-[100px]">
              <div className="bg-gray-100 dark:bg-gray-700 rounded-lg p-3 text-center">
                <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                  Raw Events
                </div>
                <div className="text-xl font-bold font-mono text-gray-900 dark:text-white">
                  {stats.rawTotal.toLocaleString()}
                </div>
              </div>
            </div>

            {/* Arrow */}
            <div className="text-gray-400 dark:text-gray-500 text-2xl px-2">
              →
            </div>

            {/* Matched */}
            <div className="flex-1 min-w-[100px]">
              <div className="bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 rounded-lg p-3 text-center">
                <div className="text-xs text-green-600 dark:text-green-400 mb-1">
                  Matched
                </div>
                <div className="text-xl font-bold font-mono text-green-600 dark:text-green-400">
                  {stats.matchedCount.toLocaleString()}
                </div>
              </div>
            </div>

            {/* Arrow */}
            <div className="text-gray-400 dark:text-gray-500 text-2xl px-2">
              →
            </div>

            {/* Stored */}
            <div className="flex-1 min-w-[100px]">
              <div className="bg-gray-100 dark:bg-gray-700 rounded-lg p-3 text-center">
                <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                  Stored
                </div>
                <div className="text-xl font-bold font-mono text-gray-900 dark:text-white">
                  {stats.storedTotal.toLocaleString()}
                </div>
              </div>
            </div>

            {/* Arrow */}
            <div className="text-gray-400 dark:text-gray-500 text-2xl px-2">
              →
            </div>

            {/* Arbitrages */}
            <div className="flex-1 min-w-[100px]">
              <div className="bg-gray-100 dark:bg-gray-700 rounded-lg p-3 text-center opacity-50">
                <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                  Arbitrages
                </div>
                <div className="text-xl font-bold font-mono text-gray-500 dark:text-gray-400">
                  --
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Error Display */}
        {error && (
          <div className="mb-6 p-3 bg-red-100 dark:bg-red-900/30 border border-red-300 dark:border-red-700 rounded-lg text-red-700 dark:text-red-300 text-sm">
            {error}
          </div>
        )}

        {/* Events Table */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
          {/* Table Header with Filters */}
          <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <h2 className="font-semibold text-gray-900 dark:text-white">
              Events
            </h2>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setFilter("all")}
                className={`px-3 py-1 text-sm rounded-full transition-colors ${
                  filter === "all"
                    ? "bg-blue-600 text-white"
                    : "bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
                }`}
              >
                All ({data?.count || 0})
              </button>
              <button
                onClick={() => setFilter("matched")}
                className={`px-3 py-1 text-sm rounded-full transition-colors ${
                  filter === "matched"
                    ? "bg-green-600 text-white"
                    : "bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
                }`}
              >
                Matched ({stats.matchedCount})
              </button>
              <button
                onClick={() => setFilter("unmatched")}
                className={`px-3 py-1 text-sm rounded-full transition-colors ${
                  filter === "unmatched"
                    ? "bg-gray-600 text-white"
                    : "bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
                }`}
              >
                Unmatched ({stats.unmatchedCount})
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 dark:bg-gray-700">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                    Providers
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                    Home Team
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                    Away Team
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                    Competition
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                    Start Time
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {paginatedEvents.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-4 py-8 text-center text-gray-500 dark:text-gray-400"
                    >
                      No events found
                    </td>
                  </tr>
                ) : (
                  paginatedEvents.map((event) => {
                    const providers = Object.keys(event.providers) as Provider[];
                    const isMatched = providers.length > 1;
                    return (
                      <tr
                        key={event.id}
                        className={`hover:bg-gray-50 dark:hover:bg-gray-700/50 ${
                          isMatched
                            ? "bg-green-50/50 dark:bg-green-900/10"
                            : ""
                        }`}
                      >
                        <td className="px-4 py-3">
                          <div className="flex gap-1">
                            {providers.map((p) => (
                              <span
                                key={p}
                                className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                                  p === "pslive"
                                    ? "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300"
                                    : "bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-300"
                                }`}
                              >
                                {p === "pslive" ? "PL" : "9W"}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-900 dark:text-white">
                          {event.homeTeam}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-900 dark:text-white">
                          {event.awayTeam}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">
                          {event.competition}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">
                          {format(new Date(event.startTime), "MMM d, HH:mm")}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1 text-sm bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed rounded transition-colors text-gray-700 dark:text-gray-300"
              >
                Prev
              </button>
              <span className="text-sm text-gray-600 dark:text-gray-400">
                Page {page} of {totalPages} ({filteredEvents.length} events)
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="px-3 py-1 text-sm bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed rounded transition-colors text-gray-700 dark:text-gray-300"
              >
                Next
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
