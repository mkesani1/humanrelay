# HumanRelay v2 — Site Brief

**Working title:** The Human Layer for Embodied AI
**Deliverable:** Single-page marketing site (no build step, single HTML file, deployable to Vercel)
**Date:** June 2026

---

## 1. What HumanRelay is becoming

HumanRelay evolves from a human-judgment API into the **one-stop shop for human data and human judgment for robots and AI agents**. Four products, one pipeline:

| # | Product | What it is | Status |
|---|---------|-----------|--------|
| 1 | **Capture** | Egocentric data collection — 4K first-person video of real human work | Live: hundreds of hours/day, growing fast |
| 2 | **Annotate** | Annotation, labeling, and evaluation | Proven: delivered via sister company [IndiVillage](https://indivillage.com), 500M+ annotations |
| 3 | **Judge** | Human-in-the-loop API — five primitives (Classify, Judge, Extract, Escalate, Resolve) + Relay decomposition | Existing HumanRelay product |
| 4 | **Operate** | Teleoperation — real-time human intervention for deployed robot fleets | New offer |

**The connecting idea (the flywheel):** *Every intervention is a labeled demonstration.* A deployed robot escalates → a HumanRelay operator resolves it in real time (Judge or Operate) → the intervention is recorded, annotated (Annotate), and returned as training-ready data → the customer's next model needs fewer escalations. Data exhaust becomes the product.

## 2. Audiences (priority order)

1. **Humanoid & robotics companies** — buying pretraining data and needing a 24/7 human fallback for deployed fleets. They care about: data specs, daily throughput, QA process, latency/SLA, security, one-vendor convenience.
2. **Frontier labs** — training VLA / world models, running RLHF and evals. They care about: scale, diversity, provenance & consent, taxonomy rigor, expert evaluators.
3. **Investors** — evaluating the company. They care about: the data-bottleneck thesis, real traction numbers, the IndiVillage moat, the flywheel, the ethical-workforce story.

The site must work for all three without splitting into separate pages: lab/robotics buyers get specs and APIs; investors get narrative and numbers.

## 3. Positioning & message hierarchy

- **H1:** "The human layer for agents and robots."
- **Core argument:** AI is starved for human data and human judgment. HumanRelay runs the entire human side of the AI stack — capture, annotation, real-time judgment for agents, teleoperation for robots — with managed teams in offices, not anonymous gig workers. Embodied AI is the growth story; agents that need humans in the loop are an equal, here-today market.
- **Key differentiators (in order):**
  1. **Managed, not gig.** Salaried, trained, office-based teams. Same people on your project every day. Quality, security, and consistency that gig platforms structurally cannot offer.
  2. **Proven via IndiVillage.** The annotation claims aren't aspirational — the sister company has delivered 500M+ annotations for global AI teams.
  3. **Already capturing.** Hundreds of hours of 4K egocentric video per day, today, and growing.
  4. **Real-time, not just batch.** Sub-minute HITL responses and live teleoperation — the layer gig/batch vendors can't do.
  5. **The flywheel.** One vendor from pretraining data to deployment fallback, where every escalation feeds back into training data.

## 4. Proof points (use these; do not inflate)

- Hundreds of hours of 4K egocentric video captured **daily**, growing fast
- 500M+ annotations delivered (IndiVillage track record)
- 1,200+ managed professionals — office-based, salaried, trained
- 99%+ QA accuracy · 98% client retention · 20+ global clients
- Impact-sourcing workforce model (IndiVillage) — a genuine ESG story for enterprise procurement and investors

**Rule:** every number on the page must be one we can defend in a customer call. No fake logos, no invented testimonials. Where we lack social proof, lean on concrete operational detail instead — specifics are more credible than adjectives.

## 5. Voice & design direction

- **Voice:** confident, concrete, numbers-forward. Short declarative sentences. Zero hype-words ("revolutionary", "cutting-edge"). The reader should feel they're dealing with operators, not marketers.
- **Visual:** keep the v1 brand DNA — warm paper background (`#F5F0E8`), vermillion accent (`#E05A33`), dark charcoal sections — it's distinctive against the sea of dark-gradient AI sites. Elevate it with an editorial serif display face (Fraunces) over Inter body text. Generous whitespace. Diagrams over decoration: the flywheel and the Relay decomposition should be drawn, not described.
- **Performance:** single HTML file, system-light (<200 KB), no frameworks, WCAG-friendly contrast, fully responsive.

## 6. Information architecture

1. **Hero** — H1, subhead, dual CTA (Start a Pilot / Request Sample Data), stat bar
2. **The Stack** — four pillar cards: Capture · Annotate · Judge · Operate
3. **The Flywheel** (dark section) — "Every intervention is a labeled demonstration"
4. **Capture** — specs, throughput, consent & provenance, managed capture centers
5. **Annotate** — the IndiVillage story, service catalogue
6. **Judge** — five primitives, Relay decomposition demo, working code samples, per-call pricing
7. **Operate** — teleoperation for deployed fleets, safety confirmations, intervention-to-data loop
8. **Workforce** — "Managed teams. Not gig workers." Quality / Security / Impact
9. **Who it's for** — humanoid companies · frontier labs · investors (one card each, tailored CTA)
10. **Pricing** — four columns matching the four pillars
11. **FAQ** — filterable, 8+ real questions
12. **CTA + footer**

## 7. Functional requirements (fix every v1 facade)

- [ ] No dead links: every nav/footer link resolves to a real target
- [ ] Code tabs actually switch content (Python / cURL / MCP)
- [ ] FAQ category filters actually filter
- [ ] Email CTA works without a backend (prefilled `mailto:` compose) until a form endpoint exists
- [ ] `<meta>` description, Open Graph + Twitter tags, favicon
- [ ] Remove the non-functional dark-mode toggle (ship one polished theme)
- [ ] At launch: disable Vercel deployment protection so the public can actually see the site

## 8. CTAs

- **Primary:** Start a Pilot → `mailto:hello@humanrelay.ai` prefilled
- **Secondary:** Request Sample Dataset → prefilled mailto
- **Investor:** Request the Investor Memo → prefilled mailto

## 9. Out of scope (this iteration)

Blog, documentation portal, customer logos/testimonials (until real), legal pages (Privacy/Terms — link nothing rather than link `#`), form backend, analytics.
