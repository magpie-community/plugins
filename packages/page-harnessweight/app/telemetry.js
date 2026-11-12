// Present only observed facts; missing records do not prove a hook is installed or absent.
export function taskSource(agent) {
  const timing = agent.taskDuration
  const sources = timing?.metricSource ? [timing.metricSource] : timing?.sources || []
  if (sources.length > 1) return 'mixed'
  if (sources[0] === 'codex-rollout' || (!sources.length && agent.agent === 'codex')) return 'codex'
  if (sources[0] === 'cursor-hooks' || (!sources.length && agent.agent === 'cursor')) return 'cursor'
  if (sources[0] === 'task-events-v1') return 'event'
  return 'unknown'
}
export function taskEmptyKey(agent) {
  const timing = agent.taskDuration
  if (!timing) return 'task.unavailable'
  if (timing.reason === 'read-error') return 'task.readError'
  if (timing.reason === 'mixed-sources') return 'task.mixedSources'
  if (timing.coverage === 'observed') return 'task.noCompleted'
  if (agent.agent === 'codex') return 'task.codexNoData'
  if (agent.agent === 'cursor') return 'task.cursorNoData'
  return 'task.protocolNoData'
}
// Group by source before sorting durations, so unlike boundaries are not ranked together.
export function compareTaskSources(a, b) {
  return taskSource(a).localeCompare(taskSource(b), 'en')
}
