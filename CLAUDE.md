# CLAUDE.md — GOTCHA AI Execution Brain

## 🧠 Core Purpose

This file defines the **behavior, rules, and architecture constraints** for all AI-driven execution inside GOTCHA.

It is the **source of truth for how AI thinks, reads data, and executes actions**.

If PRD.md defines *what to build*, this file defines *how intelligence behaves while building and operating the system*.

---

# ⚠️ Non-Negotiable Principles

## 1. AI is NOT the system — it operates the system

* AI does NOT store business state
* AI does NOT replace services
* AI only:

  * reads from services
  * proposes actions
  * executes via service APIs

👉 All business logic lives in services, NOT in AI

---

## 2. Service Ownership Boundary Rule (CRITICAL)

Each service is **fully responsible for its own domain**.

### Examples:

* CRM Service → customers, leads, updates
* Messaging Service → sending messages, inbox
* Broadcast Service → campaigns, scheduling
* Workflow Service → flows, automation
* Identity Service → merging customers
* AI Service → reasoning ONLY

### RULE:

> AI can ONLY interact with a service through its public API layer.

AI is strictly forbidden from:

* reading internal DB tables directly
* duplicating service logic
* bypassing service APIs

---

## 3. Read Model Isolation Rule

AI reads data ONLY via:

* Service API
* Aggregated read models
* Approved query endpoints

### Forbidden:

* raw DB queries
* cross-service direct joins

👉 If cross-service data is needed → request must go through an aggregation layer

---

## 4. Action Execution Rule

All AI actions must follow:

1. Analyze intent
2. Generate execution plan
3. Validate via policy engine
4. Execute via service API
5. Log execution + reasoning

---

## 5. AI Usage Logging (MANDATORY)

EVERY AI interaction must be logged.

### Logged data:

* input prompt
* context used
* services accessed
* tools invoked
* actions executed
* reasoning summary
* approval state (if applicable)

### Purpose:

* auditability
* debugging
* compliance
* improvement loop

---

## 6. Tool & Service Call Tracking

Every AI call to a service MUST generate a usage record:

### Example:

```
{
  service: "BroadcastService",
  action: "create_campaign",
  user: "agent_123",
  input: {...},
  timestamp: ...,
  reason: "follow-up churn users"
}
```

---

## 7. No Hidden State Rule

AI must NEVER assume:

* unseen customer state
* hidden workflow status
* implicit business rules

👉 If not in service → it does not exist

---

## 8. Context Discipline Rule

AI operates in two scopes only:

### Global Context

* business-level commands
* cross-customer operations
* system-wide automation

### Local Context

* single customer
* single conversation

👉 Mixing contexts is forbidden unless explicitly requested via orchestration layer

---

## 9. Approval Enforcement Layer

Any action that is:

* financial (refunds, discounts)
* irreversible
* external-facing broadcast

MUST go through approval system:

AI → propose → user approves → execute

---

## 10. Execution Minimalism Rule

AI must always:

* choose simplest working solution
* avoid architectural over-design
* reuse existing services

👉 If a service already exists → DO NOT recreate logic

---

# 🧩 Service Architecture Contract

## Each Service Must:

* Own its domain logic
* Expose a clean API layer
* Emit events for state changes
* Maintain internal consistency

---

## AI Responsibilities Per Service

AI is allowed to:

* call service APIs
* combine outputs from multiple services (via orchestrator only)
* trigger workflows

AI is NOT allowed to:

* modify service internals
* bypass validation rules
* mutate state without API call

---

# 🔁 AI Execution Pipeline

Every AI operation must follow:

```
Intent Detection
   ↓
Context Retrieval (via services only)
   ↓
Plan Generation
   ↓
Policy Validation
   ↓
Approval (if required)
   ↓
Service Execution
   ↓
Audit Logging
```

---

# 🧠 AI Behavior Constraints

## AI must:

* be deterministic in execution planning
* be explainable (why action was taken)
* respect service boundaries

## AI must NOT:

* hallucinate system state
* execute without traceability
* mix business logic with reasoning layer

---

# 🔒 Security & Safety Rules

* No direct DB access
* No secret leakage
* No bypass of RBAC
* No cross-tenant data access

---

# 📊 Observability Requirement

Every AI action must be traceable in:

* logs
* audit system
* analytics layer

Metrics:

* AI action success rate
* approval rate
* override rate
* execution latency

---

# 🚀 System Philosophy

GOTCHA is built on a strict separation:

### Services = Truth + State

### AI = Intelligence + Orchestration

👉 AI never owns truth
👉 AI only operates truth

---

# 🧠 Final Rule

If there is ever ambiguity:

> Prefer service correctness over AI intelligence

---

# END OF CLAUDE.md
