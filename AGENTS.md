# Repository Guidelines

## Project Structure & Module Organization
Source code lives in `src/`. `server.ts` boots Express and hands control to `app.ts`, which composes middleware and routes. Keep domain behavior in `brokers/`, `services/`, and `strategies/`, and share utilities via `utils/`. Shape HTTP contracts under `routes/`, with reusable guards in `middleware/`. Configuration is centralized in `config/env.ts`, reading from `.env`. TypeScript builds land in `dist/`, reference docs belong in `docs/`, and deterministic fixtures can sit in `src/data/`. Co-locate tests as `*.test.ts` beside the code under test or group wider flows in `tests/`.

## Build, Test, and Development Commands
- `npm run dev` starts the hot-reloading dev server via `tsx watch`.
- `npm run build` compiles TypeScript to production JavaScript in `dist/`.
- `npm start` serves the compiled build to mirror production settings.
- `npm run lint` runs ESLint v9 with the TypeScript plugin suite.
- `npm test` executes the Node 18 `node:test` suite over all `*.test.ts` files.

## Coding Style & Naming Conventions
Write modern TypeScript targeting Node 18 with 2-space indentation and double quotes. Keep modules focused on a single responsibility and export domain-named artefacts such as `strategies/momentumStrategy.ts` or `middleware/requestLogger.ts`. Use camelCase for values, PascalCase for types and classes, and UPPER_SNAKE_CASE for constants. Resolve lint warnings at the source rather than disabling rules.

## Testing Guidelines
Use the built-in `node:test` runner with deterministic fixtures from `src/data/`. Cover happy and failure paths for routes and middleware, faking broker calls where needed. Keep suites isolated and quick; ensure `npm test` passes before pushing. Name specs after their target (`app.test.ts`) for easy discovery.

## Commit & Pull Request Guidelines
Follow the existing Git history pattern: short, imperative subjects that capture intent (e.g., "Add broker position hydrator"). Group related edits into one commit and add body context only when behavior shifts. Pull requests should link tracking issues, explain motivation, enumerate local testing, and include API samples or screenshots for user-facing changes.

## Security & Configuration Tips
Never commit secrets—load broker credentials via `.env` and `config/env.ts`. Default production logging to concise levels and enable verbose logs only when diagnosing incidents. Validate broker integrations against sandbox endpoints before targeting live URLs, and strip sensitive data from shared logs.
