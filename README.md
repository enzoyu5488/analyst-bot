# Devbox Analyst Bot

**Ari** turns plain-language business requests into a technical analysis and manday estimate for the Devbox MEAN/Ionic stack.

It supports two intake paths:

1. **New tool** - for applications or workflows built from scratch.
2. **Extension** - for enhancements to an existing tool. This path asks for a repository link, documentation link, or short description of the existing system before analysis.

The bot is designed for business stakeholders, so users can describe the request in everyday language. The AI response translates that into:

- interpreted scope
- MEAN/Ionic technical approach
- frontend, backend, database, and mobile fit
- manday breakdown by work package
- total min/max mandays
- assumptions, risks, and open questions
- visual process flow when the request involves a workflow
- drafted user stories saved per customer when MongoDB is configured
- practical delivery recommendation
- Lex-ready contract handoff with computed commercial totals

Before estimating, Ari may ask up to three simple clarifying questions. If the request involves a workflow, approvals, handoffs, statuses, or multiple roles, Ari prioritizes asking about the process flow. Users can answer only what they know or choose "I don't know"; Ari treats unknown answers as estimate uncertainty instead of blocking the workflow.

## Run

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:3000`.

Required AI setting:

```bash
OPENAI_API_KEY=your-api-key-here
```

Optional settings:

```bash
PORT=3000
OPENAI_MODEL=gpt-5-mini
OPENAI_TIMEOUT_MS=240000
MAX_CONTEXT_CHARS=60000
QUESTION_FILE_CONTEXT_CHARS=40000
MAX_UPLOAD_MB=20
DEFAULT_DAY_RATE=10000
ARI_PUBLIC_BASE_URL=http://localhost:3101
LEX_API_BASE_URL=http://localhost:3000
LEX_API_TOKEN=
MICROSOFT_TENANT_ID=common
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
MICROSOFT_REDIRECT_URI=http://localhost:3101/auth/callback
MICROSOFT_ALLOWED_EMAIL_DOMAIN=
SESSION_SECRET=replace-with-a-long-random-string
MONGODB_URI=
MONGODB_DB_NAME=analyst_bot
MONGODB_STORIES_COLLECTION=customer_user_stories
ORG_SLUG=devboxph
```

## Inputs

The intake form asks for:

- whether the request is a new tool or an extension
- customer name
- requester and business unit
- tool or project name
- existing repository/documentation reference for extensions
- business problem and desired outcome
- user groups
- requested features
- data, reports, and integrations
- constraints, risks, policies, or timeline
- optional supporting files

Supported uploads: PDF, DOCX, TXT, HTML, Markdown, CSV, and JSON.

When a file is uploaded, Ari treats it as primary source material. Ari reads the document before asking clarifying questions and should only ask about items that are missing, unclear, or materially change the analysis.

## Customer User Stories

Ari drafts business-readable user stories as part of every analysis. When `MONGODB_URI` is configured, each analysis saves those stories against the customer name provided at intake.

Saved story sets are written to `MONGODB_STORIES_COLLECTION` and can be retrieved with:

```text
GET /api/customers/:customerName/user-stories
```

Microsoft SSO follows the same environment pattern as contract-bot. Leave `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` blank for local unauthenticated development, or set them to require Microsoft sign-in.

Saved analysis records include `orgSlug`; the default is `devboxph` so the same MongoDB database can support future tenants cleanly.

## Instance Setup

Use `setup-analyst-bot-instance.sh` to provision an Ubuntu instance with Node.js 20, PM2, dependencies, and Ari running on port `3101`.

```bash
chmod +x setup-analyst-bot-instance.sh
./setup-analyst-bot-instance.sh
```

Unlike the contract-bot setup script, this does not configure a NAT redirect from port 80. Point your portal, security group, proxy, or ALB directly at port `3101`.

## Lex Handoff

After Ari completes an analysis, use **Send to Lex** to collect the contract-facing fields Lex needs:

- customer name
- project name
- supplier entity and signatory
- currency
- estimate basis
- monthly running cost
- reference contract
- user stories file
- notes for Lex

Ari asks for the day rate only at the final Lex handoff step, then computes the one-time total as:

```text
selected mandays * day rate
```

By default, Ari sends the max manday estimate to Lex for a conservative contract draft. Ari then polls Lex's background job and redirects to the generated contract using `?contractId=`.

Ari passes the process flow to Lex as **Appendix Process Flow** in the project brief.

When MongoDB storage is enabled, Ari also sends Lex an `ariUserStoriesUrl` field and includes the same link in the project brief. Lex can use that URL for a button or popup that opens Ari's saved story summary.

Set `LEX_API_BASE_URL=https://contracts.devboxph.com` when you want the handoff to target production instead of the sibling/local contract-bot.

When contract-bot authentication is enabled, set `LEX_API_TOKEN` in Ari to the same value as `INTEGRATION_API_TOKEN` in contract-bot.

## Estimation Notes

Mandays are estimated using common delivery activities for the MEAN/Ionic stack:

- discovery and requirements clarification
- UX/UI design
- Angular/Ionic frontend work
- Express/Node API work
- MongoDB data model and migration work
- integrations
- QA and regression testing
- UAT support
- deployment and release support
- project management and contingency

For extensions, the bot also accounts for repository/documentation review, existing architecture constraints, compatibility, and regression testing.
