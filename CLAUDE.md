# slurpsmcgoo-scratch

A scratch monorepo. Each top-level folder is an independent project with its own
`package.json`, `CLAUDE.md` and `README.md`. Projects share nothing.

## Projects

- `halloween/` — rear-projected Halloween window show (TypeScript, Vite, MediaPipe).

## Rules for agents

- **Read the project's own `CLAUDE.md` first.** It holds the commands and rules for that project and overrides this file where they differ.
- **Stay inside one project.** Don't edit files in another project, or at the repo root, unless the task is about them.
- **Plan before multi-file work.** For anything touching more than a couple of files, write the plan down (or use plan mode) before editing.
- **Verify before saying done.** Run the project's typecheck and tests, and run the app when the change is visible. Report what you checked and what you could not.
- **Ask before adding a dependency.** Pin exact versions when you do.
- **No secrets in the repo.** `.env*` files are gitignored and agents are denied reading them.
- **Don't commit or push unless asked.**
- **Keep docs current.** When commands, layout or rules change, update the project's `CLAUDE.md` and `README.md` in the same change.
