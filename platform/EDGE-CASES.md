# The Common-Sense Gap — Edge-Case Library

> Every human knows not to drive into a flooded road. No dataset does.

This is the canonical library of **common-sense gap** scenarios: situations deployed
robots and agents hit in the field that **genuinely cannot be in the training set** —
too rare, too new, or too local for any corpus — but that any adult resolves in seconds.
The canonical real-world anchors: an AV meeting a flooded road, construction cones that
contradict the lane markings, a robotaxi rolling into fresh concrete. This is the class
of problem AV companies staff remote-assistance desks for; HumanRelay is that desk,
as an API, for everyone.

**The entry test (strict):** the model could not have had this in training. Two common
failure modes get rejected:
- *Knowledge gaps* — "ask a specialist a thing specialists know" (drug interactions,
  boiler service intervals). That's a database row; models train on it. Cut.
- *Well-corpused judgment* — fraud scripts, common pedestrian interactions. Banks and
  AV labs have millions of examples; a model can be trained on them. Library-only,
  never the site.

Each entry is written as a real Relay trace — the question, the decomposition, the
tiers, and the verdict a trained worker would return.

Used in three places:

1. **The site** — the rotating Relay demo on humanrelay.com (`public/index.html`)
   renders entries marked ★. Keep the two in sync in the same commit.
2. **Sales demos** — run any entry live through `POST /v1/relay` against staging.
3. **Worker calibration** — entries seed gold items: the expected verdicts are
   unambiguous to a calibrated human, which is exactly what makes them gold.

Conventions: 3 binaries per entry (keeps the site card height stable), tier pricing
Basic $0.50 / Complex $1.00 / Expert $2.50, every verdict defensible in a customer call.

---

## ★ 1. The flooded road (delivery robot · the thesis example)

**Asker:** delivery robot
**Question:** "The road ahead is covered in water. Proceed?"

| Binary | Tier | Price |
|---|---|---|
| Does the water span the full width of the road? | Basic | $0.50 |
| Are vehicles ahead stalled or turning around? | Basic | $0.50 |
| Given both: safe to proceed? | Complex | $1.00 |

**Verdict:** "No. Full-width standing water and cars turning back — reroute."
**Meta:** 3 binaries · 2 in parallel · 31 seconds · $2.00 total
**Why it can't be trained:** flooding is rare, local, and visually unique every time;
depth is invisible from a camera frame. Humans don't estimate depth either — they read
the *social* evidence (other drivers turning around) and a lifetime prior about water.

## ★ 2. The contradicting cones (robotaxi · unusual construction)

**Asker:** robotaxi
**Question:** "Construction cones contradict the lane markings ahead. Which do I follow?"

| Binary | Tier | Price |
|---|---|---|
| Do the cones form a single continuous path through the zone? | Basic | $0.50 |
| Is fresh surface work visible where the painted lane runs? | Basic | $0.50 |
| Given both: follow the cones over the markings? | Complex | $1.00 |

**Verdict:** "Follow the cones. The painted lane runs into fresh concrete — the
markings predate today's work."
**Meta:** 3 binaries · 2 in parallel · 28 seconds · $2.00 total
**Why it can't be trained:** every construction zone is improvised that morning, by a
crew, with whatever cones they had. The ground truth (which signal is current) exists
only at that intersection, that day. A robotaxi famously drove into wet concrete over
exactly this.

## ★ 3. The officer at the red light (AV · authority override)

**Asker:** AV
**Question:** "An officer is waving me through a red light. Go?"

| Binary | Tier | Price |
|---|---|---|
| Is the person directing traffic in uniform or hi-vis at an active scene? | Basic | $0.50 |
| Is the gesture clearly directed at this vehicle? | Basic | $0.50 |
| Given both: proceed against the signal? | Complex | $1.00 |

**Verdict:** "Go. Uniformed officer, gesture aimed at you — hand signals override the light."
**Meta:** 3 binaries · 2 in parallel · 31 seconds · $2.00 total
**Why it can't be trained:** a human ordering you to break the written rule, with
improvised gestures, at an incident scene that didn't exist an hour ago. Authority
recognition + intent reading + rule override in one shot — and the right answer is
*yes*, which makes it a terrible thing to learn from data.

## ★ 4. The cable across the path (sidewalk robot · storm aftermath)

**Asker:** sidewalk robot
**Question:** "Storm debris: a cable is hanging across the sidewalk. Pass under it?"

| Binary | Tier | Price |
|---|---|---|
| Is the cable attached to a utility pole at either end? | Basic | $0.50 |
| Are warning markers or utility crews present? | Basic | $0.50 |
| Given both: treat it as live and reroute? | Complex | $1.00 |

**Verdict:** "Reroute. Attached overhead, sagging, no crew on scene — treat it as live."
**Meta:** 3 binaries · 2 in parallel · 27 seconds · $2.00 total
**Why it can't be trained:** downed lines exist for hours after a storm and then
vanish; the corpus is tiny and the visual difference between clothesline and live wire
is contextual, not visual. Humans default to "treat it as live" — a prior about
consequences, not pixels.

## ★ 5. The chicken on the counter (kitchen robot · elapsed-state judgment)

**Asker:** kitchen robot
**Question:** "This chicken was left out during prep. Still safe to cook?"

| Binary | Tier | Price |
|---|---|---|
| Was it unrefrigerated for more than two hours? | Basic | $0.50 |
| Any visible discoloration or off texture? | Basic | $0.50 |
| Given both: safe to cook and serve? | Complex | $1.00 |

**Verdict:** "No. Three hours on the counter — discard and restock."
**Meta:** 3 binaries · 2 in parallel · 26 seconds · $2.00 total
**Why it can't be trained:** the rule is written down; the *state of this kitchen* is
not. What the dataset can't contain is the elapsed history of this particular bird in
this particular afternoon — exactly the context a human on the scene reconstructs in
seconds.

---

## Library (not on the site — weaker under the strict test, still useful operationally)

These are real judgment calls and good dry-run / gold-item content, but a determined
lab *could* train on them (fraud corpora exist; pedestrian interactions are abundant).
Don't use them to argue the thesis to a robotics customer.

## 6. The crosswalk wave (sidewalk robot · social negotiation)

**Question:** "A driver is waving me across, but their car is still rolling. Cross?"
**Binaries:** Has the vehicle come to a complete stop? (Basic) · Is a second lane of
traffic present and unstopped? (Basic) · Given both: cross now? (Complex)
**Verdict:** "No. Wait for the full stop — a wave is not a guarantee."

## 7. The shattered blender (support agent · fraud judgment)

**Question:** "Customer says the blender arrived shattered. Refund $89?"
**Binaries:** Does the photo show a damaged item in its original packaging? (Basic) ·
Is the damage consistent with shipping, not use? (Complex) · Given both: approve the
refund? (Complex)
**Verdict:** "Approve. Outer box intact, crushed corner inside — classic transit damage."
Used by `scripts/seed-dry-run.sh`.

## 8. The grandparent wire (banking agent · social engineering)

**Question:** "82-year-old customer is wiring $9,400 to a 'grandson stranded abroad.'
Process it?"
**Binaries:** Is this payee new on the account? (Basic) · Does the memo match a known
scam script? (Complex) · Given both: hold for a fraud call-back? (Complex)
**Verdict:** "Hold it. New payee plus the stranded-relative script — call the customer first."

## 9. The leaning pallet (warehouse robot · physical hazard)

**Question:** "A pallet stack in aisle 7 is leaning. Pass under it?"
**Binaries:** Is the lean visibly past vertical from two angles? (Basic) · Is the top
layer unsecured? (Basic) · Given both: safe to pass? (Complex)
**Verdict:** "No. Take aisle 8 and flag it — that stack is coming down."
Used by `scripts/seed-dry-run.sh`.

## 10. The dog in the driveway (delivery robot · animal behavior)

**Question:** "A dog is sitting in the delivery path. Continue to the door?"
**Binaries:** Is the dog restrained or fenced? (Basic) · Is its posture relaxed —
ears, tail, stance? (Complex) · Given both: proceed? (Complex)
**Verdict:** "No. Unrestrained and stiff posture — leave the package at the gate."

## 11. The door left ajar (home robot · security vs. courtesy)

**Question:** "Resident's front door is ajar and no one answers. Close it?"
**Binaries:** Any signs of forced entry on frame or lock? (Complex) · Is a resident
visible or audible inside? (Basic) · Given both: close the door or alert? (Complex)
**Verdict:** "Don't touch it. No forced entry but no response — notify the resident
and log video."

---

### Adding entries

A site-worthy (★) edge case has all four:
1. **It cannot be in the training set** — too rare, too new, or too local for any
   corpus. The Waymo-flooded-road test: if a lab could buy or scrape enough examples
   to train on it, it goes in the library section at best, never on the site.
2. **A human resolves it in under a minute** from the context the machine can send.
3. **The wrong answer is expensive** — safety, money, liability, or trust.
4. **The verdict is defensible** — a calibrated worker pool agrees (gold-item quality).

Cut history (so they don't creep back): the boiler (specialist knowledge = lookup),
the pharmacy interaction (drug interactions are a database; models train on it).

Keep site entries (★) at exactly 3 binaries and update `public/index.html` in the same
commit.
