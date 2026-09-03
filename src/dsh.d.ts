/**
 * Ambient type surfaces for the two DeepSeek Harness packages this
 * plugin talks to. The plugin deliberately has ZERO runtime imports
 * from the host train: it receives `ctx` from apply() and calls the
 * registry methods through it, so no link-time dependency can ever
 * drift or mismatch. Shapes below mirror the published contracts of
 * @deepseek-ai/dsh-tools 0.1.x and @deepseek-ai/cordis 4.x and were
 * verified against their shipped .d.ts files.
 */

declare module '@deepseek-ai/cordis' {
  /** A lifecycle-owned side effect: return a disposer, cordis runs it on unload. */
  export type Effect = () => Promise<void> | void | (() => Promise<void> | void)

  export interface Context {
    /** Tool registry, provided by the dsh-tools package. */
    tools: import('@deepseek-ai/dsh-tools').ToolRuntime
    /** Register a side effect owned by this plugin fiber. */
    effect(execute: () => Effect, label?: string): Disposable | AsyncDisposable
    /** Subscribe to a service/event; returns an unsubscribe function when a subscription is returned. */
    on<T = unknown>(event: string, listener: (data: T, ...more: unknown[]) => void): () => void
    /** Simple logger compatible with console, when the host mounts one. */
    logger?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>
  }
}

declare module '@deepseek-ai/dsh-tools' {
  export type JsonSchemaNode = Record<string, unknown>

  /** Model-facing content block. Text blocks are the workhorse here. */
  export type ContentBlock = { type: 'text'; text: string } | { type: string; [key: string]: unknown }

  export interface ToolRunContext {
    signal: AbortSignal
    timeoutMs?: number
  }

  export interface ToolCallView {
    card: 'generic'
    title: string
    rawInput?: unknown
  }

  export interface ToolResultView {
    card: 'generic'
    title?: string
    content?: ContentBlock[]
  }

  export interface ToolDefinition {
    name: string
    description?: string
    /** Raw JSON Schema document, exactly as MCP servers deliver it. */
    parameters: JsonSchemaNode
    output: {
      /** `{}` accepts any JSON value; render projects it to content blocks. */
      schema: JsonSchemaNode
      render(args: unknown, value: unknown): ContentBlock[]
    }
    /** Returns the canonical (JSON-safe) tool result. Errors are thrown. */
    execute(args: unknown, exec: ToolRunContext): Promise<unknown>
    presentCall?(args: unknown): ToolCallView
    presentResult?(args: unknown, result: unknown): ToolResultView
    timeoutMs?: number
  }

  export interface ToolRuntime {
    /** Register a tool globally; returns the exact disposer for it. */
    register(definition: ToolDefinition): () => void
  }
}