import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'

export async function loadWorkflowYaml(filePath: string): Promise<unknown> {
  const contents = await readFile(filePath, 'utf8')
  return parse(contents)
}
