# claude-mods

Mod e skill personali per Claude Code, raccolte nel marketplace `mods-locali`.

- **barra-stato**: riga sotto l'input con modello, effort, contesto e minuti di cache rimasti (`ctx 14% (49m)`), limiti 5 ore e 7 giorni, e i job al lavoro (agenti, shell e monitor) con da quanto tempo sono attivi (`job 3 (27m)`).
- **clean-view**: vista calma che nasconde le righe dei tool e mostra sopra il prompt una checklist del piano; senza cornice, per lasciare più spazio agli step; con poco spazio (per esempio con molti agenti al lavoro) mostra solo titolo, avanzamento e step attivo.
- **gsd-docs**: skill di documentazione portate da [GSD](https://github.com/open-gsd/gsd-core) (licenza MIT, in `gsd-docs/LICENSE`). `/gsd-docs:map-codebase` scrive 7 documenti di analisi del codice in `docs/`; `/gsd-docs:docs-update` scrive e verifica README e `docs/` sul codice. Usano gli agenti `gsd-docs:codebase-mapper`, `gsd-docs:doc-writer` e `gsd-docs:doc-verifier`. `docs-update` richiede Node.js.
- **git**: `/commit` (anche `/git:commit`) raggruppa i file modificati per lavoro e fa un commit per gruppo in stile Conventional Commits (commitizen), seguendo la configurazione commitizen o commitlint, il `git log` e il `CLAUDE.md` del progetto. Mostra un'anteprima e aspetta l'ok, fa il push se c'è un remoto e ricapitola i commit in tabella. Argomenti liberi: `su <branch>`, `senza push`, `subito` (niente anteprima), `con lo stage` o `senza lo stage`, percorsi. Non usa mai `--force` né `--no-verify`; se il push è rifiutato e il working tree è pulito fa `git pull --rebase` e riprova.

## Installazione

Il repository è privato: sul computer dove installi serve un accesso a GitHub (git con le tue credenziali) che possa leggerlo.

Al prompt di una sessione di Claude Code nel terminale:

```
/plugin install barra-stato --marketplace ciaoiomichiamoalex/claude-mods
/plugin install clean-view --marketplace ciaoiomichiamoalex/claude-mods
/plugin install gsd-docs --marketplace ciaoiomichiamoalex/claude-mods
/plugin install git --marketplace ciaoiomichiamoalex/claude-mods
```

Alla prima riga rispondi `y` per aggiungere il marketplace, poi scegli lo scope.

Da una shell:

```
claude plugin install barra-stato --marketplace ciaoiomichiamoalex/claude-mods
claude plugin install clean-view --marketplace ciaoiomichiamoalex/claude-mods
claude plugin install gsd-docs --marketplace ciaoiomichiamoalex/claude-mods
claude plugin install git --marketplace ciaoiomichiamoalex/claude-mods
```

Riavvia Claude Code dopo l'installazione.

## Aggiornamenti

Dopo un push su questo repository, sul computer che le usa:

```
claude plugin marketplace update mods-locali
claude plugin update barra-stato@mods-locali
claude plugin update clean-view@mods-locali
claude plugin update gsd-docs@mods-locali
claude plugin update git@mods-locali
```

A ogni modifica alza la `version` nel `plugin.json` della mod, così l'aggiornamento la riconosce come nuova.
