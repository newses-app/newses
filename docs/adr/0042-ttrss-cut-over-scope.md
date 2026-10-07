# 0042. TTRSS cut-over scope

- Status: Accepted
- Date: 2026-10-07
- Supersedes 0032

## Context
0032 moved filters, scoring, and full text to Later, noting that filters would be missing at the P3 cut-over. TTRSS users rely on all three daily, and once TTRSS is retired they would be lost until scheduled. The compatibility API acceptance criteria named clients nobody in the household uses (Reeder, NetNewsWire), while the clients in use are the TTRSS Android app and ReadYou.

## Decision
- Phases stay as 0032 set them, except that filters, scoring, and full text move to P3. Score sorting stays Later.
- The TTRSS-compatible API is accepted against the TTRSS Android app and Newsboat; the Google Reader API against ReadYou and Newsboat. Newsboat speaks both protocols and can be scripted.

## Consequences
- P3 is larger, but TTRSS can be retired without losing filters, scores, or full-text opt-ins, and the importer maps them at cut-over.
- Other Google Reader clients may work but are not verified.
