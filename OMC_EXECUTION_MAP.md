# 🧠 OMC Execution Map - SYSTEM-LEVEL (Feature-Agnostic)

---

## 🧠 PURPOSE

Define a **universal execution contract** for the entire system, independent of features.

This map governs:

* how ANY capability is executed
* how AI interacts with the system
* how safety, consistency, and correctness are enforced

👉 Applies to ALL code in the repository

---

# ⚙️ SYSTEM MODEL

The system is composed of 3 layers:

```
AI Layer (Decision)
↓
OMC Layer (Control / Enforcement)
↓
Service Layer (Execution)
```

---

## 🧠 AI LAYER (Decision Only)

Responsibilities:

* understand intent
* decide what to do
* generate structured plans

Constraints:

* ❌ no direct execution
* ❌ no DB access
* ❌ no side effects

---

## ⚙️ OMC LAYER (MANDATORY CONTROL PLANE)

Responsible for:

* interpreting AI decisions
* enforcing rules
* executing safely

---

### Components

#### 1. Intent Classification

Output:

* chat
* execution
* ambiguous

---

#### 2. Tool Resolution

Build runtime toolset:

```
availableTools = resolveTools(tenant, context)
```

Split into:

* systemTools
* actionTools
* integrationTools

---

#### 3. Context Engine

* pulls data from services
* uses systemTools only
* builds execution context

---

#### 4. Plan Builder (AI-assisted)

* produces ExecutionPlan
* uses:

  * actionTools
  * integrationTools

---

#### 5. Plan Validator

Ensures:

* schema correctness
* tool validity
* param completeness

---

#### 6. Execution Controller

Handles:

* retries
* idempotency
* sequencing

---

#### 7. Permission + Policy Gate

Enforces:

* RBAC
* tenant rules
* business policy

---

#### 8. Approval Gate

* blocks risky actions
* requires human confirmation

---

#### 9. Execution Router

Routes each step to:

* internal service
* external connector

---

#### 10. Audit Layer

Logs:

* input
* decision
* plan
* execution
* result

---

# 🔌 SERVICE LAYER (SOURCE OF TRUTH)

Rules:

* each service owns its domain
* no cross-domain mutations
* no AI bypass

Execution MUST happen through:

* service APIs
* or connector layer

---

# 🧩 TOOL SYSTEM (UNIVERSAL)

## 🔒 SYSTEM TOOLS

Purpose:

* read data
* enrich context

Rules:

* not executable
* not visible to user
* not in plans

---

## ⚙️ ACTION TOOLS

Purpose:

* mutate system state

Rules:

* must have real side effects
* must go through full OMC pipeline

---

## 🔌 INTEGRATION TOOLS

Purpose:

* external actions

Rules:

* tenant-scoped
* permission-controlled
* executed via connectors

---

# 🔁 UNIVERSAL EXECUTION FLOW

Applies to ANY request:

```
1. Receive input
2. Classify intent
3. Resolve tools
4. Gather context
5. Build plan (if execution)
6. Validate plan
7. Check policy
8. Check approval
9. Execute via services
10. Log everything
```

---

# 🚨 SYSTEM RULES (NON-NEGOTIABLE)

## Execution Integrity

* no fake success
* no stubbed actions
* no silent failures

---

## Architecture Integrity

* no duplicate tool systems
* no parallel execution paths
* no direct DB access from AI

---

## Consistency

* every action must be:

  * traceable
  * auditable
  * deterministic

---

## Isolation

* AI cannot:

  * bypass OMC
  * call services directly
  * mutate state outside tools

---

# 🧠 SYSTEM GUARANTEE

If this map is respected:

* every feature works within the same model
* every new capability is safe by design
* every bug is traceable

---

# 🧠 FINAL PRINCIPLE

```
AI = Brain (decides)
OMC = Nervous System (controls)
Services = Body (executes)
```
