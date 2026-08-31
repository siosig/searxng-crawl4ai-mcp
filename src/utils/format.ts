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

/**
 * `gathered` is how many items were collected before the text was cut.
 *
 * Optional, and absent for every caller that has nothing to say here. Where it
 * applies - a search that paged until it had the requested count - the two
 * numbers answer different questions: how much was found, and how much fitted.
 * Without the first, a caller reading a cut list has no way to tell a thin
 * result set from a long one that ran into the size limit, and would narrow a
 * query that was already working (FR-032).
 */
export function truncate(
  text: string,
  limit = CHARACTER_LIMIT,
  gathered?: number,
): Rendered {
  if (text.length <= limit) return { text, truncated: false };

  const found =
    gathered === undefined
      ? ""
      : ` ${gathered} results were gathered; the text above stops part way through them.`;

  const notice =
    `\n\n[truncated: the response exceeded the size limit.${found} Narrow the request ` +
    "- fewer URLs, a lower page limit, or a more specific query.]";

  return { text: text.slice(0, limit - notice.length) + notice, truncated: true };
}

/** Escape a value for a markdown table cell. */
export function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
