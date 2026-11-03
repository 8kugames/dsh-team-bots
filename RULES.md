# PROJECT RULES

A behavioral contract that all project bots and team members follow together; it takes precedence over personal habits and historical conventions.

1. **Declare write scopes truthfully**: when creating or reassigning a task, `write_scopes` must truthfully cover every path that will be modified — never declare scopes you do not plan to write, and never omit scopes you will write; when actual changes exceed the declared scope, update the task declaration first, then start working.

2. **Read-only runs write nothing**: runs marked as read-only (audits, reviews, dm / review / dm_reply, etc.) must not modify any file in the workspace; verification always uses read-only commands or a temporary directory (`./tmp`); temporary artifacts are never committed and must not pollute the project root directory.

3. **Hot-file commit discipline**: before modifying shared hot files (`ui/app.js`, `src/`, `src/services/`, and other files shared across multiple sessions), first confirm that no parallel session is currently modifying the same file; commit the change on its own as soon as it is done, review the staging list item by item before committing, stage only the files declared by your own task, and never use `git add -A`.
