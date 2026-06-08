# Architecture

## Overview

kazi-lab is a research lab built around four AI agents and a shared Postgres database. The agents operate on a shared corpus of papers, claims, experiments, critiques, and annotations. The database is the substrate; the agents are processes that operate on it.

## Agents

1. Scribe, knowledge layer. Ingests papers, extracts structured fields, builds the corpus.
2. Critic, adversarial review. Argues against claims, identifies counterarguments. (Not built yet.)
3. Experimentalist, code and experiments. Designs and runs experiments, logs results. (Not built yet.)
4. Writer, long-form output. Drafts paper sections, blog posts, project pages. (Not built yet.)

## Integration

Agents integrate through shared database state, not through direct calls. The Scribe writes papers; the Critic reads them and writes critiques; the Experimentalist reads claims and writes experiment results; the Writer reads everything and writes artifacts.

## Office (UI)

The Office is the human-facing interface to the system. Local-only for now. It surfaces what the agents have been doing and lets the human direct the work. Four tabs, one per agent. Currently only the Scribe tab is functional.

## Stack

See CLAUDE.md.

## Status

June 1, 2026: Foundation being built. Scribe v1 in progress. Office shell in progress. Other agents are placeholders.
