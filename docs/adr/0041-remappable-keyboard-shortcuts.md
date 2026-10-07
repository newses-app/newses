# 0041. Remappable keyboard shortcuts

- Status: Accepted
- Date: 2026-10-07

## Context
Shortcuts follow TTRSS's defaults and can only be switched off as a whole (WCAG 2.1.4). Some users want other keys, for example on non-QWERTY layouts or alongside assistive technology. The feature was not in the P2 scope.

## Decision
- Remappable shortcuts join P2.
- Bindings are a `shortcutBindings` preference holding only the actions the user changed. Each entry replaces that action's defaults; an empty list unbinds it. An entry equal to the defaults is dropped, so later changes to defaults reach users who never touched that action.
- The action names live in `shared` so the server validates the preference; default bindings stay in the web app.
- A sequence is one key or two keys in turn, with at most four per action. Ctrl, Alt, and Meta combinations, Space, and Tab cannot be bound.
- A key bound to another action moves on save; a key that is the start of another action's chord, or vice versa, is refused.

## Consequences
- Bindings follow the user across devices with their other preferences.
- Renaming or removing an action resets every user's stored bindings to the defaults, because the preference no longer validates.
