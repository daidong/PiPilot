# Research Pilot Default Project Skills

These skills are application-specific defaults for Research Pilot.

Directory layout:

```text
examples/research-pilot/skills/default-project-skills/<skill-id>/SKILL.md
examples/research-pilot/skills/default-project-skills/<skill-id>/scripts/*
```

Included skills:
- `citation-management`
- `research-grants`
- `matplotlib`

Desktop startup seeds these into each opened project at:

```text
.agentfoundry/skills/<skill-id>
```

Seeding is non-destructive: existing project-local skills are not overwritten.
