# Devbox Analyst Bot

**Ari** turns plain-language business requests into a technical analysis and manday estimate for the Devbox MEAN/Ionic stack.

The primary experience is chat-led. Ari first asks whether the user wants to continue prior user stories created under their signed-in email or start something new, then asks what source material to use:

- **Start from scratch** - for applications or workflows built from a business idea.
- **Draft or supporting documents** - Ari reads the file before asking what remains unclear.
- **Approved contract** - Ari reads for metadata, billing milestones, obligations, and next-stage handoff without changing the signed contract.
- **Existing tool or repository** - Ari asks for repository/documentation context and estimates the extension work.

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

Ari asks one business-friendly question at a time and shows a confidence rating after each answer. The goal is a useful **80% confidence** view, not perfect certainty; users can generate the Ari summary once they are comfortable with the confidence level.

Ari is calibrated to Devbox sizing norms. As an anchor, a simple one-page static website with supplied copy/assets and no backend, forms, CMS, authentication, or integrations is about **1 manday**. Ari should scale upward only for concrete added complexity such as custom design rounds, multi-page content, CMS/admin editing, integrations, hosting/DNS/SSL work, analytics, broader QA, or approvals.

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
ANALYSIS_JOB_TTL_MS=1800000
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
SESSION_COOKIE_SECURE=false
MONGODB_URI=
MONGODB_DB_NAME=analyst_bot
MONGODB_STORIES_COLLECTION=customer_user_stories
ORG_SLUG=devboxph
S3_BUCKET=
S3_REGION=ap-southeast-1
S3_PREFIX=analyst-bot
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
ARI_S3_ENDPOINT=
ARI_S3_FORCE_PATH_STYLE=false
ARI_S3_SIGNED_URL_SECONDS=900
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

Supported uploads: PDF, DOCX, TXT, HTML, Markdown, CSV, JSON, PNG, JPG, and WEBP.

When a file is uploaded, Ari treats it as primary source material. Ari reads documents and inspects diagrams before asking clarifying questions, then should only ask about items that are missing, unclear, or materially change the analysis.

Long-running document reading, clarifying questions, and analysis run as background jobs. The browser starts the job and polls Ari until the result is ready, so large document analysis is less likely to fail because of a gateway request timeout.

## Customer User Stories

Ari drafts business-readable user stories as part of every analysis. When `MONGODB_URI` is configured, each analysis saves those stories against the customer name provided at intake.

Saved story sets are written to `MONGODB_STORIES_COLLECTION` and can be retrieved with:

```text
GET /api/customers/:customerName/user-stories
```

Microsoft SSO follows the same environment pattern as contract-bot. Leave `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` blank for local unauthenticated development, or set them to require Microsoft sign-in. If Ari is served over plain HTTP through the port 80 NAT redirect, keep `SESSION_COOKIE_SECURE=false`; if Ari is behind HTTPS, set it to `true`.

Saved analysis records include `orgSlug`; the default is `devboxph` so the same MongoDB database can support future tenants cleanly.

## Source Document Storage

When `S3_BUCKET` and `S3_REGION` are configured, Ari stores uploaded source documents in S3 before temporary local uploads are deleted. Ari also writes an HTML summary artifact to S3 for each generated summary. The MongoDB story record stores the S3 bucket/key, original filename, MIME type, size, uploader email, and timestamp so Ari can resume saved work with durable document references and a summary-file link.

You can reuse the same bucket and AWS credentials from contract-bot. Use a different prefix/sub-folder for Ari, for example:

```bash
S3_BUCKET=same-bucket-as-contract-bot
S3_REGION=ap-southeast-1
S3_PREFIX=analyst-bot
AWS_ACCESS_KEY_ID=same-access-key-as-contract-bot
AWS_SECRET_ACCESS_KEY=same-secret-as-contract-bot
```

Those are the same S3 details contract-bot uses. Ari just needs its own prefix so files land under a separate folder.

For AWS-hosted deployments, prefer an instance role or task role with `s3:PutObject` and `s3:GetObject` permission on the chosen prefix. `s3:GetObject` is used to create expiring summary-file links. For local development, set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. If using an S3-compatible service, set `ARI_S3_ENDPOINT` and `ARI_S3_FORCE_PATH_STYLE=true`.

Saved stories carry lifecycle status:

- `starting` with Ari's intake confidence before analysis
- `summary_generated` with the generated summary confidence
- `sent_to_lex` after Ari hands the package to Lex; Ari can show these again but should not change them

## Instance Setup

Use `setup-analyst-bot-instance.sh` to provision an Ubuntu instance with Node.js 20, PM2, dependencies, Ari running on port `3101`, and iptables NAT redirecting public port `80` to `3101`.

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
