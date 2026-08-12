# Overlay Baseline Disposition

Status: **preserved evidence; accepted as historical input only.** The verbatim
unified diff in [`overlay-baseline.patch`](./overlay-baseline.patch) records the
speculative overlay that preceded the controlled stability work. It MUST NOT be
reapplied. Its meaningful whitespace is part of the evidence artifact and must
remain unchanged.

At inherited tip `1ffca14` (`1ffca147b461ea044e041626eb1ccc7465169526`), the
overlay is dispositioned as follows:

- **Kept/already landed:** stderr draining, sanitized errors, and defensive
  close/destroy guards.
- **Rejected:** fixed 30→60s connect and 120→180s idle timeout bumps.
- **Replaced:** the 90s raw-byte watchdog, superseded by semantic-progress plus
  H2 liveness.

The repository gates were rerun against this tip and are recorded in the RCA.
