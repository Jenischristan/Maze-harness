/**
 * Central output-size budget for every tool result.
 *
 * Before this module each tool carried its own number (32 KiB in the executor,
 * 256 KiB in `fetch`, 2× the budget while buffering `bash`), so context
 * accounting and compaction thresholds could not rely on a single value and the
 * user saw different truncation behaviour depending on which tool produced the
 * text. Tools that need a different cap derive it from this constant so the
 * relationship stays explicit and testable.
 */

/** Default bytes of tool output handed to the model. */
export const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024;

/**
 * `fetch` keeps its own, larger budget: a web page is not a workspace file and
 * 32 KiB cuts most documentation pages in half. Still bounded and derived from
 * the default so raising the default raises this too.
 */
export const FETCH_MAX_BYTES = DEFAULT_MAX_OUTPUT_BYTES * 8;

/** Hard ceiling on bytes any single response body may contribute. */
export const FETCH_HARD_MAX_BYTES = 1024 * 1024;
