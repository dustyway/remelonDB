# Changelog

## Unreleased

### Added

- `await controller.syncNow()` now waits for the requested run and resolves with its `SyncControllerState`, including errors without rejecting; calls during a run share the queued follow-up, and disposal resolves pending calls with the current state.

### Changed

- The manual-controller docstring now awaits `syncNow()` from the UI.
- Callers using `no-floating-promises` must await `syncNow()` or explicitly ignore it with `void controller.syncNow()`.
