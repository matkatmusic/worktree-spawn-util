// log-pruning — remove daemon log entries older than a retention period

import { readFileSync, writeFileSync, renameSync } from "node:fs";

export function pruneLogFile(logPath: string, maxAgeDays: number): void {
  let content: string;
  try {
    content = readFileSync(logPath, "utf-8");
  } catch {
    return; // File doesn't exist yet
  }

  const lines = content.split("\n");
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const kept: string[] = [];
  let currentHeaderTs: number | null = null;
  let inHeader = false;

  for (const line of lines) {
    // Session header start: === SESSION START [ISO] ===
    const headerMatch = line.match(
      /^=== SESSION START \[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\] ===$/,
    );
    if (headerMatch) {
      currentHeaderTs = new Date(headerMatch[1]).getTime();
      inHeader = true;
      if (currentHeaderTs >= cutoff) {
        kept.push(line);
      }
      continue;
    }

    // Session header end
    if (line === "========================") {
      inHeader = false;
      if (currentHeaderTs !== null && currentHeaderTs >= cutoff) {
        kept.push(line);
      }
      currentHeaderTs = null;
      continue;
    }

    // Inside header block — inherit header's timestamp
    if (inHeader) {
      if (currentHeaderTs !== null && currentHeaderTs >= cutoff) {
        kept.push(line);
      }
      continue;
    }

    // Regular log line — extract [ISO] prefix
    const logMatch = line.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/);
    if (logMatch) {
      const ts = new Date(logMatch[1]).getTime();
      if (ts >= cutoff) {
        kept.push(line);
      }
      continue;
    }

    // No timestamp — keep (conservative)
    kept.push(line);
  }

  // Atomic write: temp file + rename
  const tmpPath = logPath + ".tmp";
  try {
    writeFileSync(tmpPath, kept.join("\n"));
    renameSync(tmpPath, logPath);
  } catch {
    // Best effort — leave original intact
  }
}
