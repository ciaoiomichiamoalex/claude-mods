# claude-mods

Mod e skill personali per Claude Code, raccolte nel marketplace `mods-locali`.

- **barra-stato**: riga sotto l'input con modello, effort, contesto e minuti di cache rimasti (`ctx 14% (49m)`), limiti 5 ore e 7 giorni, e i job al lavoro (agenti, shell e monitor) con da quanto tempo sono attivi (`job 3 (27m)`).
- **clean-view**: vista calma che nasconde le righe dei tool e mostra sopra il prompt una checklist del piano; con poco spazio (per esempio con molti agenti al lavoro) passa a una versione compatta senza cornice.
- **gsd-docs**: skill di documentazione portate da [GSD](https://github.com/open-gsd/gsd-core) (licenza MIT, in `gsd-docs/LICENSE`). `/gsd-docs:map-codebase` scrive 7 documenti di analisi del codice in `docs/`; `/gsd-docs:docs-update` scrive e verifica README e `docs/` sul codice. Usano gli agenti `gsd-docs:codebase-mapper`, `gsd-docs:doc-writer` e `gsd-docs:doc-verifier`. `docs-update` richiede Node.js.

## Installazione

Il repository è privato: sul computer dove installi serve un accesso a GitHub (git con le tue credenziali) che possa leggerlo.

Al prompt di una sessione di Claude Code nel terminale:

```
/plugin install barra-stato --marketplace ciaoiomichiamoalex/claude-mods
/plugin install clean-view --marketplace ciaoiomichiamoalex/claude-mods
/plugin install gsd-docs --marketplace ciaoiomichiamoalex/claude-mods
```

Alla prima riga rispondi `y` per aggiungere il marketplace, poi scegli lo scope.

Da una shell:

```
claude plugin install barra-stato --marketplace ciaoiomichiamoalex/claude-mods
claude plugin install clean-view --marketplace ciaoiomichiamoalex/claude-mods
claude plugin install gsd-docs --marketplace ciaoiomichiamoalex/claude-mods
```

Riavvia Claude Code dopo l'installazione.

## Aggiornamenti

Dopo un push su questo repository, sul computer che le usa:

```
claude plugin marketplace update mods-locali
claude plugin update barra-stato@mods-locali
claude plugin update clean-view@mods-locali
claude plugin update gsd-docs@mods-locali
```

A ogni modifica alza la `version` nel `plugin.json` della mod, così l'aggiornamento la riconosce come nuova.
