---
id: EX-202
source: markdown
title: Weekly reflection summary
---

<!-- EXAMPLE DATA. Invented requirement for the fictional habit tracker Pebble. Not a real specification. -->

## Outcome

A person can open Pebble on Sunday and read a short plain-language summary of the habits they kept that week.

## Scope

- frontend shows the weekly reflection on the home screen and requests it from the assistant API.
- ai-core writes the summary from that week's habit records and returns it on a new endpoint.
- evals-obs is out of scope.

## Workflow

feature

## Acceptance criteria

- The Sunday home screen shows a reflection paragraph for the current week.
- The paragraph is loaded from ai-core, not composed in the browser.
- A week with no completed habits shows a calm empty state instead of an error.
