# Plain-Language Contract (technical writing)

Audience assumption: a tired expert reading at 11 pm who will reject anything they
must read twice. Plain language signals mastery; dense language reads as insecurity.

1. TERM BUDGET. Coin at most 2-3 new terms per document, only for a concept used
   5+ times that has no standard name. Define each in one plain sentence at first
   use, and keep a term sheet. Never coin hyphenated compounds (X-bounded, X-aware,
   X-backed, X-driven, X-facing) where a plain phrase works: "family-bounded
   control space" -> "only the knobs that matter for this workload family".

2. ADJECTIVES ARE NOT CLAIMS. Never call your own system conservative, trustworthy,
   robust, principled, or safe unless the same sentence states the measurable
   behavior: "conservative: when the match score is below t, it returns the
   default instead of a tuned setting".

3. ONE NEW IDEA PER SENTENCE. If a sentence introduces two new concepts, split it.
   Do not compress meaning to sound dense; unpacking is not dumbing down.

4. CONCRETE ACTORS. Sentence subjects should be things that act (we, the system,
   the scheduler), not abstractions (evidence, validation, serving, the framework).
   Use verbs, not nominalization chains: "executed validation of transfer" ->
   "we run both workloads and check that the results agree".

5. SAY IT ONCE. Each claim gets one canonical statement in the most important
   place. Elsewhere, refer back; never restate it in fancier words. Every
   re-paraphrase reads to the reviewer as a new, undefined concept.

6. THE READ-ALOUD TEST. If you would not say the sentence to a colleague at a
   whiteboard, rewrite it until you would.

7. NO META-WRITING. Do not describe your own claims ("this defines the paper's
   claim boundary"). Make the claim.

8. DEFINE BEFORE USE. Any term a first-year grad student in the field could not
   define gets a one-line definition at its first occurrence.

Calibration (a real SC reviewer called the BAD version "the most opaque language
I have ever seen in a computer science paper"):

BAD:  "Evidence is never pooled before semantic partition, never attached to trace
       summaries alone, never transferred across workloads without executed
       validation, and never served outside the corresponding family-bounded
       control space."

GOOD: "We reuse a configuration only where its performance was actually measured.
       Traces are first split by interface; two workloads' results are merged only
       when their measured responses agree; and a recommendation is served only to
       workloads in the same family."
