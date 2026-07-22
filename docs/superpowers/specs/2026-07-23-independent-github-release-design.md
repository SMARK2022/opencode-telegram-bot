# Independent GitHub Release Design

Date: 2026-07-23
Status: approved

## Goal

Publish this codebase as an independent public repository at
`SMARK2022/opencode-telegram-bot`, without GitHub fork metadata or a runtime
dependency on the upstream repository. Releases are distributed through GitHub
Release assets rather than npm.

## Repository Identity

- GitHub repository: `SMARK2022/opencode-telegram-bot`
- Package name: `@smark2022/opencode-telegram-bot`
- First independent release: `v0.22.4`
- CLI command remains `opencode-telegram`
- The existing upstream remote is retained locally as `upstream`; the new
  standalone repository becomes `origin`.

## CI And Release

`ci.yml` runs install, lint, build, and tests for pushes and pull requests to
`main`, plus manual dispatch.

`publish.yml` runs only from a version tag or a manual dispatch whose selected
ref is that exact version tag. It verifies `v<package version>`, runs the same
quality gates, compiles TypeScript, creates an installable `npm pack` tarball,
writes a SHA-256 checksum, and uploads both files to a GitHub Release. It never
publishes to npm and requires no npm token or trusted-publisher setup.

## Release Flow

1. Commit the package identity, documentation, and workflow changes.
2. Create the standalone public repository through `gh`.
3. Push `main` and wait for CI.
4. Create and push `v0.22.4` only after CI passes.
5. Wait for the Release workflow and verify the release assets.

The historical upstream `v0.22.3` tag is not pushed to the new repository. The
first GitHub Release therefore represents the complete independent distribution.

## Installation

Users download `smark2022-opencode-telegram-bot-0.22.4.tgz` from the GitHub
Release and run `npm install -g <downloaded-tarball>`. The package includes the
compiled `dist` directory and exposes the unchanged `opencode-telegram` binary.

## Failure Boundaries

- A tag/package-version mismatch fails before building or releasing.
- Lint, build, test, or packaging failure prevents release creation.
- Main-branch pushes never create releases.
- Existing releases and tags are not recreated by the workflow.
- npm credentials and npm package ownership are outside this design.
