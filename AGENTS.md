# Repository Guidelines

## Project Structure & Module Organization
Source lives in `src/`. `server.ts` boots the HTTP server and delegates to `app.ts`, which wires middleware and routers. Domain-specific logic stays in `brokers/`, `services/`, and `strategies/`; shared helpers belong in `utils/`. Request/response shaping sits in `routes/` alongside validation middleware, while reusable request guards live in `middleware/`. Configuration is centralized in `config/env.ts`, which reads `.env` values. Keep generated assets in `dist/` via the TypeScript compiler, and place long-form docs or diagrams under `docs/`.

## Build, Test, and Development Commands
`npm run dev` starts the Express app with `tsx watch` for hot reload. `npm run build` compiles TypeScript into `dist/`. `npm start` serves the compiled build; use it to verify production configs. `npm run lint` runs ESLint v9 with the TypeScript plugin suite. `npm test` executes Node’s built-in test runner against all `*.test.ts` files.

## Coding Style & Naming Conventions
Write modern TypeScript targeting Node 18+. Use 2-space indentation and favor double quotes, matching existing modules. Keep files module-scoped (one responsibility per file). Name files and exports after their domain (`strategies/momentumStrategy.ts`, `middleware/requestLogger.ts`). Use camelCase for functions/variables, PascalCase for classes/types, and UPPER_SNAKE_CASE for constants. Run `npm run lint` before opening a PR; fix issues rather than suppressing rules unless discussed.

## Testing Guidelines
Author unit or integration specs with the `node:test` API and co-locate them as `*.test.ts` beside the code under test or in `tests/` when covering cross-cutting flows. Prefer deterministic fixtures in `src/data/` and stub broker calls through lightweight fakes. Ensure new middleware and routes include happy-path and failure-path coverage. Aim to keep the suite green with `npm test` prior to committing.

## Commit & Pull Request Guidelines
Follow the existing git log: short, imperative subjects that state intent (e.g., “Add broker position hydrator”). Group related changes into a single commit, and include additional context in the body when behavior shifts. Pull requests should link any tracking issue, describe the motivation, list testing performed, and attach API response samples or screenshots for client-facing changes. Request review once CI and linting are clean.

## Security & Configuration Tips
Never commit secrets—supply broker keys and toggles via a local `.env` file (see `config/env.ts` for expected names). Treat logging settings cautiously in production; disable verbose request logging unless troubleshooting. Validate external integrations against sandbox endpoints before pointing at live broker URLs.
