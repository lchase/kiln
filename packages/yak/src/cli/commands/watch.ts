import path from 'node:path'
import { render } from 'ink'
import React from 'react'
import { readJournal } from '../../engine/journal.js'
import { defaultRunsDir, findLatestRunId, readRunWorkflow } from '../../engine/run.js'
import { snapshotFromJournal, watchRun } from '../../engine/watch.js'
import { WatchApp } from '../watch-ui.js'

export interface WatchCommandOptions {
  runsDir?: string
}

export async function watchCommand(runId: string | undefined, opts: WatchCommandOptions = {}): Promise<number> {
  const runsDir = opts.runsDir ?? defaultRunsDir()
  const resolvedRunId = runId ?? (await findLatestRunId(runsDir))

  if (!resolvedRunId) {
    console.error('no runs found')
    return 1
  }

  const runDir = path.join(runsDir, resolvedRunId)
  const workflow = await readRunWorkflow(runDir).catch(() => undefined)
  if (!workflow) {
    console.error(`run ${resolvedRunId} not found`)
    return 1
  }

  const initialEvents = await readJournal(runDir)
  const instance = render(React.createElement(WatchApp, { snapshot: snapshotFromJournal(workflow, initialEvents) }))

  await watchRun(runDir, workflow, (snapshot) => {
    instance.rerender(React.createElement(WatchApp, { snapshot }))
  })

  instance.unmount()
  await instance.waitUntilExit()
  return 0
}
