# Notepad
<!-- Auto-managed by OMC. Manual edits preserved in MANUAL section. -->

## Priority Context
<!-- ALWAYS loaded. Keep under 500 chars. Critical discoveries only. -->

## Working Memory
<!-- Session notes. Auto-pruned after 7 days. -->
### 2026-02-24 12:10
Architecture review tasks from discussion:
1. Move AgentConfigGenerator from auth service to AI service - expose as API endpoint
2. Rename /history/:phone route to /history/:customerExternalId - update route, service, frontend API client
3. Future: Customer entity for cross-channel identity (PARKED)
4. Skip Meta profile fetch when customerName already exists on conversation
5. Add refresh token mechanism - silent refresh instead of re-login after 24h
6. Add token revocation check - verify isActive on every request, not just login
7. Refactor aiMode - separate into Bot (tenant-level) + Copilot (department-level), onboarding only generates copilot config, bot config only when enabled
8. Add tenantId to all tables - DepartmentMember, AgentConfig, DepartmentCopilotConfig
9. Copilot suggestions - don't auto-fetch when last message is OUTBOUND, show Regenerate button instead
10. Restrict /api/ai-assist/prompt/:deptId to SYSTEM_ADMIN only + add View AI Prompt in sysadmin console
11. Conversation list: hide conversations assigned to other agents, remove status badges from cards, show only unassigned + assigned to me


## MANUAL
<!-- User content. Never auto-pruned. -->

