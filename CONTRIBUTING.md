# Contributing to moraq

moraq is early. The core design is still moving, so talk before you code.

## Before you start

- **Bugs:** open an issue with the bug report template. Include a minimal reproduction.
- **Features or API changes:** open a feature request issue first and wait for a reply. A PR for a feature nobody agreed on will probably be closed, even if the code is good.
- **Small fixes** (typos, docs, obvious one-line bugs): go straight to a PR.
- **Security issues:** never in a public issue. See [SECURITY.md](SECURITY.md).

## Setup

You need Node 22 or newer. The version CI uses is in `.nvmrc`.

```sh
git clone https://github.com/<your-username>/moraq.git
cd moraq
npm ci
```

## Making a change

1. Fork the repo and create a branch from `main`.
2. Keep the PR to one change. Two unrelated fixes means two PRs.
3. Add or update tests for any behaviour change.
4. Run the checks locally before pushing:

   ```sh
   npm run lint --if-present
   npm run typecheck --if-present
   npm run test --if-present
   ```

5. Open the PR and fill in the template.

`main` is protected. Every change, including the maintainer's, lands through a PR that passes CI.

## Rules for library code

- **No new runtime dependencies** without discussing it in an issue first. moraq aims to ship with zero or close to zero.
- **No vendor SDKs.** Providers are called with `fetch`.
- **No API keys in code, tests or fixtures.** Recorded responses must have keys and personal data stripped.
- **Tests never call real provider APIs.** Use the fake `fetch` and recorded fixtures.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`. Mark breaking changes with `!`, e.g. `feat!: rename createMoraq option`.

## Code of conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
