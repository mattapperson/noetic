# Security Policy

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Instead, report them privately through GitHub's built-in private vulnerability
reporting:

1. Go to the [**Security** tab](https://github.com/mattapperson/noetic/security)
   of this repository.
2. Click **Report a vulnerability** to open a private advisory.
3. Provide a description of the issue, the affected package(s) and version(s),
   steps to reproduce, and the potential impact.

This creates a private channel visible only to you and the maintainers.

If you are unable to use GitHub's private reporting, you can instead email
**security@noetic.tools** with the same details.

You should receive an acknowledgement within a few business days. We will work
with you to understand and validate the issue, prepare a fix, and coordinate
disclosure. Please give us a reasonable window to release a fix before any
public disclosure.

## Supported Versions

Noetic is pre-1.0 and under active development. Security fixes are applied to the
**latest released version** of each affected `@noetic-tools/*` package. We
recommend always running the most recent release.

## Scope

This policy covers the packages published from this repository
(`@noetic-tools/*` and related `@noetic/*` packages) and the repository
tooling. Vulnerabilities in third-party dependencies should be reported to the
respective upstream projects; if a dependency issue affects Noetic users, we
appreciate a heads-up via the private channel above so we can bump or patch.
