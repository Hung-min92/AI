AI Task Manager — Agent Instructions
1. Project context
This repository is a full-stack MERN application for personal project and task management, with AI-assisted planning planned for a later phase.
- Frontend: client/ — React, TypeScript, Vite; dark-mode UI planned.
- Backend: server/ — Node.js (ES modules), Express, Mongoose, Zod.
- Authentication: Argon2id password hashing; jose JWT access tokens; Register, Login and /me routes.
- Database models: User, Project, Task.
- Database environments: ai_task_manager_dev for development and ai_task_manager_test for isolated integration testing.
- Current priority: complete and verify authentication integration tests before Project CRUD.
Repository state must be inspected at the beginning of every task. This document describes intended practices; verify that files and functionality exist rather than assuming they do.
2. Working agreement: plan → review → execute → verify
1. Read the relevant source files, tests and this file before proposing changes.
2. Restate the goal, scope, assumptions, affected files, risks and acceptance criteria.
3. If a task is marked planning/read-only, do not modify files, install dependencies, or perform database writes.
4. Implement only the explicitly approved scope. Do not silently add features or refactor unrelated code.
5. Run appropriate tests and report their actual results. Do not claim PASS for tests not executed.
6. Show a concise change summary and any unresolved risks; wait for human approval before committing or pushing.
7. Explain architectural decisions, code flow and test failures in Vietnamese, in a beginner-friendly teaching style.
3. Architecture and coding conventions
- Keep frontend and backend separate.
- Backend HTTP request flow: route → validation/auth middleware → controller → service → model/database.
- Routes declare endpoints and middleware. Controllers handle HTTP input/output. Services own business rules. Models define persistence. Keep controllers thin.
- Use ES module import/`export` in the backend, matching the existing codebase.
- Prefer the project's existing libraries, patterns and naming conventions. Explain and obtain approval before introducing a new dependency.
- Validate untrusted input with Zod; reject unexpected client-controlled fields such as owner, userId, passwordHash, and authorization decisions supplied in request bodies.
- Derive the authenticated user's identity from validated authentication middleware, never from client-submitted owner IDs.
- For Project and Task access, verify ownership at the service/query level. Knowing a document ID does not authorize access.
- Do not return password hashes, secrets, database URIs or raw internal error details in API responses.
- Keep app.js independently importable for offline HTTP tests; avoid starting the HTTP server or MongoDB connection merely by importing it.
- Use clear, minimal edits and keep old behavior intact unless the task explicitly changes it.
4. Authentication and security rules
- Never store plaintext passwords. Use the existing Argon2id hashing/verification service; preserve password input exactly (do not trim passwords).
- Preserve the agreed email normalization policy: trim and lowercase; do not silently strip dots or +tags.
- JWTs must be signed and verified using the configured expected algorithm, issuer, audience and expiration. Do not put sensitive personal data or secrets in JWT payloads.
- Never log passwords, password hashes, bearer tokens, JWT_SECRET, or connection strings.
- Keep registration/login responses consistent with the agreed API contract; avoid leaking account existence.
- Preserve rate limiting and request-body size limits when modifying authentication routes.
- Do not enable or manually exercise Register against ai_task_manager_dev until its users.email unique index is confirmed to exist. A unique declaration in the Mongoose schema is not proof the database index exists.
- Treat production deployment, credential rotation and public exposure as separate approval-gated tasks.
5. MongoDB Atlas safety boundaries
- The Atlas cluster may also host an unrelated FashionStore database. Never query, write, delete, migrate or modify it.
- ai_task_manager_dev is for development; ai_task_manager_test is the only database permitted for approved integration-test fixtures.
- Integration tests must consume only MONGODB_TEST_URI, never fall back to MONGODB_URI.
- Before any integration-test write: validate the database name in the URI/configuration and verify the connected database name equals ai_task_manager_test. Verify the database user's permissions and required indexes.
- Use a dedicated, least-privilege test database user. Never change Atlas users, roles or network rules without approval.
- Keep autoCreate and autoIndex disabled unless a specifically approved task changes them. Index creation is a separate explicit approval.
- Never run dropDatabase(), dropCollection(), syncIndexes(), unrestricted deleteMany({}), or destructive migrations.
- For authorized tests, use uniquely marked fixtures, record their IDs, clean up only those fixtures, and verify cleanup. Report incomplete cleanup explicitly.
- Do not print environment-variable values, full MongoDB URI, hostnames, usernames, passwords or tokens in reports.
- On Windows, this project has encountered MongoDB SRV DNS ECONNREFUSED; an optional test DNS resolver configuration (MONGODB_TEST_DNS_SERVERS) may be used when already supported by code. Do not hardcode public DNS into multiple modules or change system DNS without approval.
6. Tests and acceptance criteria
Run commands from server/ unless otherwise stated:
- npm test — offline HTTP, schema and authentication tests; must not connect to Atlas.
- npm run test:integration — database-model integration tests; writes and cleans fixtures on ai_task_manager_test; run only when specifically approved and safely configured.
- npm run test:integration:auth — authentication HTTP/database integration tests; same approval and isolation rules.
- npm run dev — start backend for development (requires correctly configured environment and MongoDB connection).
For frontend changes, run the available scripts in client/ (typically npm run lint and npm run build) and report both results.

Before finishing a coding task:
1. Run the tests appropriate to the change; include negative cases and authorization checks where applicable.
2. Inspect git status, git diff --check, and the actual diff (including newly created files).
3. State: files changed; commands run; tests PASS/FAIL/SKIPPED; limitations; required human decisions.
4. If a test fails, investigate the cause. Never remove assertions or silently weaken tests solely to make them pass.
7. Git, secrets and destructive operations
- Do not commit, push, merge, rebase, reset, force-push, deploy or open a pull request without explicit approval.
- Do not overwrite other uncommitted changes. Inspect branch and working-tree status first.
- Preserve the root .gitignore; ensure .env, .env.* (except safe .env.example), node_modules, build output and logs are ignored.
- Do not stage or publish any .env file, credential, private key or token.
- Avoid git add . without inspecting all staged files. Review newly added/untracked files as well as tracked diffs.
- Before any destructive operation, stop and request specific approval with a plain-language explanation of the impact.
8. Response format for each completed task
Reply in Vietnamese with:
1. Goal and scope — what was requested and what was intentionally excluded.
2. Files changed — paths and reasons.
3. Implementation and request/data flow — understandable explanation.
4. Verification — exact commands and actual results, distinguishing offline tests from Atlas integration tests.
5. Security/data impact — any database access, index changes, fixture creation/cleanup, or secret-handling risk.
6. Issues and next step — unresolved problems and one proposed follow-up task.
Never state that the database, API or application works end-to-end based only on mocks or offline unit tests.
## Git Operations — User Controlled

The user exclusively controls all Git and GitHub operations.

Codex MUST NOT execute Git commands.

Codex MUST NOT:
- Create, switch, rename, or delete branches.
- Create or remove Git worktrees.
- Run git add, commit, push, pull, fetch, merge, or rebase.
- Run git stash, reset, restore, or clean.
- Create, approve, or merge Pull Requests.
- Change GitHub repository settings.

Codex MAY:
- Implement approved features.
- Fix approved code issues.
- Run automated tests.
- Explain which source files were changed.
- Suggest Git commands for the user to execute manually.

After completing a coding task, Codex must stop and
wait for the user to perform Git operations.

Never perform Git operations without explicit
instructions from the user.