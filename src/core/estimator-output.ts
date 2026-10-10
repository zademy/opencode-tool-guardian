import type { OutputStats } from "./models.js";

/**
 * Local size estimate of an observed tool output.
 *
 * Token counts are a local heuristic (~4 characters per token), never a billed figure.
 * The plugin does not truncate anything: Context Mode owns output compaction.
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** Flattens the documented result shape (output plus content parts) into text for sizing only. */
export function measureResult(result: unknown): { chars: number; bytes: number; lines: number } {
  let text = "";
  if (typeof result === "string") {
    text = result;
  } else if (typeof result === "object" && result !== null) {
    const record = result as Record<string, unknown>;
    const output = record.output;
    if (typeof output === "string") text += output;
    const content = record.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === "string") text += part;
        else if (part !== null && typeof part === "object") {
          const value = (part as Record<string, unknown>).text;
          if (typeof value === "string") text += value;
        }
      }
    }
    if (text.length === 0 && output !== undefined && output !== null) {
      try {
        text = JSON.stringify(output) ?? "";
      } catch {
        text = "";
      }
    }
  }
  if (text.length === 0) return { chars: 0, bytes: 0, lines: 0 };
  return { chars: text.length, bytes: Buffer.byteLength(text, "utf8"), lines: countLines(text) };
}

/** A trailing newline closes the last line instead of opening a new one. */
function countLines(text: string): number {
  let lines = 0;
  for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") lines += 1;
  return lines > 0 && !text.endsWith("\n") ? lines + 1 : lines;
}

export function recordOutput(stats: OutputStats, result: unknown, largeOutputLines: number): boolean {
  const size = measureResult(result);
  if (size.chars === 0) return false;
  stats.outputs += 1;
  stats.totalChars += size.chars;
  stats.totalBytes += size.bytes;
  stats.totalLines += size.lines;
  if (size.chars > stats.largestChars) stats.largestChars = size.chars;
  if (size.lines > largeOutputLines) {
    stats.largeOutputs += 1;
    return true;
  }
  return false;
}
