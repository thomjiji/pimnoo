## Agent skills

### Issue tracker

Issues and specs for this repository live in GitHub Issues. Use `gh` for issue operations. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical triage labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. Read the root `CONTEXT.md` and relevant records under `docs/adr/` when they exist. See `docs/agents/domain.md`.

### Extension plug-in testing

When developing a new extension component or updating an existing one, plug only the components under test into the running Pi. Configure `~/.pi/agent/settings.json`, then reload the session and verify each extension loads exactly once (`pi list` for sources, command/tool listings for registration); a component loaded from two sources registers twice and fails in subtle ways.

- New component (absent from the released package): add its checkout directory to the `extensions` array, e.g. `"extensions": ["/workspace/pimnoo/extensions/<name>"]`. No package filtering needed.
- Updated component (already in the package): exclude it from the git package with an object-form filter and plug the checkout copy, e.g. package entry `{"source": "git:github.com/thomjiji/pimnoo", "extensions": ["!extensions/<name>/**"]}` plus `"extensions": ["/workspace/pimnoo/extensions/<name>"]`.
- Switching the whole package between sources: remove the old entry before installing the new one (`pi remove <path>` then `pi install git:...`). A local path and a git URL are distinct package identities and both load side by side.
