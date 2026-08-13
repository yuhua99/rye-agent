import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

export const API_TIMEOUT_MS = 5000;

export function home(): string {
  return homedir();
}

export function readJson(path: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const data = JSON.parse(readFileSync(path, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data)
      ? data
      : undefined;
  } catch {
    return undefined;
  }
}

export function readAuth(): Record<string, unknown> {
  return readJson(`${home()}/.pi/agent/auth.json`) ?? {};
}

export function formatReset(date: Date): string {
  const diffMs = date.getTime() - Date.now();
  if (diffMs < 0) return "now";

  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return `${diffMins}m`;

  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  if (hours < 24) return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;

  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d${remHours}h` : `${days}d`;
}

export function createTimeoutController(timeoutMs: number): {
  controller: AbortController;
  clear: () => void;
} {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, clear: () => clearTimeout(timeoutId) };
}

export function parseRetryAfter(res: Response): number | undefined {
  const header = res.headers.get("retry-after");
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;

  const date = new Date(header);
  if (!Number.isNaN(date.getTime())) {
    const ms = date.getTime() - Date.now();
    return ms > 0 ? ms : undefined;
  }
  return undefined;
}

export function toPercent(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  const percent = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, percent));
}

export function errorMessage(
  error: unknown,
  fallback = "Fetch failed",
): string {
  if (error instanceof Error && error.name === "AbortError") return "Timed out";
  return error instanceof Error ? error.message : fallback;
}

export function keychainPassword(service: string): string | undefined {
  try {
    return execFileSync(
      "security",
      ["find-generic-password", "-s", service, "-w"],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
  } catch {
    return undefined;
  }
}
