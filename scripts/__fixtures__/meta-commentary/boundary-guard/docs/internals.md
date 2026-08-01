# Implementation notes

PLANTED VIOLATIONS. This tree stands in for an implementation-facing `docs/**`
that a caller deliberately does not list. Every line below would fail the gate
if this file were ever selected.

This page is compiled from the design system — do not hand-edit it.
The renderer block (epic #1620, landed in the first wave) draws the widget.
Selection uses the ratified claim-only mode. Per the ruling, it never widens.
Containment is specified in cinatra#1607 AC6 · publish decision · ruling 4.
Bulk import is still landing.
