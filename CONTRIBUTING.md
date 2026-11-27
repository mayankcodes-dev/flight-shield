# Contributing to flight-shield

Thank you for your interest in contributing.

## Before you open a PR

1. **Open an issue first** for significant changes — bugs, features, API changes.
   Small fixes (typos, docs) can go straight to a PR.

2. **One concern per PR.** Keep pull requests focused; it makes review faster.

## Development setup

```sh
git clone https://github.com/mayankcodes-dev/flight-shield.git
cd flight-shield
npm install
npm run build
npm test
```

## Rules

- **Tests are required.** Every bug fix must include a regression test named
  after the specific behaviour it proves. Every new feature must include tests
  covering the happy path and at least one edge case.
- **No new runtime dependencies.** flight-shield is intentionally
  zero-dependency. Dev dependencies are fine.
- **TypeScript only.** All source lives in `src/`. Do not edit `dist/`.
- **Keep the public API minimal.** New exports must be justified.

## Running checks

```sh
npm test                # vitest — 63 regression tests
npm run build           # tsup — ESM + CJS + DTS
npm run check:exports   # publint export correctness
npm run bench           # mitata benchmarks
```

All checks must pass before a PR is merged. The `prepublishOnly` script runs
all three automatically on `npm publish`.

## Commit style

Use the [Conventional Commits](https://www.conventionalcommits.org/) format:

```
feat(shield): add waitUntil option for serverless runtimes
fix(batch): Map missing-key routes through resolveEntry
docs: update Redis adapter example in README
chore: bump version to 3.4.0
```

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md).
By participating you agree to abide by its terms.
