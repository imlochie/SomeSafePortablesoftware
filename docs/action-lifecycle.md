# Action lifecycle and user-facing semantics

Archive Assistant keeps decision, execution, verification, and outcome as separate facts.

```text
understand
  → decide
  → prepare
  → execute
  → verify
  → outcome
```

## Decision boundary

Review approval records the user's decision. It does not itself start a download or mutate the archive. Acquisition job creation, starting work, operation planning, preflight, and execution remain separate control-plane actions.

The normal UI should explain this as:

```text
Approval records your decision.
The download is not started by opening or approving this review.
A separate job must be created and started.
```

## Distinct facts

The UI must not treat these as interchangeable:

```text
download finished
file verified
added to archive
archive outcome verified
```

The strongest completion wording must match the strongest persisted evidence. A passed download verification does not by itself prove that an archive operation occurred.

## Failure language

Where supported by persisted state:

```text
Download failed
  → The download failed; review what changed before retrying.

Download finished, verification failed
  → The downloaded file exists, but it was not verified successfully.

Archive operation completed, postflight unavailable
  → The archive operation completed, but final verification information is unavailable.

Unknown result
  → I don't have enough information to confirm what happened.
```

The UI must not promise retry safety when the repository cannot establish whether the previous attempt changed the archive. Recovery-required work remains visible for review.

## Consequence preview

Before a review decision, the workload story explains the boundary in plain language:

```text
If you approve:
  your decision is recorded and the existing approval-gated workflow may continue.

What will not happen yet:
  opening the story or recording the decision does not by itself start a download or change the archive.
```

This wording reflects the current implementation, where review approval, job creation, job start, and archive operation execution are separate steps.

## Current state versus recorded outcome

A live state is not a historical outcome. The workload and Queue surfaces use refreshing read-only queries to reflect current persisted state, while lineage and History describe what has already been recorded. No display refresh mutates lifecycle state.

## User-facing stages

Technical state names are translated at normal disclosure depth:

```text
queued → Waiting to start
inspecting → Checking the source
downloading → Downloading the file
verifying → Checking the downloaded file
moving → Putting the file in your archive
complete → Downloaded and verified
recovery_required → Something needs review before continuing
```

Technical state, IDs, provider details, and operation diagnostics remain available only through deeper detail surfaces.
