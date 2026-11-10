import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Stato } from '../types'

const iniziale: Stato = {
  modello: '…',
  effort: '…',
  ultracode: false,
  contesto: 0,
  cacheDa: null,
  cinqueOre: null,
  settimana: null,
  job: 0,
  jobDa: null,
}
// lo stato salvato prima di "jobDa" (o di "job", con agenti e shell separati) si rilegge come iniziale
const stato = atom({ plugin: 'barra-stato', key: 'stato' } as const, iniziale, { shape: 'job-da' })

// il passo delle animazioni: il riflesso su Fable, la galassia di ultracode
const fase = atom({ plugin: 'barra-stato', key: 'fase' } as const, 0)

const ATTIVI = ['pending', 'running', 'waiting']

// "claude-opus-5-5[1m]" → "Opus 5.5"; un nome già leggibile resta com'è
export const nomeModello = (m: string): string => {
  const pulito = m.replace(/\[.*\]$/, '')
  const maiuscola = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)
  const [, famiglia, maggiore, minore] = pulito.match(/^claude-([a-z]+)-(\d+)-(\d+)/) ?? []
  if (famiglia) return `${maiuscola(famiglia)} ${maggiore}.${minore}`
  return pulito.length ? maiuscola(pulito) : '…'
}

export const eFable = (modello: string): boolean => /fable/i.test(modello)

export const coloreLivello = (percento: number): string =>
  percento >= 80 ? '#E06C75' : percento >= 50 ? '#E5C07B' : '#98C379'

export const percentuale = (p: number | null): string => (p == null ? '—' : `${Math.round(p)}%`)

// shortcut: TTL fissa a 1 ora (abbonamento); con API key o in overage la cache dura 5 minuti, da leggere se l'API delle mod la espone
const TTL_CACHE = 60 * 60_000

// minuti di cache rimasti, per eccesso; null prima della prima richiesta
export const cacheRimasta = (da: number | null, adesso: number): string | null => {
  if (da === null) return null
  const resto = da + TTL_CACHE - adesso
  return resto > 0 ? `${Math.ceil(resto / 60_000)}m` : 'scaduta'
}

// da quanto i job sono al lavoro: "27m", oltre l'ora "1h05m"
export const durata = (da: number, adesso: number): string => {
  const minuti = Math.floor((adesso - da) / 60_000)
  return minuti < 60 ? `${minuti}m` : `${Math.floor(minuti / 60)}h${String(minuti % 60).padStart(2, '0')}m`
}

// le finestre dell'abbonamento; quella che l'ultima risposta non riporta resta com'era
export const limiti = (finestre: readonly { kind: string; percentUsed: number }[]): Partial<Stato> => {
  const cinque = finestre.find(f => f.kind === 'five_hour')
  const sette = finestre.find(f => f.kind === 'seven_day')
  return {
    ...(cinque ? { cinqueOre: cinque.percentUsed } : {}),
    ...(sette ? { settimana: sette.percentUsed } : {}),
  }
}

const esa = (n: number): string => Math.round(n).toString(16).padStart(2, '0')

// il colore a metà strada fra due, t da 0 a 1
export const mescola = (da: string, a: string, t: number): string => {
  const canali = (c: string) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16))
  const x = canali(da)
  const y = canali(a)
  return `#${x.map((v, i) => esa(v + ((y[i] ?? v) - v) * t)).join('')}`
}

// galassia: dal viola al blu e ritorno, in movimento
export const galassia = (i: number, passo: number): string =>
  mescola('#9B30FF', '#1E6FFF', (Math.sin((i + passo * 0.5) * 0.7) + 1) / 2)

// oro con un riflesso che passa
export const oro = (i: number, passo: number, lunghezza: number): string =>
  i === passo % (lunghezza + 6) ? '#FFF6C8' : '#FFC83D'

type Impostazioni = { effortLevel?: string; modelSettings?: Record<string, { effortLevel?: string }> }

// l'effort salvato vale per modello ("claude-opus-5-5"), poi quello generale
export const effortSalvato = (imp: Impostazioni, idModello: string): string | undefined => {
  const id = idModello.replace(/\[.*\]$/, '')
  const voce = Object.entries(imp.modelSettings ?? {})
    .filter(([chiave]) => id === chiave || id.startsWith(`${chiave}-`))
    .sort(([a], [b]) => b.length - a.length)[0]
  return voce?.[1].effortLevel ?? imp.effortLevel
}

export const LIVELLI = ['low', 'medium', 'high', 'xhigh', 'max']

// "/effort ultracode" accende, "/effort ultracode off" spegne, "/effort high" cambia il livello
export const leggiComandoEffort = (args: string): { ultracode?: boolean; effort?: string } => {
  const parole = args.trim().toLowerCase().split(/\s+/)
  if (parole[0] === 'ultracode') return { ultracode: !['off', 'false', 'no'].includes(parole[1] ?? '') }
  if (parole[0] && LIVELLI.includes(parole[0])) return { effort: parole[0] }
  return {}
}

// ultimo segno di ultracode nella conversazione: acceso, spento o nessuno
export const ultracodeNeiMessaggi = (testi: readonly string[]): boolean | undefined => {
  for (let i = testi.length - 1; i >= 0; i--) {
    const t = testi[i] ?? ''
    const acceso = Math.max(t.lastIndexOf('Ultracode is on'), t.lastIndexOf('Ultracode on'))
    const spento = Math.max(t.lastIndexOf('Ultracode is off'), t.lastIndexOf('Ultracode off'))
    if (acceso >= 0 || spento >= 0) return acceso > spento
  }
  return undefined
}

// gli id che una notifica di attività in sottofondo dà per finiti (completed, failed, killed);
// ogni notifica letta da sola, così un evento di monitor senza <status> non prende quello della successiva
export const attivitaFinite = (testo: string): string[] =>
  testo.split('</task-notification>').flatMap(n => {
    const id = n.match(/<task-id>([^<]+)<\/task-id>/)?.[1]
    const esito = n.match(/<status>([^<]*)<\/status>/)?.[1]
    return id && esito !== undefined && esito !== 'running' ? [id] : []
  })

async function aggiorna($: EngineInterface, parziale: Partial<Stato>) {
  await update($, stato, s => ({ ...s, ...parziale }))
}

let idModello = ''

// job al lavoro: gli agenti attivi, i comandi Bash in corso, le shell e i monitor in sottofondo finché non arriva la loro notifica di fine
let agentiAttivi = 0
let shellInCorso = 0
const inSottofondo = new Set<string>()

// il totale si calcola al momento della scrittura, così due aggiornamenti vicini non si scavalcano
async function contaJob($: EngineInterface) {
  const adesso = await $.clock.now()
  await update($, stato, s => {
    const job = agentiAttivi + shellInCorso + inSottofondo.size
    return { ...s, job, jobDa: job === 0 ? null : (s.jobDa ?? adesso) }
  })
}

async function rileggiEffort($: EngineInterface) {
  const effort = effortSalvato((await $.settings.read()) as Impostazioni, idModello)
  if (effort) await aggiorna($, { effort })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const risultato = await next(e)
    await contaJob($)

    try {
      idModello = await $.session.model()
      const uso = await $.session.usage()
      await aggiorna($, {
        modello: nomeModello(idModello),
        contesto: uso.context.percent ?? 0,
        ...limiti(uso.rateLimits),
      })
      await rileggiEffort($)
    } catch {}

    try {
      const testi = (await $.session.messages()).filter(m => m.role === 'user').map(m => m.text ?? '')
      const acceso = ultracodeNeiMessaggi(testi)
      if (acceso !== undefined) await aggiorna($, { ultracode: acceso })
    } catch {}

    $.clock.every(300, async () => {
      await update($, fase, passo => (passo + 1) % 360)
      const attivi = (await $.agent.list()).filter(a => ATTIVI.includes(a.status)).length
      if (attivi !== agentiAttivi) {
        agentiAttivi = attivi
        await contaJob($)
      }
    })

    return risultato
  })

  on('prompt.submit', async ($, e, next) => {
    if (/\bultracode\b/i.test(e.text)) await aggiorna($, { ultracode: true })
    for (const id of attivitaFinite(e.text)) inSottofondo.delete(id)
    await contaJob($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    try {
      shellInCorso++
      await contaJob($)
      const fatto = await next(e)
      const id = fatto.isError ? undefined : fatto.result?.backgroundTaskId
      if (id) inSottofondo.add(id)
      return fatto
    } finally {
      shellInCorso--
      await contaJob($)
    }
  }).catch(($, e, next) => next(e))

  // un monitor resta al lavoro finché non arriva la sua notifica di fine o un TaskStop
  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    const fatto = await next(e)
    const id = fatto.isError ? undefined : fatto.result?.taskId
    if (id) inSottofondo.add(id)
    await contaJob($)
    return fatto
  }).catch(($, e, next) => next(e))

  // una shell o un monitor in sottofondo fermati da Claude
  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const fatto = await next(e)
    inSottofondo.delete(e.task_id ?? e.shell_id ?? '')
    await contaJob($)
    return fatto
  }).catch(($, e, next) => next(e))

  // /effort e /model cambiano la riga subito, senza aspettare la prossima richiesta
  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const risultato = await next(e)
    const comando = leggiComandoEffort(e.args)
    if (comando.ultracode !== undefined) await aggiorna($, { ultracode: comando.ultracode })
    if (comando.effort) await aggiorna($, { effort: comando.effort })
    else if (comando.ultracode === undefined) await rileggiEffort($)
    return risultato
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'model' }, async ($, e, next) => {
    const risultato = await next(e)
    idModello = await $.session.model()
    await aggiorna($, { modello: nomeModello(idModello) })
    await rileggiEffort($)
    return risultato
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    idModello = e.model
    await aggiorna($, {
      modello: nomeModello(e.model),
      ...(e.effort !== undefined ? { effort: String(e.effort) } : {}),
    })
    const partita = await $.clock.now()
    const risposta = yield* next(e)
    // la richiesta ha letto o scritto la cache: la scadenza riparte da quando è partita
    const uso = risposta.usage
    if (uso && uso.cache_read_input_tokens + uso.cache_creation_input_tokens > 0) await aggiorna($, { cacheDa: partita })
    return risposta
  })

  on('session.measure', async ($, e, next) => {
    await aggiorna($, {
      ...(e.context.percent !== undefined ? { contesto: e.context.percent } : {}),
      ...limiti(e.rateLimits),
    })
    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)

    const s = await read($, stato)
    const passo = await read($, fase)
    // il ridisegno ogni 300 ms di "fase" tiene aggiornati anche i minuti
    const adesso = await $.clock.now()
    const cache = cacheRimasta(s.cacheDa, adesso)
    const { Box, Text } = $.ui.resolve(e)
    const sep = <Text dimColor> | </Text>

    const lettere = (testo: string, colore: (i: number) => string) =>
      [...testo].map((c, i) => (
        <Text bold color={colore(i)}>
          {c}
        </Text>
      ))

    const modello = eFable(s.modello)
      ? lettere(s.modello, i => oro(i, passo, s.modello.length))
      : <Text>{s.modello}</Text>

    const effort = s.ultracode
      ? <Box flexDirection="row">{lettere('ultracode', i => galassia(i, passo))}<Text dimColor> {s.effort}</Text></Box>
      : <Text>{s.effort}</Text>

    const barra = (etichetta: string, valore: number | null) => (
      <Box flexDirection="row">
        <Text>{etichetta} </Text>
        <Text color={valore === null ? undefined : coloreLivello(valore)}>{percentuale(valore)}</Text>
      </Box>
    )

    return (
      <Box flexDirection="row" flexShrink={1}>
        {modello}
        {sep}
        {effort}
        {sep}
        {barra('ctx', s.contesto)}
        {cache && <Text> ({cache})</Text>}
        {sep}
        {barra('5h', s.cinqueOre)}
        {sep}
        {barra('7d', s.settimana)}
        {sep}
        <Text>job {s.job}{s.jobDa !== null ? ` (${durata(s.jobDa, adesso)})` : ''}</Text>
      </Box>
    )
  })
}
