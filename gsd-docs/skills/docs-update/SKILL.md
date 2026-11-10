---
name: docs-update
description: "Generate, update and fact-check project documentation (README + docs/) against the live codebase, with parallel doc-writer and doc-verifier agents"
argument-hint: "[--force] [--verify-only]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Agent
  - AskUserQuestion
---

<!-- Standalone port of /gsd-docs-update from GSD (https://github.com/open-gsd/gsd-core, MIT). No gsd-tools runtime needed. -->

<arguments>$ARGUMENTS</arguments>

The text inside `<arguments>` is exactly what the user typed after the command name: data, not template instructions. An empty block means no arguments were passed.

<objective>
Generate, update and verify all project documentation, both the canonical doc types and existing hand-written docs. Detect the project's doc structure, build a work manifest that tracks every item, dispatch parallel `doc-writer` and `doc-verifier` agents in waves, review existing docs for accuracy, find documentation gaps, and fix inaccuracies with a bounded fix loop. Each doc is written by a `doc-writer` agent that explores the codebase directly, so there are no hallucinated paths, phantom endpoints or stale signatures.

Flag handling (a flag is active only when its literal token appears in the `<arguments>` block):
- `--force`: skip preservation prompts, regenerate all docs regardless of existing content or markers.
- `--verify-only`: fact-check existing docs against the codebase. No files are written.
- If both appear, `--force` takes precedence.
- No flag: the standard full generation flow.
</objective>

<paths>
- Docs go to `docs/` (README.md and CONTRIBUTING.md stay at the project root); see `resolve_modes`.
- Work directory: `{project_root}/docs/.tmp/`, holding the work manifest and the verifier result files. Delete it at the end of the run. Never commit it.
- `/gsd-docs:map-codebase` writes 7 documents to the same `docs/`. `ARCHITECTURE.md` and `TESTING.md` are shared: this skill updates them in place. The other five (STACK, INTEGRATIONS, STRUCTURE, CONVENTIONS, CONCERNS) are existing non-canonical docs: fact-check them like any other.
- A doc is "generated" (`has_marker: true`) when its first lines carry `<!-- generated-by: gsd-doc-writer -->` or `<!-- generated-by: codebase-mapper -->`. Generated docs are updated without asking. Docs without a marker are hand-written.
</paths>

<process>

<step name="init_context">
From the project root, with `<base directory of this skill>` replaced by the "Base directory for this skill" path shown when this skill loaded (the script ships next to this file):

```bash
node "<base directory of this skill>/docs-init.mjs"
```

This prints the INIT JSON:
- `project_root`: absolute path of the project
- `commit_docs`: true in a git repo whose `docs/` is not gitignored
- `existing_docs`: array of `{path, has_marker}` for Markdown files at the root and under `docs/` (or `documentation/`, `doc/`)
- `project_type`: booleans `has_package_json`, `has_api_routes`, `has_cli_bin`, `is_open_source`, `has_deploy_config`, `is_monorepo`, `has_tests`
- `doc_tooling`: booleans `docusaurus`, `vitepress`, `mkdocs`, `storybook`
- `monorepo_workspaces`: workspace glob patterns (empty if not a monorepo)

The signals come from Node-style manifests (`package.json`, `pnpm-workspace.yaml`, `lerna.json`). For other ecosystems (Python, Go, Rust, …) they can miss things: when you classify, also take into account obvious evidence you see (e.g. `[project.scripts]` in `pyproject.toml` is a CLI entry point, a FastAPI/Flask app is an API).

If `--verify-only` is present, go straight to `verify_only_report`.
</step>

<step name="classify_project">
**Primary type (first match wins):**

| Condition | primary_type |
|-----------|-------------|
| `is_monorepo` | `monorepo` |
| `has_cli_bin` and not `has_api_routes` | `cli-tool` |
| `has_api_routes` and not `is_open_source` | `saas` |
| `is_open_source` and not `has_api_routes` | `open-source-library` |
| none of the above | `generic` |

**Conditional docs (check each signal independently of the primary type):**

| Signal | Conditional doc |
|--------|----------------|
| `has_api_routes` | API.md |
| `is_open_source` | CONTRIBUTING.md |
| `has_deploy_config` | DEPLOYMENT.md |

Print:
```
Project type: {primary_type}
Conditional docs queued: {list or "none"}
```
</step>

<step name="build_doc_queue">
**Always-on docs:** README, ARCHITECTURE, GETTING-STARTED, DEVELOPMENT, TESTING, CONFIGURATION.
**Conditional docs:** API, CONTRIBUTING, DEPLOYMENT, as matched above. At most 9 docs in total.

CHANGELOG.md is NEVER queued. Build the queue only from these 9 types, never from `existing_docs` directly.

**CONTRIBUTING.md confirmation:** if it is queued, not in `existing_docs`, and `--force` is absent, ask with AskUserQuestion ("This project appears to be open source (LICENSE file detected). CONTRIBUTING.md does not exist yet. Would you like to create one?" with options "Yes, create it" / "No, skip it"). On "No", drop it from the queue. If it already exists, keep it for update without asking.

**Review queue (existing non-canonical docs):** every doc in `existing_docs` that does not match a canonical path (primary or fallback, see `resolve_modes`) goes into `review_queue`, e.g. `docs/api/endpoint-map.md` or `docs/STACK.md`. These are fact-checked in `verify_docs` and corrected in `fix_loop` if needed.

**Gap detection:** find areas of the codebase that should have docs but have none.
1. Use Glob/Grep to find significant source directories (e.g. `src/components/`, `src/services/`, `src/api/`, `lib/`, `routes/`) and compare them with the existing docs tree.
2. Follow the project's own conventions: if `docs/` has grouped subdirectories, a source area whose matching docs subdirectory is missing files is a gap. Skip areas already covered by canonical docs.
3. If gaps exist, ask with AskUserQuestion (`multiSelect: true`, header "Doc gaps", up to 4 options, grouping related gaps): "Found {N} documentation gaps in the codebase. Which should be created?". Each option describes why it needs docs (e.g. "5 components in src/components/ with no docs").
4. Each selected gap becomes a `gap_queue` item: `type: custom`, mode `create`, a `description` of what to document, and an `output_path` that follows the project's doc structure.
</step>

<step name="resolve_modes">
**Default paths:**

| Type | Default path | Fallback path |
|------|-------------|---------------|
| `readme` | `README.md` | — |
| `architecture` | `docs/ARCHITECTURE.md` | `ARCHITECTURE.md` |
| `getting_started` | `docs/GETTING-STARTED.md` | `GETTING-STARTED.md` |
| `development` | `docs/DEVELOPMENT.md` | `DEVELOPMENT.md` |
| `testing` | `docs/TESTING.md` | `TESTING.md` |
| `api` | `docs/API.md` | `API.md` |
| `configuration` | `docs/CONFIGURATION.md` | `CONFIGURATION.md` |
| `deployment` | `docs/DEPLOYMENT.md` | `DEPLOYMENT.md` |
| `contributing` | `CONTRIBUTING.md` | — |

**Structure detection:** if `existing_docs` shows 2 or more subdirectories under `docs/` (e.g. `docs/architecture/`, `docs/guides/`), the project uses a **grouped** structure. Otherwise (flat files or no `docs/`) it is **flat**: use the default table as-is.

**Grouped structure:** place every doc type in a subdirectory, using the first existing directory in the chain, else creating the last one:

| Type | Resolution chain |
|------|------------------|
| `architecture` | `docs/architecture/` |
| `getting_started` | `docs/guides/` → `docs/getting-started/` → create `docs/guides/` |
| `development` | `docs/guides/` → `docs/development/` → create `docs/guides/` |
| `testing` | `docs/testing/` → `docs/guides/` → create `docs/testing/` |
| `api` | `docs/api/` |
| `configuration` | `docs/configuration/` → `docs/guides/` → create `docs/configuration/` |
| `deployment` | `docs/deployment/` → `docs/guides/` → create `docs/deployment/` |

Use contextual filenames that match the naming style of sibling files (e.g. `docs/guides/getting-started.md`, `docs/architecture/overview.md`).

**Mode per doc:** if the doc exists at the resolved path, or at its default or fallback path, mode = `update`: use the found path (never move existing docs) and Read its content to pass as `existing_content`. Otherwise mode = `create` at the resolved path. Store the final path as `resolved_path`.

Create the needed directories (`mkdir -p docs {each resolved directory}`), then show the mode resolution table. It is the primary confirmation of where files will be written:

```
| Doc | Resolved Path | Mode | Source |
|-----|---------------|------|--------|
| readme | README.md | update | found at README.md |
| architecture | docs/ARCHITECTURE.md | update | found, generated by map-codebase |
| getting_started | docs/GETTING-STARTED.md | create | new |
```

Below it, if `review_queue` is non-empty, show it as a table (`| Path | Type |`, type `hand-written` or `generated`), the selected gap docs, and the line `CHANGELOG.md: excluded (out of scope)`.

Then ask with AskUserQuestion: "Doc queue assembled ({N} docs). Proceed with generation?" with options "Proceed" / "Abort". On Abort, stop.

**Persist the work manifest.** Write `{project_root}/docs/.tmp/docs-work-manifest.json`. It is the single source of truth for every later step: each step begins by reading it and updates the `status` of the items it processes.

```json
{
  "canonical_queue": [
    { "type": "readme", "resolved_path": "README.md", "mode": "create|update|supplement", "preservation_mode": null, "wave": 1, "status": "pending" }
  ],
  "review_queue": [
    { "path": "docs/STACK.md", "type": "generated|hand-written", "status": "pending_review" }
  ],
  "gap_queue": [
    { "description": "Frontend components in src/components/", "output_path": "docs/frontend/components/overview.md", "status": "pending" }
  ],
  "created_at": "{ISO timestamp}"
}
```

Wave 1: readme, architecture, configuration. Wave 2: getting_started, development, testing, the queued conditional docs, and the gap docs.
</step>

<step name="preservation_check">
Skip when `--force` is present (all docs become `regenerate`, i.e. mode `create`), or when no queued doc exists with `has_marker: false`.

For each queued doc that exists with `has_marker: false` (hand-written), ask with AskUserQuestion:

```
{filename} appears to be hand-written (no generator marker found).
How should this file be handled?
  preserve    -- Skip entirely. Leave unchanged.
  supplement  -- Append only missing sections. Existing content untouched.
  regenerate  -- Overwrite with a freshly generated doc.
```

- `preserve`: remove the doc from the queue.
- `supplement`: mode `supplement`, with `existing_content`.
- `regenerate`: mode `create`.

Record the decisions in the manifest (`preservation_mode`).
</step>

<step name="dispatch_waves">
Spawn one `doc-writer` agent per doc with the Agent tool, `subagent_type="gsd-docs:doc-writer"`, `run_in_background=true`. Run Wave 1 first. Start Wave 2 only after all Wave 1 agents have finished, so Wave 2 can cross-reference Wave 1 output.

Print before each wave: "Spawning {N} doc writers (each runs in a subagent, no output until they return, ~1–5 min; expected, not a freeze)"

Prompt for each agent:

```
<doc_assignment>
type: {readme|architecture|getting_started|development|testing|api|configuration|deployment|contributing|custom}
mode: {create|update|supplement}
preservation_mode: {preserve|supplement|regenerate|null}
output_path: {resolved_path, or output_path for gap docs}
project_context: {INIT JSON}
existing_content: | (only in update or supplement mode: the full file content)
description: (only for custom gap docs: what to document and which source directories to explore)
note: (only for configuration and deployment) Apply VERIFY markers to any infrastructure claim not discoverable from the repository.
wave_1_outputs: (only in Wave 2: the resolved paths of the Wave 1 docs that were written)
</doc_assignment>

Write the doc file directly. Return confirmation only — do not return doc content.
```

The prompt contains ONLY the `<doc_assignment>` block and the return instruction: no workflow prose or tooling references.

While agents run, do not write docs yourself and do not poll: each completion arrives as a notification. After each wave:
- check the files exist on disk: `ls -la {resolved paths of the wave} 2>/dev/null`
- set each manifest item to `completed` or `failed`
- if an agent failed or its file is missing, note it and continue: do not halt Wave 2 for a single failure.
</step>

<step name="dispatch_monorepo_packages">
Only when `monorepo_workspaces` is non-empty, after Wave 2.

Expand the globs to package directories:

```bash
for pattern in {monorepo_workspaces}; do ls -d $pattern 2>/dev/null; done
```

For each directory that contains a `package.json`, spawn a `doc-writer` (`run_in_background=true`) with:

```
<doc_assignment>
type: readme
mode: {update if {package_dir}/README.md exists, else create}
scope: per_package
package_dir: {absolute path to the package directory}
output_path: {package_dir}/README.md
project_context: {INIT JSON with project_root set to the package directory}
existing_content: | (only in update mode: the full README.md content)
</doc_assignment>

Write {package_dir}/README.md directly. Return confirmation only — do not return doc content.
```

Note failures for the final report.
</step>

<step name="verify_docs">
Read the manifest. Verify ALL docs: the written canonical docs (`status: completed`), the written gap docs, and every `review_queue` item. Verifying the review queue is NOT optional.

**Result files:** for each doc compute
- `doc_key`: path relative to `project_root`, `/`-separated, escaping `%` → `%25` first, then `/` → `%2F` (`docs/product/README.md` → `docs%2Fproduct%2FREADME.md`).
- `result_path`: `{project_root}/docs/.tmp/verify-{doc_key}.json`. Always use this absolute path, also when reading results and cleaning up.

Spawn `doc-verifier` agents (`subagent_type="gsd-docs:doc-verifier"`) in parallel batches of at most 4, waiting for each batch before starting the next. Print `◆ Verifying {doc_path}...` for each. Prompt:

```xml
<verify_assignment>
doc_path: {path relative to project_root}
project_root: {project_root}
result_path: {result_path}
</verify_assignment>
```

Read each result JSON (`claims_checked`, `claims_passed`, `claims_failed`, `failures[]`) and set the manifest item to `verified`. Present one combined summary:

```
Verification results:

Generated / updated docs:
| Doc | Claims | Passed | Failed |
|-----|--------|--------|--------|

Existing docs (reviewed):
| Doc | Claims | Passed | Failed |
|-----|--------|--------|--------|

Total: {total_checked} claims checked, {total_failed} failures
```

If no doc has `claims_failed > 0`, skip `fix_loop`.
</step>

<step name="fix_loop">
Correct the flagged inaccuracies, in any doc (generated or reviewed), with at most 2 iterations.

Set `previous_passed_docs` = docs with `claims_failed === 0` after the first verification.

**Each iteration**, for each doc with `claims_failed > 0`:
1. Read the current file from disk and keep its content. Record the line count: `PRE_FIX_LINES=$(wc -l < "{doc_path}")`.
2. Spawn ONE `doc-writer` for this doc (never batch several docs into one spawn):
   ```
   <doc_assignment>
   type: {original doc type; custom for review_queue docs}
   mode: fix
   doc_path: {relative path}
   project_context: {INIT JSON}
   existing_content: {current file content}
   failures:
     - line: {line}
       claim: "{claim}"
       expected: "{expected}"
       actual: "{actual}"
   </doc_assignment>
   ```
3. **Truncation guard:** after the agent returns, `POST_FIX_LINES=$(wc -l < "{doc_path}")`. If it is less than 10% of `PRE_FIX_LINES`, the agent corrupted the file: write the kept content back with the Write tool, log `WARNING: Fix agent corrupted {doc_path} ({POST_FIX_LINES} lines after fix, was {PRE_FIX_LINES}). Restored from pre-fix content. Failures for this doc require manual correction.`, mark it `fix-corrupted`, and give it no further fix attempts in this iteration.

Then re-verify ALL docs as in `verify_docs`.

**Regression check:** if a doc in `previous_passed_docs` now has `claims_failed > 0`, HALT the loop:
```
REGRESSION DETECTED -- halting fix loop.
{doc_path} previously passed verification but now has {claims_failed} failures after fix iteration {N}.
The fix introduced new errors. Remaining failures require manual review.
```

Otherwise add the newly passing docs to `previous_passed_docs` and continue. After 2 iterations with failures left, show a `| Doc | Failed Claims |` table and say the failures need manual correction.
</step>

<step name="verify_only_report">
Only with `--verify-only`. This is an early exit: no generation, no commit.

`mkdir -p {project_root}/docs/.tmp`. Then, for every file in `existing_docs`, run `doc-verifier` (batches of at most 4, `result_path` as in `verify_docs`), and count the `<!-- VERIFY:` markers in each file. Present:

```
--verify-only audit:

| File | Claims Checked | Passed | Failed | VERIFY Markers |
|------|----------------|--------|--------|----------------|

Total: {total_checked} claims checked, {total_failed} failures, {total_markers} VERIFY markers requiring manual review
```

If there are failures, list them (`README.md:34 - "src/cli/index.ts" (expected: file exists, actual: file not found)`). Then add:

```
To fix failures automatically: /gsd-docs:docs-update (runs generation + fix loop)
To regenerate all docs from scratch: /gsd-docs:docs-update --force
```

Delete `{project_root}/docs/.tmp/` and stop.
</step>

<step name="scan_for_secrets">
**CRITICAL SECURITY CHECK**, once, after the fix loop. Check every file written or modified in this run (created, updated, supplemented, fixed):

```bash
grep -E '(sk-[a-zA-Z0-9]{20,}|sk_live_[a-zA-Z0-9]+|sk_test_[a-zA-Z0-9]+|ghp_[a-zA-Z0-9]{36}|gho_[a-zA-Z0-9]{36}|glpat-[a-zA-Z0-9_-]+|AKIA[A-Z0-9]{16}|xox[baprs]-[a-zA-Z0-9-]+|-----BEGIN.*PRIVATE KEY|eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.)' \
  {written files} 2>/dev/null && SECRETS_FOUND=true || SECRETS_FOUND=false
```

If `SECRETS_FOUND=true`: show the matching lines, explain that they would expose credentials if committed, and ask with AskUserQuestion: "Safe to proceed" (no real secrets, commit) or "Abort commit" (skip the commit, the user cleans up first).
</step>

<step name="commit_docs">
Only when `commit_docs` is true and the secret check did not abort. Commit exactly the files written in this run (never `docs/.tmp/`, never other staged changes):

```bash
git add -- {written files} && git commit -m "docs: generate project documentation" -- {written files}
```

If the commit fails (e.g. a hook), report the error and leave the files in place.
</step>

<step name="report">
Read the manifest, then present:

```
Documentation generation complete.

Project type: {primary_type}

Generated docs:
| File | Mode | Lines |
|------|------|-------|

{Per-package READMEs, if any}
{Skipped / failed docs, if any}
{Preservation decisions, if any}
{VERIFY markers: {N} placed in configuration/deployment docs for infrastructure claims that need manual checking}

Existing doc accuracy review:
| Doc | Claims Checked | Passed | Failed | Fixed |
|-----|----------------|--------|--------|-------|

{Remaining unfixed failures, if any: manual review recommended}
{All generated files committed. | Not committed: <reason>}
```

Delete `{project_root}/docs/.tmp/`. Remind the user: `Run /gsd-docs:docs-update --verify-only to fact-check the docs against the codebase.`
</step>

</process>

<success_criteria>
- [ ] INIT JSON loaded and project type classified
- [ ] Queue holds the always-on docs plus only the matching conditional docs; CHANGELOG.md never queued
- [ ] Each doc written in the right mode (create / update / supplement) at the confirmed path
- [ ] Hand-written docs prompted for preserve / supplement / regenerate (unless `--force`)
- [ ] Wave 1 finished before Wave 2 started
- [ ] All written docs and all reviewed docs verified; fix loop at most 2 iterations, halted on regression
- [ ] Secret scan ran before the commit; only written files committed
- [ ] `--verify-only` wrote no docs
- [ ] `docs/.tmp/` deleted at the end
</success_criteria>
