# Dr. Mendoza Multi-Specialty Clinic — How the System Works

Staff sign-in portal and clinic management system.
Everything is a **static website** (HTML/CSS/JS) talking to a **Supabase** Postgres
database through server-side functions, with **Brevo** doing the actual e-mail delivery.

---

## 1. The big picture

```
   ┌─────────────────────────────── YOUR COMPUTER / PHONE ──────────────────────────────┐
   │                                                                                    │
   │   index.html  ──► js/login.js                                                      │
   │   app.html    ──► js/app.js                                                        │
   │                                                                                    │
   │   window.db = supabase.createClient(URL, PUBLISHABLE_KEY)   (js/config.js)         │
   └───────────────────────────────────┬────────────────────────────────────────────────┘
                                       │  HTTPS (JSON RPC)
                                       ▼
   ┌──────────────────────────────── SUPABASE (Postgres) ───────────────────────────────┐
   │                                                                                    │
   │   login()  verify_login_code()  verify_session()  create_patient()  get_stats() …  │
   │   (SECURITY DEFINER functions — the ONLY thing the website may touch)              │
   │                                                                                    │
   │   Tables: employees · services · patients · visits · visit_items · payments        │
   │           activity_log · receipt_files · app_settings                              │
   │           login_codes · employee_sessions                                          │
   │                                                                                    │
   │   ⚠ The database has NO outbound internet access, so it CANNOT call Brevo.         │
   └───────────────────────────────────┬────────────────────────────────────────────────┘
                                       │  (builds the e-mail, returns it as JSON)
                                       ▼
   ┌────────────────────────── SUPABASE EDGE FUNCTION ──────────────────────────────────┐
   │   hyper-function      (supabase/functions/send-code/index.ts)                      │
   │   POSTs the finished e-mail to Brevo. Has its own internet access.                 │
   │   Brevo API key lives only in the Edge secret — never in the browser.              │
   └───────────────────────────────────┬────────────────────────────────────────────────┘
                                       │  HTTPS + api-key
                                       ▼
   ┌──────────────────────────────────── BREVO ─────────────────────────────────────────┐
   │   https://api.brevo.com/v3/smtp/email                                              │
   │   Sender: Dr. Mendoza Multi-Specialty Clinic <hernalwinston@gmail.com>             │
   │   Delivers to the staff member's mailbox (Gmail, Yahoo, …).                        │
   └────────────────────────────────────────────────────────────────────────────────────┘
```

**In one sentence:** the browser asks Postgres to make a code; Postgres builds the
finished e-mail and hands it back as JSON; the Edge Function posts it to Brevo; Brevo
puts it in the staff member's inbox; the staff member types the code back into the site.

---

## 2. Login flow (step by step)

```
                     STAFF MEMBER                      SYSTEM
                          │                             │
     ┌────────────────────┴────────────────────┐        │
     │  index.html  →  email + password        │        │
     └────────────────────┬────────────────────┘        │
                          │  rpc('login', email, pw)    │
                          └────────────────────────────►│
                                                        │ 1. find employee by email, else by username
                                                        │ 2. check password  (pgcrypto crypt())
                                                        │ 3. account active? has an e-mail address?
                                                        │ 4. rate limit: 15-second cooldown,
                                                        │    max 20 codes per hour
                                                        │ 5. invalidate every earlier code
                                                        │ 6. make a random 6-digit code
                                                        │ 7. store ONLY the bcrypt hash of it
                                                        │ 8. expires_at = now() + 10 minutes
                                                        │ 9. fn_otp_email()  → builds the branded HTML
                                                        │10. returns { challenge_id, masked_email,
                                                        │     sent_at, mail: {to,subject,html,text} }
                          │  ◄──────────────────────────┘
                          │
     ┌────────────────────┴────────────────────┐
     │  login.js forwards mail → Edge Function │
     │  db.functions.invoke('hyper-function')  │
     └────────────────────┬────────────────────┘
                          │
                          └────────────────────────────►│  POST /v3/smtp/email
                                                        │  → Brevo accepts, returns messageId
                          │  ◄── { ok: true } ──────────┘
     ┌────────────────────┴───────────────────────────┐
     │  "Code sent to jo***@gmail.com at 6:04 PM"     │
     │  6-digit box + 10-minute countdown              │
     └────────────────────┬───────────────────────────┘
                          │  types the 6 digits
                          │  rpc('verify_login_code', challenge_id, code)
                          └────────────────────────────►│
                                                        │ 1. challenge exists? not used? not expired?
                                                        │ 2. fewer than 5 wrong attempts?
                                                        │ 3. crypt(typed_code, stored_hash) matches?
                                                        │ 4. employee still active?
                                                        │ 5. create a session token, valid 3 hours
                                                        │ 6. mark the code consumed (one-time use)
                          │  ◄── { token, role, … } ────┘
     ┌────────────────────┴────────────────────┐
     │  Session.save(data) → localStorage      │
     │  redirect → app.html                    │
     └────────────────────┬────────────────────┘
                          │
                          └────────────────────────────►│  rpc('verify_session', token)
                                                        │  (server-side check on every page load —
                                                        │   localStorage alone is never trusted)
                          │  ◄── employee record ───────┘
```

### Security rules baked into the code

| Rule | Where | Why |
|---|---|---|
| Code is **never stored**, only its bcrypt hash | `login_codes.code_hash` | A database dump cannot reveal working codes |
| Codes live **10 minutes** | `login()` | Short window if an e-mail is intercepted |
| **5 wrong attempts** kill the challenge | `verify_login_code()` | Blocks brute force (1 in a million × 5) |
| **One-time use** | `consumed_at` | A code cannot be replayed |
| **Only the newest code works** | `login()` / `resend_login_code()` | An older e-mail can never sign you in |
| **15-second cooldown**, max **20 codes/hour** | rate-limit block | Stops spam without locking staff out |
| Email shown as `jo***@gmail.com` | `fn_mask_email()` | Confirms the address without exposing it |
| Session checked **server-side** | `verify_session()` | Tampering with localStorage does nothing |
| Session lasts **3 hours** | `employee_sessions.expires_at` | Staff must re-authenticate daily |

---

## 3. Supabase — what it is and how it is set up

**Supabase** hosts a real PostgreSQL database plus APIs. In this project it does all the
storage, all the logic, and all the security.

### The connection (js/config.js)

```js
SUPABASE_URL : https://rknsbfykyulrejnbwjuf.supabase.co
SUPABASE_KEY : sb_publishable_1eOKsHa61pzfly5n4DMutg_hOpDQLMe   ← publishable (safe in a browser)
```

The **publishable key** may live in the website source — it is designed to be public and
carries no privileged access. The **secret** (used only by the Edge Function) never
appears in any HTML or JS file.

### Why functions, not tables

The website never does `select * from employees`. Every operation is a **Postgres
function** (`login`, `create_patient`, `get_stats`, …) marked `security definer`, so:

* the **rules** live in the database, not in JavaScript — the site cannot be edited to
  bypass them;
* passwords are compared with `pgcrypto.crypt()` inside the database;
* every function begins by calling `fn_actor(p_actor)` / `fn_is_admin(p_actor)`, which
  read the session token and refuse to run for an unknown or expired user;
* sensitive tables have **no grants at all**, so even the publishable key cannot read
  them directly — only through a permitted function.

### Objects in the database

**Data tables**

| Table | Holds |
|---|---|
| `employees` | staff accounts, bcrypt `password_hash`, role, e-mail, `is_active` |
| `services` | the clinic's price list |
| `patients` | patient records (registered by an admin/employee) |
| `visits` | one row per consultation |
| `visit_items` | the services charged inside a visit |
| `payments` | money received, method, refunds |
| `receipt_files` | stored PDF/HTML receipts |
| `queue_entries` | the waiting line: `queue_no`, `ticket`, `patient_id`, `display_name`, `purpose`, `status` (`waiting`/`serving`/`done`/`skipped`), `window_no`, timestamps |
| `activity_log` | who did what, and when |
| `app_settings` | configurable clinic/Brevo settings |

**Auth tables**

| Table | Holds |
|---|---|
| `login_codes` | one row per issued code: `code_hash`, `expires_at`, `attempts`, `consumed_at`, `email_status` |
| `employee_sessions` | one row per signed-in user: `token`, `expires_at` |

**Main functions**

```
login()  →  verify_login_code()  →  verify_session()  →  logout()
               resend_login_code()

create/update/list employee · create_patient · search_patients · get_patient_record
create_visit · record_payment · start_lab · complete_visit · refund_visit
list_visits · get_stats · get_charts · get_report
list_services · upsert_service · list_activity · list_archived · delete_archived
save_receipt_file · get_receipt_file · list_receipts · heartbeat
join_queue · queue_next · queue_start · queue_done · queue_skip · queue_state · get_queue
```

**The waiting queue (FIFO)**

```
front desk (app.html)            waiting-room screen (queue.html, NO login)
   join_queue()  ─┐                         ▲
   queue_next()   ├─►  queue_entries  ──────┘ get_queue()  every 4 s
   queue_done()   │     (one row per          (first name + ticket only,
   queue_skip()  ─┘      ticket)              never a full name / contact)
```

- Staff call the next patient from the **Queue** view; the room screen shows
  **Now Serving** (big ticket) plus the numbered **Waiting** list.
- The screen is reached from the **Live Queue** link on the login page, or by
  opening `queue.html` directly — it needs **no account**.
- `get_queue()` is public on purpose so the TV needs no login, but it only ever
  returns the **first name** (`fn_first_name`) and the ticket number.
- Only one counter is served at a time; calling a new patient auto-finishes the
  previous one.

**Helpers**

```
fn_actor()          turns a session token into an employee row (or raises)
fn_is_admin()       true only for role = 'admin'
fn_mask_email()     jolohernal@gmail.com  →  jo***@gmail.com
fn_otp_email()      builds the branded sign-in / reset e-mail (subject, HTML, text)
fn_send_brevo()     reports whether the e-mail could be handed over
fn_log()            writes to activity_log
```

---

## 4. Brevo — what it is and how it is set up

**Brevo** (formerly Sendinblue) is the transactional e-mail service. It is what actually
puts the message into the mailbox.

| Item | Value |
|---|---|
| API endpoint | `https://api.brevo.com/v3/smtp/email` |
| API key | `xkeysib-…` — stored **only** as the Edge Function secret `BREVO_API_KEY` |
| Verified sender | `hernalwinston@gmail.com` (display name: *Dr. Mendoza Multi-Specialty Clinic*) |
| Account id | `10922950` |
| IP blocking | **Off** — it must stay off, otherwise Brevo refuses the send |

### Who calls Brevo, and why it is not the database

Supabase deliberately gives the **Postgres database no outbound internet access**, so a
`select http_post('https://api.brevo.com/…')` from inside the database simply hangs.
This project tried both native options first:

| Attempt | Result |
|---|---|
| `pg_net` (Supabase's queue extension) | Enqueued but its background worker never ran on this project → every call stayed `queued` forever |
| `http` extension (direct call) | Hangs → the statement is cancelled by `statement timeout` (error `57014`) |

The **Edge Function** has its own network access, so it works reliably. That is the whole
reason `send-code` exists.

### Reading the mail template

`fn_otp_email()` produces one JSON object:

```json
{
  "subject": "Dr. Mendoza Clinic - sign-in code (6:04 PM)",
  "html":    "<!doctype … the branded card …>",
  "text":    "Your 6-digit sign-in code is: 813952 …"
}
```

Design: navy→blue header (`#103778` → `#1976E8`), `DM` monogram, Poppins + Inter type,
pale blue panels (`#EAF5FF` / `#F6FBFF`), 20px rounded card, `letter-spacing:9px` code.

The **send time appears in the subject, the body and the code screen** so a reader can
never grab a code from an older e-mail by mistake (Gmail would otherwise stack every
message with an identical subject into one thread).

---

## 5. How the three pieces work together

```
        BROWSER                 SUPABASE                 BREVO
          │                        │                        │
          │  1. email + password   │                        │
          │───────────────────────►│                        │
          │                        │ 2. verify credentials  │
          │                        │ 3. make 6-digit code   │
          │                        │ 4. hash it, store it   │
          │                        │ 5. build the e-mail    │
          │  6. { challenge_id,    │    (fn_otp_email)      │
          │       mail: {...} }    │                        │
          │◄───────────────────────│                        │
          │  7. POST mail ────────►│  Edge Function         │
          │                        │───────────────────────►│
          │                        │  8. { messageId }      │
          │                        │◄───────────────────────│
          │  9. "Code sent"        │                        │
          │                        │                        │
          │                        │                        │ 10. delivers to
          │                        │                        │     the mailbox
          │  11. types the code    │                        │
          │───────────────────────►│                        │
          │                        │ 12. bcrypt compare     │
          │                        │ 13. issue session      │
          │  14. { token, role }   │                        │
          │◄───────────────────────│                        │
          │  15. app.html          │                        │
          │───────────────────────►│  verify_session(token) │
          │                        │◄───────────────────────│  (no Brevo involved)
```

Responsibilities, cleanly separated:

* **Supabase** decides *whether* a sign-in may happen (credentials, expiry, attempts,
  session validity) and *what* the e-mail says.
* **Edge Function** is only a **delivery courier**. It holds no business logic — it
  validates the address, adds the sender, posts to Brevo, and reports the truth.
* **Brevo** does one thing: put the message in a mailbox, and report
  `requests` → `delivered` / `blocked` / `error` / `spam` in its statistics API.

---

## 6. Files in this project

```
mendoza_clinic_landing/
├── index.html                 public landing page + the two-step login
├── app.html                   the staff application (after sign-in)
├── queue.html                 the waiting-room screen (public, no login)
├── schema.sql                 THE WHOLE DATABASE — run this in the SQL Editor
├── HOW_IT_WORKS.md            this document
├── css/
│   ├── style.css              landing page
│   ├── login.css              login screen
│   └── app.css                staff application
└── js/
    ├── config.js              Supabase client + Session helper + peso()
    ├── script.js              landing page behaviour
    ├── login.js               the two-step sign-in flow
    └── app.js                 clinic features (patients, visits, queue, receipts, reports)
```

Supabase side:

```
supabase/functions/send-code/index.ts     the Edge Function that posts to Brevo
```

---

## 7. How to check each link in the chain

When something fails, test **one link at a time**.

**1. Database makes the code**
```sql
select public.login('hernalwinston@gmail.com', 'admin123');
```
Must return `challenge_id`, `masked_email`, `sent_at` and a `mail` object.

**2. Edge Function delivers**
Open the browser console and run:
```js
db.functions.invoke('hyper-function', { body: { to:'you@example.com', subject:'Test',
  html:'<b>Dr. Mendoza Clinic</b>', text:'Test' } }).then(r => console.log(r))
```
Must resolve with `{ data: { ok: true, messageId: '…' } }`.

**3. Brevo actually sent it**
Dashboard → *Transactional* → *Statistics*, or:
```bash
curl -H "api-key: xkeysib-…" \
  "https://api.brevo.com/v3/smtp/statistics/events?event=delivered&limit=5"
```
`requests` must grow, then `delivered`. `blocked` / `error` / `spam` must stay empty.

**4. Code is accepted**
Use the code from the **newest** e-mail — the one whose time matches the code screen.

**5. The waiting queue**
```sql
select public.get_queue();                       -- what the TV sees (public)
select public.queue_state('…actor uuid…');       -- what the staff screen sees
```
`get_queue()` must show only first names. If the TV stays blank, confirm
`get_queue` is granted to `anon` (it is, in section 9 of `schema.sql`).

---

## 8. Maintenance

| Task | How |
|---|---|
| Change anything in the database | Edit `schema.sql`, then paste the **whole file** into the SQL Editor and run it |
| Rotate the Brevo key | Brevo → *SMTP & API* → generate a new key, then Edge Function → *Secrets* → `BREVO_API_KEY` → Save |
| Rename the Edge Function | Not possible — the slug is fixed at creation. The site calls `hyper-function` |
| Give a staff member e-mail access | Admin → Employees → set an **e-mail address**. Without one, login raises *"No email address is set for this account."* |
| Show the waiting queue on a TV | Click **Live Queue** on the login page, or open `queue.html` full-screen in a browser. It needs no login and refreshes itself every ~4 s |
| See who signed in / what happened | `activity_log`, or the app's activity screen |

### Accounts

| Username | Password | E-mail |
|---|---|---|
| `admin` | `admin123` | hernalwinston@gmail.com |
| `kenontiv` | `admin123` | Kenontiv@gmail.com |
| `emplo` | *(set by admin)* | jolohernal@gmail.com |
| `winston` | *(set by admin)* | **none — cannot receive codes** |
| `employee` | *(set by admin)* | **none — cannot receive codes** |

> An account **must** have an e-mail address before it can be used to sign in.
> The waiting-room screen needs **no account at all** — reach it from the
> **Live Queue** link on the login page.
