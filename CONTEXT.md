# polakapi

A desktop workspace for running AI coding CLIs side by side, with tools to plan, run and review their work.

## Code review

**Code review**:
The screen where a branch's changes are inspected, explained by an agent, and judged before integrating into the base branch.
_Avoid_: Diff viewer, reviewer window

**Base branch**:
The branch the reviewed branch is compared against; `main` unless the user picks another.
_Avoid_: Target, base ref

**Process**:
One independent flow of behavior touched by the branch's changes, documented as its own pseudo-code file and judged on its own.
_Avoid_: Feature, module, flow

**Verdict**:
The GO or NO-GO a reviewer agent gives a single Process for integration into the base branch.
_Avoid_: Approval, score

**Review run**:
The button-triggered two-step review of a branch: first split the changes into Processes as pseudo-code, then give each Process a Verdict with its complexity and architecture.
_Avoid_: Audit, workflow

**Changes**:
The working-tree side of Code review, showing staged, unstaged and untracked files with their git actions.
_Avoid_: Status, working copy

**Branch**:
The side of Code review that compares the current branch against the Base branch; the Review run works here.
_Avoid_: PR view, comparison
