export type Stato = {
  modello: string
  effort: string
  ultracode: boolean
  contesto: number
  // quando è partita l'ultima richiesta del thread principale che ha usato la cache; null prima della prima
  cacheDa: number | null
  cinqueOre: number | null
  settimana: number | null
  job: number
  // quando job è passato da zero a più di zero; null mentre è zero
  jobDa: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'barra-stato': { stato: Shaped<Stato>; fase: number }
  }
}
