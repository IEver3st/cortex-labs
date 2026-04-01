# Capture Preview Dark Mode Design

## Goal

Bring the capture preview zoom modal in line with the app's existing light and dark themes.

## Problem

The capture preview modal is currently styled with hardcoded light-mode colors. In dark mode, that causes two visible issues:

1. The modal card stays light instead of following the rest of the app theme.
2. The full-screen overlay applies a bright cream wash that makes the background viewer look overly white.

## Chosen Approach

Use the app's existing shared theme tokens (`--mg-*`) for the capture preview modal instead of hardcoded light-only values.

## Why This Approach

- It keeps the modal visually consistent with the rest of the app.
- It automatically supports both light and dark mode without maintaining duplicate styles.
- It reduces future drift because the modal will inherit updates to shared theme tokens.
- It fixes the washed-out background by replacing the bright overlay with a theme-aware tinted blur.

## Scope

This change should remain styling-focused.

- Update the preview zoom overlay to use a theme-aware blurred tint instead of the current pale wash.
- Update the preview zoom card, preview frame, labels, slider, buttons, and capture-angle controls to use shared theme tokens.
- Preserve all current modal behavior and interactions.

## Implementation Notes

### Overlay

- Replace the current bright overlay background with a darker, theme-aware translucent tint.
- Keep blur so the viewer remains visible behind the modal.
- Avoid bleaching the underlying scene in either theme.

### Card

- Use shared surface/input/background tokens for the modal shell and preview panel.
- Use shared foreground/muted/border tokens for text and dividers.

### Controls

- Keep the existing accent color behavior through the app's accent token.
- Ensure selected angle states remain clearly visible in both themes.
- Ensure disabled and hover states remain legible in both themes.

## Expected Outcome

- In light mode, the modal keeps the current visual language but is slightly less washed out.
- In dark mode, the modal appears as a dark panel consistent with the rest of the app.
- The viewer behind the modal is blurred and subdued instead of turning bright white.

## Risks

- Token-only conversion may expose any control that still depends on a hardcoded light value.
- Range input styling may vary slightly across platforms, so verification should include a quick visual pass.

## Verification

- Open the capture preview modal in light mode and confirm no regression in readability or selection states.
- Open the capture preview modal in dark mode and confirm the modal uses dark surfaces and readable contrast.
- Confirm the background blur no longer creates a white haze behind the modal.
