---
id: EX-203
source: markdown
title: Habit list shows yesterday twice
---

<!-- EXAMPLE DATA. Invented bug for the fictional habit tracker Pebble. Not a real bug report. -->

## Outcome

A person opening Pebble after midnight sees each completed habit once, not duplicated from the previous day.

## Scope

- frontend only. The bug is in the day-boundary grouping of the habit list.
- ai-core is out of scope.
- evals-obs is out of scope.

## Workflow

bug

## Acceptance criteria

- Opening the habit list after midnight shows each habit once.
- A habit completed yesterday still appears on yesterday.
