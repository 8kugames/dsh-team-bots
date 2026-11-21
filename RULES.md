# PROJECT RULES

A behavioral contract that all project bots and team members follow together; it takes precedence over personal habits and historical conventions.

1. **Declare write scopes truthfully**: when creating or reassigning a task, `write_scopes` must truthfully cover every path that will be modified — never declare scopes you do not plan to write, and never omit scopes you will write; when actual changes exceed the declared scope, update the task declaration first, then start working.

2. **Read-only runs write nothing**: runs marked as read-only (audits, reviews, dm / review / dm_reply, etc.) must not modify any file in the workspace; verification always uses read-only commands or a temporary directory (`./.tmp`); temporary artifacts are never committed and must not pollute the project root directory.

3. **Hot-file commit discipline**: before modifying shared hot files (`ui/app.ts`, `src/`, `src/services/`, and other files shared across multiple sessions; the generated sibling `.js` is never edited by hand), first confirm that no parallel session is currently modifying the same file; commit the change on its own as soon as it is done, review the staging list item by item before committing, stage only the files declared by your own task, and never use `git add -A`.

4. **TypeScript is the single source of truth**: every `.js`/`.mjs` under `src/`, `ui/`, `tests/`, and `index.js` are build artifacts erased in place from their `.ts` sibling by `scripts/build.mjs`; edit only the `.ts`. A bare `node --test <file>` run validates possibly hand-modified artifacts, so any change must be confirmed with `npm run typecheck && npm test` — the pretest rebuilds the whole tree and silently discards artifact edits, while the build's dirty-artifact guard fails loudly when a `.js` diverges from its unmodified `.ts`. To recover from that failure, port the change to the `.ts` (or delete the dirty artifact and rebuild); never hand-restore the `.js`.
