# Discovery trust

OpenHub separates three kinds of tools.

| Kind | Source | Can be installed |
| --- | --- | --- |
| Verified Registry tool | `registry/` Manifests, reviewed and validated in CI | yes, through an approved plan |
| Unverified Candidate | public search results (GitHub, npm, the MCP Registry) | **no** |
| Unidentified configured server | an MCP server in your config that matches no Registry tool | no; shown, never assumed |

## Candidates

- `openhub discover` writes Candidates as drafts into `registry-candidates/`. It never writes to `registry/`.
- Candidates are labeled UNVERIFIED and DRAFT. They have no Install, Adopt or Update action and are never recommended.
- Descriptions and install instructions from Candidates are untrusted text: shown as plain text, never parsed into commands and never executed.
- `openhub candidate prepare <candidateId>` writes a local contribution package (draft Manifest, diff, pull request text) for a human to review and submit. OpenHub writes nothing to GitHub.

## Trending and New for your project

- Trending: Not historical star growth: a deterministic score combining current popularity with recent release and repository activity. It does not rate security or code quality.
- New for your project lists Registry tools added recently (per `catalog.yaml`) that fill a gap in this project and are not installed yet.

## Identity matching

Installed servers are matched to Registry tools by exact name and by package or image identity. Only exact and strong matches count; weak or unresolved matches never mark a capability as installed and cannot be adopted.
