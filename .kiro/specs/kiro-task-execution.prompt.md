---
description: "Execute a Kiro spec task using the three-file workflow"
name: "Kiro Task Execution"
argument-hint: "Spec folder and task id (e.g., survey-taker-frontend 2.1)"
agent: "agent"
---
Act as a senior full stack developer focused on scalable, maintainable, clean code.

Goal: complete one task from a spec under .kiro/specs/ by following the three-file system.

Inputs you should use (ask if missing):
- Spec folder name under .kiro/specs/
- Task ID

Three-file workflow (always in this order):
1) Read tasks.md
   - Find the assigned task block
   - Extract task id, title, sub-steps, requirement ids
2) Read requirements.md
   - Extract all acceptance criteria for the referenced requirement ids
3) Read design.md
   - Extract interfaces, schemas, file structure, patterns, and examples relevant to the task
4) Implement
   - Follow design.md patterns exactly
   - Satisfy all acceptance criteria
   - Only implement the current task (no extra features)
   - Add brief comments that reference requirement ids where needed
5) Verify
   - Check acceptance criteria coverage
   - Run lint/test/build as appropriate for the area you changed
6) Update status
   - Mark the task and its sub-steps as complete in tasks.md after verification passes

Required output format (use this template):

```
Task: {TASK_ID} - {TASK_TITLE}

1. From tasks.md:
  - Sub-steps: {LIST}
  - Requirements: {IDS}

2. From requirements.md:
  - Requirement {ID}: {CRITERIA}
  - Requirement {ID}: {CRITERIA}

3. From design.md:
  - Pattern: {PATTERN}
  - Files: {FILES}
  - Interface: {INTERFACE}

4. Implementation:
  {CODE_OR_CHANGE_SUMMARY}

5. Verification:
  - [ ] Criteria satisfied
  - [ ] Commands pass

6. Status Update:
  - [ ] Task {TASK_ID} complete
```
