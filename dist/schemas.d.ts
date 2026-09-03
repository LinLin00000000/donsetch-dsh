/**
 * Tool-name and presentation helpers shared by the registration code.
 * No deps.
 */
/**
 * MCP protocol tool names should already satisfy [A-Za-z0-9_-]{1,64},
 * but hostile or buggy servers are a reality: sanitize defensively and
 * reject names that cannot be expressed in the harness contract.
 */
export declare function sanitizeRawName(raw: unknown): string | null;
/** Final public (model-facing) tool name, or null when unsupported. */
export declare function publicToolName(prefix: string, raw: string): string | null;
/** Validate the user-configurable prefix: short, contract-shaped, safe. */
export declare function isValidPrefix(prefix: unknown): prefix is string;
/** Plain truncation, no ANSI, no ellipsis when it fits. */
export declare function truncate(text: string, max: number): string;
/** Host only: compact call label, e.g. "en.wikipedia.org" or '"query"'. */
export declare function callFocus(args: unknown): string;
/** Call-card title: "toolName · focus" or the bare tool name. */
export declare function callTitle(toolName: string, args: unknown): string;
/** First meaningful line of a text blob, for result titles. */
export declare function firstLine(text: string, max: number): string;
