import { expect, test } from 'claude-code/testing'

import { attivitaFinite, cacheRimasta, durata } from './register'

const notifica = (id: string, stato: string) =>
  `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_01</tool-use-id>\n<output-file>C:\\tmp\\${id}.output</output-file>\n<status>${stato}</status>\n<summary>Background command "sleep 30" ${stato}</summary>\n</task-notification>`

test('le notifiche di fine liberano le shell, quelle ancora in corso no', () => {
  expect(attivitaFinite(notifica('b1', 'completed'))).toEqual(['b1'])
  expect(attivitaFinite(`${notifica('b2', 'killed')}\n${notifica('b3', 'running')}\n${notifica('b4', 'failed')}`)).toEqual(['b2', 'b4'])
  expect(attivitaFinite('ricordami di guardare <status>completed</status>')).toEqual([])
})

test("un evento di monitor senza <status> non prende l'esito della notifica dopo", () => {
  const evento = '<task-notification>\n<task-id>m1</task-id>\n<event>riga</event>\n</task-notification>'
  expect(attivitaFinite(`${evento}\n${notifica('b5', 'completed')}`)).toEqual(['b5'])
})

test('i minuti di cache rimasti, per eccesso, poi scaduta', () => {
  const minuto = 60_000
  expect(cacheRimasta(null, 0)).toBe(null)
  expect(cacheRimasta(0, 11 * minuto)).toBe('49m')
  expect(cacheRimasta(0, 59 * minuto + 1)).toBe('1m')
  expect(cacheRimasta(0, 60 * minuto)).toBe('scaduta')
})

test('da quanto i job sono al lavoro, per difetto, con le ore oltre i 60 minuti', () => {
  const minuto = 60_000
  expect(durata(0, 59_999)).toBe('0m')
  expect(durata(0, 27 * minuto + 30_000)).toBe('27m')
  expect(durata(0, 65 * minuto)).toBe('1h05m')
})
