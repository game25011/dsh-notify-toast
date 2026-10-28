import assert from 'node:assert/strict'
import test from 'node:test'

import { createGoalSummaryTracker } from '../lib/goal-summary.js'

function clock() {
  let now = 1000
  const timers = []
  return {
    now: () => now,
    setTimer(callback, ms) {
      const timer = { at: now + Math.max(0, Number(ms) || 0), callback, cancelled: false }
      timers.push(timer)
      return timer
    },
    clearTimer(timer) {
      if (timer) timer.cancelled = true
    },
    runNext() {
      const timer = timers.shift()
      if (!timer || timer.cancelled) return false
      now = Math.max(now, timer.at)
      timer.callback()
      return true
    },
    runAll() {
      while (timers.length) {
        if (!this.runNext()) continue
      }
    },
  }
}

function create(options = {}) {
  const c = clock()
  const summaries = []
  const state = { enabled: options.enabled !== false }
  const tracker = createGoalSummaryTracker({
    enabled: () => state.enabled,
    getIntervalMs: () => 2500,
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    onSummary: (payload) => summaries.push(payload),
  })
  return {
    c,
    summaries,
    tracker,
    setEnabled(value) {
      state.enabled = value !== false
    },
  }
}

function createGoal(tracker, sessionId = 's1', rounds = 0, revision = 1) {
  tracker.onGoalChange(sessionId, {
    kind: 'goal/change',
    operation: 'create',
    goal: { id: 'goal-1', revision, phase: 'active' },
    roundsStarted: rounds,
  })
}

function complete(tracker, operation = 'complete', phase = 'complete', rounds, revision = 2, sessionId = 's1') {
  tracker.onGoalChange(sessionId, {
    kind: 'goal/change',
    operation,
    goal: { id: 'goal-1', revision, phase },
    roundsStarted: rounds,
  })
}

test('goal mode suppresses per-turn completions and emits one aggregate summary', () => {
  const { c, summaries, tracker } = create()
  createGoal(tracker)
  assert.equal(tracker.onTurnEnd('s1', { text: 'step 1', turnKey: '1' }), true)
  assert.equal(tracker.onTurnEnd('s1', { text: 'step 2', turnKey: '2' }), true)
  assert.equal(tracker.onTurnEnd('s1', { text: 'step 3', turnKey: '3' }), true)
  assert.equal(summaries.length, 0, 'no notification while the goal is active')
  complete(tracker, 'complete', 'complete', 3)
  c.runAll()
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].kind, 'complete')
  assert.equal(summaries[0].count, 3)
  assert.equal(summaries[0].goalOutcome, 'complete')
  assert.equal(summaries[0].text, 'step 3')
  assert.equal(summaries[0].allDone, false)
})

test('a terminal event inside a turn waits for that turn to finish before summarizing', () => {
  const { c, summaries, tracker } = create()
  createGoal(tracker)
  tracker.onTurnStart('s1')
  tracker.onTurnEnd('s1', { text: 'previous round', turnKey: '1' })
  tracker.onTurnStart('s1')
  complete(tracker, 'complete', 'complete', 2)
  c.runAll()
  assert.equal(summaries.length, 0, 'must not publish before the final turn ends')
  assert.equal(tracker.onTurnEnd('s1', { text: 'final wrap-up', turnKey: '2' }), true)
  c.runAll()
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].text, 'final wrap-up')
  assert.equal(tracker.onTurnEnd('s1', { text: 'final duplicate', turnKey: '2' }), true)
  assert.equal(tracker.onTurnEnd('s1', { text: 'ordinary next turn', turnKey: '3' }), false)
  c.runAll()
  assert.equal(summaries.length, 1)
})

test('paused and blocked goals use neutral outcomes', () => {
  const paused = create()
  createGoal(paused.tracker)
  paused.tracker.onTurnEnd('s1', { text: 'paused work', turnKey: '1' })
  complete(paused.tracker, 'pause', 'paused', 1)
  paused.c.runAll()
  assert.equal(paused.summaries[0].goalOutcome, 'paused')

  const blocked = create()
  createGoal(blocked.tracker)
  blocked.tracker.onTurnEnd('s1', { text: 'blocked work', turnKey: '1' })
  complete(blocked.tracker, 'block', 'blocked', 1)
  blocked.c.runAll()
  assert.equal(blocked.summaries[0].goalOutcome, 'blocked')
})

test('an active goal disarmed by session resume flushes once', () => {
  const { c, summaries, tracker } = create()
  createGoal(tracker)
  tracker.onTurnEnd('s1', { text: 'partial', turnKey: '1' })
  tracker.onGoalRound('s1', { kind: 'goal', goalId: 'goal-1', revision: 1, round: 1 })
  tracker.onActivation({ sessionId: 's1', goal: { id: 'goal-1', revision: 1, activation: 'disarmed' } })
  c.runAll()
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].goalOutcome, 'paused')
})

test('clear does not emit a summary and resets the run', () => {
  const { c, summaries, tracker } = create()
  createGoal(tracker)
  tracker.onTurnEnd('s1', { text: 'discarded', turnKey: '1' })
  tracker.onGoalChange('s1', {
    kind: 'goal/change',
    operation: 'clear',
    cleared: { id: 'goal-1', revision: 3 },
    clearedAt: 1001,
  })
  c.runAll()
  assert.equal(summaries.length, 0)
})

test('zero authoritative rounds do not invent a step from a buffered turn', () => {
  const { c, summaries, tracker } = create()
  createGoal(tracker)
  tracker.onTurnEnd('s1', { text: 'work', turnKey: '1' })
  complete(tracker, 'complete', 'complete', 0)
  c.runAll()
  assert.equal(summaries.length, 0)
})

test('resume starts a new run segment with a fresh baseline', () => {
  const { c, summaries, tracker } = create()
  createGoal(tracker, 's1', 0)
  tracker.onTurnEnd('s1', { text: 'first run', turnKey: '1' })
  complete(tracker, 'pause', 'paused', 2)
  c.runAll()
  assert.equal(summaries[0].count, 2)
  tracker.onGoalChange('s1', {
    kind: 'goal/change',
    operation: 'resume',
    goal: { id: 'goal-1', revision: 3, phase: 'active' },
    roundsStarted: 2,
  })
  tracker.onTurnEnd('s1', { text: 'second run', turnKey: '2' })
  complete(tracker, 'complete', 'complete', 5, 4)
  c.runAll()
  assert.equal(summaries.length, 2)
  assert.equal(summaries[1].count, 3)
  assert.equal(summaries[1].text, 'second run')
})

test('quick pause then resume finalizes the old segment before starting the new one', () => {
  const { c, summaries, tracker } = create()
  createGoal(tracker)
  tracker.onTurnEnd('s1', { text: 'first segment', turnKey: '1' })
  complete(tracker, 'pause', 'paused', 1)
  assert.equal(summaries.length, 0, 'pause is still inside its settle window')
  tracker.onGoalChange('s1', {
    kind: 'goal/change',
    operation: 'resume',
    goal: { id: 'goal-1', revision: 3, phase: 'active' },
    roundsStarted: 1,
  })
  assert.equal(summaries.length, 1, 'old segment is finalized on resume')
  assert.equal(summaries[0].count, 1)
  assert.equal(summaries[0].text, 'first segment')
  tracker.onTurnEnd('s1', { text: 'second segment', turnKey: '2' })
  complete(tracker, 'complete', 'complete', 2, 4)
  c.runAll()
  assert.equal(summaries.length, 2)
  assert.equal(summaries[1].count, 1)
  assert.equal(summaries[1].text, 'second segment')
})

test('a duplicate terminal event never emits a second summary', () => {
  const { c, summaries, tracker } = create()
  createGoal(tracker)
  tracker.onTurnEnd('s1', { text: 'work', turnKey: '1' })
  complete(tracker, 'complete', 'complete', 1)
  complete(tracker, 'complete', 'complete', 1, 3)
  c.runAll()
  assert.equal(summaries.length, 1)
})

test('only the exact already-accounted turn is suppressed after flush', () => {
  const { c, summaries, tracker } = create()
  createGoal(tracker)
  tracker.onTurnEnd('s1', { text: 'work', turnKey: '7' })
  complete(tracker, 'complete', 'complete', 1)
  c.runAll()
  assert.equal(summaries.length, 1)
  assert.equal(tracker.onTurnEnd('s1', { text: 'same event duplicate', turnKey: '7' }), true)
  assert.equal(tracker.onTurnEnd('s1', { text: 'ordinary next turn', turnKey: '8' }), false)
  c.runAll()
  assert.equal(summaries.length, 1)
})

test('disabled delivery does not suppress ordinary turns and does not replay after re-enable', () => {
  const { c, summaries, tracker, setEnabled } = create({ enabled: false })
  createGoal(tracker)
  assert.equal(tracker.onTurnEnd('s1', { text: 'normal', turnKey: '1' }), false)
  complete(tracker, 'complete', 'complete', 1)
  c.runAll()
  assert.equal(summaries.length, 0)
  setEnabled(true)
  assert.equal(tracker.onTurnEnd('s1', { text: 'late ordinary', turnKey: '2' }), false)
  c.runAll()
  assert.equal(summaries.length, 0)
})

test('re-enabling during a goal starts accounting at the first newly enabled round', () => {
  const { c, summaries, tracker, setEnabled } = create({ enabled: false })
  createGoal(tracker)
  assert.equal(tracker.onTurnEnd('s1', { text: 'before enable', turnKey: '1' }), false)
  setEnabled(true)
  tracker.onGoalRound('s1', { kind: 'goal', goalId: 'goal-1', revision: 1, round: 2 })
  assert.equal(tracker.onTurnEnd('s1', { text: 'after enable', turnKey: '2' }), true)
  complete(tracker, 'complete', 'complete', 2)
  c.runAll()
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].count, 1)
})

test('stale goal transitions are ignored', () => {
  const { c, summaries, tracker } = create()
  createGoal(tracker, 's1', 0, 1)
  complete(tracker, 'complete', 'complete', 2, 3)
  // A stale complete for an older revision must not schedule another summary.
  complete(tracker, 'complete', 'complete', 2, 2)
  c.runAll()
  assert.equal(summaries.length, 1)
})
