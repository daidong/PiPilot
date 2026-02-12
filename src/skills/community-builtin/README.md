# Community Built-in Skills

This directory contains framework-integrated community skills using open directory format:

```text
src/skills/community-builtin/<skill-id>/SKILL.md
src/skills/community-builtin/<skill-id>/scripts/*
```

Project-local user skills use the same layout under:

```text
.agentfoundry/skills/<skill-id>/SKILL.md
.agentfoundry/skills/<skill-id>/scripts/*
```

Included examples:
- `repo-quick-audit`
- `markitdown`
- `citation-management`
- `research-grants`
- `document-docx`

Build note:
- `npm run build` copies this directory to `dist/skills/community-builtin` so published packages can load community skills without source files.
