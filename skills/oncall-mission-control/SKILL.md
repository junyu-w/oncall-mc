---
name: oncall-mission-control
description: Use when the user asks to set up, start, resume, check or end "mission control", "oncall mission control" or "oncall-mc" for an on-call shift, or gives an on-call shift recipe (Slack channels to watch, how often, and what workers may do). Runs Mission Control in the Herdr app through the oncall-mc CLI.
---

# Oncall Mission Control

Mission Control runs an on-call shift in the Herdr app. It has three kinds of agents:
- An operator agent, in a "Mission Control" space.
- Watcher agents. Each one watches a Slack channel.
- Worker agents, which triage what the watchers find.

A side panel shows the watchers and their tasks.
The `oncall-mc` CLI does everything. Do not build or start these agents yourself.

1. Run `oncall-mc guide` and read all of it before you do anything else. It is the manual.
   - If `oncall-mc` is not on PATH, it is not installed. Ask the user for the repository URL. Then clone it
     to `~/.local/share/oncall-mc` and run `~/.local/share/oncall-mc/bin/oncall-mc install`.
2. Follow the guide's setup flow. In short:
   - `oncall-mc install`
   - Agent commands: ask the user for the model and approval flags, then run `oncall-mc config ...`. Never invent
     flags. Do not run doctor before the user answers.
   - `oncall-mc doctor`, until it passes.
   - `oncall-mc recipe add <name>` with the user's recipe, if they gave one.
   - `oncall-mc start --recipe <name>`
3. Ask the user before anything that stops agents: `start --replace`, or `end --yes`.
4. If the user asked only to install the tool, or asked how to use it, follow the guide's "After an install"
   section: reply with the short summary of prompts. Do not start a session.
