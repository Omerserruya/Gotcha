// Home page data lifted verbatim from GOTCHA Website.dc.html (English source; Hebrew via he.js)
window.GOTCHA_HOME = {
  MENUS: {
      product: {
        cols: [
          { t: 'The conversation', d: 'All your communication', icon: 'inbox', bg: '#EDF4E7', ic: '#2E7D5B',
            items: [
              { t: 'Omnichannel', n: '6 channels', icon: 'inbox', page: 'feat-omnichannel' },
              { t: 'Customers', n: 'one record', icon: 'contact', page: 'feat-customers' },
              { t: 'Social engagement', n: 'comments & DMs', icon: 'at-sign', page: 'feat-social' },
              { t: 'Store widget', n: 'sells', icon: 'shopping-cart', page: 'feat-widget' },
              { t: 'WhatsApp broadcast', n: 'campaigns that reply', icon: 'megaphone', page: 'feat-broadcast' }
            ] },
          { t: 'Beside your team', d: 'It does the reading, you decide', icon: 'square-pen', bg: '#EAE4FB', ic: '#4B3E8E',
            items: [
              { t: 'Your new employee', n: 'AI, on the team', icon: 'user-round-check', page: 'feat-employee' },
              { t: 'Copilot', n: 'in every thread', icon: 'square-pen', page: 'feat-copilot' },
              { t: 'Call pilot', n: 'beta', icon: 'phone-call', page: 'feat-callpilot' },
              { t: 'Approvals', n: 'your limits', icon: 'check-check', page: 'feat-approvals' }
            ] },
          { t: 'Teach it, measure it', d: 'Where the answers and the numbers live', icon: 'sliders-horizontal', bg: '#FBEEE8', ic: '#C4552F',
            items: [
              { t: 'Knowledge base', n: 'your sources', icon: 'library', page: 'feat-knowledge' },
              { t: 'AI Studio', n: 'no prompts', icon: 'sliders-horizontal', page: 'feat-studio' },
              { t: 'Analytics', n: 'named causes', icon: 'bar-chart-3', page: 'feat-analytics' }
            ] },
          { t: 'Connect it up', d: 'Where the messages and the data come from', icon: 'plug', bg: '#EDF1F7', ic: '#3E5C99',
            items: [
              { t: 'Channels', n: '8 channels', icon: 'radio', page: 'feat-channels' },
              { t: 'Integrations', n: '40+ systems', icon: 'plug', page: 'feat-integrations' }
            ] }
        ],
        railKicker: 'The product', railTitle: 'Every channel. One inbox.',
        railBody: 'WhatsApp, Instagram, Messenger, email and web chat, threaded by customer, with everything known about her beside the conversation.',
        railLink: 'See the product', railShot: 'assets/shots/inbox.png'
      },
      solutions: {
        cols: [
          { t: 'By business type', d: 'What a normal week looks like for you', icon: 'store', bg: '#FBEEE8', ic: '#C4552F',
            items: [
              { t: 'Ecommerce', n: 'orders & returns', icon: 'shopping-bag', page: 'sol-ecommerce' },
              { t: 'Lead handling', n: 'enquiries & quotes', icon: 'user-plus', page: 'sol-leads' }
            ] },
          { t: 'By industry', d: 'The questions your trade gets asked', icon: 'layout-grid', bg: '#EAE4FB', ic: '#4B3E8E',
            items: [
              { t: 'Cosmetics & skincare', n: 'shade & ingredients', icon: 'sparkles', page: 'sol-cosmetics' },
              { t: 'Fashion & clothing', n: 'size & returns', icon: 'shirt', page: 'sol-fashion' },
              { t: 'Home & furniture', n: 'delivery & assembly', icon: 'sofa', page: 'sol-home' },
              { t: 'Clinics & aesthetics', n: 'bookings & prep', icon: 'stethoscope', page: 'sol-clinics' },
              { t: 'Restaurants & local', n: 'tables & allergens', icon: 'utensils', page: 'sol-food' },
              { t: 'Electronics & gadgets', n: 'specs & warranty', icon: 'cpu', page: 'sol-electronics' },
              { t: 'Jewellery & gifting', n: 'sizing & engraving', icon: 'gem', page: 'sol-jewellery' }
            ] },
          { t: 'By role', d: 'Who this changes the day for', icon: 'briefcase', bg: '#F0EDE7', ic: '#55524C',
            items: [
              { t: 'Running it alone', n: 'owner-operator', icon: 'crown', page: 'sol-owner' },
              { t: 'On the front line', n: 'agents & reception', icon: 'headphones', page: 'sol-agent' }
            ] }
        ],
        railKicker: 'Your AI employees', railTitle: 'Hire one for support, one for sales.',
        railBody: 'Each employee owns its area, works every hour, and does only what you allow: suggest, ask me first, or do it.',
        railLink: 'Meet your new employee', railShot: 'assets/shots/employees.png'
      },
      integrations: {
        cols: [
          { t: 'Commerce', d: 'Orders, refunds, stock, customers', icon: 'shopping-bag', bg: '#EDF4E7', ic: '#2E7D5B',
            items: [{ t: 'Shopify', n: '7 actions', icon: 'shopping-bag' }, { t: 'WooCommerce', n: '6', icon: 'shopping-cart' }, { t: 'Returns platforms', n: '4', icon: 'package' }] },
          { t: 'CRM & business systems', d: 'Reads and writes, both ways', icon: 'database', bg: '#EDF1F7', ic: '#3E5C99',
            items: [{ t: 'Zoho', n: '5', icon: 'database' }, { t: 'Monday', n: '4', icon: 'kanban' }, { t: 'HubSpot', n: '5', icon: 'contact' }, { t: 'ERP', n: 'custom', icon: 'server' }] },
          { t: 'Day to day', d: 'Calendars, files, phone numbers', icon: 'calendar', bg: '#FBEEE8', ic: '#C4552F',
            items: [{ t: 'Google Calendar', n: '3', icon: 'calendar' }, { t: 'Google Drive', n: 'knowledge', icon: 'folder' }, { t: 'Calendly', n: '2', icon: 'calendar-clock' }, { t: 'Anything with an API', n: '', icon: 'plug' }] }
        ],
        railKicker: 'How connecting works', railTitle: 'A system becomes a capability',
        railBody: 'Connect Shopify and GOTCHA can look up orders, check stock and refund. You then decide which of those it may do without asking.',
        railLink: 'Browse all integrations', railShot: 'assets/shots/systems.png'
      },
      company: {
        cols: [
          { t: 'Who we are', d: 'The company behind the product', icon: 'building-2', bg: '#EFEAE1', ic: '#7A6A4F',
            items: [
              { t: 'About us', n: 'our story', icon: 'building-2', page: 'co-about' },
              { t: 'Careers', n: 'not hiring, still reading', icon: 'briefcase', page: 'co-careers' }
            ] },
          { t: 'What we write', d: 'What we learn from real inboxes', icon: 'newspaper', bg: '#EAE4FB', ic: '#4B3E8E',
            items: [
              { t: 'Blog', n: 'journal', icon: 'newspaper', page: 'co-blog' },
              { t: 'Help center', n: 'guides & setup', icon: 'book-open', page: 'co-help' }
            ] },
          { t: 'Trust and talking', d: 'How we hold your data, and how to reach us', icon: 'shield-check', bg: '#EDF4E7', ic: '#2E7D5B',
            items: [
              { t: 'Security', n: 'how we hold your data', icon: 'shield-check', page: 'co-security' },
              { t: "Let's Chat!", n: 'talk to a person', icon: 'message-circle', page: 'co-chat' }
            ] }
        ],
        railKicker: 'From the journal', railTitle: 'The shift nobody works',
        railBody: 'Your customers write in the evening, on the sofa, with the phone in one hand. That is exactly when nobody is reading.',
        railLink: 'Read the journal', railShot: 'assets/shots/inbox.png'
      },
      resources: {
        cols: [
          { t: 'Learn', d: 'Get going, and get better at it', icon: 'book-open', bg: '#FBEEE8', ic: '#C4552F',
            items: [{ t: 'Help center', n: '', icon: 'book-open' }, { t: 'Getting started guide', n: '', icon: 'flag' }, { t: 'Playbooks by industry', n: '', icon: 'map' }, { t: 'Blog', n: '', icon: 'newspaper' }] },
          { t: 'Trust', d: 'What we do with your customers\' data', icon: 'shield-check', bg: '#EDF4E7', ic: '#2E7D5B',
            items: [{ t: 'Security', n: '', icon: 'shield-check', page: 'co-security' }, { t: 'Encryption and access', n: '', icon: 'lock' }, { t: 'Privacy and GDPR', n: '', icon: 'file-text' }, { t: 'What the AI never trains on', n: '', icon: 'brain' }] },
          { t: 'Talk to us', d: 'A person, not a form', icon: 'message-circle', bg: '#EDF1F7', ic: '#3E5C99',
            items: [{ t: "Let's Chat!", n: '', icon: 'message-circle', page: 'co-chat' }, { t: 'Help center', n: '', icon: 'book-open', page: 'co-help' }, { t: 'About us', n: '', icon: 'building-2', page: 'co-about' }, { t: 'Careers', n: '', icon: 'briefcase', page: 'co-careers' }] }
        ],
        railKicker: 'From the journal', railTitle: 'Answering is easy. Acting is the job.',
        railBody: 'Writing the reply is the last ten percent. The work is finding the order, reading the policy and carrying it out.',
        railLink: 'Read the journal', railShot: 'assets/shots/approvals.png'
      }
    },
  TRACE: [
      ['Reading what she asked', 'shipping · frustrated'],
      ['Recognising her', 'Dana Cohen · 6 orders'],
      ['Finding the order', '#1842'],
      ['Checking the carrier', 'stuck since Tuesday'],
      ['Reading your refund policy', 'eligible'],
      ['Checking what it may do', 'under ₪200 · allowed'],
      ['Refunding ₪179', 'done'],
      ['Checking stock for a replacement', '11 left'],
      ['Writing to her', 'in her language']
    ],
  BIZ: {
          retail: {
            accent: '#A8C57A', kicker: 'Retail and ecommerce',
            h: 'Your store already knows the answer. GOTCHA just gets there first.',
            sub: 'Connect Shopify or WooCommerce and it reads your products, your orders, your shipping and returns policy, then answers from them rather than guessing.',
            steps: [
              { n: '01', t: 'It finds the order before it answers', d: 'Name, phone or order number, on any channel. The tracking, the carrier and the real delay, not a template apology.' },
              { n: '02', t: 'Returns and refunds actually happen', d: 'Inside the limit you set it refunds, replaces or opens a return itself. Above it, the decision waits in your approvals with the cost of waiting stated.' },
              { n: '03', t: 'It sells while it answers', d: 'Size and shade questions answered from your own charts, stock checked live, the nearest alternative offered when something is out.' },
              { n: '04', t: 'You see the cause, not the volume', d: 'Two hundred conversations traced to one bad size chart is a thing you fix this afternoon.' }
            ],
            stats: [
              { v: '72%', l: 'of shop questions are order status' },
              { v: '19s', l: 'average first reply, day or night' },
              { v: '₪200', l: 'the refund limit most shops start with' }
            ],
            demoTitle: 'WhatsApp · 02:14', demoMeta: 'nobody awake',
            demo: [
              { t: 'My package still has not arrived and it was a gift.', side: 'in' },
              { t: 'Checked the order, the carrier and your delay policy.', side: 'trace' },
              { t: 'Order #1842 has been stuck since Tuesday, which is not good enough. I have refunded the full ₪179 and can hold one from tomorrow\'s batch.', side: 'out' }
            ],
            demoFoot: 'Refunds under your limit are hers to make. Above it, nobody gets woken up, it waits until morning.',
            cta: 'See the ecommerce playbook', ctaNote: 'orders, returns, sizing, stock',
            railLabel: 'One night in your shop, screen by screen',
            moments: [
              { label: 'A customer writes', screen: 'WhatsApp · 22:41', icon: 'message-circle', time: 'nobody awake',
                t: 'She writes at 22:41. It answers in nineteen seconds.',
                note: 'Order found, carrier checked, refund policy read, six previous orders remembered. Then a reply that sounds like you on a good day.',
                msgs: [
                  { side: 'in', t: 'My package still has not arrived and I have been waiting two weeks. This was a gift.' },
                  { side: 'trace', t: 'found order #1842 · carrier stalled since Tue · limit ₪200 · 6 previous orders' },
                  { side: 'out', t: 'I am sorry, order #1842 has been stuck with the carrier since Tuesday, which is not good enough. I have refunded the full ₪179 and can hold one from tomorrow\'s batch.', meta: 'sent 22:41 · refund already processed' }
                ] },
              { label: 'The inbox', screen: 'Inbox · beside the conversation', icon: 'inbox', panel: 'light', time: 'one view, no second window',
                t: 'Six channels. One inbox. Everything about her beside the conversation.',
                note: 'WhatsApp, Instagram, email, web chat and the phone land in the same place, with the order, the customer and what Copilot did next to the message.',
                title: 'Dana Cohen · order #1842',
                prows: [ { k: 'Order #1842 · linen set, sand, king', v: '₪179', pill: 'Stalled' }, { k: 'Carrier', v: 'no movement since Tuesday' }, { k: 'Copilot', v: 'refunded, reply sent', pill: 'Done' }, { k: 'Also open', v: 'WhatsApp · Instagram · email', pill: 'Synced' } ] },
              { label: 'Your store, connected', screen: 'What Shopify lets GOTCHA do', icon: 'plug', panel: 'light', time: 'you set this once',
                t: 'It reads Shopify. You decide what it may touch.',
                note: 'Looking things up is allowed. Money asks you first. Customer details, never. The same rules apply to every AI employee unless you narrow them.',
                prows: [ { k: 'Find a product', pill: 'Allowed' }, { k: 'Look up an order', pill: 'Allowed' }, { k: 'Check stock', v: '11 sand king left', pill: 'Allowed' }, { k: 'Refund', v: 'up to ₪200 on its own', pill: 'Ask first' }, { k: 'Cancel an order', pill: 'Ask first' }, { k: 'Change customer details', pill: 'Never' } ] },
              { label: 'Above your limit', screen: 'Approvals', icon: 'check-check', panel: 'dark', time: 'requested 01:20 · reversible within 24h',
                t: 'A ₪480 refund waits for you. Nobody gets woken up.',
                note: 'Each decision arrives with why it is recommended, what happens if you approve and what it costs to wait. One key, and Dana is told on WhatsApp.',
                title: 'Refund ₪480 to Dana Cohen',
                prows: [ { k: 'Delivered 4 days ago, marked damaged on arrival', v: 'photo attached' }, { k: 'Inside the 14-day damage window', v: 'policy' }, { k: 'Third contact about this order', v: 'frustrated' } ],
                keys: [ { key: 'A', t: 'Approve' }, { key: 'E', t: 'Edit amount' }, { key: 'R', t: 'Reject' } ], keysNote: 'two more after this' },
              { label: 'One person, every channel', screen: 'Customers · Dana Cohen', icon: 'contact', panel: 'light', time: 'with you since March 2024',
                t: 'It remembers her the way a good shop assistant would.',
                note: 'Sand over grey, ships to a work address, replies fastest in the evening. Six orders, ₪2,140 lifetime, zero refunds, and the promise a colleague made her last week.',
                quote: 'Buys linen twice a year, always in sand. Patient until a delivery slips, then she writes three times in a day.',
                prows: [ { k: 'Lifetime', v: '₪2,140 · 6 orders · 0 refunds' }, { k: 'GOTCHA remembers', v: 'sand over grey · ships to work' }, { k: 'Note · Maya, 25 Aug', v: 'promised a replacement by Thursday' } ] },
              { label: 'Say what you want done', screen: '⌘K · works from every screen', icon: 'terminal', panel: 'dark', time: 'ESC to close',
                t: 'Type "refund dana". It does it.',
                note: 'The same line answers questions and takes actions, from any screen. How many refunds did we give this month, and why? Ask it.',
                title: 'refund dana|',
                prows: [ { k: 'Refund Dana Cohen · order #1842', v: '↵', pill: 'Ask first' }, { k: 'Go to Dana Cohen', v: 'customer · 6 orders · frustrated today' }, { k: 'Go to order #1842', v: '₪179 · in transit · stalled' }, { k: 'Ask: how many refunds did we give this month, and why?', v: '' } ] },
              { label: 'Where the money is', screen: 'Analytics · What conversations are worth', icon: 'trending-up', panel: 'light', time: 'last 7 days',
                t: 'Two hundred conversations traced to one bad size chart.',
                note: 'It groups what people ask about and what those conversations were worth. The thing you fix this afternoon is on this screen, not buried in a transcript.',
                quote: 'Conversations turned into ₪96,600 this week. Two thirds of it came from answering a product question within a minute.',
                prows: [ { k: 'Where is my order', v: '312 conversations', pill: 'Done' }, { k: 'Does this run small', v: '204 · one size chart', pill: 'Open' }, { k: 'Back in stock', v: '141 · ₪18,400 sold' } ] },
              { label: 'Your morning', screen: 'Home · Tuesday, 28 August', icon: 'sunrise', panel: 'light', time: '08:30',
                t: 'Fourteen closed overnight. One decision waiting.',
                note: 'You read the decision, press A, and the day starts. Nothing is sitting unanswered from last night.',
                title: 'Good morning, Maya',
                prows: [ { k: 'Closed overnight by GOTCHA', v: '14', pill: 'Done' }, { k: 'Waiting on you', v: 'refund ₪480 · Dana Cohen', pill: 'Open' }, { k: 'Unanswered from last night', v: '0' } ] },
              { label: 'Where it lands', big: '88%', bigNote: 'of shop conversations answered and closed without a person touching them.',
                t: 'The routine leaves. The judgment stays with you.',
                note: 'Order status, tracking, address changes and returns inside your limits. Everything else, and anything unusual, still comes to a person, with the answer already drafted.' }
            ],
            askTitle: 'The questions it answers without you.',
            askNote: 'Taken from real shop inboxes. Every one of them has an answer somewhere in your store already.',
            asks: ['Where is my order?', 'Can I change the delivery address?', 'Does this run small?', 'Is the black back in stock?', 'I want to exchange for a size up', 'Will it arrive before Friday?', 'What is your return window?', 'Which shade for olive skin?', 'Can I add to my order?'],
            weekTitle: 'Watching on Monday. Answering by Thursday.',
            week: [
              { d: 'Day 1', t: 'It reads your store', b: 'Products, orders, shipping and returns policy, and the last few months of your own replies. Nothing to write, nothing to train.' },
              { d: 'Day 2 to 3', t: 'Watch-only mode', b: 'It drafts what it would have sent on real conversations and you correct it. Your team keeps answering, nothing goes out unseen.' },
              { d: 'Day 4 onwards', t: 'It takes the routine', b: 'Order status, tracking, address changes and returns inside your limits. Everything else still comes to a person.' }
            ],
            before: ['The 22:40 "where is my order" sits until morning, and she has already left a review.', 'Your team retypes the same tracking answer forty times a day.', 'A return request goes quiet for two days and turns into a chargeback.'],
            after: ['She has the tracking, the real delay and a refund within nineteen seconds.', 'Your team sees only the conversations that actually need judgment.', 'Returns open themselves inside your rules, and you see them in the morning.'],
            closer: 'Live in an afternoon, no card to start.',
            page: 'sol-ecommerce'
          },
          leads: {
            accent: '#C9BCF7', kicker: 'Leads and enquiries',
            h: 'The lead that gets an answer in five minutes is the lead you keep.',
            sub: 'It answers the enquiry, asks the two or three things you actually need, books the call in your calendar and hands you a brief instead of a transcript.',
            steps: [
              { n: '01', t: 'It answers while they are still interested', d: 'Instagram, WhatsApp, the form on your site. Same minute, in their language, with the price range you allow it to quote.' },
              { n: '02', t: 'It qualifies with your questions', d: 'Budget, timing, location, scope. Whatever you ask on the phone, asked politely and in order, without interrogating anyone.' },
              { n: '03', t: 'It books, then reminds', d: 'Real availability from your calendar, the slot confirmed, the reminder sent, the no-show rebooked.' },
              { n: '04', t: 'It follows up twice, then stops', d: 'Two nudges, spaced the way a person would, and it tells you which leads went quiet rather than quietly dropping them.' }
            ],
            stats: [
              { v: '5 min', l: 'the window where a lead still replies' },
              { v: '3', l: 'questions to qualify, then a booking' },
              { v: '0', l: 'enquiries left sitting overnight' }
            ],
            demoTitle: 'Instagram DM · 21:40', demoMeta: 'after hours',
            demo: [
              { t: 'How much for a kitchen, roughly? We are in Haifa.', side: 'in' },
              { t: 'Checked your price ranges, your service area and Thursday\'s diary.', side: 'trace' },
              { t: 'For a kitchen your size it is usually ₪28k to ₪40k depending on the doors. We do work in Haifa. Thursday 10:00 or 16:00 for a measure and a real number?', side: 'out' }
            ],
            demoFoot: 'It quotes only inside the ranges you set. Anything unusual comes to you with the answer already drafted.',
            cta: 'See the lead handling playbook', ctaNote: 'qualifying, booking, follow-up',
            railLabel: 'One lead, from the first message to a booked meeting',
            moments: [
              { label: 'A lead comes in', screen: 'Instagram DM · 21:40', icon: 'instagram', time: 'after hours',
                t: 'She asks at 21:40. Your AI employee answers in fourteen seconds.',
                note: 'It quotes only inside the range you set, confirms the service area and offers two real slots from your calendar. Nobody on your team is awake.',
                msgs: [
                  { side: 'in', t: 'How much for a kitchen, roughly? We are in Haifa.' },
                  { side: 'trace', t: 'price range: kitchens ₪28k to ₪40k · Haifa inside zone · Thu 10:00 / 16:00 open' },
                  { side: 'out', t: 'For a kitchen your size it is usually ₪28k to ₪40k depending on the doors, and yes, we work in Haifa. Thursday 10:00 or 16:00 for a measure and a real number?', meta: 'sent 21:40 · 14 seconds after she wrote' }
                ] },
              { label: 'They get talking', screen: 'Instagram DM · 21:46', icon: 'instagram', time: 'qualifying',
                t: 'It asks your three questions, politely, in order.',
                note: 'Budget, timing, scope. Whatever you ask on the phone, asked the way a person would, and the meeting booked while she is still interested.',
                msgs: [
                  { side: 'in', t: 'Closer to 40 then. Do you handle the permits, and could we do 16:00?' },
                  { side: 'out', t: 'We handle the permits. Thursday 16:00 is yours, and I have sent you the two measurements to have ready so the visit takes twenty minutes.', meta: 'booked · reminder set for Wednesday night' }
                ] },
              { label: 'Everything lands in your CRM', screen: 'Your CRM · deal updated', icon: 'database', panel: 'light', time: 'written 21:47 · nobody typed it',
                t: 'The contact, the deal, the notes, the meeting. All of it in your CRM, as it happens.',
                note: 'HubSpot, Zoho, monday.com, Salesforce or your own system. Every message, every answer she gave and every promise made is written to her record the moment it happens, so your team opens the CRM and finds the whole story there.',
                title: 'Kitchen, Haifa · ₪34,000',
                prows: [ { k: 'Contact created', v: 'Instagram DM · after hours', pill: 'Synced' }, { k: 'Stage', v: 'Meeting booked · Thu 16:00', pill: 'Booked' }, { k: 'Notes', v: 'budget ~₪40k · permits · 6 to 8 doors', pill: 'Synced' }, { k: 'Conversation', v: 'full transcript attached', pill: 'Synced' }, { k: 'Owner', v: 'Matan · notified on WhatsApp' } ],
                keys: [ { key: 'H', t: 'HubSpot' }, { key: 'Z', t: 'Zoho' }, { key: 'M', t: 'monday' } ], keysNote: 'or the system you already use' },
              { label: 'What it already knew', screen: 'Customers · her record', icon: 'contact', panel: 'light', time: 'before replying',
                t: 'Everything it used to answer her, in one record you can open.',
                note: 'First wrote on 2 August about worktops. Haifa, inside your zone. Asked for a range, not a discount. Replies in the evening within minutes.',
                quote: 'Asked for a range, not a discount. Replies fastest in the evening, usually within minutes.',
                prows: [ { k: 'First wrote', v: '2 Aug · worktops' }, { k: 'Location', v: 'Haifa · inside your zone' }, { k: 'Interest', v: 'kitchen · 6 to 8 doors' }, { k: 'Also reaches you on', v: 'WhatsApp · Instagram' } ] },
              { label: 'Call pilot', screen: 'On the call · Copilot is listening', icon: 'phone-call', panel: 'dark', time: '1:24', wave: true, waveLabel: 'Hebrew · translating as she speaks',
                t: 'On the call, it tells you what to say. And when to ask for the meeting.',
                note: 'It listens, finds what she was promised, checks the diary while she talks, and puts the next line in front of you. Book the meeting now.',
                quote: 'Book the meeting now and I will hold Sunday 11:00 while we talk. Shall I put you in?',
                prows: [ { k: 'Found the promise from 25 Aug', v: 'Tomer, replacement' }, { k: 'Checked Sunday\'s diary', v: '11:00 open' } ],
                keys: [ { key: '↵', t: 'Read it out' }, { key: 'S', t: 'Softer' } ], keysNote: 'attached to her record when the call ends' },
              { label: 'Hire it for enquiries', screen: 'Studio · your AI employee', icon: 'user-plus', panel: 'light', time: 'hired by you, 09:41',
                t: 'Watch-only for a week. Then it answers on its own.',
                note: 'This week it drafts and tells you. From next week it answers, inside the ranges and hours you set. About two things a day will still reach you.',
                title: 'Enquiries is working',
                prows: [ { k: 'This week it drafts, and tells you', v: 'nothing reaches a customer without you', pill: 'Ask first' }, { k: 'From 11 September it answers on its own', v: 'Instagram, WhatsApp, web form · any hour', pill: 'Open' }, { k: 'About two things a day will reach you', v: 'discounts · jobs outside your zone' } ] },
              { label: 'It follows up, then stops', screen: 'Outreach · in flight', icon: 'send', panel: 'light', time: 'this week',
                t: 'Two nudges, spaced like a person would. Then it tells you who went quiet.',
                note: 'A day of silence gets a message, another gets a call, and the ones who chose not to answer are named rather than quietly dropped.',
                prows: [ { k: 'Quiet since Thursday · 14 leads', v: 'WhatsApp nudge · day 1', pill: 'Done' }, { k: 'Still quiet · 6 leads', v: 'GOTCHA called · day 3 · 4 answered', pill: 'Done' }, { k: 'Chose not to answer · 2 leads', v: 'named in your CRM, not dropped', pill: 'Synced' } ] },
              { label: 'Your morning', screen: 'Home · Thursday, 30 August', icon: 'sunrise', panel: 'light', time: '08:30',
                t: 'Three qualified leads. Two meetings booked. One decision for you.',
                note: 'Each one with a brief, not a transcript. The discount somebody asked for is waiting with the reply already drafted.',
                title: 'Good morning, Matan',
                prows: [ { k: 'Qualified overnight', v: '3 leads · briefs ready', pill: 'Done' }, { k: 'Meetings booked', v: 'Thu 16:00 · Sun 11:00', pill: 'Booked' }, { k: 'Waiting on you', v: 'a discount request · reply drafted', pill: 'Open' } ] },
              { label: 'Where it lands', big: '5 min', bigNote: 'the window where a lead still replies, and the reason it answers first, every time.',
                t: 'Zero enquiries left sitting overnight.',
                note: 'The lead that gets an answer in five minutes is the lead you keep. Everything unusual, a discount, a special job, still comes to you, drafted.' }
            ],
            askTitle: 'The questions it answers before you wake up.',
            askNote: 'Taken from real enquiry inboxes. Answering these fast is most of what wins the job.',
            asks: ['How much does it cost?', 'Do you work in my area?', 'When could you start?', 'Can I see examples?', 'Is a consultation free?', 'Can we do Thursday instead?', 'How long does it take?', 'Do you handle the permits?', 'Are you available next month?'],
            weekTitle: 'Every enquiry answered in the same minute.',
            week: [
              { d: 'Day 1', t: 'It learns what you sell', b: 'Your services, your price ranges, your service area and the questions you always ask before quoting.' },
              { d: 'Day 2 to 3', t: 'Watch-only mode', b: 'It drafts the reply and the qualifying questions on real enquiries. You approve, correct, and it learns your line.' },
              { d: 'Day 4 onwards', t: 'It answers and books', b: 'Ranges quoted inside your limits, calls booked in your calendar, follow-ups sent twice and then stopped.' }
            ],
            before: ['The 21:40 DM gets an answer at 09:15, by which time she has three other quotes.', 'You qualify the same three things on every call, and half of them were never a fit.', 'Two leads a week go quiet because nobody remembered to follow up.'],
            after: ['She has a range, your service area confirmed and a slot held, in the same minute.', 'You walk into calls with the brief already written and the questions answered.', 'Nothing goes quiet, and you see exactly which leads chose not to answer.'],
            closer: 'Live in an afternoon, no card to start.',
            page: 'sol-leads'
          }
        }
};

window.GOTCHA_HOME.UC = [
      { t: 'Online store', edge: '#C4552F', line: 'Half your day is "where is my order" and the other half is a size question.',
        body: 'GOTCHA opens the order in your store, reads the tracking, and answers with the truth. When someone wants to cancel, it checks whether it has been packed before promising anything.',
        does: [{ t: 'Order status', d: 'Real tracking, not "let me check"' }, { t: 'Cancel or return', d: 'Checks fulfilment first, then acts' }, { t: 'Refunds', d: 'Up to the limit you set' }, { t: 'Size & fit', d: 'From your own product copy' }],
        stats: [{ v: '88%', l: 'answered alone' }, { v: '19s', l: 'first reply' }, { v: '₪12,400', l: 'carts recovered monthly' }],
        msg: 'Hey, can I swap the sand set for the navy? Ordered Tuesday.', tag: 'Exchange · order found automatically',
        answer: "Yes, it hasn't left us yet, so I've swapped it to navy in the same size. No charge, and it ships tomorrow.",
        foot: 'Exchange opened in your returns platform. Stock adjusted. Nobody on your team touched it.' },
      { t: 'Wholesale & trade', edge: '#8A6A16', line: 'Every trade enquiry is the same six questions, and each one waits a day for an answer.',
        body: 'It quotes your trade prices, states lead times per product, and opens a trade account when someone qualifies. When two of your own documents disagree about the minimum order, it says it will check rather than guessing.',
        does: [{ t: 'Trade pricing', d: 'Your real price list, per tier' }, { t: 'Lead times', d: 'Per product, kept current' }, { t: 'Open an account', d: 'Collects what you need, once' }, { t: 'Reorders', d: 'Reads their usual order back' }],
        stats: [{ v: '22%', l: 'more trade enquiries closed' }, { v: '4h', l: 'was: two days' }, { v: '12', l: 'reorders it chased' }],
        msg: 'What is the minimum for a first wholesale order, and do you do 30 days?', tag: 'Wholesale · high value',
        answer: 'Minimum first order is ₪550, and yes, 30 day terms once the trade account is open. I can start that now if you send your business number.',
        foot: 'Trade account drafted. Eitan sees it in the morning with everything already filled in.' },
      { t: 'Services & bookings', edge: '#4F7A2E', line: 'People ask for a slot at eleven at night and book with someone else by morning.',
        body: 'It offers real slots from your calendar, books them, reschedules, and reminds people the day before. Cancellations free the slot and offer it to whoever asked next.',
        does: [{ t: 'Real availability', d: 'Straight from your calendar' }, { t: 'Book & reschedule', d: 'Without a form' }, { t: 'Reminders', d: 'Day before, on WhatsApp' }, { t: 'No-show follow-up', d: 'Asks once, politely' }],
        stats: [{ v: '31%', l: 'fewer empty slots' }, { v: '0', l: 'double bookings' }, { v: '2m', l: 'to book, average' }],
        msg: 'Do you have anything Thursday afternoon? Preferably late.', tag: 'Booking · intent to buy',
        answer: 'Thursday at 16:30 or 17:45 are both free. Shall I hold 17:45 for you?',
        foot: 'Booked, added to the calendar, reminder scheduled. It also noted she prefers late slots.' },
      { t: 'Clinics', edge: '#E0B341', line: 'Reception cannot answer the phone and the WhatsApp at the same time.',
        body: 'It answers both, handles the routine, hours, prices, what to bring, rescheduling, and passes anything clinical straight to a person, immediately and without pretending otherwise.',
        does: [{ t: 'Reschedule', d: 'The single biggest volume' }, { t: 'Prices & cover', d: 'From your own list' }, { t: 'Preparation', d: 'What to bring, fasting, forms' }, { t: 'Hands over fast', d: 'Anything clinical goes to staff' }],
        stats: [{ v: '74%', l: 'handled without reception' }, { v: '100%', l: 'clinical questions escalated' }, { v: '0', l: 'medical advice given' }],
        msg: "I need to move my Sunday appointment, and does it need to be on an empty stomach?", tag: 'Reschedule + preparation',
        answer: 'Moved to Tuesday 09:00. And yes, nothing to eat or drink for eight hours beforehand, water is fine.',
        foot: 'Calendar updated. The preparation answer came from your own instructions, nothing invented.' },
      { t: 'Restaurants & local', edge: '#4F7A2E', line: 'The busiest hour is exactly when nobody can look at the phone.',
        body: 'It takes reservations, answers about parking, allergens and the menu, and tells people the truth about the wait. When something is off tonight, it knows.',
        does: [{ t: 'Reservations', d: 'Real tables, real times' }, { t: 'Menu & allergens', d: "From tonight's menu" }, { t: 'Waiting time', d: 'Honest, not optimistic' }, { t: 'Large groups', d: 'Passes to a person' }],
        stats: [{ v: '96%', l: 'answered during service' }, { v: '18s', l: 'during the rush' }, { v: '41', l: 'covers saved weekly' }],
        msg: 'Table for 2 tonight around 8? Also is the mushroom dish vegan?', tag: 'Reservation · dietary',
        answer: '20:15 is free. Shall I book it? The mushroom dish has butter in it, but the chef does it with oil on request.',
        foot: 'Booked. Note attached to the table, and the kitchen sees the request when you open service.' }
    ];
window.GOTCHA_HOME.FAQ = [
      ['What is GOTCHA, exactly?', 'One AI platform for everything customers send you. It merges every channel into a single inbox and adds an AI employee and a copilot that do not just talk: they carry out real actions and turn every conversation into customer intelligence inside your CRM.'],
      ['Does the AI really take action, or is it just a chatbot?', 'It takes real action. The AI employee understands the request and handles it end to end: it finds the order, opens the exchange, sends the tracking, updates the CRM. Not a set of canned replies.'],
      ['Will it replace my human agents?', 'No. It handles the routine and hands over to a person the moment it should, with the whole customer picture on one screen. From there Copilot makes your agents faster, and Call Pilot guides them live during phone calls.'],
      ['Which channels do you work with?', 'WhatsApp, Instagram, Messenger, email, web chat and Slack, plus phone calls, where Call Pilot guides your agents in real time. Every channel in one merged inbox, with the full cross-channel history for each customer.'],
      ['How much control do I have over what the AI does?', 'Full control. You set the autonomy level for each action: suggest only, ask me first with a human in the loop, or fully autonomous. Sensitive actions such as refunds or discounts can always require approval.'],
      ['Does it connect to my CRM and my tools?', 'Yes. Conversations are summarised and synced to your CRM or ERP, the customer profile is enriched automatically, and tasks and follow-ups are created for you. No copy and paste.'],
      ['How long does it take to get started?', 'Fast. You connect your channels, add your knowledge base and invite your team. Most teams are live the same day.'],
      ['What about data security?', 'Everything is encrypted, in transit and at rest, with role-based permissions and full separation between organisations. We never sell or expose your data.']
    ];
window.GOTCHA_HOME.PERMS = [
        { t: 'Look up an order', n: 'used 904 times this week', b0: '#F7F5F1', c0: '#121212', b1: 'transparent', c1: '#7A766F', b2: 'transparent', c2: '#7A766F' },
        { t: 'Check stock', n: 'used 288 times', b0: '#F7F5F1', c0: '#121212', b1: 'transparent', c1: '#7A766F', b2: 'transparent', c2: '#7A766F' },
        { t: 'Refund up to ₪200', n: '41 this month · none disputed', b0: '#F7F5F1', c0: '#121212', b1: 'transparent', c1: '#7A766F', b2: 'transparent', c2: '#7A766F' },
        { t: 'Refund more than ₪200', n: 'comes to you', b0: 'transparent', c0: '#7A766F', b1: '#E8D9A8', c1: '#2A2412', b2: 'transparent', c2: '#7A766F' },
        { t: 'Cancel an order', n: 'comes to you', b0: 'transparent', c0: '#7A766F', b1: '#E8D9A8', c1: '#2A2412', b2: 'transparent', c2: '#7A766F' },
        { t: "Change a customer's details", n: 'your team only', b0: 'transparent', c0: '#7A766F', b1: 'transparent', c1: '#7A766F', b2: '#E4A88F', c2: '#2A1712' }
      ];
window.GOTCHA_HOME.BADGES = [
        { t: 'GDPR aligned', icon: 'file-check', ic: '#3E5C99' },
        { t: 'Meta Business Partner', icon: 'badge-check', ic: '#3E5C99' },
        { t: 'Encrypted in transit and at rest', icon: 'lock', ic: '#7A6A4F' },
        { t: 'Role-based access', icon: 'shield-check', ic: '#2E7D5B' }
      ];
window.GOTCHA_HOME.FOOT = [
          { t: 'Product', items: ['Omnichannel', 'Social engagement', 'WhatsApp broadcast', 'Your new employee', 'Copilot', 'Call pilot (beta)', 'Knowledge base', 'Approvals', 'Customers', 'AI Studio', 'Analytics', 'Store widget', 'Channels'] },
          { t: 'Solutions', items: ['Cosmetics & skincare', 'Fashion & clothing', 'Home & furniture', 'Clinics & aesthetics', 'Restaurants & local', 'Electronics', 'Jewellery & gifting', 'Ecommerce', 'Lead handling', 'Running it alone', 'On the front line'] },
          { t: 'Integrations', items: ['Shopify', 'WooCommerce', 'Zoho', 'Monday', 'Browse all'] },
          { t: 'Why us', items: ['Why GOTCHA', 'It acts, not just answers', 'Your limits, per action', 'Priced per conversation', 'Security'] },
          { t: 'Our Company', items: ['About us', 'Blog', 'Help center', 'Careers', 'Security'] }
        ];
window.GOTCHA_HOME.SOCIAL = [
        { t: 'Instagram', icon: 'instagram', href: 'https://www.instagram.com/gotcha.co.il/' },
        { t: 'Facebook', icon: 'facebook', href: 'https://www.facebook.com/gotchainbox' },
        { t: 'YouTube', icon: 'youtube', href: 'https://www.youtube.com/channel/UCBaxp7m0y5tIjdwkNezrdgA' }
      ];

// leads: fitness coaching overlay
(function () {
  var L = window.GOTCHA_HOME.BIZ.leads, M = L.moments;
  var REPLY = 'התוכנית של 3 חודשים עולה ₪1,890, ואפשר לשלם בשלושה תשלומים. היא בנויה בדיוק למי שמתחילה מאפס: אימונים מהבית, תפריט שמותאם לך וליווי בוואטסאפ כל יום. רוצה שיחת היכרות קצרה מחר ב-10:00 או ב-18:00?';
  L.demo = [{ side: 'in', t: 'היי, כמה עולה תוכנית הליווי של 3 חודשים? אני מתחילה מאפס, זה מתאים לי?' }, { side: 'trace', t: 'בדק את מחירון התוכניות, אפשרויות התשלום והיומן של מחר.' }, { side: 'out', t: REPLY }];
  M[0].t = 'היא שואלת ב-21:40. עובד ה-AI שלכם עונה תוך ארבע עשרה שניות.';
  M[0].note = 'הוא נותן מחיר רק מתוך המחירון שקבעתם, מסביר למי התוכנית מתאימה ומציע שני מועדים אמיתיים מהיומן. אף אחד בצוות לא ער.';
  M[0].msgs = [{ side: 'in', t: 'היי, כמה עולה תוכנית הליווי של 3 חודשים? אני מתחילה מאפס, זה מתאים לי?' }, { side: 'trace', t: 'תוכנית 3 חודשים ₪1,890 · מתאים למתחילות · מחר 10:00 / 18:00 פנוי' }, { side: 'out', t: REPLY, meta: 'נשלח 21:40 · 14 שניות אחרי שכתבה' }];
  M[1].note = 'מטרה, ניסיון קודם, הגבלות בתזונה. מה שהייתם שואלים בטלפון, נשאל כמו שאדם היה שואל, ושיחת ההיכרות נקבעת כשהיא עוד בעניין.';
  M[1].msgs = [{ side: 'in', t: 'המטרה שלי לרדת 8 קילו לפני החתונה של אחותי. אני צמחונית, זה בעייתי? ואפשר ב-18:00?' }, { side: 'out', t: 'צמחונות זו בכלל לא בעיה, התפריט נבנה סביב מה שאת אוכלת. מחר 18:00 שמור לך, ושלחתי לך שאלון קצר כדי ששיחת ההיכרות תיקח עשרים דקות.', meta: 'נקבע · תזכורת נשלחה לערב שלפני' }];
  M[2].title = 'תוכנית ליווי 3 חודשים · ₪1,890';
  M[2].prows[0].v = 'אינסטגרם · אחרי שעות העבודה';
  M[2].prows[1].v = 'שיחת היכרות נקבעה · מחר 18:00';
  M[2].prows[2].v = 'מטרה: מינוס 8 ק״ג · צמחונית · חתונה בעוד 4 חודשים';
  M[2].prows[4].v = 'עומר · עודכן בוואטסאפ';
  M[3].note = 'כתבה לראשונה ב-2 באוגוסט על אימונים מהבית. מתחילה, בלי ניסיון קודם. שאלה על מחיר, לא על הנחה. עונה בערב תוך דקות.';
  M[3].quote = 'שאלה על מחיר, לא על הנחה. עונה הכי מהר בערב, בדרך כלל תוך דקות.';
  M[3].prows = [{ k: 'First wrote', v: '2 באוג׳ · אימונים מהבית' }, { k: 'רמה', v: 'מתחילה · בלי ניסיון קודם' }, { k: 'Interest', v: 'תוכנית ליווי · 3 חודשים' }, { k: 'Also reaches you on', v: 'WhatsApp · Instagram' }];
  M[4].quote = 'בואי נקבע עכשיו שיחה עם המאמנת, אני שומר לך את יום ראשון 11:00 בזמן שאנחנו מדברות. להכניס אותך?';
  M[4].prows = [{ k: 'מצא את מה שהובטח ב-25 באוג׳', v: 'תפריט ניסיון לשבוע' }, { k: "Checked Sunday's diary", v: '11:00 open' }];
  M[5].prows[2].v = 'הנחות · שאלות רפואיות';
  M[7].prows[1].v = 'מחר 18:00 · ראשון 11:00';
})();

// retail: story rebuild
(function () {
  var B = window.GOTCHA_HOME.BIZ.retail, R = B.moments;
  B.h = 'אתם כבר יודעים את התשובה, GOTCHA עושה את זה מהר יותר';
  R[0].t = 'היא כותבת ב-22:41, ועובד ה-AI שלנו מטפל בזה מיד';
  R[0].note = 'ההזמנה נמצאה, חברת המשלוחים נבדקה, המלאי נבדק. במקום לזכות אוטומטית, הוא נותן לה לבחור: זיכוי לכרטיס, קרדיט לחנות או משלוח חדש.';
  R[0].msgs = [
    { side: 'in', t: 'החבילה שלי עדיין לא הגיעה ואני מחכה שבועיים. זו הייתה מתנה.' },
    { side: 'out', t: 'מצטער, הזמנה #1842 תקועה אצל חברת המשלוחים מיום שלישי. מה תעדיפי: זיכוי לכרטיס, קרדיט לחנות, או שנשלח לך אחת חדשה כבר מחר?' },
    { side: 'in', t: 'תשלחו חדשה בבקשה, אני צריכה אותה עד שישי' },
    { side: 'out', t: 'סגור. אחת חדשה יוצאת אלייך מחר בבוקר עם שליח, ותגיע לפני שישי. זה עלינו.', meta: 'נשלח 22:42 · נשארו 11 במלאי · משלוח חדש נפתח במערכת' }
  ];
  R[1].t = 'מכל הערוצים, למקום אחד מסודר.';
  R[1].note = 'וואטסאפ, אינסטגרם, מסנג׳ר, מייל, צ׳אט באתר וטלפון נוחתים באותה תיבה, וליד כל שיחה רואים מי מטפל בה עכשיו.';
  R[1].screen = 'תיבת הפניות · 24 פתוחות';
  R[1].inbox = [
    { icon: 'whatsapp', n: 'דנה כהן', s: 'החבילה שלי עדיין לא הגיעה…', time: '22:41', pill: 'AI מטפל', k: 'ai', on: true },
    { icon: 'instagram', n: 'יוסי לוי', s: 'יש את זה במידה M?', time: '22:38', pill: 'AI מטפל', k: 'ai' },
    { icon: 'messenger', n: 'רוני א.', s: 'אפשר להחליף לצבע אחר?', time: '22:30', pill: 'נסגר', k: 'done' },
    { icon: 'gmail', n: 'מיכל ש.', s: 'חשבונית להזמנה #1790', time: '21:52', pill: 'נסגר', k: 'done' },
    { icon: 'globe', n: 'אורח באתר', s: 'כמה זמן לוקח משלוח לאילת?', time: '21:47', pill: 'AI מטפל', k: 'ai' },
    { icon: 'phone', n: 'אבי ג.', s: 'שיחה שלא נענתה · נקבעה חזרה', time: '21:15', pill: 'אצלכם', k: 'you' }
  ];
  R[2] = { label: 'המערכות שלכם, מחוברות', screen: 'הרשאות · כל המערכות', icon: 'plug', panel: 'dark', time: 'מגדירים פעם אחת',
    t: 'הוא קורא את המערכות של העסק. אתם מחליטים מה מותר ומה אסור.',
    note: 'החנות, מערכת ההזמנות, ה-CRM והמלאי. לכל פעולה שלוש אפשרויות: לבצע לבד, לשאול קודם או אף פעם. משנים פעם אחת וכל הערוצים מצייתים.',
    title: 'מה מותר לו לעשות במערכות שלכם',
    prows: [
      { k: 'חיפוש מוצר', v: 'בכל המערכות', seg: 0 },
      { k: 'בדיקת הזמנה', v: 'Shopify · Priority', seg: 0 },
      { k: 'שליחה מחדש', v: 'פריט אחד להזמנה', seg: 0 },
      { k: 'זיכוי עד ₪150', v: 'מבוצע לבד', seg: 0 },
      { k: 'זיכוי מעל ₪150', v: 'עובר לאישורים', seg: 1 },
      { k: 'שינוי פרטי לקוח', v: '', seg: 2 }
    ] };
  R[3].t = 'עד ₪150 הוא מזכה לבד. מעל זה, הזיכוי מחכה לכם.';
  R[3].note = 'נועה קיבלה זיכוי של ₪150 בלי לחכות לאף אחד. הזיכוי של דנה גבוה מהגבול שקבעתם, אז הוא עבר לאישורים עם כל מה שצריך כדי להחליט. מקש אחד, ודנה מעודכנת בוואטסאפ.';
  R[3].prows = [{ k: 'קודם: זיכוי ₪150 לנועה לוי', v: 'בתוך הגבול · בוצע לבד', pill: 'Done' }].concat(R[3].prows);
  R[4].prows = R[4].prows.concat([{ k: 'היום · וואטסאפ', v: 'חבילה תקועה · נשלחה חדשה' }, { k: '14 ביולי · אינסטגרם', v: 'שאלה על מידה · נסגר' }]);
  var A = { label: 'הכל בשליטה', screen: 'אנליטיקס · 7 ימים אחרונים', icon: 'bar-chart-3', panel: 'light', time: 'מתעדכן בזמן אמת',
    t: 'כל מה שקורה בשיחות, במסך אחד.',
    note: 'כמה שיחות GOTCHA סגר לבד, כמה מהר ענה, על מה שואלים ומה זה הכניס. בלי לפתוח אף תמלול.',
    title: 'שיחות הפכו ל-₪96,600 השבוע',
    prows: [
      { k: 'נסגרו בלי מגע אדם', v: '1,284 · 88%', pill: 'Done' },
      { k: 'זמן תגובה ממוצע', v: '19 שניות' },
      { k: 'שביעות רצון', v: '4.8 מתוך 5' },
      { k: 'פעולות שביצע', v: '212 שליחות וזיכויים' },
      { k: 'הנושא הכי נפוץ', v: 'איפה ההזמנה שלי · 312' }
    ] };
  var C = { label: 'הכל בבקרה', screen: 'שיחות חיות · עכשיו', icon: 'eye', panel: 'dark', time: '3 שיחות פתוחות',
    t: 'רואים כל שיחה שה-AI מנהל, ולוקחים שליטה מתי שרוצים.',
    note: 'ליד כל שיחה רואים מי מטפל בה, מה כבר נעשה ומה הצעד הבא. לחיצה אחת והשיחה עוברת אליכם באמצע, עם כל ההקשר.',
    prows: [
      { k: 'דנה כהן · וואטסאפ', v: 'שליחה מחדש · מחר 09:00', pill: 'AI', hl: true },
      { k: 'יוסי לוי · אינסטגרם', v: 'שאלת מידה', pill: 'AI' },
      { k: 'אבי ג. · טלפון', v: 'שיחה חוזרת ב-10:30', pill: 'אצלכם' }
    ],
    keys: [{ key: 'T', t: 'קחו שליטה' }, { key: '↵', t: 'פתחו את השיחה' }],
    keysNote: 'ה-AI עוצר, וממשיך רק כשתחזירו לו' };
  R.splice(5, 2, A, C);
})();

// trims: end on the morning
(function () {
  var Z = window.GOTCHA_HOME.BIZ;
  ['retail', 'leads'].forEach(function (k) { Z[k].moments = Z[k].moments.filter(function (m) { return m.label !== 'Where it lands'; }); });
  var A = Z.retail.moments.filter(function (m) { return m.label === 'הכל בשליטה'; })[0];
  if (A) {
    A.chart = [34, 41, 39, 52, 58, 70, 88];
    A.chartDays = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
    A.prows = A.prows.slice(0, 3);
  }
})();

// week: before/after + try it
window.GOTCHA_HOME.WEEK = [{"t":"חנות אונליין","rows":[["whatsapp","דנה","איפה ההזמנה שלי? הזמנתי לפני שבוע","ממתינה 9 שעות","ההזמנה #1842 אצל השליח, תגיע מחר עד 14:00"],["instagram","שירן","יש את השמלה במידה S?","ממתינה 5 שעות","יש! נשארו 3. לשמור לך אחת?"],["globe","אורח באתר","אפשר להחזיר אם לא מתאים?","ממתין יום","בטח, 14 יום להחזרה. שלחתי לך קישור"],["gmail","יוסי","לא קיבלתי חשבונית","ממתין יומיים","החשבונית נשלחה עכשיו למייל שלך"]],"qs":[["איפה ההזמנה שלי?","הזמנה #1842 יצאה אתמול עם שליח, והיא אמורה להגיע מחר עד 14:00. שלחתי לך קישור למעקב בוואטסאפ."],["יש את זה במידה M?","יש! נשארו 2 במידה M בצבע חול. רוצה שאשמור לך אחת לשעתיים הקרובות?"],["אפשר להחליף מוצר?","בטח. יש לך 14 יום להחלפה. פתחתי לך בקשה, ושליח יאסוף מהבית ביום שלישי."]]},{"t":"מאמן כושר ותזונה","rows":[["instagram","נועה","כמה עולה ליווי של 3 חודשים?","ממתינה 6 שעות","₪1,890, אפשר ב-3 תשלומים. רוצה שיחת היכרות?"],["whatsapp","אבי","אפשר לשנות את האימון של מחר?","ממתין 3 שעות","העברתי אותך לחמישי 07:00"],["whatsapp","מיכל","מה אוכלים לפני אימון בוקר?","ממתינה יום","שלחתי לך 3 אפשרויות מהתפריט שלך"],["messenger","רון","זה מתאים גם למתחילים?","ממתין יומיים","בדיוק בשביל זה בנינו את התוכנית. רוצה לשמוע?"]],"qs":[["כמה עולה הליווי?","תוכנית של 3 חודשים עולה ₪1,890, ואפשר ב-3 תשלומים. היא כוללת תפריט אישי, אימונים מהבית וליווי בוואטסאפ. רוצה שיחת היכרות מחר?"],["זה מתאים למתחילות?","בדיוק בשבילך. מתחילים מאימונים של 20 דקות ומעלים בהדרגה. רוב המתאמנות שלנו התחילו מאפס."],["אפשר לדחות את האימון?","אין בעיה. העברתי את האימון של מחר ליום חמישי ב-07:00, ושלחתי לך תזכורת."]]},{"t":"קליניקה וטיפולי יופי","rows":[["whatsapp","הדס","יש תור ללייזר השבוע?","ממתינה 5 שעות","יש ביום רביעי 16:30. לקבוע?"],["instagram","ליאת","כמה עולה טיפול פנים?","ממתינה 8 שעות","₪380, ובחבילה של 3 ₪990"],["phone","שיחה שלא נענתה","054-•••••••","ממתין יום","GOTCHA חזר בוואטסאפ וקבע תור"],["whatsapp","רותם","צריך להגיע עם משהו לטיפול?","ממתינה 3 שעות","רק בלי קרם על הפנים. נתראה מחר"]],"qs":[["יש תור השבוע?","יש ביום רביעי ב-16:30 וביום חמישי ב-10:00. לקבוע לך אחד מהם?"],["כמה עולה טיפול פנים?","טיפול פנים עולה ₪380, ובחבילה של 3 טיפולים ₪990. הטיפול לוקח שעה."],["צריך להתכונן לטיפול?","רק להגיע בלי קרם ובלי איפור. אם יש לך רגישות בעור, כדאי לספר לנו כבר עכשיו."]]},{"t":"נדל״ן","rows":[["whatsapp","עמית","הדירה ברחוב הרצל עוד זמינה?","ממתין 7 שעות","כן. אפשר לראות אותה מחר ב-18:00"],["globe","פנייה מהאתר","מחפשים 4 חדרים ברמת גן","ממתין יום","שלחתי 3 דירות שמתאימות. מתי נוח לשיחה?"],["instagram","שני","יש חניה?","ממתינה 4 שעות","יש חניה בטאבו ומחסן"],["gmail","דוד","רוצה להעריך את הדירה שלי","ממתין יומיים","קבעתי שמאי ליום ראשון 10:00"]],"qs":[["הדירה עוד זמינה?","כן, 4 חדרים בהרצל 12, קומה 3 עם מעלית. אפשר לראות אותה מחר ב-18:00 או ביום שישי ב-10:00."],["יש חניה?","יש חניה רשומה בטאבו ומחסן, והדירה שופצה לפני שנה."],["אפשר הערכה לדירה שלי?","בטח. אני צריך כתובת וגודל משוער, ואקבע לך שמאי. יום ראשון ב-10:00 מתאים?"]]},{"t":"קורסים וסדנאות","rows":[["instagram","יעל","מתי המחזור הבא?","ממתינה 6 שעות","נפתח ב-3 בנובמבר, נשארו 4 מקומות"],["whatsapp","אורי","אפשר לשלם בתשלומים?","ממתין 4 שעות","עד 6 תשלומים בלי ריבית. שלחתי קישור"],["globe","אורח באתר","זה מתאים בלי ניסיון?","ממתין יום","כן, השיעור הראשון מתחיל מאפס"],["gmail","מאיה","פספסתי שיעור, יש הקלטה?","ממתינה יומיים","ההקלטה מחכה לך באזור האישי"]],"qs":[["מתי המחזור הבא?","המחזור הבא נפתח ב-3 בנובמבר, פעמיים בשבוע בערב. נשארו 4 מקומות."],["אפשר בתשלומים?","כן, עד 6 תשלומים בלי ריבית. שלחתי לך קישור להרשמה."],["זה מתאים בלי ניסיון?","לגמרי. השיעור הראשון מתחיל מאפס, ויש מנטור שמלווה אותך לאורך כל הקורס."]]},{"t":"מלונות","rows":[["whatsapp","תמר","יש חדר פנוי בסוף השבוע?","ממתינה 5 שעות","יש סוויטה פנויה, ₪1,450 ללילה עם ארוחת בוקר"],["instagram","גיל","אפשר צ׳ק אאוט מאוחר?","ממתין 3 שעות","סידרתי לך עד 14:00 בלי תוספת"],["gmail","שרה","ארוחת בוקר כלולה?","ממתינה יום","כן, 07:00 עד 10:30 בגינה"],["phone","שיחה שלא נענתה","03-•••••••","ממתין יומיים","GOTCHA חזר בוואטסאפ ושלח הצעה"]],"qs":[["יש חדר בסוף השבוע?","יש סוויטה פנויה מחמישי עד שבת, ₪1,450 ללילה כולל ארוחת בוקר. לשמור לך?"],["אפשר צ׳ק אאוט מאוחר?","סידרתי לך צ׳ק אאוט עד 14:00 בלי תוספת. נתראה!"],["יש חניה במלון?","יש חניה חינם לאורחים, ממש מול הכניסה. אפשר גם להזמין הסעה מהרכבת."]]}];

window.GOTCHA_HOME.WEEK.push({ t: 'אחר', rows: [['whatsapp','לקוח חדש','כמה זה עולה?','ממתין 6 שעות','שלחתי את המחירון ושתי אפשרויות שמתאימות לו'],['instagram','פנייה באינסטגרם','אתם פתוחים בשבת?','ממתינה 4 שעות','סגורים בשבת, פתוחים מחר מ-09:00'],['globe','אורח באתר','אפשר לדבר עם מישהו?','ממתין יום','קבעתי שיחה עם הצוות מחר ב-11:00'],['gmail','לקוח קיים','שלחתי מייל ולא חזרו אליי','ממתין יומיים','סליחה על העיכוב, הבקשה טופלה ונשלח אישור']], qs: [] });

// process: learn + connect
(function () {
  var Z = window.GOTCHA_HOME.BIZ;
  var learnR = { label: 'לומד את העסק', screen: 'קורא את האתר שלכם', icon: 'scan-search', panel: 'light', time: 'כמה דקות', scan: true,
    t: 'קודם הוא לומד את העסק שלכם.',
    note: 'מכניסים כתובת אתר, ו-GOTCHA קורא כל עמוד: מוצרים, מחירים, משלוחים, החזרות ושאלות נפוצות. אחרי כמה דקות הוא עונה כמו מישהו מהצוות.',
    title: 'yourstore.co.il',
    prows: [{ k: 'מוצרים ומחירים', v: '1,240 פריטים', pill: 'נלמד' }, { k: 'משלוחים', v: 'זמנים ועלויות', pill: 'נלמד' }, { k: 'מדיניות החזרות', v: '14 יום', pill: 'נלמד' }, { k: 'שאלות נפוצות', v: '38 תשובות', pill: 'נלמד' }] };
  var connR = { label: 'מחברים את המערכות', screen: 'אינטגרציות', icon: 'plug-zap', panel: 'light', time: 'חיבור בלחיצה',
    t: 'ואז מחברים את הערוצים והמערכות.',
    note: 'הערוצים שבהם הלקוחות כותבים, והמערכות שבהן נמצאות התשובות. מהרגע הזה הוא מתחיל לעבוד, ואתם מחליטים כמה.',
    prows: [{ k: 'Shopify', v: 'הזמנות · מוצרים · מלאי', pill: 'מחובר' }, { k: 'WhatsApp Business', v: 'המספר שלכם נשאר שלכם', pill: 'מחובר' }, { k: 'Instagram ו-Messenger', v: 'הודעות ותגובות', pill: 'מחובר' }, { k: 'Gmail', v: 'פניות במייל', pill: 'מחובר' }, { k: 'Priority', v: 'לקוחות וחשבוניות', pill: 'מחובר' }] };
  var learnL = { label: 'לומד את העסק', screen: 'קורא את האתר שלכם', icon: 'scan-search', panel: 'light', time: 'כמה דקות', scan: true,
    t: 'קודם הוא לומד את העסק שלכם.',
    note: 'מכניסים כתובת אתר, ו-GOTCHA קורא כל עמוד: התוכניות, המחירים, למי זה מתאים ומה שואלים לפני שמצטרפים.',
    title: 'noa-fit.co.il',
    prows: [{ k: 'תוכניות ומחירים', v: '3 תוכניות', pill: 'נלמד' }, { k: 'למי זה מתאים', v: 'מתחילות ומתקדמות', pill: 'נלמד' }, { k: 'שאלות נפוצות', v: '24 תשובות', pill: 'נלמד' }, { k: 'מדיניות ביטול', v: '14 יום', pill: 'נלמד' }] };
  var connL = { label: 'מחברים את המערכות', screen: 'אינטגרציות', icon: 'plug-zap', panel: 'light', time: 'חיבור בלחיצה',
    t: 'ואז מחברים את הערוצים והמערכות.',
    note: 'איפה שהלידים מגיעים, היומן שבו קובעים שיחות וה-CRM שבו הכל נרשם. מהרגע הזה הוא מתחיל לעבוד.',
    prows: [{ k: 'Instagram ו-WhatsApp', v: 'הודעות ולידים', pill: 'מחובר' }, { k: 'Google Calendar', v: 'שיחות היכרות', pill: 'מחובר' }, { k: 'HubSpot', v: 'לידים ועסקאות', pill: 'מחובר' }, { k: 'Gmail', v: 'פניות מהאתר', pill: 'מחובר' }] };
  Z.retail.moments = [learnR, connR].concat(Z.retail.moments.filter(function (m) { return m.label !== 'לומד את העסק' && m.label !== 'מחברים את המערכות'; }));
  Z.leads.moments = [learnL, connL].concat(Z.leads.moments.filter(function (m) { return m.label !== 'לומד את העסק' && m.label !== 'מחברים את המערכות'; }));
  Z.retail.moments.forEach(function (m) { if (m.label === 'המערכות שלכם, מחוברות') m.label = 'אתם מחליטים'; });
})();

// logos everywhere
(function () {
  var Z = window.GOTCHA_HOME.BIZ, L = { 'Shopify': 'shopify.svg', 'WhatsApp Business': 'whatsapp.svg', 'Instagram ו-Messenger': 'instagram.svg', 'Gmail': 'gmail.svg', 'Instagram ו-WhatsApp': 'instagram.svg' };
  ['retail', 'leads'].forEach(function (k) {
    Z[k].moments.forEach(function (m) {
      (m.prows || []).forEach(function (r) {
        if (L[r.k]) r.logo = L[r.k];
        if (/וואטסאפ|WhatsApp/.test(r.k) && !r.logo) r.logo = 'whatsapp.svg';
        if (/אינסטגרם|Instagram/.test(r.k) && !r.logo) r.logo = 'instagram.svg';
        if (/טלפון/.test(r.k) && !r.logo) r.logo = 'phone.svg';
        if (/מייל|Gmail/.test(r.k) && !r.logo) r.logo = 'gmail.svg';
      });
      if (m.label === 'מחברים את המערכות' && k === 'retail') {
        m.connectLogos = true;
        m.prows.splice(1, 0, { k: 'WooCommerce', v: 'או החנות שלכם בווקומרס', pill: 'מחובר', logo: 'woo.png' });
        m.prows = m.prows.filter(function (r) { return r.k !== 'Priority'; });
        m.prows.push({ k: 'Outlook', v: 'פניות במייל', pill: 'מחובר', logo: 'outlook.svg' });
      }
    });
  });
})();

// inbox UI + order
(function () {
  var Z = window.GOTCHA_HOME.BIZ, R = Z.retail.moments;
  var find = function (lbl) { return R.filter(function (m) { return m.label === lbl; })[0]; };
  var conn = find('מחברים את המערכות');
  if (conn) conn.prows = [{ k: 'Shopify', v: 'הזמנות · מוצרים · מלאי', pill: 'מחובר', logo: 'shopify.svg' }, { k: 'WhatsApp Business', v: 'המספר שלכם נשאר שלכם', pill: 'מחובר', logo: 'whatsapp.svg' }, { k: 'Facebook ו-Messenger', v: 'הודעות ותגובות', pill: 'מחובר', logo: 'facebook.svg' }, { k: 'Instagram', v: 'הודעות ותגובות', pill: 'מחובר', logo: 'instagram.svg' }, { k: 'Gmail', v: 'פניות במייל', pill: 'מחובר', logo: 'gmail.svg' }];
  var inb = find('The inbox');
  if (inb) inb.inbox = { fly: true, title: 'מוקצה לי', count: '4', view: 'מוקצה לי', rows: [
    { icon: 'whatsapp.svg', ini: 'דכ', n: 'דנה כהן', s: 'החבילה שלי עדיין לא הגיעה…', time: '22:41', tags: [['AI מטפל', 'ai']], on: true },
    { icon: 'instagram.svg', ini: 'יו', n: 'יואב', s: 'שלום, יש את המוצר הזה גם במידה L?', time: '22:38', tags: [['חריגה מה-SLA', 'sla'], ['8 דקות בהמתנה'], ['אתם']] },
    { icon: 'gmail.svg', ini: 'רו', n: 'רותם', s: 'רציתי לשאול לגבי החשבונית מההזמנה האחרונה', time: '21:52', tags: [['חריגה מה-SLA', 'sla'], ['אתם']] },
    { icon: 'messenger.svg', ini: 'רא', n: 'רוני א.', s: 'אפשר להחליף לצבע אחר?', time: '21:30', tags: [['AI מטפל', 'ai']] },
    { icon: 'globe.svg', ini: 'אב', n: 'אורח באתר', s: 'כמה זמן לוקח משלוח לאילת?', time: '21:15', tags: [['AI מטפל', 'ai']] }
  ] };
  var perm = find('אתם מחליטים'); if (perm) perm.t = 'אתם מחליטים מה מותר ומה אסור';
  var appr = find('Above your limit'); if (appr) appr.t = 'ומה שהגדרתם מחכה לכם לאישור';
  var cust = find('One person, every channel'); if (cust) cust.t = 'כל המידע נשמר בצורה מסודרת';
  var ctrl = find('הכל בבקרה');
  if (ctrl) {
    delete ctrl.prows; delete ctrl.keys; delete ctrl.keysNote; delete ctrl.panel;
    ctrl.t = 'רואים כל שיחה שה-AI מנהל, ולוקחים שליטה מתי שרוצים';
    ctrl.inbox = { title: 'מנוהל ע״י GOTCHA', count: '4', view: 'מנוהל ע״י GOTCHA', rows: [
      { icon: 'whatsapp.svg', ini: 'דכ', n: 'דנה כהן', s: 'סגור. אחת חדשה יוצאת אלייך מחר בבוקר', time: 'עכשיו', badge: '3', tags: [['AI מטפל', 'ai']], on: true, btn: 'קחו שליטה' },
      { icon: 'globe.svg', ini: 'אב', n: 'אורח באתר', s: 'הנה כמה פריטים שמשתלבים מעולה עם…', time: 'יום ג׳', badge: '7', tags: [['יום בהמתנה']] },
      { icon: 'instagram.svg', ini: 'יו', n: 'יואב', s: 'יש לנו במידה L, לשמור לך אחת?', time: '22:39', tags: [['AI מטפל', 'ai']] },
      { icon: 'whatsapp.svg', ini: 'מע', n: 'מתן עמרן', s: 'יצרתי זיכוי בחנות בסכום ₪549 בקוד…', time: '14.10', tags: [['6 ימים בהמתנה']] }
    ] };
  }
  var anal = find('הכל בשליטה'), morn = find('Your morning');
  var order = R.filter(function (m) { return m !== ctrl && m !== anal && m !== morn; });
  Z.retail.moments = order.concat([ctrl, anal, morn].filter(Boolean));
})();

// leads: story pass 2
(function () {
  var Z = window.GOTCHA_HOME.BIZ, L = Z.leads.moments;
  var find = function (lbl) { return L.filter(function (m) { return m.label === lbl; })[0]; };
  var conn = find('מחברים את המערכות');
  if (conn) conn.prows.forEach(function (r) { if (r.k === 'HubSpot') { r.k = 'ה-CRM שלכם'; r.v = 'HubSpot, monday, Zoho או כל מערכת אחרת'; r.logo = 'crm.svg'; } if (r.k === 'Google Calendar') r.logo = 'googlecalendar.svg'; });
  var c1 = find('A lead comes in');
  if (c1) {
    c1.t = 'היא שואלת ב-21:40, ועובד ה-AI שלנו עונה תוך רגע';
    c1.note = 'לפני שהוא נותן מחיר, הוא מתעניין בה: מה המטרה ומה הניסיון שלה. רק אז הוא מציג את התוכנית שמתאימה לה ומציע שני מועדים מהיומן. ככה מוכרים.';
    c1.msgs = [
      { side: 'in', t: 'היי, כמה עולה תוכנית הליווי של 3 חודשים?' },
      { side: 'out', t: 'היי! לפני שאספר על התוכניות, מה המטרה שלך? ויש לך ניסיון קודם באימונים?' },
      { side: 'in', t: 'רוצה לרדת 8 קילו לפני החתונה של אחותי, ואין לי ניסיון' },
      { side: 'out', t: 'מושלם, התוכנית של 3 חודשים בנויה בדיוק בשבילך: אימונים מהבית ותפריט אישי. היא עולה ₪1,890, ואפשר בשלושה תשלומים. שיחת היכרות מחר ב-10:00 או ב-18:00?', meta: 'נשלח 21:41' }
    ];
  }
  var c2 = find('They get talking'); if (c2) c2.t = 'הוא עונה על כל השאלות בנימוס ובמקצועיות';
  var crm = find('Everything lands in your CRM');
  if (crm) { crm.t = 'כל עבודת הבק אופיס עלינו: אנחנו ממלאים הכל ב-CRM שלכם'; crm.screen = 'ה-CRM שלכם · העסקה עודכנה'; }
  var knew = find('What it already knew'); if (knew) knew.t = 'כל המידע על הלקוחה נשמר ומסוכם באנשי הקשר שלנו';
  var call = find('Call pilot'); if (call) call.t = 'בשיחת טלפון בלייב, הוא מכווין את נציג המכירות ומסכם את כל השיחה';
  var morn = find('Your morning');
  var anal = { label: 'הכל בשליטה', screen: 'אנליטיקס · 7 ימים אחרונים', icon: 'bar-chart-3', panel: 'light', time: 'מתעדכן בזמן אמת',
    t: 'כל הלידים, במסך אחד', note: 'כמה לידים נענו, כמה שיחות נקבעו וכמה הפכו ללקוחות. בלי לפתוח אף תמלול.',
    title: 'לידים הפכו ל-₪35,900 השבוע', chart: [30, 38, 45, 49, 60, 71, 86], chartDays: ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'],
    prows: [{ k: 'לידים שנענו תוך דקה', v: '212 · 96%', pill: 'Done' }, { k: 'שיחות היכרות שנקבעו', v: '48' }, { k: 'הפכו ללקוחות', v: '19' }] };
  Z.leads.moments = L.filter(function (m) { return m.label !== 'Hire it for enquiries' && m.label !== 'It follows up, then stops' && m !== morn && m.label !== 'הכל בשליטה'; }).concat([anal, morn].filter(Boolean));
})();

window.GOTCHA_HOME.WEEK.splice(1, 0, { t: 'מכירות לידים', rows: [['instagram','נועה','כמה עולה תוכנית הליווי?','ממתינה 6 שעות','שאל על המטרה שלה, ואז שלח תוכנית ומחיר'],['globe','טופס באתר','רוצה לשמוע פרטים על השירות','ממתין יום','חזר אליו תוך דקה וקבע שיחה למחר 10:00'],['whatsapp','אבי','אפשר הצעת מחיר?','ממתין 4 שעות','שאל שלוש שאלות ושלח הצעה מותאמת'],['gmail','מיכל','השארתי פרטים ולא חזרו אליי','ממתינה יומיים','הליד עודכן ב-CRM ונקבעה שיחה עם הצוות']], qs: [] });

// ecommerce: abandoned cart page
(function () { var c = window.GOTCHA_HOME.MENUS.product.cols[0]; if (!c.items.some(function (x) { return x.page === 'feat-cart'; })) c.items.splice(4, 0, { t: 'Cart recovery', n: 'Bring left carts back on WhatsApp', icon: 'shopping-basket', page: 'feat-cart' }); })();
