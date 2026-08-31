import type { McpServer } from "@modelcontextprotocol/server";
import { JobStatusInput } from "../schemas/tools.js";
import { getJobStatus } from "../upstream/crawl4ai.js";
import { ANNOTATIONS, documentsMarkdown, guarded, reply } from "./shared.js";

export function registerJobStatusTool(server: McpServer): void {
  server.registerTool(
    "web_job_status",
    {
      title: "Check a background crawl",
      description:
        "Look up a crawl that was submitted for background processing, using the id it returned. " +
        "Reports whether it is still running, finished, or failed, and returns the pages once it is done. " +
        "Safe to call repeatedly; the same id always reports the same state.",
      inputSchema: JobStatusInput,
      annotations: ANNOTATIONS,
    },
    async (params) =>
      guarded("web_job_status", params.format, async () => {
        const job = await getJobStatus(params.jobId);

        const headline =
          job.state === "running"
            ? `Crawl ${job.jobId} is still running.`
            : job.state === "failed"
              ? `Crawl ${job.jobId} failed: ${job.failure?.message ?? "no reason given"}`
              : `Crawl ${job.jobId} finished with ${job.documents?.length ?? 0} pages.`;

        const body = job.documents ? `\n\n${documentsMarkdown(job.documents)}` : "";
        return reply(headline + body, { ...job }, params.format);
      }),
  );
}
