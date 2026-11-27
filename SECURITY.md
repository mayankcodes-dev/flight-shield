# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 3.x     | ✅ Current |
| < 3.0   | ❌ No longer supported |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report security issues privately by emailing the maintainer or by using
[GitHub's private vulnerability reporting](https://github.com/mayankcodes-dev/flight-shield/security/advisories/new).

Include:
- A description of the vulnerability and its potential impact
- Steps to reproduce or a minimal proof of concept
- The version(s) affected

You will receive a response within **72 hours** acknowledging receipt. If the
issue is confirmed, a patch will be released as quickly as possible.

## Scope

flight-shield is a **process-local** library with no network calls, no file
I/O, and no runtime dependencies. The attack surface is limited to:

- **Key collisions** in `serializeKey` allowing cross-caller data leaks
- **Prototype pollution** via crafted input objects
- **Memory exhaustion** via unbounded `MemoryCacheAdapter` entries
  (mitigated by the `maxEntries` constructor argument)

Out of scope: vulnerabilities in your application's own cache backend (Redis,
Memcached) or database — flight-shield does not control those.
