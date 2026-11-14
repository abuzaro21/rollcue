# Product thesis

Short version: [THESIS.md](THESIS.md). This is the longer argument.

## The workflow

A small roll-fed print shop (one wide-format printer-cutter, vinyl and label stock on rolls) receives a steady stream of customer files: stickers for a market stall, jar labels, a window poster, a shop banner. Before anything prints, someone in prepress must answer the same questions for every file:

1. What is this job? The filename, the notes, the order form and the artwork often disagree.
2. Will it print well at the ordered size? Is the resolution enough?
3. Does it need a cut path? Is there one, and is it named the way the cutter expects?
4. Does it fit the roll, with margins?
5. If something is wrong, can I fix it, or must I ask the customer?

Today this is done in a preflight tool built as a workstation: a job list, a ticket form, a preflight report, a cut-and-offsets tab, an output tab. Every job walks through every tab. The software is good at checking, but it never starts. The operator types in what the job is, picks the checks, reads a table, decides the fix, applies it, and generates output.

## What changes

The questions are the same for every file, and most of the answers are in the file. So the system should ask them itself, the moment a file arrives, and do the work that follows from the answers. The person should see only what needs a person:

- **The decision, not the data.** One card per job. The headline is the one thing that matters ("No cut path in the file"). The prepared result is shown next to the original. Evidence is one click away, never in the way.
- **Prepared, not suggested.** RollCue does not say "you should add a cut contour". It traces one, builds the production PDF, verifies it, and shows it. The operator reviews a finished artifact, not a recommendation.
- **Approval, not execution.** The operator's yes is the only thing that makes it real, and the yes is bound to the exact file they saw.
- **Correction, not re-entry.** If the job type is wrong, one tap fixes it. Everything downstream is redone. The system remembers, so the same mistake does not come back in this session.
- **Abstention, not bluffing.** When the evidence cannot separate two jobs, the card asks with a visual choice. When the evidence is thin but the model is confident anyway, the card says "check this one".

## Why not a chatbot

A chat interface would make the operator describe each job in words, then read the answer and check it. That moves the work into prose and adds a step. The facts are in the file; nobody should have to type them. RollCue has no text box anywhere in the main flow.

## Why not a dashboard

A dashboard would show every job's metrics and let the operator find the problem. RollCue shows one job, one problem and one prepared fix. The queue at the top is a list of the next decisions, not a set of charts.

## What is real and what is not

- Real: file inspection, inference, preflight checks, cut-contour tracing, PDF generation and verification, approval binding, recovery, audit trail. The prepared PDFs are valid production files with a spot-colour cut path that Ghostscript separates into its own plate.
- Not real: there is no printer or cutter. "Release" writes a ticket to this demo's queue. The model is trained on generated files, not on customer files.
