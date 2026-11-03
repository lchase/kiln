import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { TransformStep } from '../ir/types.js'

export type TransformInputs = Record<string, unknown>
export type TransformFn = (inputs: TransformInputs) => unknown

export async function resolveTransformFn(fn: string, cwd: string): Promise<TransformFn> {
  const modulePath = path.resolve(cwd, '.yak/transforms.ts')
  const mod: Record<string, unknown> = await import(pathToFileURL(modulePath).href)
  const impl = mod[fn]
  if (typeof impl !== 'function') {
    throw new Error(`transform "${fn}" not found in .yak/transforms.ts`)
  }
  return impl as TransformFn
}

export async function runTransformStep(
  step: TransformStep,
  inputs: TransformInputs,
  cwd: string,
): Promise<unknown> {
  const impl = await resolveTransformFn(step.fn, cwd)
  return impl(inputs)
}
