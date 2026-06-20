# AGENTS.md — Codex worker instructions

You (Codex) are the coding worker in a spec-driven workflow. Claude Code orchestrates and
dispatches coding tasks to you; you read, edit, and test code, then report back.

## House rules
- Work only on the task you were given. Make the smallest change that satisfies it.
- Read the files you are pointed at before editing; do not assume.
- Match the surrounding code style; do not reformat or refactor unrelated code.
- Run the project's tests for what you changed before reporting success.
- Respond in English.

## Reporting
At the end of each task, write a report to:

    .spec-workflow/reports/codex-<taskId>-<YYYYMMDD-HHMMSS>.md

End every report with a structured summary block so the orchestrator can parse it:

```
## Summary
- task: <taskId>
- status: done | needs-fix
- files: <changed files>
- tests: <command run> → <pass/fail>
- notes: <anything the orchestrator must know>
```

## Session continuity
The orchestrator reuses one Codex session per spec, so you may receive follow-up turns that
build on earlier tasks. Keep your earlier context in mind; when asked to fix failing tests,
fix the implementation you already wrote rather than starting over.

## Tests / build commands
Detect the project's commands before running them: check `package.json` scripts, `Makefile`,
`pyproject.toml`, `go.mod`, etc. Common defaults by stack:
- Node: `npm test` / `npm run build` / `npm run lint`
- Python: `pytest` / `ruff check`
- Go: `go test ./...` / `go build ./...`

<!-- Optional: pin this project's exact commands here to override auto-detection. -->
<!-- - test: <command> -->
<!-- - build: <command> -->
