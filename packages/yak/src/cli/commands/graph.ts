import { renderMermaid } from '../../ir/graph.js'
import { loadWorkflowYaml } from '../../ir/load.js'
import { normalizeWorkflow } from '../../ir/normalize.js'

/** Deliberately skips `validateWorkflow` — graphing an invalid workflow to
 * see *why* it's invalid is the point, not a load-time-checked feature. */
export async function graphCommand(workflowPath: string): Promise<number> {
  const raw = await loadWorkflowYaml(workflowPath)
  const workflow = normalizeWorkflow(raw)
  console.log(renderMermaid(workflow))
  return 0
}
