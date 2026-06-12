---
name: skill-empty
description: a present-but-empty watch key — must FAIL LOUD, never silently collapse to "no watches"
cinatra-watches:
  primitives: []
---
A `cinatra-watches:` block with a PRESENT key (`primitives:`) that has zero items
is malformed: an empty watch class is a silent false-negative, so the gate must
exit 2 rather than fall back to the heuristic. This fixture exercises fail-loud.
