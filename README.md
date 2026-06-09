# HumanRelay v2 — The Human Layer for Embodied AI

> **Note:** this branch (`claude/humanrelay-review-7985vu`) repurposes this repo to host the
> HumanRelay v2 site rebuild, because the original humanrelay Vercel project has no linked
> Git repository (it was deployed via CLI) and this session could not create a new repo.
> `main` still contains the Third Space Cafe business-plan dashboard.

## Contents

- `BRIEF.md` — positioning, audience, design, and IA brief for the v2 site
- `public/index.html` — the new single-file site (no build step)
- `v1/index.html` — snapshot of the previous site as deployed at humanrelay.vercel.app

## The story

HumanRelay is the one-stop shop for HITL robot and agent data:

1. **Capture** — egocentric data collection (hundreds of hours of 4K first-person video daily)
2. **Annotate** — labeling & evaluation, proven via sister company [IndiVillage](https://indivillage.com) (500M+ annotations)
3. **Judge** — human-in-the-loop API (Classify, Judge, Extract, Escalate, Resolve + Relay decomposition)
4. **Operate** — teleoperation for deployed fleets

Connected by the flywheel: *every intervention is a labeled demonstration.*

## Deploy

Static site, no build: deploy the repo to Vercel (`outputDirectory: public`) or any static host.
Recommended: move this to a dedicated `humanrelay` repo and link it to the existing
`humanrelay` Vercel project, then disable deployment protection for public launch.
