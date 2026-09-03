# Writing style

Companion Hub English docs and human-facing comments follow the [Google developer documentation style guide](https://developers.google.com/style).

## Must follow

- **Second person** (“you”) for instructions; avoid “we will” and “let’s”.
- **Active voice** and present tense when describing product behavior.
- **Sentence case** for titles and headings (`Private VPN`, not `Private VPN Setup Guide` as Title Case Everywhere).
- **Serial commas**.
- **Descriptive link text** (not “click here”).
- Put **conditions before instructions** (“If the sidecar is down, restart the stack”).
- Prefer short sentences; one idea per sentence when practical.

## Avoid

- Cheerleading (“Sure!”, “Feel free!”, “It’s easy”)
- Softeners in procedures (“simply”, “just”, “easily”)
- Pre-announcements (“In this document we will…”)
- Exclamation points in technical prose
- Buzzwords and unexplained jargon; define product terms once (see [`README.md`](README.md#product-names))

## Comments in code

Comments explain **why**, not what the next line does.

- Prefer one to three sentences over postmortem essays.
- Do not paste private lab URLs, passwords, or keys into comments.
- Device or host **names** used as examples are fine (`core-2`).
- Issue references (`CI-Hub#1234`) are fine when they justify a non-obvious invariant.

Generated schemas, license text, and third-party vendor docs are out of scope for this house style.
