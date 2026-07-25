# Technical Notes

Ari is a small Express application adapted from the `contract-bot` scaffold.

## Runtime

- Express serves the static UI and `/api/*` routes.
- Multer handles uploads into `uploads/`.
- PDF and DOCX files are extracted with `pdf-parse` and `mammoth`.
- OpenAI Responses API produces a strict JSON analysis.
- Microsoft SSO uses `@azure/msal-node` and the same environment variable pattern as contract-bot.
- MongoDB stores drafted user stories by customer when `MONGODB_URI` is configured.

## Main Endpoint

`POST /api/clarifying-questions`

Returns up to three business-friendly questions that would materially improve the manday estimate. The endpoint uses the same intake fields as analysis and returns:

- `question`
- `whyItMatters`

When the request appears workflow-based, Ari prioritizes one process-flow question.

`POST /api/analyses`

Form fields:

- `projectType`: `new-tool` or `extension`
- `customerName`
- `requesterName`
- `businessUnit`
- `toolName`
- `existingToolReference`
- `businessProblem`
- `desiredOutcome`
- `users`
- `keyFeatures`
- `dataAndIntegrations`
- `constraints`
- `timeline`
- `assumptions`
- `supportingFiles`: optional multi-file upload

For `extension`, `existingToolReference` is required.

## Output Schema

The server asks OpenAI for strict JSON with:

- project classification
- executive summary
- interpreted scope
- technical approach
- process flow
- drafted user stories
- MEAN/Ionic fit
- work packages with min/max mandays
- total min/max mandays
- confidence
- assumptions
- risks
- open questions
- recommendation

When MongoDB is configured, `/api/analyses` returns `savedStorySet` after persisting the generated stories.

## Customer Story Storage

`GET /api/customers/:customerName/user-stories`

Returns up to 20 recent story sets for the normalized customer name.

`POST /api/customer-user-stories`

Allows a caller to save a story set directly. Expected JSON fields:

- `customerName`
- `projectType`
- `toolName`
- `keyFeatures`
- `summary`
- `userStories`

If `MONGODB_URI` is missing, direct story storage returns a configuration error. Analysis still completes and reports that stories were not saved.

## Lex Handoff Endpoint

`POST /api/lex-handoffs`

This endpoint accepts Ari's analysis and intake JSON, computes the one-time total from the selected mandays and submitted day rate, then proxies a multipart request to Lex at `LEX_API_BASE_URL/api/engagements`. The day rate is used for computation only and is not included in the Lex project brief.

The Lex handoff includes Ari's visual process flow HTML under **Appendix Process Flow** so contract-bot can record it as a contract appendix.

When a saved story set exists, Ari sends `ariUserStoriesUrl` in the multipart handoff and includes the same URL in the project brief. Lex can show this as a button or popup source for Ari's generated summary page.

If `LEX_API_TOKEN` is set, Ari sends it to Lex as a bearer token so contract-bot can accept trusted server-to-server handoffs while keeping Office 365 auth for browser users.

`GET /api/lex-jobs/:jobId`

This endpoint proxies Lex job polling at `LEX_API_BASE_URL/api/review-jobs/:jobId`. When Lex returns a completed engagement, Ari returns a redirect URL in the form:

```text
{LEX_API_BASE_URL}/?contractId={contractId}
```

Default Lex URL:

```text
http://localhost:3000
```

Production Lex URL:

```text
https://contracts.devboxph.com
```
