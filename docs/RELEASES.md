# BrokkAi adapter releases

Publish `@brokkai/codex-acp` from `BrokkAi/codex-acp`. Keep the `codex-acp` executable name and pin the supported Codex version exactly. Upstream remains a source of updates, not a publication destination.

Run `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, and `npm pack`. Validate new mj guardian and yolo sessions locally with the packaged adapter before publishing. Guardian must preserve configured workspace grants across successive turns and route escalation through automatic review; yolo must run without sandbox restrictions or approval requests.

Update the version and changelog, commit package.json and package-lock.json, and push the tested commit to BrokkAi main. Create and push its matching `vX.Y.Z` tag. The publish.yml workflow verifies package identity and version, runs checks, packs the artifact, then publishes that exact tarball to npm and attaches it to a GitHub release. There is no automatic preview publish or upstream registry dispatch.

The npm package must have a trusted publisher for repository `BrokkAi/codex-acp`, workflow `publish.yml`, environment `release`. Bootstrap the new package with an authorized npm maintainer if necessary, then configure trusted publishing. No npm tokens are stored in this repository. The release environment must allow version tags. Enable Actions after installing this fork's workflows.

For recovery, dispatch publish.yml with the existing tag. Published npm versions are immutable and skipped during recovery. Never move a published tag. Verify the npm version and GitHub tarball, then update mj's exact package pin and lockfile and its container image installation.
