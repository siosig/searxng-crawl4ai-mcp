import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "specs/**", "ansible/**", "tmp/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    // The upstream boundary. Only src/upstream/ may speak HTTP to SearXNG or
    // Crawl4AI; everything else consumes the normalised types it returns.
    //
    // This is the rule that keeps an upstream contract change from rippling
    // through the whole codebase, so it is enforced rather than documented.
    files: ["src/**/*.ts"],
    ignores: ["src/upstream/**"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message:
            "Call upstream services through src/upstream/ instead. Direct fetch() outside that directory breaks the boundary that keeps upstream changes contained.",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "undici",
              message:
                "Call upstream services through src/upstream/ instead of reaching for an HTTP client here.",
            },
          ],
        },
      ],
    },
  },
);
