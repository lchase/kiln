export interface AgentAdapterRequest {
  prompt: string
  systemPrompt?: string
  tools: string[]
  cwd: string
  model?: string
  schema?: unknown                     // JSON Schema
  sessionId?: string                   // resume a prior session
  signal: AbortSignal
}

export interface AgentAdapterResponse {
  output: unknown                      // parsed if schema given, else string
  sessionId: string
  tokens: { input: number; output: number }
  filesChanged: string[]
  stopReason: 'complete' | 'max_turns' | 'error' | 'aborted'
}

export interface AgentAdapter {
  id: string
  run(req: AgentAdapterRequest): Promise<AgentAdapterResponse>
}
