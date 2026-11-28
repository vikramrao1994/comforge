# 0003 — One active publisher, owner-signed per candidate

Status: accepted.

A package version is published only from a candidate built by CI without a credential and
authorized by the owner's offline signature over that candidate's digest, the source commit and
the workflow digest. There is one active publisher at a time; moving publication is an owner
action ([release governance](../contributing/release-governance.md)).
