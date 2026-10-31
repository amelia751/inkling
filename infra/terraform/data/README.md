# spurby-data stack

Buckets for data we curate: `public` (public and registered datasets, seed data, demos),
`fixtures` (synthetic e2e and staging data), `releases` (de-identified releases from
`spurby-phi`). The release identity (`studio-release@spurby-phi`, from `../phi`) may only create
objects in `releases`; the perimeter's egress rule (`../org`, `-var release_egress=true`) lets
it through. Same deploy identity and state bucket as `../org` (prefix `data`).

`public_read=true` needs an `iam.allowedPolicyMemberDomains` exception for this project first:
the organization admits only its own identities, and `allUsers` isn't one.
