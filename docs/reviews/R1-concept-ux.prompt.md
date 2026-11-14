You are an independent, adversarial reviewer for a competition entry. You are read-only. Work only inside the current repository (RollCue). Do not read any other directory.

CHALLENGE: DOO Builders League, "Beyond the Chatbot": what replaces the dashboard and the chatbot in an AI-native world? Requirements: a real product for one real workflow; non-chat and non-dashboard; shows only what the operator needs to decide next; infers intent from real context (not a hardcoded script); proactively initiates at least one useful action; human review before any consequential effect; a side-by-side comparison with the traditional interface; demonstrated recovery from a wrong guess. Disqualifiers: a chatbot with styling, a dashboard with an Ask-AI button, a scripted sequence pretending to be inference, no working demo. Judging: concept clarity 25%, technical depth 25%, demo 20%, failure thinking 15%, thesis 15%.

THIS REVIEW: R1, product concept and user experience.

Attached screenshots, all from the current build at 1440×900 unless noted:
1. first visit (four seeded jobs, already prepared);
2. stickers-final.pdf, a deliberately ambiguous job, flagged "thin evidence";
3. "Not this?" opened on it;
4. after correcting it to Poster;
5. the evidence panel opened (full page);
6. the legacy comparison surface;
7. mobile, 390×844.

Read what you need: README.md, docs/THESIS.md, docs/PRODUCT-THESIS.md, docs/WORKFLOW.md, docs/LEGACY-COMPARISON.md, docs/ARCHITECTURE-DECISIONS.md, ui/src/*.tsx, src/policy.ts, src/service.ts, samples/manifest.json, scripts/make-samples.ts, e2e/*.ts.

YOUR TASKS:
1. **Try hard to show it is a dashboard or a hardcoded flow in disguise.** For example: are the seeded samples' outcomes produced by real inference and policy on the real files, or are they special-cased anywhere by sample id, filename or a fixed table? Does the UI branch on sample ids? Is the "thin evidence" flag computed or staged? Is the queue strip a dashboard? Is the evidence panel a dashboard? Cite file:line for every claim. If you find no special-casing, say so plainly.
2. Concept: is the thesis clear and is it true of the product as built? What would a skeptical judge say in the first 30 seconds? What is weak or confusing?
3. UX: judge the first 30 seconds, spatial hierarchy, the single decision card, the "Not this?" recovery, copy quality, empty and loading states, keyboard and mobile. List the concrete problems you can see in the screenshots or code, ranked by impact on a judge. For each, give the smallest fix.
4. Legacy comparison: is it fair? Is the method sound? What would make it more convincing without making it dishonest?
5. Any claim in the docs that the code does not support.

FORMAT: plain markdown, at most about 1500 words. Number each finding R1-1, R1-2, … with a severity (blocker / major / minor / nit), evidence (file:line or screenshot number), and the smallest fix. End with a one-paragraph verdict, including whether it passes the "not a dashboard, not a chatbot, not a scripted flow" bar.
