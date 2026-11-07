# Releasing moraq

A release is a GitHub Release. Publishing one with a tag like `v0.2.0` runs `.github/workflows/publish.yml`. That workflow runs every check, builds the package and publishes that version to npm with provenance.

`package.json` in the repo stays at `0.0.0`. The workflow sets the real version from the tag at publish time, so releasing never needs a commit to `main`.

## Every release

1. Make sure `main` is green and has everything you want to ship.
2. Pick the version. Before 1.0, a `feat` means a minor bump (`0.1.0` → `0.2.0`) and a `fix` means a patch (`0.2.0` → `0.2.1`). A breaking change also gets a minor bump while moraq is below 1.0.
3. On GitHub, go to **Releases → Draft a new release**.
   - **Tag:** `v0.2.0`, created on `main`.
   - Click **Generate release notes**. The notes come from the PR titles, which follow Conventional Commits.
   - Tick **Set as a pre-release** for versions like `v0.3.0-beta.1`. Those publish under the `next` npm tag, so `npm install @moraq/core` doesn't pick them up.
4. Click **Publish release**, then watch the **Publish** workflow under Actions.

If a check fails, nothing gets published. Fix it on `main`, delete the release and its tag, and publish again.

## One-time setup (before the first release)

npm's trusted publishing lets the workflow publish without an npm token. On npm you can only configure it for a package that already exists, so the very first version goes out by hand.

1. Create an account on [npmjs.com](https://www.npmjs.com) and turn on two-factor authentication.
2. Publish `0.1.0` from your machine:

   ```sh
   git switch main && git pull
   npm ci && npm run build
   npm version 0.1.0 --no-git-tag-version
   npm login
   npm publish --access public --provenance=false
   git checkout package.json package-lock.json
   ```

3. On npmjs.com, open the `@moraq/core` package, then **Settings → Trusted publishing**, and add GitHub Actions with:
   - Organization or user: `M0RAKINY0`
   - Repository: `moraq`
   - Workflow filename: `publish.yml`
4. Still under the package settings, set **Publishing access** to require two-factor authentication and disallow tokens. From then on, only the workflow can publish.
5. Create the `v0.1.0` GitHub Release so the history matches. The workflow sees that `0.1.0` is already on npm and skips publishing.

Every release after that is just the steps under "Every release".
