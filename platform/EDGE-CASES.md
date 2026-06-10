# The Common-Sense Gap — Edge-Case Library

> Every human knows not to drive into a flooded road. No dataset does.

This is the canonical library of **common-sense gap** scenarios: cases where a deployed
agent or robot needs an answer, the model can't be trusted to produce one, and a human
verifies in seconds. The unifying test: **more training data does not fix this case.**

It comes in two flavors — keep both represented on the site:

1. **Out-of-distribution situations** (robots, AVs): the physical world produced
   something too rare, too new, or too local for any corpus — the flooded road, the
   construction cones contradicting lane paint, the robotaxi rolling into fresh
   concrete. This is what AV companies staff remote-assistance desks for.
2. **Long-tail instance ambiguity** (agents — the higher-volume case): the *category*
   is in every training set, but *this instance* lives in the tail. The customer's
   photo is 60% wasp; field-guide images didn't help. 60% isn't good enough when the
   dispatch, the listing, or the compliance hold rides on it. Human verification is
   the product.

**Rejected flavors** (the cut history at the bottom keeps them from creeping back):
- *Knowledge gaps* — "ask a specialist a thing specialists know" (drug interactions,
  boiler service intervals). That's a database row; models train on it.
- *Well-corpused judgment* — known fraud scripts, routine pedestrian interactions.
  Labs have millions of examples. Library-only, never the site.

Each entry is written as a real Relay trace — the question, the decomposition, the
tiers, and the verdict a trained worker would return.

Used in three places:

1. **The site** — the rotating Relay demo on humanrelay.com (`public/index.html`)
   renders entries marked ★. Keep the two in sync in the same commit.
2. **Sales demos** — run any entry live through `POST /v1/relay` against staging.
3. **Worker calibration** — entries seed gold items: the expected verdicts are
   unambiguous to a calibrated human, which is exactly what makes them gold.

Conventions: tier pricing Basic $0.50 / Complex $1.00 / Expert $2.50; every verdict
defensible in a customer call. **Robot/AV cases are usually `strategy=direct`** — an
image is sent, a question is asked, one human answers; don't force a decomposition
where one look resolves it. Decomposed entries keep exactly 3 binaries (stable site
card height). **Every site card shows the attached frame** as an inline SVG
illustration drawn in-brand (flat shapes, muted scene palette, vermillion accents,
an "attached frame" chip) — never real or stock photos posing as customer data,
never fake EXIF/timestamps. Illustrative is honest; fake-real is not.

---

## ★ 1. Bee or wasp (pest-control agent · long-tail image verification — the default card)

**Asker:** pest-control dispatch agent
**Question:** "Customer photo: what's nesting in the wall — bees or wasps? Model says
60% wasps."

| Binary | Tier | Price |
|---|---|---|
| Are the insects fuzzy rather than smooth and shiny? | Basic | $0.50 |
| Is the nest waxy comb rather than papery layers? | Basic | $0.50 |
| Given both: dispatch an exterminator rather than a beekeeper? | Complex | $1.00 |

**Verdict:** "Bees. Fuzzy bodies on wax comb — book a live removal, not an exterminator."
**Meta:** 3 binaries · 2 in parallel · 26 seconds · $2.00 total
**Why more data doesn't fix it:** classifiers ace field-guide photos and fail on what
customers actually send — backlit, blurry, half a nest behind drywall. The fork is
consequential: honeybees are protected and get a beekeeper; wasps get poison. A wrong
dispatch costs a truck roll either way.

## ★ 2. The flooded road (delivery robot · the thesis example · strategy=direct)

**Asker:** delivery robot, sending a camera frame
**Question:** "Is this safe to drive through?" + `content: {image_url}`

**Trace:** direct — already one question. One trained human looks at the frame
(Complex, $1.00). No decomposition: a robot's escalation is an image and a question,
and the answer is one judgment.

**Answer:** "No. Water spans the road and cars are turning back — reroute."
**Meta:** direct · 1 human · 19 seconds · $1.00 total
**Why more data doesn't fix it:** flooding is rare, local, and visually unique every
time; depth is invisible from a camera frame. Humans read the *social* evidence (other
drivers turning around) and a lifetime prior about water.

## ★ 3. The counterfeit listing (marketplace agent · adversarial long tail)

**Asker:** marketplace agent
**Question:** "New listing: is this $1,400 handbag authentic? Model confidence: 58%."

| Binary | Tier | Price |
|---|---|---|
| Is the date code format valid for the claimed production year? | Basic | $0.50 |
| Do the logo stamp font and spacing match the brand's? | Complex | $1.00 |
| Given both: approve the listing? | Complex | $1.00 |

**Verdict:** "Reject. Date-code format was retired years before the claimed year —
counterfeit."
**Meta:** 3 binaries · 2 in parallel · 33 seconds · $2.50 total
**Why more data doesn't fix it:** counterfeits are adversarial — new fakes are
manufactured specifically to beat last season's detectors. The tail regrows weekly.
Marketplaces run human authentication desks for exactly this; we're that desk by API.

## ★ 4. The contradicting cones (robotaxi · unusual construction · strategy=direct)

**Asker:** robotaxi, sending a camera frame
**Question:** "Cones contradict the lane markings. Which do I follow?" + `content: {image_url}`

**Trace:** direct — one trained human looks at the frame (Complex, $1.00).

**Answer:** "The cones. That painted lane runs into fresh concrete."
**Meta:** direct · 1 human · 22 seconds · $1.00 total
**Why more data doesn't fix it:** every construction zone is improvised that morning,
by a crew, with whatever cones they had. The ground truth (which signal is current)
exists only at that intersection, that day. A robotaxi famously drove into wet
concrete over exactly this.

## ★ 5. The eagle in the drone frame (survey agent · expert-tier long tail)

**Asker:** environmental survey agent
**Question:** "Drone frame from the turbine site: common buzzard or protected golden
eagle?"

| Binary | Tier | Price |
|---|---|---|
| Are white patches visible at the base of the primaries? | Basic | $0.50 |
| Is the tail pattern consistent with a juvenile golden eagle? | Expert | $2.50 |
| Given both: log a protected-species sighting and hold work? | Complex | $1.00 |

**Verdict:** "Golden eagle, juvenile. Log the sighting and hold work in the buffer zone."
**Meta:** 3 binaries · 2 in parallel · 41 seconds · $4.00 total
**Why more data doesn't fix it:** bird classifiers are excellent on clear adult
specimens and punt on distant, motion-blurred juveniles — the exact frames compliance
decisions hang on. A raptor specialist reads plumage stage + structure in one look.
This is the expert tier earning its price on a *perception* call, not a lookup.

---

## Library (not on the site — weaker under the test, still useful operationally)

Real judgment calls and good dry-run / gold-item content, but either the corpus exists
or the case is narrower than the thesis. Don't use these to argue the thesis in a
customer call.

## 6. The officer at the red light (AV · authority override)

**Question:** "An officer is waving me through a red light. Go?"
**Binaries:** Is the person directing traffic in uniform or hi-vis at an active scene?
(Basic) · Is the gesture clearly directed at this vehicle? (Basic) · Given both:
proceed against the signal? (Complex)
**Verdict:** "Go. Uniformed officer, gesture aimed at you — hand signals override the light."

## 7. The cable across the path (sidewalk robot · storm aftermath)

**Question:** "Storm debris: a cable is hanging across the sidewalk. Pass under it?"
**Binaries:** Is the cable attached to a utility pole at either end? (Basic) · Are
warning markers or utility crews present? (Basic) · Given both: treat it as live and
reroute? (Complex)
**Verdict:** "Reroute. Attached overhead, sagging, no crew on scene — treat it as live."

## 8. The chicken on the counter (kitchen robot · elapsed-state judgment)

**Question:** "This chicken was left out during prep. Still safe to cook?"
**Binaries:** Was it unrefrigerated for more than two hours? (Basic) · Any visible
discoloration or off texture? (Basic) · Given both: safe to cook and serve? (Complex)
**Verdict:** "No. Three hours on the counter — discard and restock."
Used by `scripts/seed-dry-run.sh`.

## 9. The crosswalk wave (sidewalk robot · social negotiation)

**Question:** "A driver is waving me across, but their car is still rolling. Cross?"
**Binaries:** Has the vehicle come to a complete stop? (Basic) · Is a second lane of
traffic present and unstopped? (Basic) · Given both: cross now? (Complex)
**Verdict:** "No. Wait for the full stop — a wave is not a guarantee."

## 10. The shattered blender (support agent · fraud judgment)

**Question:** "Customer says the blender arrived shattered. Refund $89?"
**Binaries:** Does the photo show a damaged item in its original packaging? (Basic) ·
Is the damage consistent with shipping, not use? (Complex) · Given both: approve the
refund? (Complex)
**Verdict:** "Approve. Outer box intact, crushed corner inside — classic transit damage."
Used by `scripts/seed-dry-run.sh`.

## 11. The grandparent wire (banking agent · social engineering)

**Question:** "82-year-old customer is wiring $9,400 to a 'grandson stranded abroad.'
Process it?"
**Binaries:** Is this payee new on the account? (Basic) · Does the memo match a known
scam script? (Complex) · Given both: hold for a fraud call-back? (Complex)
**Verdict:** "Hold it. New payee plus the stranded-relative script — call the customer first."

## 12. The leaning pallet (warehouse robot · physical hazard)

**Question:** "A pallet stack in aisle 7 is leaning. Pass under it?"
**Binaries:** Is the lean visibly past vertical from two angles? (Basic) · Is the top
layer unsecured? (Basic) · Given both: safe to pass? (Complex)
**Verdict:** "No. Take aisle 8 and flag it — that stack is coming down."
Used by `scripts/seed-dry-run.sh`.

## 13. The dog in the driveway (delivery robot · animal behavior)

**Question:** "A dog is sitting in the delivery path. Continue to the door?"
**Binaries:** Is the dog restrained or fenced? (Basic) · Is its posture relaxed —
ears, tail, stance? (Complex) · Given both: proceed? (Complex)
**Verdict:** "No. Unrestrained and stiff posture — leave the package at the gate."

## 14. The door left ajar (home robot · security vs. courtesy)

**Question:** "Resident's front door is ajar and no one answers. Close it?"
**Binaries:** Any signs of forced entry on frame or lock? (Complex) · Is a resident
visible or audible inside? (Basic) · Given both: close the door or alert? (Complex)
**Verdict:** "Don't touch it. No forced entry but no response — notify the resident
and log video."

---

### Adding entries

A site-worthy (★) edge case has all four:
1. **More training data doesn't fix it** — either the situation is out-of-distribution
   (too rare, too new, too local for any corpus) or the instance sits in the long tail
   where model confidence is stuck around 60% and 60% isn't good enough. If a lab
   could buy or scrape its way to reliability on this case, it's library-only.
2. **A human resolves it in under a minute** from the context the machine can send.
3. **The wrong answer is expensive** — safety, money, liability, or trust.
4. **The verdict is defensible** — a calibrated worker pool agrees (gold-item quality).

Mix both flavors on the site: agent-side long-tail verification is the volume business;
robot/AV out-of-distribution scenes are the thesis anchor.

Cut history (so they don't creep back): the boiler (specialist knowledge = lookup),
the pharmacy interaction (drug interactions are a database; models train on it).

Robot/AV entries default to `strategy=direct` (image + question → one human);
decomposed entries keep exactly 3 binaries. Update `public/index.html` in the same
commit.
