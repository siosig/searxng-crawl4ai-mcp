import * as z from "zod/v4";

/**
 * Tool inputs.
 *
 * Every schema is `.strict()`: a model that invents an argument should be told
 * so, not silently ignored. A quietly dropped argument produces a result that
 * looks right and answers a different question.
 */

export const FormatSchema = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("Response shape: readable markdown, or json for machine use.");

export const SearchInput = z
  .object({
    query: z.string().min(1).max(512).describe("What to search for."),
    limit: z.coerce.number().int().min(1).max(50).default(10)
      .describe("Maximum number of hits to return."),
    language: z.string().max(16).default("auto")
      .describe('Language code such as "ja" or "en". "auto" leaves it to the engines.'),
    categories: z.array(z.string().max(32)).max(8).default(["general"])
      .describe('SearXNG categories, e.g. ["general"], ["news"], ["it"].'),
    format: FormatSchema,
  })
  .strict();

export const ScrapeInput = z
  .object({
    url: z.url().describe("Page to fetch."),
    format: FormatSchema,
  })
  .strict();

export const SearchAndScrapeInput = z
  .object({
    query: z.string().min(1).max(512).describe("What to search for."),
    topN: z.coerce.number().int().min(1).max(10).default(3)
      .describe("How many of the top hits to fetch in full."),
    language: z.string().max(16).default("auto").describe("Language code, or auto."),
    format: FormatSchema,
  })
  .strict();

export const BatchScrapeInput = z
  .object({
    urls: z.array(z.url()).min(1).max(20).describe("Pages to fetch."),
    format: FormatSchema,
  })
  .strict();

export const CrawlInput = z
  .object({
    url: z.url().describe("Where the crawl starts."),
    maxDepth: z.coerce.number().int().min(1).max(5).default(2)
      .describe("How many link hops away from the start page to follow."),
    maxPages: z.coerce.number().int().min(1).max(100).default(20)
      .describe("Hard cap on pages fetched. The crawl stops here even if more remain."),
    sameHostOnly: z.boolean().default(true)
      .describe("Stay on the starting host. Turning this off can wander far."),
    format: FormatSchema,
  })
  .strict();

export const MapInput = z
  .object({
    url: z.url().describe("Page whose links should be listed."),
    limit: z.coerce.number().int().min(1).max(500).default(100)
      .describe("Maximum number of URLs to return."),
    includeExternal: z.boolean().default(false)
      .describe("Include links pointing off the starting host."),
    format: FormatSchema,
  })
  .strict();

export const ExtractInput = z
  .object({
    url: z.url().describe("Page to extract from."),
    instruction: z.string().min(1).max(2000)
      .describe("What to pull out, in plain language."),
    format: FormatSchema,
  })
  .strict();

export const JobStatusInput = z
  .object({
    jobId: z.string().min(1).max(128).describe("Identifier returned by web_crawl."),
    format: FormatSchema,
  })
  .strict();

export type Format = z.infer<typeof FormatSchema>;
