import { expect, test } from 'claude-code/testing'

import { EMPTY, planSteps, startJob } from './clean-view'

const list = planSteps(startJob(EMPTY, 0), ['First step', 'Second step', 'Third step'], 0)
const state: Record<string, unknown> = { cleanViewEnabled: true, checklist: list, tick: 0 }

const band = (maxRows: number) =>
  ({
    plugin: 'clean-view',
    component: 'AbovePrompt',
    surface: 'terminal',
    props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows, bodyColumns: 80, scroll: { offset: 0, bodyRows: maxRows - 1 }, view: {} },
  }) as const

test('the band has no frame, and with little room keeps title, progress and the active step', async ($, on) => {
  on('state.get', (_, e) => ({ value: { value: state[e.key], version: 1 } }))
  on('clock.now', () => ({ value: 60_000 }))

  // header, summary and three steps fill five rows exactly: no frame, every step shown
  const roomy = await $.ui.mount(band(5))
  expect(JSON.stringify(await roomy.drawn())).not.toContain('borderStyle')
  expect(await roomy.find({ type: 'Text', text: /Third step/ })).toBeDefined()
  await roomy.unmount()

  // five agents under the prompt leave the band two rows, as in the screenshot
  const tight = await $.ui.mount(band(3))
  expect(JSON.stringify(await tight.drawn())).not.toContain('borderStyle')
  expect(await tight.find({ type: 'Text', text: /Step 1 of 3/ })).toBeDefined()
  expect(await tight.find({ type: 'Text', text: /First step/ })).toBeDefined()
  expect(await tight.find({ type: 'Text', text: /Third step/ })).toBeUndefined()
  await tight.unmount()
})
