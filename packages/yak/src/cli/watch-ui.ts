import { Box, Text } from 'ink'
import React from 'react'
import { formatLoopBudget } from '../engine/status.js'
import type { WatchSnapshot } from '../engine/watch.js'

const h = React.createElement

/** No JSX — this repo builds `.ts` only, and a single small component isn't
 * worth a `.tsx`/jsx-tsconfig detour. `React.createElement` directly. */
export function WatchApp({ snapshot }: { snapshot: WatchSnapshot }) {
  const openGates = new Set(snapshot.openGateIds)

  const stepRows = snapshot.stepStatuses.map((s) =>
    h(
      Text,
      { key: s.stepId, color: openGates.has(s.stepId) ? 'yellow' : undefined },
      `${s.stepId}: ${s.status}${openGates.has(s.stepId) ? ' — awaiting yak resume' : ''}`,
    ),
  )

  const loopRows = snapshot.loopStatuses.map((l) =>
    h(Text, { key: `loop-${l.stepId}`, dimColor: true }, `  ${l.stepId}: ${formatLoopBudget(l)}`),
  )

  const footer =
    snapshot.runStatus !== undefined
      ? [h(Text, { key: 'footer', bold: true }, `run ${snapshot.runStatus}`)]
      : []

  return h(Box, { flexDirection: 'column' }, ...stepRows, ...loopRows, ...footer)
}
