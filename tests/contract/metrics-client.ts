/** Read the metrics endpoint from inside the compose network. */
export async function fetchMetrics(): Promise<string> {
  const url = process.env.METRICS_URL ?? "http://127.0.0.1:9464/metrics";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`metrics endpoint answered ${res.status}`);
  return res.text();
}

/** Every `mcp_`-prefixed sample line, which is one time series each. */
export function mcpSeries(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("mcp_") && !line.startsWith("#"))
    .map((line) => line.slice(0, line.lastIndexOf(" ")));
}

export function sampleValue(text: string, prefix: string): number | null {
  const line = text.split("\n").find((l) => l.startsWith(prefix));
  if (!line) return null;
  return Number(line.slice(line.lastIndexOf(" ") + 1));
}
