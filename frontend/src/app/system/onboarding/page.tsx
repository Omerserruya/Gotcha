"use client";

import { SystemLayout } from "@/components/SystemLayout";

const steps = [
  {
    number: 1,
    title: "Create a New Tenant",
    content: `Go to **Tenants** > **New Tenant** in the sidebar.

Fill in the organization details:
- **Organization Name** — the company name (e.g., "Acme Corp")
- **Slug** — URL-safe identifier, auto-generated from name (e.g., "acme-corp")
- **Admin Name** — name of the tenant's first admin user
- **Admin Email** — login email for the tenant admin
- **Admin Password** — password for the tenant admin (min 8 characters)

Click **Create Tenant**. This creates the organization and its first admin user in one step.`,
  },
  {
    number: 2,
    title: "Share Login Credentials",
    content: `Send the tenant admin their login details:

- **Login URL**: your frontend URL (e.g., \`https://app.yourdomain.com/login\`)
- **Organization ID**: the tenant slug (e.g., \`acme-corp\`)
- **Email**: the admin email you set
- **Password**: the admin password you set

The tenant admin uses the regular login page (not the System Admin login).`,
  },
  {
    number: 3,
    title: "Tenant Admin: Connect Channels",
    description: "Done by the tenant admin",
    content: `The tenant admin goes to **Channels** in their dashboard:

- **WhatsApp**: Click "Connect WhatsApp" and complete the Embedded Signup wizard. Select or create a WhatsApp Business Account and choose a phone number.
- **Messenger**: Click "Connect Messenger" and authorize Facebook Page(s).
- **Instagram**: Click "Connect Instagram" and authorize the Facebook Page linked to an Instagram Business Account.

Requires a Meta (Facebook) App with the appropriate permissions configured in your environment.`,
  },
  {
    number: 4,
    title: "Tenant Admin: Add Agents",
    description: "Done by the tenant admin",
    content: `The tenant admin goes to **Agents** > **Add Agent**.

Enter name, email, and password for each agent. Agents can then log in with the same Organization ID and start handling conversations.`,
  },
  {
    number: 5,
    title: "Tenant Admin: Set Up Departments",
    description: "Optional — done by the tenant admin",
    content: `Go to **Departments** to organize agents into teams:

- Create departments (e.g., "Sales", "Support")
- Add agents as members
- Set queue mode: **Claim** (agents pick conversations manually) or **Round Robin** (auto-assigned)`,
  },
  {
    number: 6,
    title: "Tenant Admin: Configure Chatbot",
    description: "Optional — done by the tenant admin",
    content: `Go to **Chatbot Builder** to create automated conversation flows:

- Add nodes: messages, quick replies, conditions, department routing, handover to agent
- Activate the flow — incoming messages are handled by the bot before reaching agents`,
  },
  {
    number: 7,
    title: "Tenant Admin: Configure Co-Pilot",
    description: "Optional — done by the tenant admin",
    content: `Go to **Co-Pilot** to set up AI-powered agent assistance:

- Write a system prompt describing the business
- Add behavioral rules
- Choose mode: **Ready Message** (clickable reply suggestions) or **Context Only** (summary + tips)

Requires \`OPENAI_API_KEY\` to be set in the environment.`,
  },
  {
    number: 8,
    title: "Tenant Admin: Set Business Hours",
    description: "Optional — done by the tenant admin",
    content: `Go to **Settings** to configure availability:

- Enable business hours
- Set timezone and weekly schedule
- Set an auto-response message for outside hours`,
  },
];

const roles = [
  { name: "SYSTEM_ADMIN", scope: "Global", color: "orange", desc: "You — manage all tenants, create/disable organizations, system-wide stats" },
  { name: "ADMIN", scope: "Tenant", color: "blue", desc: "Tenant admin — manage agents, channels, departments, chatbot, co-pilot, settings" },
  { name: "AGENT", scope: "Tenant", color: "gray", desc: "Agent — handle conversations, view assigned chats" },
];

export default function OnboardingPage() {
  return (
    <SystemLayout>
      <div className="max-w-4xl mx-auto p-6 space-y-8 pb-20">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Onboarding Guide</h1>
          <p className="text-sm text-gray-500 mt-1">Step-by-step guide to onboard a new tenant and their team</p>
        </div>

        {/* Steps */}
        <div className="space-y-4">
          {steps.map((step) => (
            <details key={step.number} className="bg-white rounded-2xl border border-gray-200 overflow-hidden group" open={step.number === 1}>
              <summary className="flex items-center gap-4 p-5 cursor-pointer hover:bg-gray-50 transition">
                <span className="w-8 h-8 bg-orange-100 text-orange-600 rounded-lg flex items-center justify-center text-sm font-bold shrink-0">
                  {step.number}
                </span>
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-900 text-sm">{step.title}</h3>
                  {step.description && <p className="text-xs text-gray-400 mt-0.5">{step.description}</p>}
                </div>
                <svg className="w-4 h-4 text-gray-400 transition-transform group-open:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                </svg>
              </summary>
              <div className="px-5 pb-5 pt-0">
                <div className="ps-12 text-sm text-gray-600 leading-relaxed whitespace-pre-line">
                  {step.content.split(/`([^`]+)`/).map((part, i) =>
                    i % 2 === 1 ? (
                      <code key={i} className="bg-gray-100 text-gray-800 px-1.5 py-0.5 rounded text-xs font-mono break-all">{part}</code>
                    ) : (
                      <span key={i}>{part.split(/\*\*([^*]+)\*\*/).map((p, j) =>
                        j % 2 === 1 ? <strong key={j} className="text-gray-900">{p}</strong> : p
                      )}</span>
                    )
                  )}
                </div>
              </div>
            </details>
          ))}
        </div>

        {/* Roles */}
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <h2 className="font-semibold text-gray-900 mb-4">Roles Overview</h2>
          <div className="space-y-3">
            {roles.map((role) => (
              <div key={role.name} className="flex items-start gap-3 p-3 rounded-xl bg-gray-50">
                <div className="flex items-center gap-2 shrink-0 w-40">
                  <code className="text-xs font-mono font-bold text-gray-800">{role.name}</code>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                    role.color === "orange" ? "bg-orange-100 text-orange-600" :
                    role.color === "blue" ? "bg-blue-100 text-blue-600" :
                    "bg-gray-200 text-gray-600"
                  }`}>{role.scope}</span>
                </div>
                <p className="text-sm text-gray-600">{role.desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Troubleshooting */}
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <h2 className="font-semibold text-gray-900 mb-4">Troubleshooting</h2>
          <div className="space-y-4">
            {[
              { q: "Tenant admin can't log in", a: "Verify the tenant slug is correct (lowercase, no spaces). Check the tenant is not disabled in your Tenants page." },
              { q: "Channels not receiving messages", a: "Verify webhook URL is publicly accessible. Check channel status in the tenant's Channels page. Ensure Meta App has correct permissions." },
              { q: "Agent can't see conversations", a: "Make sure the agent is active and assigned to the correct department. Check that conversations are being routed to their department." },
              { q: "Co-Pilot not generating suggestions", a: "Verify OPENAI_API_KEY is set in the environment. Check that the tenant admin has enabled Co-Pilot in their settings." },
            ].map((item) => (
              <div key={item.q}>
                <p className="text-sm font-medium text-gray-900">{item.q}</p>
                <p className="text-xs text-gray-500 mt-0.5">{item.a}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </SystemLayout>
  );
}
