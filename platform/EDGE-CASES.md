# The Common-Sense Gap — Edge-Case Library

> Every human knows not to drive into a flooded road. No dataset does.

This is the canonical library of **common-sense gap** scenarios: questions deployed agents
and robots hit in the field that no training set covers, but any adult resolves instantly.
Each entry is written as a real Relay trace — the question, the decomposition, the tiers,
and the verdict a trained worker would return.

Used in three places:

1. **The site** — the rotating Relay demo on humanrelay.com (`public/index.html`) renders
   entries marked ★. Keep the two in sync when editing.
2. **Sales demos** — run any entry live through `POST /v1/relay` against staging.
3. **Worker calibration** — entries seed gold items: the expected verdicts are
   unambiguous to a calibrated human, which is exactly what makes them gold.

Conventions: 3 binaries per entry (keeps the site card height stable), tier pricing
Basic $0.50 / Complex $1.00 / Expert $2.50, every verdict defensible in a customer call.

---

## ★ 1. The boiler (field service · expert trade)

**Asker:** field-service robot
**Question:** "Should I replace this boiler or repair it?"

| Binary | Tier | Price |
|---|---|---|
| Is the unit more than 15 years old? | Basic | $0.50 |
| Visible corrosion on the heat exchanger? | Expert | $2.50 |
| Flue gas reading within safe limits? | Expert | $2.50 |

**Verdict:** "Replace. Corrosion present, flue reading borderline, unit is 18 years old."
**Meta:** 3 binaries · 2 in parallel · 47 seconds · $5.50 total
**Why models miss it:** the repair-vs-replace call mixes hard thresholds (age) with
trade judgment (what corrosion *on this exchanger* means). Plumbers learn it by seeing
hundreds of boilers; no public dataset shows that.

## ★ 2. The flooded road (delivery robot · the thesis example)

**Asker:** delivery robot
**Question:** "The road ahead is covered in water. Proceed?"

| Binary | Tier | Price |
|---|---|---|
| Does the water span the full width of the road? | Basic | $0.50 |
| Are vehicles ahead stalled or turning around? | Basic | $0.50 |
| Given both: safe to proceed? | Complex | $1.00 |

**Verdict:** "No. Full-width standing water and cars turning back — reroute."
**Meta:** 3 binaries · 2 in parallel · 31 seconds · $2.00 total
**Why models miss it:** depth is invisible from a camera frame. Humans don't estimate
depth either — they read the *social* evidence (other drivers turning around) and apply
a rule nobody ever wrote down.

## ★ 3. The shattered blender (support agent · fraud judgment)

**Asker:** customer-support agent
**Question:** "Customer says the blender arrived shattered. Refund $89?"

| Binary | Tier | Price |
|---|---|---|
| Does the photo show a damaged item in its original packaging? | Basic | $0.50 |
| Is the damage consistent with shipping, not use? | Complex | $1.00 |
| Given both: approve the refund? | Complex | $1.00 |

**Verdict:** "Approve. Outer box intact, crushed corner inside — classic transit damage."
**Meta:** 3 binaries · 2 in parallel · 38 seconds · $2.50 total
**Why models miss it:** "does this story add up" is adversarial — fraud patterns shift
faster than any training set. A human who has seen a thousand claims pattern-matches
the photo against the story in seconds.

## ★ 4. The chicken on the counter (kitchen robot · food safety)

**Asker:** kitchen robot
**Question:** "This chicken was left out during prep. Still safe to cook?"

| Binary | Tier | Price |
|---|---|---|
| Was it unrefrigerated for more than two hours? | Basic | $0.50 |
| Any visible discoloration or off texture? | Basic | $0.50 |
| Given both: safe to cook and serve? | Complex | $1.00 |

**Verdict:** "No. Three hours on the counter — discard and restock."
**Meta:** 3 binaries · 2 in parallel · 26 seconds · $2.00 total
**Why models miss it:** the two-hour rule is folk food-safety knowledge applied with
context (kitchen temperature, raw vs. cooked) that every line cook holds and no
egocentric video labels.

---

## Library (not yet on the site)

## 5. The leaning pallet (warehouse robot · physical hazard)

**Question:** "A pallet stack in aisle 7 is leaning. Pass under it?"
**Binaries:** Is the lean visibly past vertical from two angles? (Basic) · Is the top
layer unsecured? (Basic) · Given both: safe to pass? (Complex)
**Verdict:** "No. Take aisle 8 and flag it — that stack is coming down."
**Why models miss it:** humans have a lifetime prior on how stacked things fall.

## 6. The dog in the driveway (delivery robot · animal behavior)

**Question:** "A dog is sitting in the delivery path. Continue to the door?"
**Binaries:** Is the dog restrained or fenced? (Basic) · Is its posture relaxed —
ears, tail, stance? (Complex) · Given both: proceed? (Complex)
**Verdict:** "No. Unrestrained and stiff posture — leave the package at the gate."
**Why models miss it:** reading animal body language is ancient human competence;
labeled corpora are tiny and the cost of a wrong "proceed" is a headline.

## 7. The grandparent wire (banking agent · social engineering)

**Question:** "82-year-old customer is wiring $9,400 to a 'grandson stranded abroad.'
Process it?"
**Binaries:** Is this payee new on the account? (Basic) · Does the memo match a known
scam script? (Complex) · Given both: hold for a fraud call-back? (Complex)
**Verdict:** "Hold it. New payee plus the stranded-relative script — call the customer."
**Why models miss it:** the transaction is procedurally valid. Only the *story* is wrong,
and scam scripts mutate weekly.

## 8. The door left ajar (home robot · security vs. courtesy)

**Question:** "Resident's front door is ajar and no one answers. Close it?"
**Binaries:** Any signs of forced entry on frame or lock? (Complex) · Is a resident
visible or audible inside? (Basic) · Given both: close the door or alert? (Complex)
**Verdict:** "Don't touch it. No forced entry but no response — notify the resident
and log video."
**Why models miss it:** touching the scene destroys evidence if something is wrong;
the polite action and the safe action diverge. Humans feel that instantly.

## 9. The two medications (pharmacy agent · expert escalation)

**Question:** "Refill request: patient takes warfarin, new scrip is high-dose ibuprofen.
Fill it?"
**Binaries:** Are both prescriptions active for the same patient? (Basic) · Is this a
flagged interaction class? (Expert) · Given both: fill or escalate to the prescriber?
(Expert)
**Verdict:** "Escalate. Known bleed-risk interaction — confirm with the prescriber."
**Why models miss it:** the lookup is easy; the *liability judgment* of fill-vs-call is
what pharmacists are paid for. Expert tier exists for exactly this.

## 10. The crosswalk wave (sidewalk robot · social negotiation)

**Question:** "A driver stopped and is waving me across, but their car is still rolling
slightly. Cross?"
**Binaries:** Has the vehicle come to a complete stop? (Basic) · Is a second lane of
traffic present and unstopped? (Basic) · Given both: cross now? (Complex)
**Verdict:** "No. Wait for the full stop — a wave is not a guarantee."
**Why models miss it:** the gesture says go, the physics says wait. Humans resolve
gesture-vs-evidence conflicts hundreds of times a day; datasets record almost none.

---

### Adding entries

A good edge case has all four:
1. **A human resolves it in under a minute** from the context the machine can send.
2. **No dataset covers it** — it's tacit, social, adversarial, or too rare to label at scale.
3. **The wrong answer is expensive** — safety, money, liability, or trust.
4. **The verdict is defensible** — a calibrated worker pool agrees (gold-item quality).

Keep site entries (★) at exactly 3 binaries and update `public/index.html` in the same
commit.
