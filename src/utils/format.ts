import { CHARACTER_LIMIT } from "../constants.js";

export type ResponseFormat = "markdown" | "json";

export interface Rendered {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Render a tool result for the model, bounded in size.
 *
 * Tool output lands directly in a context window, so an unbounded page dump can
 * crowd out everything else the agent was holding. Oversized output is cut and
 * says so, rather than being quietly shortened - a silently trimmed result
 * reads as complete and gets acted on as if it were.
 */
export function render(
  data: unknown,
  format: ResponseFormat,
  toMarkdown: (value: never) => string,
): Rendered {
  const text =
    format === "json"
      ? JSON.stringify(data, null, 2)
      : toMarkdown(data as never);

  return truncate(text);
}

export function truncate(text: string, limit = CHARACTER_LIMIT): Rendered {
  if (text.length <= limit) return { text, truncated: false };

  const notice =
    "\n\n[truncated: the response exceeded the size limit. Narrow the request " +
    "- fewer URLs, a lower page limit, or a more specific query.]";

  return { text: text.slice(0, limit - notice.length) + notice, truncated: true };
}

/** Escape a value for a markdown table cell. */
export function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
