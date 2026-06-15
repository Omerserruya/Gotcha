I now have comprehensive coverage of the codebase. Let me compile the full user stories report:

---

# CHATCENTER FRONTEND USER STORIES ANALYSIS

## FRAMEWORK & ROUTING
- **Framework**: Next.js 14.2.0 (App Router)
- **UI Library**: React 18.3.0
- **Real-time**: Socket.io 4.8.0
- **Charting**: Recharts 2.12.0
- **Flow Builder**: ReactFlow 11.11.0
- **Styling**: Tailwind CSS 3.4.0

---

## GLOBAL COMPONENTS & SHARED INTERACTIONS

### Command Center (Ctrl/Cmd+K)
- **Location**: `/frontend/src/components/CommandCenter/CommandCenterModal.tsx`
- **API Surface**: `gotcha-api.ts` (simulateCommand, executePlan)
- **State**: Plan preview, execution loading, error handling
- **Context-aware**: Conversation ID or Contact ID aware prompts

---

# PAGE-BY-PAGE USER STORIES

## Page: / (Landing / Home)
Redirects authenticated users to `/conversations`, shows landing page for unauthenticated users.

**User Story #1:**
As an unauthenticated visitor,
I want to see a landing page,
So that I can understand the product and navigate to login.

UI Entry Point:
- Landing page component display

Frontend Location:
- `/frontend/src/app/page.tsx` (LandingPage component)

Frontend Action Flow:
1. Check `useAuth()` context for authenticated user
2. If loading, show loading spinner
3. If user exists, redirect to `/conversations`
4. If no user, render LandingPage

API Call:
- No API call found (frontend-only behavior)

State Changes:
- Router redirect based on auth state

Edge Cases:
- Loading state during auth check
- User redirected mid-navigation

---

## Page: /login

**User Story #2:**
As a tenant user,
I want to log in with email, password, and workspace slug,
So that I can access the application.

UI Entry Point:
- Email input field
- Password input field
- Workspace slug input field
- Submit button

Frontend Location:
- `/frontend/src/app/login/page.tsx`

Frontend Action Flow:
1. User fills email, password, tenantSlug fields
2. User clicks Submit or presses Enter
3. Frontend validates inputs are non-empty
4. Frontend calls login API
5. On success, context stores token and user data
6. Router redirects to `/conversations` or `/setup` (if onboarding incomplete)

API Call:
- `POST /api/auth/login` (email, password, tenantSlug)
- Response: { token, refreshToken, user, tenantStatus }

State Changes:
- Auth context updated with token, user, refreshToken
- Router navigation based on tenantStatus

Edge Cases:
- Login error message displayed
- Setup wizard redirect if tenant onboarding incomplete
- Forgot password flow initiates modal

---

**User Story #3:**
As a system administrator,
I want to toggle between system admin login and tenant login,
So that I can use either mode.

UI Entry Point:
- "System Admin Login" / "Back to tenant login" toggle button (bottom of form)

Frontend Location:
- `/frontend/src/app/login/page.tsx` (isSystemAdmin state)

Frontend Action Flow:
1. User clicks toggle button
2. isSystemAdmin state flipped
3. Workspace slug field hidden/shown based on mode
4. Submit calls `apiSystemLogin` or `apiLogin` accordingly

API Call:
- `POST /api/system/login` (if system admin mode)

State Changes:
- isSystemAdmin boolean state
- Form fields visibility

Edge Cases:
- None critical

---

**User Story #4:**
As a user who forgot their password,
I want to request a password reset link,
So that I can regain access.

UI Entry Point:
- "Forgot password?" link (below password field)
- Forgot password modal with email + workspace slug fields

Frontend Location:
- `/frontend/src/app/login/page.tsx` (showForgotPassword state)

Frontend Action Flow:
1. User clicks "Forgot password?" link
2. Modal appears with email and tenantSlug inputs
3. User fills fields and submits
4. Frontend calls forgotPassword API
5. Success message shown: "If an account exists, a reset link has been sent"
6. Form fields cleared
7. User can return to login form or close modal

API Call:
- `POST /api/auth/forgot-password` (email, tenantSlug)
- Response: { success, message }

State Changes:
- showForgotPassword, forgotEmail, forgotTenantSlug states
- forgotMessage displayed on success
- forgotError displayed on failure

Edge Cases:
- No error message distinguishes existing vs non-existing emails (security)
- Loading state during API call
- Form clears on success

---

**User Story #5:**
As a user,
I want to toggle password visibility,
So that I can verify what I've typed.

UI Entry Point:
- Eye/eye-slash icon button (right side of password field)

Frontend Location:
- `/frontend/src/app/login/page.tsx` (showPassword state)

Frontend Action Flow:
1. User clicks eye icon
2. showPassword state toggled
3. Input type switches between "text" and "password"
4. Icon visual updates

API Call:
- No API call found (frontend-only behavior)

State Changes:
- showPassword boolean state

Edge Cases:
- Icon state immediately reflects input type

---

## Page: /conversations

**User Story #6:**
As an agent,
I want to view a list of all conversations (inbox),
So that I can see which conversations are available to handle.

UI Entry Point:
- Conversation list panel (left sidebar on desktop, full width on mobile)
- Shows conversation previews with last message, channel, customer name

Frontend Location:
- `/frontend/src/components/conversations/ConversationList.tsx`

Frontend Action Flow:
1. Page mounted, `getConversations` called
2. Socket.io listens for real-time updates
3. Conversations rendered in list with search/filter applied
4. Last message, timestamp, channel badge displayed for each
5. Unread count/indicator shown for conversations with unread messages
6. User clicks conversation to select

API Call:
- `GET /api/conversations?search=...&channel=...&departmentId=...` (with optional filters)
- Response: { data: [], meta: { totalPages } }

State Changes:
- conversations array, search filter, channelFilter, departmentFilter
- selectedId updated when user clicks conversation
- lastReadMap updated from localStorage
- markedUnread Set synchronized via localStorage

Edge Cases:
- Empty conversation list state
- Socket.io real-time message arrival
- Infinite scroll or pagination (meta.totalPages used)
- Unread indicator persists across sessions via localStorage

---

**User Story #7:**
As an agent,
I want to search conversations by customer name or phone,
So that I can find specific conversations.

UI Entry Point:
- Search input field (top of conversation list)
- Type and filter updates in real-time

Frontend Location:
- `/frontend/src/components/conversations/ConversationList.tsx` (search state)

Frontend Action Flow:
1. User types in search field
2. search state updated
3. useCallback dependency triggers fetchConversations
4. API called with search param
5. Conversation list re-rendered with filtered results

API Call:
- `GET /api/conversations?search={query}`

State Changes:
- search state
- conversations list updated

Edge Cases:
- Empty search results
- Debounce not implemented (may cause frequent API calls)

---

**User Story #8:**
As an admin agent,
I want to filter conversations by channel (WhatsApp, Messenger, etc.),
So that I can focus on specific channels.

UI Entry Point:
- Channel filter dropdown (top of conversation list)
- Options: All, WhatsApp, Messenger, Instagram, Gmail, Slack, Outlook

Frontend Location:
- `/frontend/src/components/conversations/ConversationList.tsx` (channelFilter state)

Frontend Action Flow:
1. User clicks channel filter dropdown
2. Selects channel option
3. channelFilter state updated
4. fetchConversations called with channel param
5. List filtered by selected channel

API Call:
- `GET /api/conversations?channel={channel}`

State Changes:
- channelFilter state
- conversations list

Edge Cases:
- "All channels" option clears filter
- Multi-select not supported (only one channel at a time)

---

**User Story #9:**
As an admin agent,
I want to filter conversations by department,
So that I can view only conversations assigned to my department.

UI Entry Point:
- Department filter dropdown (admin only)

Frontend Location:
- `/frontend/src/components/conversations/ConversationList.tsx` (departmentFilter state, admin-only via user.role check)

Frontend Action Flow:
1. Admin fetches departments list on mount
2. Department filter dropdown populated
3. User selects department
4. departmentFilter state updated
5. fetchConversations called with departmentId param
6. List filtered

API Call:
- `GET /api/departments` (on mount)
- `GET /api/conversations?departmentId={id}`

State Changes:
- departments list, departmentFilter state
- conversations list

Edge Cases:
- Non-admin users don't see department filter
- Empty department dropdown if no departments exist

---

**User Story #10:**
As an agent,
I want to mark a conversation as unread,
So that I can follow up on it later.

UI Entry Point:
- Right-click context menu on conversation item
- "Mark as unread" option

Frontend Location:
- `/frontend/src/components/conversations/ConversationList.tsx` (contextMenu, handleMarkUnread)

Frontend Action Flow:
1. User right-clicks conversation
2. Context menu appears at mouse position
3. User clicks "Mark as unread"
4. markedUnread Set updated
5. Set synchronized to localStorage
6. Conversation re-renders with unread indicator
7. Context menu closes

API Call:
- No API call found (frontend-only behavior - localStorage-backed)

State Changes:
- markedUnread Set, contextMenu state
- localStorage["chatcenter:markedUnread"] updated

Edge Cases:
- Context menu dismisses on Escape key
- Context menu dismisses on scroll
- Context menu dismisses on click outside

---

**User Story #11:**
As an agent,
I want to delete a conversation permanently,
So that I can remove conversations I don't need.

UI Entry Point:
- Right-click context menu → "Delete" option
- Confirmation modal appears

Frontend Location:
- `/frontend/src/components/conversations/ConversationList.tsx` (handleDeleteClick, handleDeleteConfirm)
- `ConfirmModal.tsx` component

Frontend Action Flow:
1. User right-clicks conversation
2. Clicks "Delete" in context menu
3. ConfirmModal appears asking for confirmation
4. User confirms
5. deleteConversation API called
6. Conversation removed from list
7. If selected conversation was deleted, chat panel clears

API Call:
- `DELETE /api/conversations/{id}?force=true`

State Changes:
- deleteTarget state
- conversations list updated
- selectedId cleared if deleted conversation was open

Edge Cases:
- Confirmation modal required before deletion
- Loading state during deletion
- Error handling if deletion fails

---

**User Story #12:**
As an agent,
I want to select and open a conversation,
So that I can view the message history and respond.

UI Entry Point:
- Click conversation item in list

Frontend Location:
- `/frontend/src/components/conversations/ConversationList.tsx` → `/frontend/src/components/conversations/ChatPanel.tsx`

Frontend Action Flow:
1. User clicks conversation in list
2. selectedId state updated (ConversationList → ChatPanel)
3. On mobile: conversation list hides, chat panel shows
4. On desktop: chat panel displays alongside list
5. ChatPanel calls getConversation API
6. Messages loaded and displayed

API Call:
- `GET /api/conversations/{id}` (in ChatPanel)
- Response: { data: { id, messages: [], customerName, channel, ... } }

State Changes:
- selectedId state
- conversation, messages states in ChatPanel
- Window history pushState for browser back button

Edge Cases:
- Mobile: conversation list hidden while chat open
- Desktop: side-by-side layout
- Browser back button support via history API

---

**User Story #13:**
As an agent on mobile,
I want to go back from the chat to the conversation list,
So that I can select a different conversation.

UI Entry Point:
- Back arrow button (top-left of chat panel on mobile)

Frontend Location:
- `/frontend/src/components/conversations/ChatPanel.tsx` (onBack prop)

Frontend Action Flow:
1. User clicks back button
2. onBack callback fires
3. selectedId set to null in ConversationList
4. Chat panel hides, conversation list shows

API Call:
- No API call found (frontend-only behavior)

State Changes:
- selectedId state

Edge Cases:
- Browser back button also triggers via history.popState listener

---

## Page: /conversations (ChatPanel Component)

**User Story #14:**
As an agent,
I want to view the message history of a conversation,
So that I can understand the context.

UI Entry Point:
- Chat panel main area
- Messages displayed in chronological order

Frontend Location:
- `/frontend/src/components/conversations/ChatPanel.tsx`

Frontend Action Flow:
1. ChatPanel mounted with conversationId
2. getConversation API called
3. Messages array loaded from response
4. Messages rendered in scrollable area
5. Auto-scroll to bottom on new messages
6. Socket.io listeners for real-time message updates

API Call:
- `GET /api/conversations/{id}`
- Real-time: socket.on("message:new", (data) => ...)

State Changes:
- messages array
- conversation object

Edge Cases:
- Auto-scroll to latest message on arrival
- Loading state while fetching
- Empty message list for new conversations

---

**User Story #15:**
As an agent,
I want to send a text message in a conversation,
So that I can respond to the customer.

UI Entry Point:
- Message input field (bottom of chat panel)
- Send button or Ctrl/Cmd+Enter

Frontend Location:
- `/frontend/src/components/conversations/ChatPanel.tsx` (handleSend, inputText state)

Frontend Action Flow:
1. User types message in input field
2. Message text stored in inputText state
3. User clicks Send button or presses Ctrl+Enter
4. handleSend form submission fires
5. sendMessage API called
6. Message added to local messages array optimistically
7. Input cleared
8. Message auto-scrolls into view

API Call:
- `POST /api/conversations/{id}/messages` (body: string)
- Response: { data: { id, body, direction, timestamp, ... } }

State Changes:
- inputText cleared
- messages array updated
- sending boolean state during request

Edge Cases:
- Empty message validation
- Sending state prevents duplicate submissions
- Network error shows error UI

---

**User Story #16:**
As an agent,
I want to send a media file (image, video, document) to a customer,
So that I can share visual or document content.

UI Entry Point:
- File attachment button (paperclip icon near input)
- Drag-and-drop area or file picker modal

Frontend Location:
- `/frontend/src/components/conversations/ChatPanel.tsx` (attachedFiles, handleFilesSelected, handleDragOver)

Frontend Action Flow:
1. User clicks attachment button or drags files into chat area
2. File picker opens (if button click) or drag-drop detected (if drag)
3. User selects up to 5 files
4. Files added to attachedFiles array
5. File preview shown in attachment area below input
6. User can remove individual files
7. User submits form (with or without text caption)
8. For each file: sendMediaMessage API called with FormData
9. Text message sent separately if inputText is non-empty
10. Files and text cleared from form

API Call:
- `POST /api/conversations/{id}/messages/media` (FormData: file, caption)
- Response: { data: { id, mediaUrl, direction, timestamp, ... } }

State Changes:
- attachedFiles array
- messages array
- isDragging state during drag-over

Edge Cases:
- Max 5 files enforced
- Drag-over visual feedback
- File preview before send
- Error if upload fails

---

**User Story #17:**
As an agent,
I want to claim ownership of an unassigned conversation,
So that I can take responsibility for it.

UI Entry Point:
- "Claim" button (in conversation header or action menu)

Frontend Location:
- `/frontend/src/components/conversations/ChatPanel.tsx` (conversation.status check, button visibility)

Frontend Action Flow:
1. Agent views conversation assigned to no one
2. "Claim" button visible
3. Agent clicks "Claim"
4. claimConversation API called
5. Conversation status updated to assigned to current agent
6. Button hidden or state updated
7. Conversation panel shows agent name

API Call:
- `POST /api/conversations/{id}/claim`
- Response: { data: { ...conversation, assignedToId, assignedToName } }

State Changes:
- conversation object updated
- UI re-renders with new assignee info

Edge Cases:
- Button only appears if conversation is unassigned
- Loading state during claim
- Error if claim fails (e.g., already claimed by another agent)

---

**User Story #18:**
As an agent,
I want to release a conversation I've claimed,
So that another agent can take it.

UI Entry Point:
- "Release" button (in conversation header or action menu)

Frontend Location:
- `/frontend/src/components/conversations/ChatPanel.tsx`

Frontend Action Flow:
1. Agent clicks "Release" button
2. releaseConversation API called
3. Conversation status updated (no longer assigned to agent)
4. Button hidden, "Claim" button may re-appear
5. Conversation moves to unassigned queue

API Call:
- `POST /api/conversations/{id}/release`

State Changes:
- conversation.assignedToId cleared
- UI updated

Edge Cases:
- Button only appears if conversation is assigned to current agent
- Loading state during release
- Error handling

---

**User Story #19:**
As an agent,
I want to reassign a conversation to another agent,
So that another agent can take over.

UI Entry Point:
- "Reassign" button
- Agent selection dropdown or modal

Frontend Location:
- `/frontend/src/components/conversations/ChatPanel.tsx` (showTransfer, transferTab states)

Frontend Action Flow:
1. Agent clicks "Reassign" button
2. Transfer modal opens
3. "Agents" tab selected by default
4. Agents list fetched and displayed
5. Agent selects target agent
6. reassignConversation API called with target agentId
7. Conversation updated
8. Modal closes
9. Chat panel shows new assignee

API Call:
- `GET /api/agents` (fetch agents list on modal open)
- `POST /api/conversations/{id}/reassign` (agentId: string)

State Changes:
- showTransfer boolean
- transferTab state
- agents array
- conversation object

Edge Cases:
- Agents list loaded on demand when modal opens
- Reassign to same agent should be prevented or no-op

---

**User Story #20:**
As an agent,
I want to transfer a conversation to another department,
So that the right team can handle it.

UI Entry Point:
- "Reassign" button → "Departments" tab in transfer modal

Frontend Location:
- `/frontend/src/components/conversations/ChatPanel.tsx` (transferTab state)

Frontend Action Flow:
1. Agent clicks "Reassign" button
2. Transfer modal opens
3. Agent clicks "Departments" tab
4. Departments list displayed
5. Agent selects target department
6. transferToDepartment API called with departmentId
7. Conversation assigned to department queue
8. Modal closes

API Call:
- `GET /api/departments` (fetch departments list on modal open)
- `POST /api/conversations/{id}/reassign` (departmentId: string)

State Changes:
- departments array
- showTransfer, transferTab states
- conversation object

Edge Cases:
- Departments list loaded on demand

---

**User Story #21:**
As an agent,
I want to close a conversation,
So that it's marked as resolved.

UI Entry Point:
- "Close" button (in conversation header or action menu)

Frontend Location:
- `/frontend/src/components/conversations/ChatPanel.tsx`

Frontend Action Flow:
1. Agent clicks "Close" button
2. Optional: confirmation modal may appear
3. closeConversation API called
4. Conversation status set to CLOSED
5. Chat panel indicates conversation is closed
6. Input field may be disabled
7. Conversation moves to closed/history section

API Call:
- `POST /api/conversations/{id}/close`

State Changes:
- conversation.status = "CLOSED"
- inputText field disabled (read-only)

Edge Cases:
- Button may require confirmation
- Closed conversations can still be reopened or viewed in history
- "Last message" timestamp in list updated

---

**User Story #22:**
As an agent,
I want to see the co-pilot panel with AI suggestions,
So that I can respond faster using suggested replies.

UI Entry Point:
- "Copilot" button or panel toggle (right side of chat)
- Panel slides in from right edge

Frontend Location:
- `/frontend/src/components/conversations/ChatPanel.tsx` (copilotOpen state)
- `/frontend/src/components/conversations/CoPilotPanel.tsx`

Frontend Action Flow:
1. Agent opens conversation with inbound message
2. Copilot panel auto-opens if last message is inbound
3. Or agent manually clicks Copilot button
4. Panel slides in showing:
   - AI-generated suggestions
   - Customer sentiment/summary
   - Escalation warnings
5. Agent can click suggestion to insert into input
6. Or agent can close panel

API Call:
- `GET /api/ai-assist/{id}/suggestions` (auto-called when copilot opens)
- `GET /api/ai-assist/{id}/summary` (optional, for conversation summary)
- Response: { data: [{ text, confidence, label }], copilotMode }

State Changes:
- copilotOpen boolean
- topSuggestion state (best suggestion displayed)
- aiGenerating boolean during fetch

Edge Cases:
- Auto-open disabled if last message is outbound
- Empty suggestions if AI can't generate
- Copilot mode can be "READY_MESSAGE", "COPILOT", or "AUTONOMOUS"

---

**User Story #23:**
As an agent,
I want to view the customer's conversation history,
So that I can see past interactions.

UI Entry Point:
- "History" button or side panel toggle

Frontend Location:
- `/frontend/src/components/conversations/ChatPanel.tsx` (historyOpen state)
- `/frontend/src/components/conversations/HistoryPanel.tsx`

Frontend Action Flow:
1. Agent clicks History button
2. History panel slides in showing previous conversations with this customer
3. Agent can click a previous conversation to view it
4. Previous conversation loaded in a read-only view or side-by-side

API Call:
- `GET /api/conversations/history/{customerExternalId}` (fetch customer's conversation history)

State Changes:
- historyOpen boolean
- History panel state

Edge Cases:
- Empty history if no previous conversations
- Read-only view to prevent accidental edits

---

**User Story #24:**
As an agent,
I want to see customer information and timeline,
So that I can understand their profile.

UI Entry Point:
- Customer name/avatar at top of chat panel
- Click to open customer details panel

Frontend Location:
- `/frontend/src/components/conversations/ChatPanel.tsx`
- `/frontend/src/components/CustomerTimeline.tsx`

Frontend Action Flow:
1. Chat panel loads conversation data
2. Customer name, avatar, channel badge displayed in header
3. Customer info (phone, email if available) shown
4. Timeline of customer interactions loaded
5. Agent can view customer's past order history, tickets, etc.

API Call:
- `GET /api/conversations/{id}` (includes customer info)
- `GET /api/identity/{contactId}/timeline` (customer timeline via GOTCHA API)

State Changes:
- conversation object contains customer info
- Timeline data loaded on panel open

Edge Cases:
- Customer may not have a name (show phone instead)
- Timeline may be empty for new customers

---

## Page: /dashboard

**User Story #25:**
As a manager,
I want to see key performance indicators (KPIs) at a glance,
So that I can monitor team health.

UI Entry Point:
- Dashboard page with KPI cards
- 8 cards displayed in grid: active conversations, waiting, closed today, total messages, avg response time, avg resolution time, queue depth, avg wait time

Frontend Location:
- `/frontend/src/app/dashboard/page.tsx`

Frontend Action Flow:
1. Dashboard page mounted
2. getDashboardStats, getAgentStats, getHourlyVolume, getDailyVolume, getQueueStats APIs called in parallel
3. KPI cards rendered with values and color-coded icons
4. Charts (hourly traffic, conversation volume) rendered below
5. Agent workload table displayed

API Call:
- `GET /api/analytics/dashboard`
- `GET /api/analytics/agents`
- `GET /api/analytics/hourly?date=...`
- `GET /api/analytics/daily?days=...`
- `GET /api/analytics/queue`
- Response: { data: { activeConversations, waitingConversations, closedToday, ... } }

State Changes:
- stats, agentStats, hourly, daily, queue states

Edge Cases:
- Loading spinners while data fetches
- Null/zero values for empty KPIs
- Data auto-refreshes or manual refresh button

---

**User Story #26:**
As a manager,
I want to see hourly conversation traffic breakdown (inbound vs outbound),
So that I can understand volume patterns.

UI Entry Point:
- "Hourly Traffic" chart (bar chart)

Frontend Location:
- `/frontend/src/app/dashboard/page.tsx` (hourly state)

Frontend Action Flow:
1. Chart data populated from getHourlyVolume API response
2. X-axis: hours (0-23)
3. Y-axis: message count
4. Bars: inbound (purple) vs outbound (light purple)
5. Tooltip shows exact values on hover
6. Legend identifies bar colors

API Call:
- `GET /api/analytics/hourly?date={date}`
- Response: { data: [{ hour, inbound, outbound }, ...] }

State Changes:
- hourly array

Edge Cases:
- Empty hours may appear as zero
- Date parameter can be customized to past dates

---

**User Story #27:**
As a manager,
I want to see daily conversation volume and closed conversations trend,
So that I can track resolution over time.

UI Entry Point:
- "Conversation Volume" line chart
- Shows total messages vs closed conversations over 14 days

Frontend Location:
- `/frontend/src/app/dashboard/page.tsx` (daily state)

Frontend Action Flow:
1. Chart rendered with daily data
2. X-axis: dates
3. Y-axis: count
4. Lines: total messages (purple) and closed (red)
5. Smooth line animation
6. Tooltip on hover

API Call:
- `GET /api/analytics/daily?days=14`
- Response: { data: [{ date, total, closed }, ...] }

State Changes:
- daily array

Edge Cases:
- Days parameter configurable
- Trend direction indicated (up/down/flat)

---

**User Story #28:**
As a manager,
I want to see which agents are handling the most conversations,
So that I can balance workload.

UI Entry Point:
- "Agent Workload" table
- Shows agent name, email, active conversations, avg response time

Frontend Location:
- `/frontend/src/app/dashboard/page.tsx` (agentStats state)

Frontend Action Flow:
1. Agent stats fetched
2. Table rendered with agents sorted by active conversations (descending)
3. Columns: Name, Active Conversations, Avg Response Time
4. Agent avatar circle shows first initial
5. Click row to navigate to agent details (optional)

API Call:
- `GET /api/analytics/agents`
- Response: { data: [{ agentId, name, email, activeConversations, avgResponseTimeMs }, ...] }

State Changes:
- agentStats array

Edge Cases:
- Empty agent list
- Agents with no conversations show 0
- Time formatted as "Xm" or "Xh"

---

## Page: /channels

**User Story #29:**
As an admin,
I want to connect WhatsApp to GOTCHA,
So that I can receive and send WhatsApp messages.

UI Entry Point:
- "Connect WhatsApp" card / button
- WhatsApp embedded signup modal

Frontend Location:
- `/frontend/src/app/channels/page.tsx` (handleConnectWhatsApp, FB.XFBML.parse)

Frontend Action Flow:
1. Admin clicks "Connect WhatsApp" button
2. Facebook app SDK loaded (if not already)
3. WA_EMBEDDED_SIGNUP component initializes
4. User follows OAuth flow in embedded iframe
5. Session info (wabaId, phoneNumberId) captured via postMessage listener
6. connectWhatsApp API called with code and session info
7. Refresh channel list
8. Success message shown

API Call:
- `POST /api/channels/connect/whatsapp` (code, wabaId, phoneNumberId)
- Response: { data: [...channel accounts] }

State Changes:
- accounts list refreshed
- sessionInfoRef updated with WABA/phone number IDs
- Embedded signup iframe displayed

Edge Cases:
- Facebook SDK loads asynchronously
- PostMessage listener captures embedded signup events
- User cancels signup flow
- Multiple phone numbers can be connected

---

**User Story #30:**
As an admin,
I want to connect Instagram to GOTCHA,
So that I can reply to Instagram DMs.

UI Entry Point:
- "Connect Instagram" card / button
- OAuth redirect to Facebook login

Frontend Location:
- `/frontend/src/app/channels/page.tsx` (handleOAuthConnect)

Frontend Action Flow:
1. Admin clicks "Connect Instagram" button
2. handleOAuthConnect("instagram") called
3. Browser redirects to OAuth authorize endpoint
4. User logs in and approves app
5. Browser redirects back with ?connected=true or ?error=...
6. useEffect detects redirect and calls fetchData
7. Channel list refreshed
8. Success/error message shown
9. URL cleaned via history.replaceState

API Call:
- Backend initiates OAuth flow (frontend just handles redirect)
- `GET /api/channels?...` (fetch updated list)

State Changes:
- accounts list refreshed
- message/messageType state shows success/error
- URL cleaned

Edge Cases:
- OAuth error handling (access_denied, no_pages, etc.)
- User may have no Instagram accounts linked to Facebook

---

**User Story #31:**
As an admin,
I want to disconnect a channel,
So that I can stop receiving messages from it.

UI Entry Point:
- Disconnect button (action menu on channel account card)
- Confirmation modal

Frontend Location:
- `/frontend/src/app/channels/page.tsx` (handleCheckStatus, openDisconnectConfirm, confirmDisconnect)

Frontend Action Flow:
1. Admin clicks disconnect button
2. ConfirmModal appears
3. Admin confirms
4. disconnectChannel API called
5. Channel account removed from list
6. Success message shown

API Call:
- `POST /api/channels/{id}/disconnect`
- Response: { success: true }

State Changes:
- accounts list updated
- disconnectConfirm state cleared
- message shows success

Edge Cases:
- Confirmation required
- Loading state during disconnect
- Channel removed from UI immediately or after API response

---

**User Story #32:**
As an admin,
I want to delete a channel account permanently,
So that it's removed from the system.

UI Entry Point:
- Delete button (action menu on channel account)
- Confirmation modal with channel name displayed

Frontend Location:
- `/frontend/src/app/channels/page.tsx` (handleDeleteClick, confirmDelete)

Frontend Action Flow:
1. Admin clicks delete button
2. Delete confirmation modal appears with channel name
3. Admin confirms
4. deleteChannelAccount API called
5. Channel account removed from list
6. Success message shown

API Call:
- `DELETE /api/agents/settings/channels/{id}`

State Changes:
- accounts list updated
- deleteConfirm state cleared

Edge Cases:
- Confirmation modal required
- Only system admin can delete channels

---

**User Story #33:**
As an admin,
I want to create a web chat widget,
So that customers can chat on my website.

UI Entry Point:
- "Create Web Chat" button
- Modal to configure widget (color, title, icon, position)

Frontend Location:
- `/frontend/src/app/channels/page.tsx` (embedModal state, widget customization inputs)

Frontend Action Flow:
1. Admin clicks "Create Web Chat" button
2. createWebchatWidget API called
3. New widget account created
4. embedModal opens with widget configuration
5. Admin customizes:
   - Color (hex picker)
   - Title text
   - Icon URL
   - Position (right or left)
6. updateWebchatSettings API called
7. Widget code displayed in tabs:
   - HTML (vanilla JS)
   - Next.js React component
   - Vue
   - PHP
8. Admin copies code and embeds it
9. Modal closes

API Call:
- `POST /api/channels/webchat/create` (name?)
- `PUT /api/channels/webchat/{accountId}/settings` (color, iconUrl, title, position)
- Response: { data: { widgetId, apiUrl, ... } }

State Changes:
- embedModal state
- widgetColor, widgetTitle, widgetPosition, widgetIconUrl states
- embedTab state (which code sample to show)

Edge Cases:
- Color picker validation
- Icon URL validation
- Multiple code samples for different frameworks
- Widget preview may be shown

---

**User Story #34:**
As a web admin,
I want to customize the web chat widget appearance,
So that it matches my brand.

UI Entry Point:
- Web chat settings modal (color, title, icon, position controls)

Frontend Location:
- `/frontend/src/app/channels/page.tsx` (widget customization inputs)

Frontend Action Flow:
1. Admin opens web chat widget settings
2. Admin adjusts:
   - Color via hex input or color picker
   - Title text ("Chat with us")
   - Icon URL
   - Position toggle (right/left)
3. savingWidget state set during save
4. updateWebchatSettings API called
5. Settings persisted
6. Success message shown

API Call:
- `PUT /api/channels/webchat/{accountId}/settings` (color, iconUrl, title, position)

State Changes:
- widgetColor, widgetTitle, widgetPosition, widgetIconUrl, savingWidget states

Edge Cases:
- Icon URL validation
- Real-time preview of widget (optional)
- Color validation (hex format)

---

**User Story #35:**
As a web admin,
I want to copy the web chat embed code,
So that I can add it to my website.

UI Entry Point:
- Multiple code tabs (HTML, Next.js, React, Vue, PHP)
- Copy button for each code block

Frontend Location:
- `/frontend/src/app/channels/page.tsx` (embedTab state, code generation)

Frontend Action Flow:
1. Admin selects desired framework tab in embedModal
2. Code displayed for that framework
3. Admin clicks Copy button
4. Code copied to clipboard
5. Toast confirmation shown
6. Admin pastes code into website

API Call:
- No API call (code generation frontend-only)

State Changes:
- embedTab state

Edge Cases:
- Copy button feedback (visual confirmation)
- Code dynamically generated based on widget config

---

## Page: /outbound/broadcasts

**User Story #36:**
As a marketer,
I want to create a new broadcast campaign,
So that I can send bulk messages to customers.

UI Entry Point:
- "Create Broadcast" button
- Wizard panel slides in from right

Frontend Location:
- `/frontend/src/app/outbound/broadcasts/page.tsx` (openCreate, showPanel state)

Frontend Action Flow:
1. Marketer clicks "Create Broadcast" button
2. Broadcast creation wizard panel opens (4-step wizard)
3. Step 1: Select channel, channel account, template, or custom body
4. Step 2: Define recipients (segment rules, import list, or all customers)
5. Step 3: Schedule or send immediately
6. Step 4: Review and send
7. Marketer completes each step
8. On final step, createBroadcast API called
9. Broadcast created (status: DRAFT or SCHEDULED)
10. Success message shown
11. Panel closes, list refreshed

API Call:
- `POST /api/broadcasts` (name, channel, channelAccountId, templateId, body, segmentRules, recipientTab, importText, sendNow, scheduledAt)
- Response: { data: { id, status, ... } }

State Changes:
- wizard state (multi-step form)
- step counter
- showPanel, editingId states
- broadcasts list refreshed

Edge Cases:
- Validation at each step
- File upload for recipient import
- Segment rule builder (add/remove rules)
- Scheduled vs send-now modes

---

**User Story #37:**
As a marketer,
I want to define recipient segments,
So that I can target specific customer groups.

UI Entry Point:
- Step 2 of broadcast wizard: "Recipients" tab
- Segment rule builder with add/remove buttons

Frontend Location:
- `/frontend/src/app/outbound/broadcasts/page.tsx` (segmentRules state in wizard)

Frontend Action Flow:
1. Marketer selects "Segment" tab in Step 2
2. Segment rule builder displayed
3. Marketer adds rules:
   - Field (channel, tag, phone, email, lastSeenAfter)
   - Operator (equals, contains, startsWith)
   - Value (text input)
4. Multiple rules can be combined (AND logic)
5. Marketer clicks "Add Rule" button to add more rows
6. Marketer clicks X button to remove a rule
7. Rules stored in wizard.segmentRules array
8. Preview shows matching customer count (optional)

API Call:
- `POST /api/broadcasts/query-segment` (optional, to show matching count)

State Changes:
- segmentRules array in wizard state

Edge Cases:
- Multiple rule rows
- Operator selection depends on field type
- Empty value validation

---

**User Story #38:**
As a marketer,
I want to import a list of recipients,
So that I can send to a specific set of customers.

UI Entry Point:
- Step 2 of broadcast wizard: "Import" tab
- File upload or paste text area

Frontend Location:
- `/frontend/src/app/outbound/broadcasts/page.tsx` (uploadMode, fileInputRef states)

Frontend Action Flow:
1. Marketer selects "Import" tab in Step 2
2. Marketer can:
   - Drag-and-drop a CSV/TXT file
   - Click file input to browse
   - Paste phone numbers/emails into text area
3. File/text parsed for phone numbers or email addresses
4. importText stored in wizard.importText
5. Preview shows number of recipients parsed

API Call:
- `POST /api/broadcasts/{id}/add-recipients` (after broadcast created, in final step)

State Changes:
- importText state in wizard
- dragOver state during drag-over

Edge Cases:
- File parsing validation
- Max file size limit
- Format validation (phone vs email)
- Preview row count

---

**User Story #39:**
As a marketer,
I want to schedule a broadcast,
So that it sends at a specific time.

UI Entry Point:
- Step 3 of broadcast wizard: Schedule section
- Toggle "Send Now" / "Schedule for Later"
- Date/time picker if scheduled

Frontend Location:
- `/frontend/src/app/outbound/broadcasts/page.tsx` (sendNow, scheduledAt states in wizard)

Frontend Action Flow:
1. In Step 3, marketer sees toggle "Send Now / Schedule for Later"
2. If "Send Now" selected:
   - sendNow = true
   - scheduledAt ignored
3. If "Schedule for Later" selected:
   - Date/time picker appears
   - Marketer selects date and time
   - scheduledAt stored in wizard
4. On final step, broadcast created with sendNow flag and scheduledAt

API Call:
- `POST /api/broadcasts` (sendNow, scheduledAt)

State Changes:
- wizard.sendNow, wizard.scheduledAt states

Edge Cases:
- Scheduled time must be in future
- Timezone consideration
- Time picker UI (datetime-local input)

---

**User Story #40:**
As a marketer,
I want to validate a broadcast before sending,
So that I can catch errors.

UI Entry Point:
- Step 4 (Review): "Validate" button before "Send"

Frontend Location:
- `/frontend/src/app/outbound/broadcasts/page.tsx` (handleNext, validateBroadcast)

Frontend Action Flow:
1. On Step 3→4 transition, validateBroadcast API called
2. Backend checks:
   - Recipients count > 0
   - Body/template valid
   - Channel account connected
3. If valid, Step 4 shows with summary
4. If invalid, error messages shown
5. Marketer can go back to fix issues

API Call:
- `POST /api/broadcasts/{id}/validate`
- Response: { valid: boolean, errors: [...] }

State Changes:
- validation state object
- validating boolean
- error array

Edge Cases:
- Validation errors shown inline
- Step 4 disabled until valid

---

**User Story #41:**
As a marketer,
I want to send a broadcast,
So that customers receive the messages.

UI Entry Point:
- Step 4: "Send" button

Frontend Location:
- `/frontend/src/app/outbound/broadcasts/page.tsx` (handleFinish, sendBroadcast)

Frontend Action Flow:
1. Marketer clicks "Send" on Step 4
2. sendBroadcast API called
3. Broadcasting begins (status changes to SENDING)
4. Progress bar shown during sending
5. Real-time updates via socket.io show:
   - sentCount
   - deliveredCount
   - readCount
   - failedCount
6. Final success message shown
7. Wizard closes, list refreshed with new broadcast

API Call:
- `POST /api/broadcasts/{id}/send`
- Real-time: socket.io broadcasts status updates

State Changes:
- broadcasts list updated with new broadcast
- showPanel closes
- step reset

Edge Cases:
- Broadcast status changes to SENDING → COMPLETED
- Failures tracked and shown
- User can navigate away while broadcasting continues

---

**User Story #42:**
As a marketer,
I want to view a broadcast's delivery status,
So that I can see how many customers received it.

UI Entry Point:
- Broadcast list row (expandable details)
- Sent count, delivered count, read count, failed count

Frontend Location:
- `/frontend/src/app/outbound/broadcasts/page.tsx` (broadcasts list, expandedId state)

Frontend Action Flow:
1. Broadcast displayed in list with status badge
2. Marketer clicks expand button
3. Broadcast details shown:
   - Name, channel, status
   - Recipient count
   - Progress bars: sent, delivered, read, failed
   - Last error message (if any)
   - Timestamps (scheduled, sent, completed)
4. Marketer can collapse details

API Call:
- No additional API call (data from getBroadcasts response)

State Changes:
- expandedId state

Edge Cases:
- Empty values if not yet sent
- Real-time updates via socket.io

---

**User Story #43:**
As a marketer,
I want to cancel a broadcast,
So that I can stop sending it.

UI Entry Point:
- Broadcast row action menu: "Cancel" button
- Confirmation modal

Frontend Location:
- `/frontend/src/app/outbound/broadcasts/page.tsx` (handleCancel)

Frontend Action Flow:
1. Marketer clicks "Cancel" button on broadcast (only if SCHEDULED or SENDING)
2. Confirmation modal appears
3. Marketer confirms
4. cancelBroadcast API called
5. Broadcast status changes to CANCELLED
6. List refreshed

API Call:
- `POST /api/broadcasts/{id}/cancel`

State Changes:
- broadcasts list updated
- broadcast.status = "CANCELLED"

Edge Cases:
- Only SCHEDULED or SENDING broadcasts can be cancelled
- Confirmation required

---

**User Story #44:**
As a marketer,
I want to delete a broadcast,
So that I can remove it from the system.

UI Entry Point:
- Broadcast row action menu: "Delete" button
- Confirmation modal

Frontend Location:
- `/frontend/src/app/outbound/broadcasts/page.tsx` (handleDelete)

Frontend Action Flow:
1. Marketer clicks "Delete" button on broadcast
2. Confirmation modal appears
3. Marketer confirms
4. deleteBroadcast API called
5. Broadcast removed from list

API Call:
- `DELETE /api/broadcasts/{id}`

State Changes:
- broadcasts list updated (broadcast removed)

Edge Cases:
- Confirmation required
- Only DRAFT or completed broadcasts can be deleted

---

## Page: /outbound/templates

**User Story #45:**
As a marketer,
I want to create a WhatsApp message template,
So that I can use it in broadcasts.

UI Entry Point:
- "Create Template" button
- Template creation form

Frontend Location:
- `/frontend/src/app/outbound/templates/page.tsx` (panelMode, template form state)

Frontend Action Flow:
1. Marketer clicks "Create Template" button
2. Form appears with fields:
   - Name
   - Channel (WhatsApp, etc.)
   - Category (MARKETING, UTILITY, AUTHENTICATION)
   - Language (en, he, ar, es, fr, de, pt)
   - Header type (NONE, TEXT, IMAGE, VIDEO, DOCUMENT)
   - Header text (if TEXT)
   - Body (supports {{1}}, {{2}}, etc. for variables)
   - Footer
3. Marketer fills form
4. createTemplate API called
5. Template saved
6. List refreshed

API Call:
- `POST /api/templates` (name, channel, channelAccountId, category, language, status, body, headerType, headerText, footer)

State Changes:
- templates list updated
- panelOpen closes
- form fields reset

Edge Cases:
- Variable placeholder syntax ({{1}}, {{2}})
- Header validation (only image/video on WhatsApp)
- Category affects submission requirements (MARKETING needs footer, etc.)

---

**User Story #46:**
As a marketer,
I want to see a preview of a template,
So that I can verify the message looks correct.

UI Entry Point:
- Template form: Preview section (WhatsApp phone frame)

Frontend Location:
- `/frontend/src/app/outbound/templates/page.tsx` (WhatsAppPreview component)

Frontend Action Flow:
1. Marketer fills template form
2. Preview updates in real-time on right side
3. Shows WhatsApp phone frame with:
   - Header (if set)
   - Body text
   - Footer (if set)
   - Variables shown as {{1}}, {{2}}, etc. (or example values if provided)
4. Preview matches WhatsApp styling

API Call:
- No API call (frontend-only rendering)

State Changes:
- No state change, derived from form inputs

Edge Cases:
- Long text wrapping
- Variable count mismatch warning
- Image/video placeholders

---

**User Story #47:**
As a marketer,
I want to submit a template to Meta for approval,
So that I can use it for sending.

UI Entry Point:
- Template row action menu: "Submit to Meta" button (only for DRAFT templates)

Frontend Location:
- `/frontend/src/app/outbound/templates/page.tsx` (submitTemplateToMeta inline function)

Frontend Action Flow:
1. Marketer clicks "Submit to Meta" on DRAFT template
2. submitTemplateToMeta API called
3. Template status changes to PENDING_APPROVAL
4. Button disabled or hidden
5. Success message shown
6. List refreshed

API Call:
- `POST /api/templates/{id}/submit-to-meta`

State Changes:
- templates list updated
- template.status = "PENDING_APPROVAL"

Edge Cases:
- Only DRAFT status templates can be submitted
- Waiting for Meta's approval (can take hours/days)
- REJECTED templates can be edited and resubmitted

---

**User Story #48:**
As a marketer,
I want to duplicate a template,
So that I can create variants.

UI Entry Point:
- Template row action menu: "Duplicate" button

Frontend Location:
- `/frontend/src/app/outbound/templates/page.tsx` (duplicateTemplate)

Frontend Action Flow:
1. Marketer clicks "Duplicate" on template
2. duplicateTemplate API called
3. New template created (name: "Copy of {original name}")
4. Status: DRAFT
5. List refreshed with new template

API Call:
- `POST /api/templates/{id}/duplicate`

State Changes:
- templates list updated with new duplicate template

Edge Cases:
- Original template not modified
- New template is always DRAFT status

---

**User Story #49:**
As a marketer,
I want to update a template,
So that I can change its content.

UI Entry Point:
- Template row: Edit button
- Form pre-filled with template data

Frontend Location:
- `/frontend/src/app/outbound/templates/page.tsx` (panelMode="edit", template form)

Frontend Action Flow:
1. Marketer clicks Edit on template
2. Form opens with template data pre-filled
3. Marketer edits fields
4. updateTemplate API called
5. Template updated
6. List refreshed

API Call:
- `PUT /api/templates/{id}` (updated fields)

State Changes:
- templates list updated
- form fields reset

Edge Cases:
- Only DRAFT templates can be fully edited
- Some fields may be read-only for APPROVED templates

---

**User Story #50:**
As a marketer,
I want to delete a template,
So that I can remove unused templates.

UI Entry Point:
- Template row action menu: "Delete" button

Frontend Location:
- `/frontend/src/app/outbound/templates/page.tsx` (handleDelete)

Frontend Action Flow:
1. Marketer clicks "Delete" on template
2. Optional confirmation modal
3. deleteTemplate API called
4. Template removed from list

API Call:
- `DELETE /api/templates/{id}` (force?: boolean)

State Changes:
- templates list updated

Edge Cases:
- Confirmation may be required
- Only DRAFT or REJECTED templates can be deleted
- If template is in use, deletion may be prevented

---

## Page: /knowledge

**User Story #51:**
As an admin,
I want to create a knowledge base,
So that I can organize documents for AI to reference.

UI Entry Point:
- "Create Knowledge Base" button
- Modal with name and description fields

Frontend Location:
- `/frontend/src/app/knowledge/page.tsx` (showCreateModal, newKbName, newKbDescription)

Frontend Action Flow:
1. Admin clicks "Create Knowledge Base" button
2. Modal appears
3. Admin enters:
   - Name
   - Description (optional)
4. Admin clicks "Create"
5. createKnowledgeBase API called
6. Knowledge base created
7. Modal closes
8. List refreshed
9. New KB automatically selected

API Call:
- `POST /api/knowledge-bases` (name, description)

State Changes:
- knowledgeBases list updated
- selectedKb state set to new KB id
- Modal closes

Edge Cases:
- Name is required
- Empty list state if no KBs created

---

**User Story #52:**
As an admin,
I want to upload a document to a knowledge base,
So that AI can reference it when answering.

UI Entry Point:
- "Add Document" button (when KB selected)
- Modal with two tabs: "Text" and "File"

Frontend Location:
- `/frontend/src/app/knowledge/page.tsx` (showUploadModal, uploadMode, docTitle, docContent)

Frontend Action Flow:
1. Admin selects knowledge base
2. Clicks "Add Document" button
3. Modal appears with Text/File tabs
4. If "Text" tab:
   - Admin enters title and content
   - Clicks "Upload"
   - uploadKnowledgeDocument API called
   - processKnowledgeDocument API called to chunk and embed
   - Document status: "PROCESSING" → "COMPLETED"
5. If "File" tab:
   - Admin selects file (PDF, DOCX, TXT, etc.)
   - uploadKnowledgeFile API called (FormData)
   - Document processing begins

API Call:
- `POST /api/knowledge-bases/{id}/documents` (title, content, sourceType)
- `POST /api/knowledge-bases/{id}/documents/{docId}/process` (chunking + embedding)
- Or: `POST /api/knowledge-bases/{id}/documents/upload` (FormData with file)

State Changes:
- knowledgeBases list updated with new document
- docTitle, docContent, selectedFile cleared
- Modal closes

Edge Cases:
- File upload with drag-and-drop support
- Processing status shown while document chunks
- Error handling for large files or format issues

---

**User Story #53:**
As an admin,
I want to delete a document from a knowledge base,
So that I can remove outdated or incorrect content.

UI Entry Point:
- Document row action menu: "Delete" button

Frontend Location:
- `/frontend/src/app/knowledge/page.tsx` (handleDeleteDoc)

Frontend Action Flow:
1. Admin clicks "Delete" on document
2. Optional confirmation
3. deleteKnowledgeDocument API called
4. Document removed from KB
5. List refreshed

API Call:
- `DELETE /api/knowledge-bases/{kbId}/documents/{docId}`

State Changes:
- knowledgeBases list updated (document removed)

Edge Cases:
- Confirmation may be required
- In-progress processing cannot be interrupted (?)

---

**User Story #54:**
As an admin,
I want to integrate a knowledge source (Confluence, Google Drive),
So that I can automatically sync documents.

UI Entry Point:
- "Integrations" tab (when KB selected)
- "Connect Integration" button with menu (Confluence, Google Drive, etc.)

Frontend Location:
- `/frontend/src/app/knowledge/page.tsx` (showConnectMenu, browseIntegration state)

Frontend Action Flow:
1. Admin clicks "Connect Integration" button
2. Menu appears with provider options
3. Admin selects provider (e.g., Confluence)
4. initConfluenceOAuth API called
5. OAuth authorize URL returned
6. Browser redirected to Confluence login
7. User authorizes app
8. Browser redirected back with integration created
9. Browse modal opens to select spaces/files to sync
10. Admin selects items
11. syncConfluenceSpaces or syncDriveFiles API called
12. Sync begins

API Call:
- `POST /api/knowledge/oauth/confluence/init?kbId={id}` → returns OAuth URL
- `GET /api/knowledge/integrations/{intId}/confluence/spaces` (list spaces)
- `GET /api/knowledge/integrations/{intId}/confluence/spaces/{key}/pages` (list pages)
- `POST /api/knowledge/integrations/{intId}/confluence/sync` (spaceKeys)
- Similar for Google Drive

State Changes:
- integrations list updated
- browseIntegration state set
- browseItems populated
- browseSelected Set tracks selected items

Edge Cases:
- OAuth flow may fail or be cancelled
- Browse modal for space/file selection
- Real-time sync progress
- Sync errors handling

---

**User Story #55:**
As an admin,
I want to delete a knowledge integration,
So that I can stop syncing from a source.

UI Entry Point:
- Integration row action menu: "Delete" button

Frontend Location:
- `/frontend/src/app/knowledge/page.tsx` (handleDeleteIntegration)

Frontend Action Flow:
1. Admin clicks "Delete" on integration
2. Confirmation modal appears
3. Admin confirms
4. deleteKnowledgeIntegration API called
5. Integration removed
6. Sync stopped

API Call:
- `DELETE /api/knowledge/integrations/{intId}`

State Changes:
- integrations list updated

Edge Cases:
- Confirmation required
- Documents synced from this source may remain (or be deleted)

---

## Page: /agents

**User Story #56:**
As an admin,
I want to create a new agent account,
So that a team member can log in and handle conversations.

UI Entry Point:
- "Create Agent" button
- Side panel with form fields

Frontend Location:
- `/frontend/src/app/agents/page.tsx` (panelMode="create", form fields)

Frontend Action Flow:
1. Admin clicks "Create Agent" button
2. Side panel opens with empty form
3. Admin fills:
   - Name
   - Email
   - Password (initial password, can be reset)
   - Department (optional)
4. Admin clicks "Create"
5. createAgent API called
6. New agent account created
7. If department selected: assignAgentToDepartment called
8. Panel closes
9. List refreshed
10. Success message shown

API Call:
- `POST /api/agents` (name, email, password)
- `POST /api/departments/{deptId}/members` (userId, departmentRole) [if dept assigned]

State Changes:
- agents list updated
- Panel closes, form resets

Edge Cases:
- Email must be unique
- Password strength requirement
- Department assignment optional
- New agent gets default role (AGENT)

---

**User Story #57:**
As an admin,
I want to edit an agent's name,
So that I can keep their profile updated.

UI Entry Point:
- Agent row: Edit button
- Side panel with form pre-filled

Frontend Location:
- `/frontend/src/app/agents/page.tsx` (panelMode="edit", formName)

Frontend Action Flow:
1. Admin clicks Edit on agent
2. Panel opens with current data
3. Admin edits Name field
4. Admin clicks "Save"
5. updateAgent API called
6. Agent updated
7. List refreshed

API Call:
- `PATCH /api/agents/{id}` (name)

State Changes:
- agents list updated
- Panel form fields reset

Edge Cases:
- Email is read-only
- Department can be changed via separate form

---

**User Story #58:**
As an admin,
I want to reset an agent's password,
So that they can regain access if forgotten.

UI Entry Point:
- Agent panel: "Reset Password" button (in edit mode)
- Modal with new password field

Frontend Location:
- `/frontend/src/app/agents/page.tsx` (showResetPassword, newPassword state)

Frontend Action Flow:
1. Admin clicks "Reset Password" button
2. Reset password modal appears
3. Admin enters new password (min 8 chars)
4. Admin clicks "Confirm"
5. resetAgentPassword API called
6. Password updated
7. Success message shown
8. Modal closes

API Call:
- `POST /api/agents/{id}/reset-password` (newPassword)

State Changes:
- newPassword cleared
- resetSuccess shown
- resetPassword modal closes

Edge Cases:
- Password strength requirement
- Confirmation may be needed
- New password sent to agent (or agent notified)

---

**User Story #59:**
As an admin,
I want to toggle an agent's active status,
So that I can deactivate agents who've left.

UI Entry Point:
- Agent panel: "Active" toggle switch (in edit mode)

Frontend Location:
- `/frontend/src/app/agents/page.tsx` (handleToggleActive)

Frontend Action Flow:
1. Admin views agent in edit panel
2. Clicks "Active" toggle switch
3. Switch animates
4. updateAgent API called with isActive flag
5. Agent status updated
6. List refreshed

API Call:
- `PATCH /api/agents/{id}` (isActive)

State Changes:
- agents list updated
- panelAgent state updated

Edge Cases:
- Inactive agents may not be able to log in
- Conversations assigned to inactive agents can be reassigned

---

**User Story #60:**
As an admin,
I want to assign an agent to a department,
So that they can handle department-specific conversations.

UI Entry Point:
- Agent panel: Department dropdown (create or edit mode)

Frontend Location:
- `/frontend/src/app/agents/page.tsx` (formDepartmentId state, department list dropdown)

Frontend Action Flow:
1. Admin creates or edits agent
2. Selects department from dropdown
3. On save, assignAgentToDepartment API called
4. Agent assigned to department

API Call:
- `POST /api/departments/{deptId}/members` (userId, departmentRole)
- Or department assignment may be part of agent creation

State Changes:
- formDepartmentId state
- agents list updated

Edge Cases:
- Agent can be reassigned to different department
- Removing department removes agent from it

---

**User Story #61:**
As an admin,
I want to delete an agent account,
So that I can remove team members who've left.

UI Entry Point:
- Agent row action menu: "Delete" button
- Confirmation modal

Frontend Location:
- `/frontend/src/app/agents/page.tsx` (handleDelete, deleteTarget state)

Frontend Action Flow:
1. Admin clicks "Delete" on agent
2. Confirmation modal appears with agent name
3. Admin confirms
4. deleteAgent API called
5. Agent account deleted
6. List refreshed

API Call:
- `DELETE /api/agents/{id}`

State Changes:
- agents list updated
- Panel closes

Edge Cases:
- Confirmation required
- Conversations assigned to deleted agent may become unassigned
- Cannot delete own account

---

## Page: /departments

**User Story #62:**
As an admin,
I want to create a department,
So that I can organize agents into teams.

UI Entry Point:
- "Create Department" button
- Modal with name, description, queue mode fields

Frontend Location:
- `/frontend/src/app/departments/page.tsx` (showCreateModal state)

Frontend Action Flow:
1. Admin clicks "Create Department" button
2. Modal appears
3. Admin fills:
   - Name
   - Description (optional)
   - Queue Mode (ROUND_ROBIN or CLAIM)
4. Admin clicks "Create"
5. createDepartment API called
6. Department created
7. List refreshed
8. New department appears at bottom (or root if top-level)

API Call:
- `POST /api/departments` (name, description, queueMode)

State Changes:
- Department tree updated
- Modal closes

Edge Cases:
- Name is required
- Queue mode defaults to ROUND_ROBIN
- Nested departments may be supported (parentId)

---

**User Story #63:**
As an admin,
I want to edit a department,
So that I can update its name or settings.

UI Entry Point:
- Department card: Edit button
- Modal with pre-filled fields

Frontend Location:
- `/frontend/src/app/departments/page.tsx` (onEdit callback)

Frontend Action Flow:
1. Admin clicks Edit on department
2. Modal appears with current data
3. Admin edits fields
4. updateDepartment API called
5. Department updated

API Call:
- `PATCH /api/departments/{id}` (name, description, queueMode, isActive)

State Changes:
- Department tree updated

Edge Cases:
- Root departments may have special restrictions
- Active/inactive toggle

---

**User Story #64:**
As an admin,
I want to manage department members,
So that I can assign agents to departments.

UI Entry Point:
- Department card: "Members" button
- Side panel showing member list and add/remove options

Frontend Location:
- `/frontend/src/app/departments/page.tsx` (onManage callback, member list panel)

Frontend Action Flow:
1. Admin clicks "Members" button on department
2. Side panel opens showing:
   - List of current members
   - Role badges (AGENT, MANAGER)
   - Remove button for each member
3. Admin can add members:
   - Click "Add Member" button
   - Select agent from dropdown
   - Choose role (AGENT or MANAGER)
   - Click "Add"
4. Or admin can remove members:
   - Click remove button
   - Optional confirmation
5. removeAgentFromDepartment or addDepartmentMember APIs called

API Call:
- `GET /api/departments/{id}/members` (initial load)
- `POST /api/departments/{id}/members` (agentId, departmentRole)
- `DELETE /api/departments/{id}/members/{userId}`
- `PATCH /api/departments/{id}/members/{userId}` (update role)

State Changes:
- members list updated
- Panel refreshed

Edge Cases:
- Agents dropdown filtered (show only unassigned agents for add)
- Role change via role selector or button
- Confirm removal of managers

---

**User Story #65:**
As an admin,
I want to view the department hierarchy,
So that I can understand the organizational structure.

UI Entry Point:
- Department page displays tree structure
- Expandable nodes with children
- Breadcrumb or parent indicators

Frontend Location:
- `/frontend/src/app/departments/page.tsx` (DepartmentNode component, expanded state)

Frontend Action Flow:
1. Page loads department tree
2. getDepartmentTree API called
3. Tree rendered with:
   - Root departments at top level
   - Child departments indented
   - Expand/collapse toggle on parent nodes
4. Admin clicks expand arrow to show/hide children
5. Members count shown for each department

API Call:
- `GET /api/departments` (returns hierarchical tree structure)

State Changes:
- expanded boolean state per department node

Edge Cases:
- Deep nesting (3+ levels)
- Rendering performance for large trees
- Breadcrumb navigation up the tree

---

**User Story #66:**
As an admin,
I want to delete a department,
So that I can remove unused teams.

UI Entry Point:
- Department card action menu: "Delete" button
- Confirmation modal

Frontend Location:
- `/frontend/src/app/departments/page.tsx` (onDelete callback)

Frontend Action Flow:
1. Admin clicks "Delete" on department
2. Confirmation modal appears
3. If department has members, warning shown
4. Admin confirms
5. deleteDepartment API called
6. Department deleted (members may be moved or unassigned)
7. Tree refreshed

API Call:
- `DELETE /api/departments/{id}`

State Changes:
- Tree updated

Edge Cases:
- Confirmation required
- Warning if department has active members
- Child departments may be promoted to parent

---

**User Story #67:**
As an admin,
I want to assign an AI agent to a department,
So that the department has AI support.

UI Entry Point:
- Department card: "Assign AI Agent" button
- Modal with AI agents list

Frontend Location:
- `/frontend/src/app/departments/page.tsx` (onAssignAI callback)

Frontend Action Flow:
1. Admin clicks "Assign AI Agent" button
2. Modal appears showing available AI agents
3. Admin selects AI agent
4. assignDepartmentAIEmployee API called
5. AI agent assigned to department
6. Modal closes, department card shows AI agent

API Call:
- `POST /api/departments/{id}/ai-employee` (aiAgentId)
- `GET /api/ai-studio/agents` (list of AI agents)

State Changes:
- Department AI assignment updated

Edge Cases:
- Only one AI agent per department (?)
- Unassign option may be available

---

## Page: /history

**User Story #68:**
As a manager,
I want to view closed conversations,
So that I can review past interactions.

UI Entry Point:
- History page with conversation list
- Filter by channel, customer, status

Frontend Location:
- `/frontend/src/app/history/page.tsx` (conversations, filters)

Frontend Action Flow:
1. History page loads
2. getConversations API called with status=CLOSED filter
3. Closed conversations displayed in list
4. Customer grouped by contact ID or phone
5. Manager can filter by:
   - Channel
   - Search (customer name)
   - Status (CLOSED)
6. Manager clicks conversation to view details/replay

API Call:
- `GET /api/conversations?status=CLOSED&search=...&channel=...&limit=200&page=...`

State Changes:
- conversations list
- filters state
- page state (pagination)

Edge Cases:
- Pagination support (totalPages in meta)
- Empty history if no closed conversations
- Large history list with search optimization

---

**User Story #69:**
As a manager,
I want to view conversation scores and ratings,
So that I can assess conversation quality.

UI Entry Point:
- History conversation details: Score section
- Star rating display

Frontend Location:
- `/frontend/src/app/history/page.tsx` (showScore, scoreData state)

Frontend Action Flow:
1. Manager clicks conversation
2. Conversation replay panel opens
3. Manager clicks "View Score" button
4. getConversationScore API called
5. Score panel displays:
   - Star rating (1-5 based on satisfaction)
   - Category scores (response time, resolution, helpfulness)
   - Score bars with values
6. Panel can be closed

API Call:
- `GET /api/conversations/{id}/score`

State Changes:
- showScore boolean
- scoreData object
- scoreLoading, scoreError states

Edge Cases:
- Missing scores if no rating provided
- Score calculation methodology (optional explanation)

---

**User Story #70:**
As a manager,
I want to replay a conversation,
So that I can review it step-by-step.

UI Entry Point:
- History conversation row: Click to open
- Replay panel with playback controls

Frontend Location:
- `/frontend/src/app/history/page.tsx` (ConversationReplay component)

Frontend Action Flow:
1. Manager clicks conversation in history list
2. Conversation details loaded
3. Replay panel opens showing:
   - Messages in sequence
   - Playback speed control
   - Timestamps
   - Play/pause buttons
4. Manager can play through conversation at adjusted speed
5. Messages appear one by one in chronological order
6. Customer sentiment shown (if available)

API Call:
- `GET /api/conversations/{id}` (fetch messages if not already loaded)

State Changes:
- selectedConvId state
- showReplay boolean
- messages array loaded

Edge Cases:
- Playback speed options (1x, 2x, 0.5x)
- Message grouping (by sender, by time)

---

## Page: /settings

**User Story #71:**
As an admin,
I want to configure business hours,
So that agents only respond during working hours.

UI Entry Point:
- Settings page: Business Hours section (collapsible card)
- Toggle enable/disable
- Day-by-day time picker (Mon-Sun)
- Timezone selector
- Auto-response template

Frontend Location:
- `/frontend/src/app/settings/page.tsx` (config state, DAYS array)

Frontend Action Flow:
1. Admin toggles business hours enable
2. If enabled, admin sets:
   - Timezone (dropdown with options like Asia/Jerusalem, America/New_York, etc.)
   - For each day (Sunday-Saturday):
     - Enable/disable toggle
     - Open time (time picker)
     - Close time (time picker)
   - Auto-response message (text area)
3. Admin clicks "Save"
4. updateBusinessHours API called
5. Success message shown

API Call:
- `PUT /api/agents/settings/business-hours` (enabled, timezone, schedule, autoResponse)

State Changes:
- config state updated

Edge Cases:
- Time validation (close > open)
- Timezone affects SLA and response time calculations
- Default 9-18 schedule on work days

---

**User Story #72:**
As an admin,
I want to configure auto-greeting,
So that customers get a welcome message.

UI Entry Point:
- Settings page: Auto-Greeting section
- Text area for greeting template

Frontend Location:
- `/frontend/src/app/settings/page.tsx` (greetingTemplate state)

Frontend Action Flow:
1. Admin scrolls to Auto-Greeting section
2. Admin enters greeting message template
3. Template can include variables
4. Admin clicks "Save"
5. updateAutoGreeting API called
6. Greeting saved

API Call:
- `PUT /api/agents/settings/auto-greeting` (template)

State Changes:
- greetingTemplate state

Edge Cases:
- Variables support (e.g., {{firstName}}, {{time}})
- Character limit
- Multi-language templates (?)

---

**User Story #73:**
As an admin,
I want to configure SLA (Service Level Agreement) settings,
So that I can enforce response time targets.

UI Entry Point:
- Settings page: SLA Settings section
- Toggle enable/disable
- SLA minutes input
- Warning threshold % input

Frontend Location:
- `/frontend/src/app/settings/page.tsx` (slaConfig state)

Frontend Action Flow:
1. Admin toggles SLA enable
2. If enabled, admin sets:
   - SLA duration (minutes) - e.g., 30 minutes
   - Warning threshold (% of SLA) - e.g., 70%
3. Admin can override SLA per department:
   - Toggles "Show Department SLA Overrides"
   - Selects department
   - Sets custom SLA minutes
4. Admin clicks "Save"
5. updateSlaSettings API called
6. Department SLAs: updateDepartmentSla called for each override

API Call:
- `PUT /api/agents/settings/sla` (enabled, slaMinutes, warningThreshold)
- `PUT /api/agents/settings/sla/department/{id}` (custom SLA per dept)

State Changes:
- slaConfig, deptSlaMap states

Edge Cases:
- SLA violations trigger warnings in UI
- Dashboard shows SLA compliance metrics
- Department overrides override global setting

---

**User Story #74:**
As an admin,
I want to configure idle automation,
So that I can auto-remind or close inactive conversations.

UI Entry Point:
- Settings page: Idle Automation section
- Reminder section:
  - Toggle enable
  - Delay (minutes) input
  - Message template text area
- Auto-Close section:
  - Toggle enable
  - Delay (minutes) input
  - Close message template text area

Frontend Location:
- `/frontend/src/app/settings/page.tsx` (idleConfig state)

Frontend Action Flow:
1. Admin toggles Reminder enable
2. If enabled, sets:
   - Delay (e.g., 60 minutes)
   - Message to remind customer
3. Admin toggles Auto-Close enable
4. If enabled, sets:
   - Delay (e.g., 24 hours = 1440 minutes)
   - Message before closing
5. Admin clicks "Save"
6. updateIdleAutomation API called

API Call:
- `PUT /api/agents/settings/idle-automation` (reminderEnabled, reminderDelayMinutes, reminderMessage, autoCloseEnabled, autoCloseDelayMinutes, autoCloseMessage)

State Changes:
- idleConfig state

Edge Cases:
- Both can be enabled simultaneously
- Reminders sent before auto-close
- Customers can reply to resets idle timer

---

**User Story #75:**
As a user,
I want to change my password,
So that I can secure my account.

UI Entry Point:
- Settings page: Password section
- Current password, new password, confirm password inputs
- Change Password button

Frontend Location:
- `/frontend/src/app/settings/page.tsx` (currentPassword, newPassword, confirmPassword states)

Frontend Action Flow:
1. User scrolls to Password section
2. User enters:
   - Current password
   - New password (min 8 chars)
   - Confirm password
3. User clicks "Change Password"
4. Validation: new ≠ current, new === confirm
5. changePasswordApi called
6. Success message shown
7. Fields cleared

API Call:
- `POST /api/auth/change-password` (currentPassword, newPassword)

State Changes:
- currentPassword, newPassword, confirmPassword cleared
- passwordMessage shown
- changingPassword boolean during request

Edge Cases:
- Validation errors shown inline
- Password strength indicator (optional)
- Current password required for security

---

## Page: /ai-studio (Hub Page)

**User Story #76:**
As an admin,
I want to view and manage AI agents (team),
So that I can configure autonomous AI team members.

UI Entry Point:
- AI Studio page: "Team" tab (default)
- Cards showing AI agents with mode badge, knowledge count, skills count

Frontend Location:
- `/frontend/src/app/ai-studio/page.tsx` (TeamTab component)

Frontend Action Flow:
1. Team tab displays grid of AI agents
2. Each card shows:
   - Agent name + initials in avatar
   - Status badge (active, draft, paused)
   - Mode badge (autonomous, copilot, human_only)
   - Connected channels (WhatsApp, Instagram, Webchat)
   - Knowledge count
   - Skills count
3. Card is clickable to view/edit agent
4. "Add Team Member" button to create new agent
5. Card click navigates to `/ai-studio/agents/{id}`

API Call:
- `GET /api/ai-studio/agents` (or `getAIAgents` from api.ts)

State Changes:
- agents array populated
- loading state

Edge Cases:
- Empty team state (no agents created)
- Status/mode filtering (optional)
- Sort by name, creation date, etc.

---

**User Story #77:**
As an admin,
I want to create a new AI agent,
So that I can add an autonomous team member.

UI Entry Point:
- Team tab: "Add Team Member" button
- Route to `/ai-studio/agents/new`

Frontend Location:
- `/frontend/src/app/ai-studio/agents/[id]/page.tsx` (new agent form)

Frontend Action Flow:
1. Admin clicks "Add Team Member"
2. Route to `/ai-studio/agents/new`
3. Agent form loaded with empty fields:
   - Name
   - Role (customer_support, sales, booking, billing, custom)
   - Description
   - Avatar color
   - Tone (professional, friendly, casual, formal)
   - Department assignment
   - Languages (English, Hebrew, Arabic checkboxes)
   - Style options (use emojis, concise, use first name, proactive toggles)
   - Channels (WhatsApp, Instagram, Webchat toggles)
   - Mode (human_only, copilot, autonomous radio buttons)
   - Status (active, draft, paused radio buttons)
   - Conversation flow steps
   - Custom guardrails list
4. Admin can add tools and knowledge sources via drawers
5. Admin clicks "Create"
6. createAIAgent API called
7. Agent created, redirects to edit page

API Call:
- `POST /api/ai-studio/agents` (agentFormData)

State Changes:
- New agent created
- Route to `/ai-studio/agents/{newId}`

Edge Cases:
- Form validation (name required, etc.)
- Tool/knowledge selection via modal drawers
- Mode selection affects available options

---

**User Story #78:**
As an admin,
I want to edit an AI agent,
So that I can update its personality and capabilities.

UI Entry Point:
- Agent card click or direct route to `/ai-studio/agents/{id}`
- Full form pre-filled with agent data

Frontend Location:
- `/frontend/src/app/ai-studio/agents/[id]/page.tsx`

Frontend Action Flow:
1. Route to `/ai-studio/agents/{id}`
2. getAIAgent API called to fetch agent data
3. Form loaded with agent data pre-filled
4. Admin can edit all fields (same as create)
5. Admin adds/removes tools via IntegrationDrawer
6. Admin adds/removes knowledge sources via KnowledgeDrawer
7. Admin clicks "Save"
8. updateAIAgent API called
9. Agent updated
10. Success message shown

API Call:
- `GET /api/ai-studio/agents/{id}` (fetch agent)
- `PUT /api/ai-studio/agents/{id}` (update agent)

State Changes:
- Agent form data updated
- API response parsed and displayed

Edge Cases:
- Many form fields
- Tool/knowledge drawers for selection
- Escalation rules builder
- Interactive messages configuration

---

**User Story #79:**
As an admin,
I want to configure an AI agent's tone and style,
So that it matches my brand voice.

UI Entry Point:
- Agent form: "Tone & Style" collapsible section

Frontend Location:
- `/frontend/src/app/ai-studio/agents/[id]/page.tsx` (tone, style form section)

Frontend Action Flow:
1. Admin opens "Tone & Style" section in agent form
2. Selects tone from radio buttons:
   - Professional
   - Friendly
   - Casual
   - Formal
3. Configures style checkboxes:
   - Use Emojis
   - Concise responses
   - Use customer's first name
   - Proactive suggestions
4. Changes auto-save or saved with form

API Call:
- No API call for individual field (saved with overall agent update)

State Changes:
- tone state
- style object in form

Edge Cases:
- Real-time preview of tone in sample message (optional)
- Style combinations affect behavior

---

**User Story #80:**
As an admin,
I want to add tools (integrations) to an AI agent,
So that it can execute actions on external systems.

UI Entry Point:
- Agent form: "Tools" section
- "Add Tool" button opens IntegrationDrawer

Frontend Location:
- `/frontend/src/app/ai-studio/agents/[id]/page.tsx` (IntegrationDrawer component)

Frontend Action Flow:
1. Admin clicks "Add Tool" button
2. IntegrationDrawer slides in
3. Shows list of available tools from connected integrations (Shopify, HubSpot, etc.)
4. Admin can:
   - Search tools by name
   - Filter by category or risk level
   - Toggle tool enable/disable
5. Admin selects tools to add
6. Selected tools appear in form with:
   - Toggle enable/disable
   - Risk badge (low, medium, high)
   - Icon and name
7. Admin can remove tools via X button

API Call:
- `GET /api/marketplace-integrations` (fetch available integrations/tools)

State Changes:
- tools array in form
- IntegrationDrawer visibility

Edge Cases:
- Tool risk level affects AI behavior (high risk may need approval)
- Tool availability depends on tenant's connected integrations
- Some tools may be high-risk and disabled by default

---

**User Story #81:**
As an admin,
I want to add knowledge sources to an AI agent,
So that it can reference documents when answering.

UI Entry Point:
- Agent form: "Knowledge" section
- "Add Knowledge" button opens KnowledgeDrawer

Frontend Location:
- `/frontend/src/app/ai-studio/agents/[id]/page.tsx` (KnowledgeDrawer component)

Frontend Action Flow:
1. Admin clicks "Add Knowledge" button
2. KnowledgeDrawer slides in
3. Shows list of available knowledge bases
4. Admin can:
   - Search by name
   - Filter by status (synced, syncing, error)
   - Toggle KB enable/disable
5. Admin selects KBs to add
6. Selected KBs appear in form with:
   - Toggle enable/disable
   - Status indicator
   - Document count (optional)
7. Admin can remove KBs via X button

API Call:
- `GET /api/knowledge-bases` (fetch available KBs)

State Changes:
- knowledge array in form
- KnowledgeDrawer visibility

Edge Cases:
- KB syncing status shown
- KB selection affects AI's ability to answer certain questions
- Multiple KBs can be added

---

**User Story #82:**
As an admin,
I want to test an AI agent,
So that I can verify its responses before deployment.

UI Entry Point:
- Agent form: "Test Agent" button
- Or TestChatModal appears
- Chat interface to send messages and see responses

Frontend Location:
- `/frontend/src/app/ai-studio/agents/[id]/page.tsx` (TestChatModal component, testAgent state)

Frontend Action Flow:
1. Admin clicks "Test Agent" button
2. TestChatModal appears showing chat interface
3. Admin types test message and sends
4. testAgentChat API called
5. Agent response shown in chat
6. Admin can continue conversation
7. Test history shows in modal
8. Admin closes modal when done

API Call:
- `POST /api/ai-studio/agents/{id}/test` (message, history)
- Response: { data: { reply: string } }

State Changes:
- testAgent state (modal visibility, messages)
- Chat history in modal

Edge Cases:
- Error handling if agent fails
- Long conversation history
- Response latency indication

---

**User Story #83:**
As an admin,
I want to view analytics on AI agent performance,
So that I can see how well it's handling conversations.

UI Entry Point:
- Analytics page: AI Performance tab (or separate analytics)
- Charts showing conversations handled, escalation rate, top categories

Frontend Location:
- `/frontend/src/app/analytics/page.tsx` (DEMO_AI_PERFORMANCE, DEMO_TOP_QUESTIONS, DEMO_TOOL_USAGE states)

Frontend Action Flow:
1. Analytics page loads (demo data shown, or real data if available)
2. AI Performance section displays:
   - Conversations handled by AI (count and %)
   - Avg resolution time
   - Escalation rate (% of conversations escalated to human)
   - Top issue categories handled (pie or bar chart)
3. Tool usage section shows:
   - List of tools used with usage count
   - Success rate per tool
4. Top questions section shows:
   - Most common questions
   - Whether automatable
   - % handled by AI

API Call:
- (Demo data used if real analytics API not available)

State Changes:
- Analytics data loaded (if real API exists)

Edge Cases:
- Data may be demo/mock
- Real analytics would require tracking AI message origins

---

## Page: /ai-studio/flows

**User Story #84:**
As an admin,
I want to create a conversation flow (visual flow builder),
So that I can design custom conversation paths.

UI Entry Point:
- AI Studio page: "Playbooks" tab
- "Create Playbook" button
- Or route to `/ai-studio/flows/new`

Frontend Location:
- `/frontend/src/app/ai-studio/flows/[id]/page.tsx`
- `/frontend/src/components/chatbot/FlowEditor.tsx`

Frontend Action Flow:
1. Admin clicks "Create Playbook" button
2. Route to `/ai-studio/flows/new`
3. FlowEditor component loads (ReactFlow canvas)
4. Admin creates flow by:
   - Adding nodes (user input, bot response, conditional, action)
   - Drawing edges between nodes
   - Configuring node details (text, conditions, actions)
5. Auto-save to localStorage or manual save
6. Admin clicks "Save" button
7. saveFlowCanvas API called
8. Flow saved, redirects to `/ai-studio/flows/{id}`

API Call:
- `POST /api/ai-studio/flows` (if creating new via API)
- `PUT /api/ai-studio/flows/{id}` (saveFlowCanvas with nodes, edges, viewport)

State Changes:
- Flow nodes and edges stored
- Flow ID updated if new

Edge Cases:
- Auto-save to prevent loss
- Validation (all nodes connected, etc.)
- Canvas zoom and pan
- Node type selection menu

---

**User Story #85:**
As an admin,
I want to edit a conversation flow,
So that I can refine conversation paths.

UI Entry Point:
- Playbook row: Edit button
- Route to `/ai-studio/flows/{id}`

Frontend Location:
- `/frontend/src/app/ai-studio/flows/[id]/page.tsx` (FlowEditor component)

Frontend Action Flow:
1. Route to `/ai-studio/flows/{id}`
2. getFlowCanvas API called to fetch flow
3. Flow loaded in editor
4. Admin edits nodes and edges
5. Auto-save or manual save
6. Changes persisted

API Call:
- `GET /api/ai-studio/flows/{id}` (fetch flow)
- `PUT /api/ai-studio/flows/{id}` (save changes)

State Changes:
- Flow nodes/edges updated

Edge Cases:
- Undo/redo support (optional)
- Version history (optional)
- Real-time collaboration (optional)

---

## Page: /copilot (Department/Global Copilot Settings)

**User Story #86:**
As an admin,
I want to configure copilot mode for my team,
So that agents get AI-powered suggestions.

UI Entry Point:
- Copilot page: Global settings section
- Toggle copilot enable
- Tabs for departments

Frontend Location:
- `/frontend/src/app/copilot/page.tsx`

Frontend Action Flow:
1. Copilot page loads
2. Admin can select:
   - Global copilot settings (selectedDeptId = null)
   - Or specific department (selectedDeptId = deptId)
3. For selected scope, admin configures:
   - Copilot mode (READY_MESSAGE, etc.)
   - System prompt (textarea)
   - Rules (editable list)
   - LLM model and provider
4. Admin clicks "Save"
5. updateCopilotSettings or updateDepartmentCopilot API called
6. Success message shown

API Call:
- `GET /api/agents/settings/copilot` (global settings)
- `PUT /api/agents/settings/copilot` (save global)
- `GET /api/departments/{id}/copilot` (department settings)
- `PUT /api/departments/{id}/copilot` (save department)

State Changes:
- copilotMode, systemPrompt, rules, model, provider states
- deptSource state (tenant vs department)

Edge Cases:
- Department settings override global
- Mode selection affects available LLMs
- System prompt character limit

---

**User Story #87:**
As an admin,
I want to manage team members in copilot,
So that I can assign agents and set their roles.

UI Entry Point:
- Copilot page: "Members" tab
- List of agents with department membership
- "Add Member" button

Frontend Location:
- `/frontend/src/app/copilot/page.tsx` (members state, showAddMember)

Frontend Action Flow:
1. Admin clicks "Members" tab
2. Members list loaded for selected department
3. Admin can:
   - Add member: clicks "Add Member", selects agent, chooses role (AGENT/MANAGER), saves
   - Remove member: clicks remove button on member row
   - Update role: clicks role badge to change
4. addDepartmentMember, removeDepartmentMember, updateDepartmentMember APIs called

API Call:
- `GET /api/departments/{id}/members` (fetch members)
- `POST /api/departments/{id}/members` (add member)
- `DELETE /api/departments/{id}/members/{userId}` (remove)
- `PATCH /api/departments/{id}/members/{userId}` (update role)

State Changes:
- members array
- showAddMember modal visibility

Edge Cases:
- Role affects permissions
- Agents dropdown filtered (show only unassigned)
- Confirm removal of managers

---

## Page: /integrations (Marketplace)

**User Story #88:**
As an admin,
I want to browse available integrations,
So that I can connect external tools.

UI Entry Point:
- Integrations page with grid of integration cards
- Category filter buttons
- Search input

Frontend Location:
- `/frontend/src/app/integrations/page.tsx`

Frontend Action Flow:
1. Integrations page loads
2. getMarketplaceIntegrations API called
3. Integrations grid displayed with:
   - Logo (or avatar)
   - Name
   - Category badge
   - Description
   - Connect button
   - Auth type badge (OAuth2, API_KEY, etc.)
4. Admin can:
   - Filter by category (All, E-Commerce, CRM, Payments, etc.)
   - Search by name
   - Click card to view details
5. Click "Connect" button to initiate setup

API Call:
- `GET /api/marketplace-integrations`

State Changes:
- integrations list
- activeCategory filter
- search filter

Edge Cases:
- Logo fallback if image fails to load
- Category filtering client-side
- Search filters list client-side

---

**User Story #89:**
As an admin,
I want to connect an integration,
So that I can use its tools in my workflows.

UI Entry Point:
- Integration card: "Connect" button
- Route to `/integrations/{slug}`

Frontend Location:
- `/frontend/src/app/integrations/[slug]/page.tsx`

Frontend Action Flow:
1. Route to `/integrations/{slug}`
2. Integration details page loaded
3. Setup instructions and "Connect" button shown
4. If OAuth:
   - Admin clicks "Connect"
   - OAuth authorize URL opened in new tab
   - User logs in and approves
   - Browser redirects back with code
   - Integration connected
5. If API Key:
   - Admin enters API key in form
   - Submits
   - Integration connected

API Call:
- `POST /api/integrations/oauth/init?provider={slug}` (if OAuth)
- Or manual API key submission

State Changes:
- Integration connection status updated
- Redirect to integrations page or details

Edge Cases:
- OAuth redirect handling
- API key validation
- Error messages if connection fails

---

## Page: /bot (Bot Configuration)

**User Story #90:**
As an admin,
I want to enable/configure the autonomous AI bot,
So that it can handle conversations without human agents.

UI Entry Point:
- Bot page: Feature enable toggle
- If enabled, AI Bot settings form appears

Frontend Location:
- `/frontend/src/app/bot/page.tsx` (AIBotSettings component, featureEnabled state)

Frontend Action Flow:
1. Bot page loads
2. If featureEnabled = null or false:
   - Message shown: "AI Bot Not Configured"
   - System admin must enable it
3. If featureEnabled = true:
   - Form shown with settings:
     - Active toggle
     - System prompt (textarea)
     - Rules (editable list)
     - Tools (checkboxes with toggle per tool)
     - Model selection (gpt-4o-mini, etc.)
     - Provider (openai)
     - Temperature, maxTokens sliders
     - Max autonomous messages and minutes
     - Confidence threshold
     - Escalation message
4. Admin edits and clicks "Save"
5. updateFirstTakeCareSettings API called

API Call:
- `GET /api/agents/settings/first-take-care` (fetch bot config)
- `PUT /api/agents/settings/first-take-care` (save config)

State Changes:
- featureEnabled, systemPrompt, tools, model, temperature, etc. states
- saved boolean (success message)

Edge Cases:
- System admin controls feature enable/disable
- Default tools and configuration
- Temperature/token sliders with validation

---

---

# GLOBAL COMPONENTS

## CommandCenter Modal (Ctrl/Cmd+K)

**User Story #91:**
As an agent,
I want to use the command center to quickly execute actions,
So that I can work faster without navigating menus.

UI Entry Point:
- Global keyboard shortcut: Ctrl+K (Windows/Linux) or Cmd+K (Mac)
- Command center modal appears

Frontend Location:
- `/frontend/src/components/CommandCenter/CommandCenterModal.tsx`
- `/frontend/src/components/CommandCenter/CommandCenterTrigger.tsx`

Frontend Action Flow:
1. User presses Ctrl/Cmd+K
2. CommandCenterModal opens (overlay)
3. Input field focused
4. User types command/prompt
5. While typing, glow state changes (thinking → ready/approval/error)
6. User presses Enter to simulate
7. Backend classifies intent: "chat" or "execution"
8. If "chat": answer shown
9. If "execution": plan shown with steps
10. User can preview with Enter or Escape to close
11. If plan shown and approved: user clicks Execute
12. executePlan API called
13. Plan executed, modal closes

API Call:
- `POST /api/action-planner/simulate` (prompt, context with conversationId or contactId)
- Response: { mode, plan, results, answer, clarification }
- `POST /api/action-planner/execute` (plan, approved: true)

State Changes:
- prompt input
- plan state
- preview array
- chatAnswer string
- loading, executing, error states
- glowState (idle → thinking → ready/approval/error)

Edge Cases:
- Context-aware (conversation ID passed if in chat)
- Escape key closes modal
- Click outside closes modal
- Examples shown if no input
- Error messages displayed

---

## Sidebar Navigation

**User Story #92:**
As a user,
I want to navigate between main sections,
So that I can access different features.

UI Entry Point:
- Left sidebar with navigation links

Frontend Location:
- `/frontend/src/components/Sidebar.tsx`
- `/frontend/src/components/MobileNav.tsx`

Frontend Action Flow:
1. Sidebar displays menu items based on user role
2. Menu items: Dashboard, Conversations, History, Channels, Knowledge, AI Studio, Outbound, Settings, Agents, Departments, System (admin only)
3. Current page highlighted
4. Click menu item to navigate
5. On mobile: burger menu icon opens/closes sidebar
6. Sidebar auto-collapses when panel opens (in conversations)

API Call:
- No API call (navigation only)

State Changes:
- Router navigation
- Sidebar visibility on mobile

Edge Cases:
- Menu items filtered by user role
- Current page indicator
- Mobile responsiveness

---

## Header / Top Bar

**User Story #93:**
As a user,
I want to see my profile and account options,
So that I can manage my account.

UI Entry Point:
- Top-right: User avatar / profile menu

Frontend Location:
- `/frontend/src/components/AppLayout.tsx` (profile menu)

Frontend Action Flow:
1. User clicks avatar
2. Dropdown menu appears with options:
   - Profile / Settings
   - Change Password (if on settings page)
   - Logout
3. User clicks option
4. Navigation or action triggered

API Call:
- Logout: clears auth context, redirects to /login

State Changes:
- Menu visibility
- Auth context cleared on logout
- Router navigation

Edge Cases:
- Avatar shows user initials or image
- Menu positioned based on screen space

---

## Language Switcher

**User Story #94:**
As a user,
I want to switch the UI language,
So that I can use GOTCHA in my preferred language.

UI Entry Point:
- Top-right area (or settings): Language selector (flags or dropdown)

Frontend Location:
- `/frontend/src/components/LanguageSwitcher.tsx`

Frontend Action Flow:
1. User clicks language selector
2. Dropdown shows language options (English, Hebrew, Arabic, etc.)
3. User selects language
4. I18n context updated
5. UI re-renders in new language
6. Language preference saved to localStorage

API Call:
- No API call (client-side I18n)

State Changes:
- I18n context locale updated
- localStorage["language"] updated
- UI text re-rendered

Edge Cases:
- RTL/LTR direction changes for Arabic/Hebrew
- Page reloads if necessary

---

---

# SUMMARY

**Total pages analyzed**: 42+ (including sub-routes and modals)

**Total user stories found**: 94

**Orphan UI Features**: None detected (all components are mounted and used)

**Missing backend wiring indicators**:
1. Analytics page uses DEMO data in many places (indicates incomplete real analytics implementation)
2. Some advanced features like undo/redo in flow builder may be frontend-only

**Most complex UX flows**:
1. **Broadcast Creation Wizard** (4-step process with segmentation, file upload, scheduling) - complex state management and multi-step form validation
2. **AI Agent Configuration** (many form fields, drawer-based tool/knowledge selection, role-based behavior) - deep nesting of configuration options
3. **Knowledge Base Management with Integrations** (OAuth flows for Confluence/Drive, browse modals, sync tracking) - integration complexity
4. **Flow Builder with ReactFlow** (visual node-based editor with canvas manipulation) - most technically sophisticated interaction
5. **CommandCenter Modal** (context-aware action planning and execution with glow state machine) - complex state and real-time feedback

---

This completes the user story extraction from the ChatCenter frontend codebase. All pages, components, modals, and primary user interactions have been documented with detailed information about API calls, state changes, and edge cases.
