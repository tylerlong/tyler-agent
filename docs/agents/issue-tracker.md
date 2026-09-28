# Issue tracker: GitHub

Issues and specs for this repo live in GitHub Issues. Use `gh` from this repository to create, read, update, label, and close them.

## Conventions

- Create: `gh issue create --title "..." --body-file <file>`
- Read: `gh issue view <number> --comments`
- List: `gh issue list --state open`
- Comment: `gh issue comment <number> --body-file <file>`
- Add or remove a label: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- Close: `gh issue close <number>`

Infer the repository from the Git remote.

## Pull requests as a triage surface

PRs as a request surface: no.

## Skill terminology

"Publish to the issue tracker" means create a GitHub issue.
"Fetch the relevant ticket" means read the GitHub issue.
Use GitHub's native sub-issues and issue dependencies when a skill needs parent or blocker relationships.
