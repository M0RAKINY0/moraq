# Security policy

## Supported versions

moraq has no stable release yet. Only the latest version on `main` gets security fixes. This section will list supported versions once 1.0 ships.

## Reporting a vulnerability

Don't open a public issue.

Report it privately through GitHub: go to the [Security tab](https://github.com/M0RAKINY0/moraq/security/advisories/new) and click "Report a vulnerability". Include:

- what the problem is and what an attacker could do with it
- steps or code to reproduce it
- the moraq version or commit you tested

You'll get a reply within 7 days. Once a fix is ready, it ships before the advisory goes public, and you get credit in the advisory unless you ask not to be named.

## What counts

moraq handles API keys and forwards prompts to third-party providers, so these matter most:

- API keys leaking into logs, errors, cache entries or thrown objects
- cache entries returned to the wrong caller
- requests sent to a host other than the one configured
- a dependency of moraq with a known vulnerability that affects it

Bugs in the providers' own APIs are out of scope. Report those to the provider.
