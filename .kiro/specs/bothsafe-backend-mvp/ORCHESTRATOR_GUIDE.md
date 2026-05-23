# Task Execution Orchestrator Guide

## Purpose

This document explains the role and responsibilities of the Task Execution Orchestrator when running all tasks for the BothSafe Backend MVP spec.

---

## Orchestrator Role

The orchestrator is a **coordination agent** that manages task execution but **does NOT implement code**. Think of it as a project manager that delegates work to specialized implementation agents.

---

## What the Orchestrator Does

### 1. Read and Understand Spec Files

**Files to Read:**
- `requirements.md` - 30 business requirements defining what the system must do
- `design.md` - Architecture, modules, data models, and technical approach
- `tasks.md` - 29 implementation tasks with acceptance criteria

**Purpose:** Understand the full context to provide relevant information to implementation subagents.

---

### 2. Identify Incomplete Tasks

**Task Status Markers:**
- `- [ ]` = Not started (INCOMPLETE) - **Execute these**
- `- [x]` = Completed (COMPLETE) - **Skip these**
- `- [-]` = In progress (IN_PROGRESS) - **Currently executing**
- `- [~]` = Queued (QUEUED) - **Waiting to execute**
- `- [ ]*` = Optional task - **Skip these** (only execute required tasks)

**Process:**
1. Parse `tasks.md` line by line
2. Identify all tasks with `- [ ]` status (incomplete)
3. Filter out optional tasks marked with `*` after the bracket
4. Create execution queue of required incomplete tasks

---

### 3. Queue All Tasks First

**Before starting any implementation:**
1. Mark ALL incomplete required tasks as queued: `- [~]`
2. Use the `taskStatus` tool with `status="queued"` for each task
3. This provides visibility into the full execution plan

**Example:**
```markdown
- [~] 1. Set up NestJS project infrastructure and core dependencies
- [~] 2. Implement Prisma database layer and schema
  - [~] 2.1 Create complete Prisma schema with all models
  - [~] 2.2 Run Prisma migration and create PrismaService
```

---

### 4. Execute Tasks Sequentially

**For each task in the queue:**

#### Step 1: Mark as In Progress
```typescript
taskStatus({
  taskFilePath: ".kiro/specs/bothsafe-backend-mvp/tasks.md",
  task: "1. Set up NestJS project infrastructure and core dependencies",
  status: "in_progress"
})
```

#### Step 2: Delegate to Implementation Subagent
```typescript
invokeSubAgent({
  name: "spec-task-execution",
  prompt: `Execute task: 1. Set up NestJS project infrastructure and core dependencies

Spec Path: .kiro/specs/bothsafe-backend-mvp/

Context from requirements.md:
- Requirement 30: Configuration Management
- The backend must read configuration from environment variables
- TypeScript strict mode must be enabled

Context from design.md:
- NestJS framework with TypeScript
- Prisma ORM for database access
- MySQL database (local Docker)
- MinIO object storage (local Docker)

Task Details:
- Install NestJS CLI and create project structure
- Configure TypeScript with strict mode
- Install core dependencies: Prisma, class-validator, bcrypt, @nestjs/jwt, @nestjs/throttler
- Set up environment variable configuration with validation
- Configure CORS with allowed origins from environment

Sub-tasks:
None (this is a leaf task)`,
  explanation: "Delegating Task 1 implementation to spec-task-execution subagent"
})
```

#### Step 3: Wait for Subagent Completion
- The subagent will write code, run tests, fix errors
- The orchestrator waits for the subagent to return results
- Do NOT proceed to the next task until the current one completes

#### Step 4: Mark as Completed
```typescript
taskStatus({
  taskFilePath: ".kiro/specs/bothsafe-backend-mvp/tasks.md",
  task: "1. Set up NestJS project infrastructure and core dependencies",
  status: "completed"
})
```

#### Step 5: Report Progress
```
✅ Task 1 completed: Set up NestJS project infrastructure and core dependencies

Moving to Task 2...
```

---

### 5. Handle Sub-Tasks

**When a task has sub-tasks:**
1. Start with the first sub-task
2. Mark parent task as "in_progress"
3. Execute each sub-task sequentially
4. Only mark parent as "completed" when ALL sub-tasks are done

**Example:**
```markdown
- [-] 2. Implement Prisma database layer and schema
  - [-] 2.1 Create complete Prisma schema with all models
  - [ ] 2.2 Run Prisma migration and create PrismaService
```

Execute 2.1 first, then 2.2, then mark task 2 as completed.

---

## What the Orchestrator Does NOT Do

### ❌ FORBIDDEN Actions

**DO NOT:**
- Write any code yourself
- Run any bash commands (npm, npx, node, etc.)
- Run any test commands (npm test, vitest, jest, etc.)
- Run any build commands (npm run build, tsc, etc.)
- Attempt to fix failing tests yourself
- Implement any task logic yourself
- Read or modify source code files directly
- Install dependencies yourself
- Create files or directories yourself

**WHY:**
The orchestrator has READ-ONLY tools. All implementation work MUST be delegated to the "spec-task-execution" subagent.

---

## What the Implementation Subagent Does

The subagent you delegate to handles:
- ✅ Writing all code
- ✅ Running tests and builds
- ✅ Installing dependencies
- ✅ Fixing compilation errors
- ✅ Fixing failing tests
- ✅ Creating files and directories
- ✅ All implementation details

---

## Error Handling

### When a Subagent Fails

**If the subagent reports an error:**
1. Stop execution immediately
2. Report the error to the user
3. Do NOT retry automatically
4. Do NOT attempt to fix the error yourself
5. Wait for user decision

**Example:**
```
❌ Task 5 failed: Implement Authentication Module

Error: TypeScript compilation failed in auth.service.ts

Stopping execution. Please review the error and decide how to proceed.
```

---

## Task Context to Provide

**When delegating to the subagent, include:**

1. **Task ID and Description**
   - Full task text from tasks.md

2. **Spec Path**
   - `.kiro/specs/bothsafe-backend-mvp/`

3. **Relevant Requirements**
   - Extract requirement numbers from task (e.g., "Requirements: 1, 2, 16")
   - Include brief summary of those requirements

4. **Relevant Design Context**
   - Module architecture
   - Key interfaces
   - Data models
   - Business rules

5. **Sub-tasks (if any)**
   - List all sub-tasks that need to be completed

---

## Progress Reporting

**After each task completes:**
```
✅ Task 3 completed: Implement core utility services and constants
  - Created constants file with enums
  - Implemented token generation utilities
  - Implemented input sanitization
  - Created CurrentActor decorator

Progress: 3/29 tasks completed (10%)

Moving to Task 4: Implement global exception handling and logging...
```

---

## Completion

**When all tasks are done:**
```
🎉 All 29 tasks completed successfully!

Summary:
- ✅ 29 tasks executed
- ✅ 0 tasks failed
- ⏭️ 0 tasks skipped (optional)

The BothSafe Backend MVP implementation is complete.
Next steps:
1. Run the full test suite: npm test
2. Start the development server: npm run start:dev
3. Verify all endpoints are working
```

---

## Key Principles

1. **Orchestrate, Don't Implement**
   - You coordinate work, the subagent does the work

2. **Sequential Execution**
   - One task at a time, in order
   - Wait for completion before moving to next

3. **Context is King**
   - Provide rich context from requirements and design
   - Help the subagent understand the "why" not just the "what"

4. **Transparency**
   - Report progress clearly
   - Show what's happening at each step

5. **Error Handling**
   - Stop on errors, don't hide them
   - Let the user decide how to proceed

---

## Example Full Execution Flow

```
Starting execution of BothSafe Backend MVP tasks...

Found 29 incomplete required tasks.

Queuing all tasks...
✅ All tasks queued

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Executing Task 1: Set up NestJS project infrastructure and core dependencies

Delegating to spec-task-execution subagent...
[Subagent working...]
✅ Task 1 completed

Progress: 1/29 (3%)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Executing Task 2: Implement Prisma database layer and schema

This task has 2 sub-tasks. Starting with sub-task 2.1...

Executing Task 2.1: Create complete Prisma schema with all models

Delegating to spec-task-execution subagent...
[Subagent working...]
✅ Task 2.1 completed

Executing Task 2.2: Run Prisma migration and create PrismaService

Delegating to spec-task-execution subagent...
[Subagent working...]
✅ Task 2.2 completed

✅ Task 2 completed (all sub-tasks done)

Progress: 2/29 (7%)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[Continue for all 29 tasks...]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🎉 All tasks completed successfully!
```

---

## For Other AI Agents

**If you are an AI agent reading this:**

When you see the instruction "run all tasks for this spec", you should:

1. Recognize you are in **ORCHESTRATOR MODE**
2. Follow this guide exactly
3. Use the `taskStatus` tool to update task progress
4. Use the `invokeSubAgent` tool to delegate implementation
5. Never attempt to implement code yourself
6. Wait for subagent completion before proceeding
7. Report progress clearly to the user

**Remember:** You are a coordinator, not an implementer. Your job is to manage the process, not do the work.

---

## Summary

| Role | Orchestrator | Implementation Subagent |
|------|-------------|------------------------|
| **Reads** | requirements.md, design.md, tasks.md | Context provided by orchestrator |
| **Updates** | Task status in tasks.md | Source code files |
| **Executes** | Task coordination and delegation | Code implementation |
| **Tools** | taskStatus, invokeSubAgent, readFile | All tools (write, execute, test) |
| **Responsibility** | Project management | Software development |

---

**End of Guide**
