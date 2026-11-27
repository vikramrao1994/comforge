# 0005 — The public source starts from a reviewed import, not transferred history

Status: accepted.

The packages were developed inside a private application repository. Their source moved here as
one reviewed, disclosure-scanned import instead of transferred history, because commit messages
of the private history reference private work. Published history stays verifiable: every release
tag, release branch, `RELEASE.json` (source commit, toolchain, file and tarball digests) and npm
provenance record is unchanged.
