require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const helmet = require('helmet');
const session = require('express-session');
const msal = require('@azure/msal-node');
const multer = require('multer');
const OpenAI = require('openai');
const { MongoClient } = require('mongodb');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const fs = require('fs/promises');
const path = require('path');

const app = express();
app.set('trust proxy', true);
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 240000);
const MAX_CONTEXT_CHARS = Number(process.env.MAX_CONTEXT_CHARS || 60000);
const QUESTION_FILE_CONTEXT_CHARS = Number(process.env.QUESTION_FILE_CONTEXT_CHARS || 40000);
const DEFAULT_DAY_RATE = Number(process.env.DEFAULT_DAY_RATE || 10000);
const ARI_PUBLIC_BASE_URL = normalizeBaseUrl(process.env.ARI_PUBLIC_BASE_URL || `http://localhost:${PORT}`);
const LEX_API_BASE_URL = normalizeBaseUrl(process.env.LEX_API_BASE_URL || 'http://localhost:3000');
const LEX_API_TOKEN = String(process.env.LEX_API_TOKEN || '').trim();
const MICROSOFT_TENANT_ID = process.env.MICROSOFT_TENANT_ID || 'common';
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID || '';
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET || '';
const MICROSOFT_REDIRECT_URI = process.env.MICROSOFT_REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;
const MICROSOFT_ALLOWED_EMAIL_DOMAIN = String(process.env.MICROSOFT_ALLOWED_EMAIL_DOMAIN || '').toLowerCase();
const AUTH_ENABLED = Boolean(MICROSOFT_CLIENT_ID && MICROSOFT_CLIENT_SECRET);
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_COOKIE_SECURE = parseBooleanEnv('SESSION_COOKIE_SECURE', process.env.NODE_ENV === 'production');
const MONGODB_URI = process.env.MONGODB_URI || '';
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'analyst_bot';
const MONGODB_STORIES_COLLECTION = process.env.MONGODB_STORIES_COLLECTION || process.env.MONGODB_COLLECTION || 'customer_user_stories';
const ORG_SLUG = normalizeOrgSlug(process.env.ORG_SLUG || 'devboxph');

let openai;
let msalClient;
let mongoClient;
let storiesIndexesReady = false;
const analysisJobs = new Map();
const clarificationJobs = new Map();
const ANALYSIS_JOB_TTL_MS = Number(process.env.ANALYSIS_JOB_TTL_MS || 30 * 60 * 1000);

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 20) * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const allowed = new Set([
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
      'text/html',
      'text/markdown',
      'text/csv',
      'application/csv',
      'application/json',
      'application/octet-stream'
    ]);
    if (!allowed.has(file.mimetype)) {
      return cb(Object.assign(new Error('Upload PDF, DOCX, TXT, HTML, MD, CSV, or JSON files.'), { status: 400 }));
    }
    cb(null, true);
  }
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(session({
  name: 'ari.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: SESSION_COOKIE_SECURE,
    maxAge: 8 * 60 * 60 * 1000
  }
}));
app.use(applyPortalUser);

app.get('/auth/status', (req, res) => {
  res.json({ success: true, authEnabled: AUTH_ENABLED, storage: storageStatus(), user: req.session.user || null });
});

app.get('/auth/signin', async (req, res, next) => {
  try {
    if (!AUTH_ENABLED) {
      res.redirect('/');
      return;
    }
    const state = randomId();
    req.session.authState = state;
    await saveSession(req);
    const authUrl = await getMsalClient().getAuthCodeUrl({
      scopes: ['openid', 'profile', 'email', 'User.Read'],
      redirectUri: microsoftRedirectUri(req),
      state,
      prompt: 'select_account'
    });
    res.redirect(authUrl);
  } catch (error) { next(error); }
});

app.get('/auth/callback', async (req, res, next) => {
  try {
    if (!AUTH_ENABLED) {
      res.redirect('/');
      return;
    }
    if (!req.query.code || req.query.state !== req.session.authState) {
      throw Object.assign(new Error('Microsoft sign-in state did not match. Please try signing in again.'), { status: 401 });
    }
    const result = await getMsalClient().acquireTokenByCode({
      code: req.query.code,
      scopes: ['openid', 'profile', 'email', 'User.Read'],
      redirectUri: microsoftRedirectUri(req)
    });
    const claims = result.idTokenClaims || {};
    const email = String(claims.preferred_username || claims.email || result.account?.username || '').toLowerCase();
    if (MICROSOFT_ALLOWED_EMAIL_DOMAIN && !email.endsWith(`@${MICROSOFT_ALLOWED_EMAIL_DOMAIN}`)) {
      throw Object.assign(new Error(`Use an account under ${MICROSOFT_ALLOWED_EMAIL_DOMAIN}.`), { status: 403 });
    }
    req.session.authState = null;
    req.session.user = {
      name: claims.name || result.account?.name || email,
      email,
      tenantId: claims.tid || result.account?.tenantId || '',
      homeAccountId: result.account?.homeAccountId || ''
    };
    const returnTo = safeReturnTo(req.session.returnTo);
    req.session.returnTo = null;
    await saveSession(req);
    res.redirect(returnTo || '/');
  } catch (error) { next(error); }
});

app.post('/auth/signout', (req, res) => {
  const logoutUrl = `https://login.microsoftonline.com/${encodeURIComponent(MICROSOFT_TENANT_ID)}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(publicBaseUrl(req))}`;
  req.session.destroy(() => {
    res.clearCookie('ari.sid');
    res.json({ success: true, logoutUrl: AUTH_ENABLED ? logoutUrl : '/' });
  });
});

app.get('/api/me', (req, res) => {
  res.json({ success: true, authEnabled: AUTH_ENABLED, storage: storageStatus(), user: req.session.user || null });
});

app.use(requireAuth);
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    openaiConfigured: hasUsableOpenAIKey(),
    model: DEFAULT_MODEL,
    botName: 'Ari',
    lexApiBaseUrl: LEX_API_BASE_URL,
    lexIntegrationConfigured: Boolean(LEX_API_TOKEN),
    authEnabled: AUTH_ENABLED,
    storage: storageStatus()
  });
});

app.post('/api/analyses', upload.array('supportingFiles', 8), async (req, res, next) => {
  try {
    const payload = normalizeRequest(req.body);
    ensureSupportingFileForDocumentLedPath(payload, req.files || []);
    const files = await extractUploadedFiles(req.files || []);
    const analysis = await createTechnicalAnalysis(payload, files);
    const savedStorySet = await saveCustomerUserStories(payload, analysis, req.session.user);
    res.json({ success: true, analysis, savedStorySet });
  } catch (error) {
    next(error);
  } finally {
    await cleanupFiles(req.files || []);
  }
});

app.post('/api/analysis-jobs', upload.array('supportingFiles', 8), async (req, res, next) => {
  try {
    const payload = normalizeRequest(req.body);
    ensureSupportingFileForDocumentLedPath(payload, req.files || []);
    const files = await extractUploadedFiles(req.files || []);
    const job = createAnalysisJob(payload, files, req.session.user);
    res.status(202).json({ success: true, job: clientAnalysisJob(job) });
  } catch (error) {
    next(error);
  } finally {
    await cleanupFiles(req.files || []);
  }
});

app.get('/api/analysis-jobs/:jobId', (req, res, next) => {
  try {
    pruneAnalysisJobs();
    const job = analysisJobs.get(req.params.jobId);
    if (!job) throw Object.assign(new Error('Ari analysis job was not found. Please start the analysis again.'), { status: 404 });
    res.json({ success: true, job: clientAnalysisJob(job) });
  } catch (error) { next(error); }
});

app.get('/api/customers/:customerName/user-stories', async (req, res, next) => {
  try {
    const customerName = clean(req.params.customerName);
    if (!customerName) throw Object.assign(new Error('Customer name is required.'), { status: 400 });
    const collection = await getStoriesCollection();
    const stories = await collection
      .find({ orgSlug: ORG_SLUG, customerKey: normalizeKey(customerName) })
      .sort({ createdAt: -1 })
      .limit(20)
      .toArray();
    res.json({ success: true, stories: stories.map(clientStorySet) });
  } catch (error) { next(error); }
});

app.post('/api/customer-user-stories', async (req, res, next) => {
  try {
    const customerName = clean(req.body.customerName);
    if (!customerName) throw Object.assign(new Error('Customer name is required.'), { status: 400 });
    const record = await saveCustomerUserStories({
      customerName,
      projectType: clean(req.body.projectType || 'new-tool'),
      toolName: clean(req.body.toolName),
      keyFeatures: clean(req.body.keyFeatures)
    }, {
      executiveSummary: clean(req.body.summary),
      draftedUserStories: Array.isArray(req.body.userStories) ? req.body.userStories : []
    }, req.session.user);
    res.status(201).json({ success: true, storySet: record });
  } catch (error) { next(error); }
});

app.get('/api/customer-user-stories/:storySetId', async (req, res, next) => {
  try {
    const storySet = await getStorySetById(req.params.storySetId);
    res.json({ success: true, storySet });
  } catch (error) { next(error); }
});

app.get('/user-stories/:storySetId', async (req, res, next) => {
  try {
    const storySet = await getStorySetById(req.params.storySetId);
    res.type('html').send(renderStorySetPage(storySet));
  } catch (error) { next(error); }
});

app.post('/api/clarifying-questions', upload.array('supportingFiles', 8), async (req, res, next) => {
  try {
    const payload = normalizeRequest(req.body);
    ensureSupportingFileForDocumentLedPath(payload, req.files || []);
    const files = await extractUploadedFiles(req.files || []);
    const questions = await createClarifyingQuestions(payload, files);
    res.json({ success: true, questions });
  } catch (error) {
    next(error);
  } finally {
    await cleanupFiles(req.files || []);
  }
});

app.post('/api/clarifying-question-jobs', upload.array('supportingFiles', 8), async (req, res, next) => {
  try {
    const payload = normalizeRequest(req.body);
    ensureSupportingFileForDocumentLedPath(payload, req.files || []);
    const files = await extractUploadedFiles(req.files || []);
    const job = createClarificationJob(payload, files);
    res.status(202).json({ success: true, job: clientClarificationJob(job) });
  } catch (error) {
    next(error);
  } finally {
    await cleanupFiles(req.files || []);
  }
});

app.get('/api/clarifying-question-jobs/:jobId', (req, res, next) => {
  try {
    pruneClarificationJobs();
    const job = clarificationJobs.get(req.params.jobId);
    if (!job) throw Object.assign(new Error('Ari question job was not found. Please start again.'), { status: 404 });
    res.json({ success: true, job: clientClarificationJob(job) });
  } catch (error) { next(error); }
});

app.post('/api/lex-handoffs', upload.fields([
  { name: 'referenceContract', maxCount: 1 },
  { name: 'userStoriesFile', maxCount: 1 },
  { name: 'draftContract', maxCount: 1 },
  { name: 'completedContract', maxCount: 1 }
]), async (req, res, next) => {
  try {
    const handoff = normalizeLexHandoff(req.body);
    const lexPayload = await buildLexPayload(handoff, req.files || {});
    const lexResponse = await fetch(`${LEX_API_BASE_URL}/api/engagements`, {
      method: 'POST',
      body: lexPayload,
      headers: lexAuthHeaders(req)
    });
    const contentType = lexResponse.headers.get('content-type') || '';
    const payload = contentType.includes('application/json')
      ? await lexResponse.json()
      : { message: await lexResponse.text() };

    if (!lexResponse.ok) {
      throw Object.assign(new Error(payload.message || `Lex returned ${lexResponse.status}.`), { status: lexResponse.status });
    }

    res.status(lexResponse.status).json({ success: true, lex: payload, lexApiBaseUrl: LEX_API_BASE_URL });
  } catch (error) {
    next(error);
  } finally {
    const files = Object.values(req.files || {}).flat();
    await cleanupFiles(files);
  }
});

app.get('/api/lex-jobs/:jobId', async (req, res, next) => {
  try {
    const lexResponse = await fetch(`${LEX_API_BASE_URL}/api/review-jobs/${encodeURIComponent(req.params.jobId)}`, {
      headers: lexAuthHeaders(req)
    });
    const contentType = lexResponse.headers.get('content-type') || '';
    const payload = contentType.includes('application/json')
      ? await lexResponse.json()
      : { message: await lexResponse.text() };

    if (!lexResponse.ok) {
      throw Object.assign(new Error(payload.message || `Lex returned ${lexResponse.status}.`), { status: lexResponse.status });
    }

    res.json({
      success: true,
      lex: payload,
      redirectUrl: payload.engagement?.contractId ? `${LEX_API_BASE_URL}/?contractId=${encodeURIComponent(payload.engagement.contractId)}` : ''
    });
  } catch (error) {
    next(error);
  }
});

function normalizeRequest(body) {
  const contractPath = normalizeLexDraftingMode(body.contractPath);
  const projectType = String(body.projectType || '').trim();
  if (!['new-tool', 'extension'].includes(projectType)) {
    throw Object.assign(new Error('Choose whether this is a new tool or an extension of an existing tool.'), { status: 400 });
  }

  const request = {
    contractPath,
    projectType,
    customerName: clean(body.customerName),
    requesterName: clean(body.requesterName),
    businessUnit: clean(body.businessUnit),
    toolName: clean(body.toolName),
    existingToolReference: clean(body.existingToolReference),
    businessProblem: clean(body.businessProblem),
    desiredOutcome: clean(body.desiredOutcome),
    users: clean(body.users),
    keyFeatures: clean(body.keyFeatures),
    dataAndIntegrations: clean(body.dataAndIntegrations),
    constraints: clean(body.constraints),
    timeline: clean(body.timeline),
    assumptions: clean(body.assumptions),
    clarificationAnswers: normalizeClarificationAnswers(body.clarificationAnswers)
  };

  if (!request.customerName) throw Object.assign(new Error('Add the customer name.'), { status: 400 });
  if (!request.toolName && contractPath === 'details') throw Object.assign(new Error('Add a tool or project name.'), { status: 400 });
  if (contractPath === 'details' && !request.businessProblem && !request.desiredOutcome && !request.keyFeatures) {
    throw Object.assign(new Error('Add at least the business problem, desired outcome, or requested features.'), { status: 400 });
  }
  if (contractPath === 'details' && request.projectType === 'extension' && !request.existingToolReference) {
    throw Object.assign(new Error('For extensions, add the existing repository link, documentation link, or a short description of the current tool.'), { status: 400 });
  }

  return request;
}

function ensureSupportingFileForDocumentLedPath(request, files) {
  if (!['refine', 'approved-upload'].includes(request.contractPath)) return;
  if (!files.length) {
    const label = request.contractPath === 'approved-upload' ? 'approved contract file' : 'draft or supporting file';
    throw Object.assign(new Error(`Upload the ${label} before asking Ari to continue.`), { status: 400 });
  }
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeClarificationAnswers(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 3).map(item => ({
      question: clean(item.question),
      answer: clean(item.answer),
      unknown: Boolean(item.unknown)
    })).filter(item => item.question);
  } catch {
    return [];
  }
}

function normalizeLexHandoff(body) {
  const analysis = parseJsonField(body.analysis, 'analysis');
  const intake = parseJsonField(body.intake, 'intake');
  const savedStorySet = body.savedStorySet ? parseJsonField(body.savedStorySet, 'savedStorySet') : null;
  const draftingMode = normalizeLexDraftingMode(body.draftingMode);
  const requiresCommercials = draftingMode !== 'approved-upload';
  const dayRate = requiresCommercials ? positiveNumber(body.dayRate || DEFAULT_DAY_RATE, 'day rate') : 0;
  const monthlyRunningCost = nonNegativeNumber(body.monthlyRunningCost, 'monthly running cost');
  const estimateBasis = ['min', 'mid', 'max'].includes(body.estimateBasis) ? body.estimateBasis : 'max';
  const selectedDays = requiresCommercials ? selectMandays(analysis, estimateBasis) : 0;
  const oneTimeTotal = requiresCommercials ? Math.round(selectedDays * dayRate) : 0;

  const handoff = {
    draftingMode,
    analysis,
    intake,
    customerName: clean(body.customerName),
    projectName: clean(body.projectName || intake.toolName),
    supplierEntity: clean(body.supplierEntity || 'Devbox Solutions Inc.'),
    signatoryName: clean(body.signatoryName || 'Romeo Patawaran Jr.'),
    signatoryTitle: clean(body.signatoryTitle || 'Client Manager'),
    currency: clean(body.currency || 'PHP'),
    vatExclusive: body.vatExclusive !== 'false',
    isFinalVersion: body.isFinalVersion === 'true',
    dayRate,
    estimateBasis,
    selectedDays,
    oneTimeTotal,
    monthlyRunningCost,
    savedStorySet,
    ariUserStoriesUrl: clean(body.ariUserStoriesUrl || savedStorySet?.userStoriesUrl),
    notesForLex: clean(body.notesForLex),
    refinementNotes: clean(body.refinementNotes),
    approvedImportNotes: clean(body.approvedImportNotes)
  };

  if (!handoff.customerName) throw Object.assign(new Error('Add the customer name before sending to Lex.'), { status: 400 });
  if (!handoff.projectName && handoff.draftingMode !== 'approved-upload') throw Object.assign(new Error('Add the project name before sending to Lex.'), { status: 400 });
  return handoff;
}

function normalizeLexDraftingMode(value) {
  if (value === 'refine') return 'refine';
  if (value === 'approved-upload') return 'approved-upload';
  return 'details';
}

function parseJsonField(value, label) {
  try {
    const parsed = JSON.parse(String(value || ''));
    if (!parsed || typeof parsed !== 'object') throw new Error('empty');
    return parsed;
  } catch {
    throw Object.assign(new Error(`The ${label} payload is missing or invalid.`), { status: 400 });
  }
}

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw Object.assign(new Error(`Enter a valid ${label}.`), { status: 400 });
  }
  return number;
}

function nonNegativeNumber(value, label) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number < 0) {
    throw Object.assign(new Error(`Enter a valid ${label}.`), { status: 400 });
  }
  return number;
}

function selectMandays(analysis, basis) {
  const min = Number(analysis.totalMinDays);
  const max = Number(analysis.totalMaxDays);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0) {
    throw Object.assign(new Error('Ari needs a valid manday estimate before sending to Lex.'), { status: 400 });
  }
  if (basis === 'min') return min;
  if (basis === 'mid') return Math.round(((min + max) / 2) * 10) / 10;
  return max;
}

async function buildLexPayload(handoff, files) {
  const form = new FormData();
  form.set('draftingMode', handoff.draftingMode);
  form.set('customerName', handoff.customerName);
  form.set('projectName', handoff.projectName);
  form.set('supplierEntity', handoff.supplierEntity);
  form.set('signatoryName', handoff.signatoryName);
  form.set('signatoryTitle', handoff.signatoryTitle);
  form.set('currency', handoff.currency);
  form.set('oneTimeTotal', String(handoff.oneTimeTotal));
  form.set('monthlyRunningCost', String(handoff.monthlyRunningCost));
  form.set('vatExclusive', String(handoff.vatExclusive));
  form.set('isFinalVersion', String(handoff.isFinalVersion));
  if (handoff.ariUserStoriesUrl) form.set('ariUserStoriesUrl', handoff.ariUserStoriesUrl);
  form.set('ariHandoffJson', JSON.stringify(buildStructuredLexHandoff(handoff)));
  if (handoff.draftingMode === 'details') {
    form.set('projectBrief', buildLexProjectBrief(handoff));
    form.set('userStories', buildLexUserStories(handoff));
  }
  if (handoff.draftingMode === 'refine') {
    form.set('refinementNotes', buildRefinementNotes(handoff));
  }
  if (handoff.draftingMode === 'approved-upload') {
    form.set('approvedImportNotes', buildApprovedImportNotes(handoff));
  }

  if (handoff.draftingMode === 'details') {
    await appendUploadedFile(form, 'referenceContract', files.referenceContract?.[0]);
    await appendUploadedFile(form, 'userStoriesFile', files.userStoriesFile?.[0]);
  }
  await appendUploadedFile(form, 'draftContract', files.draftContract?.[0]);
  await appendUploadedFile(form, 'completedContract', files.completedContract?.[0]);
  return form;
}

function buildRefinementNotes(handoff) {
  return [
    handoff.refinementNotes || '',
    handoff.notesForLex ? `Additional Lex notes: ${handoff.notesForLex}` : '',
    'Refine the uploaded draft using the context contained in that draft. Preserve commercial terms and only use Ari metadata to label and track the record.'
  ].filter(Boolean).join('\n\n');
}

function buildApprovedImportNotes(handoff) {
  return [
    handoff.approvedImportNotes || '',
    handoff.notesForLex ? `Additional internal notes: ${handoff.notesForLex}` : '',
    'Approved/offline contract sent through Ari. Lex should parse and track the approved source, not rewrite it.'
  ].filter(Boolean).join('\n\n');
}

function buildStructuredLexHandoff(handoff) {
  if (handoff.draftingMode === 'approved-upload') {
    return basicLexHandoff(handoff);
  }
  if (handoff.draftingMode === 'refine') {
    return {
      ...basicLexHandoff(handoff),
      refinementNotes: handoff.refinementNotes || '',
      instruction: 'Refine from the uploaded draft document. Do not require Ari user stories or detailed requirements.'
    };
  }
  return {
    source: 'ari-analyst-bot',
    handoffMode: handoff.draftingMode,
    generatedAt: new Date().toISOString(),
    customerName: handoff.customerName || handoff.intake.customerName || '',
    projectName: handoff.projectName || handoff.intake.toolName || '',
    requestType: handoff.intake.projectType === 'extension' ? 'Extension of an existing tool' : 'New tool',
    requester: {
      name: handoff.intake.requesterName || '',
      businessUnit: handoff.intake.businessUnit || ''
    },
    businessContext: {
      problem: handoff.intake.businessProblem || '',
      desiredOutcome: handoff.intake.desiredOutcome || '',
      usersAndRoles: handoff.intake.users || '',
      existingToolReference: handoff.intake.existingToolReference || ''
    },
    scopeSummary: handoff.analysis.executiveSummary || '',
    interpretedScope: asPlainArray(handoff.analysis.interpretedScope),
    userStories: normalizeUserStories(handoff.analysis.draftedUserStories),
    acceptanceCriteria: normalizeUserStories(handoff.analysis.draftedUserStories)
      .flatMap(story => story.acceptanceCriteria || []),
    processFlow: normalizeProcessFlowForLex(handoff.analysis.processFlow),
    technicalRequirements: [
      ...asPlainArray(handoff.analysis.technicalApproach),
      `Frontend: ${handoff.analysis.meanIonicFit?.frontend || 'Not provided'}`,
      `Backend: ${handoff.analysis.meanIonicFit?.backend || 'Not provided'}`,
      `Database: ${handoff.analysis.meanIonicFit?.database || 'Not provided'}`,
      `Mobile: ${handoff.analysis.meanIonicFit?.mobile || 'Not provided'}`
    ],
    dataAndIntegrations: handoff.intake.dataAndIntegrations || '',
    serviceOperations: asPlainArray(handoff.analysis.serviceOperations),
    timeline: handoff.intake.timeline || '',
    assumptions: asPlainArray(handoff.analysis.assumptions),
    risks: asPlainArray(handoff.analysis.risks),
    openQuestions: asPlainArray(handoff.analysis.openQuestions),
    commercialBasis: {
      currency: handoff.currency,
      selectedMandays: handoff.selectedDays,
      estimateBasis: handoff.estimateBasis,
      oneTimeTotal: handoff.oneTimeTotal,
      monthlyRunningCost: handoff.monthlyRunningCost,
      vatExclusive: handoff.vatExclusive
    },
    billingNotes: [
      `Computed one-time total: ${handoff.currency} ${handoff.oneTimeTotal}`,
      `Monthly running cost: ${handoff.currency} ${handoff.monthlyRunningCost}`,
      handoff.refinementNotes ? `Refinement notes: ${handoff.refinementNotes}` : '',
      handoff.approvedImportNotes ? `Approved import notes: ${handoff.approvedImportNotes}` : '',
      handoff.notesForLex || ''
    ].filter(Boolean),
    ariUserStoriesUrl: handoff.ariUserStoriesUrl || ''
  };
}

function basicLexHandoff(handoff) {
  return {
    source: 'ari-analyst-bot',
    handoffMode: handoff.draftingMode,
    generatedAt: new Date().toISOString(),
    customerName: handoff.customerName || handoff.intake.customerName || '',
    projectName: handoff.projectName || handoff.intake.toolName || '',
    requestType: handoff.intake.projectType === 'extension' ? 'Extension of an existing tool' : 'New tool',
    requester: {
      name: handoff.intake.requesterName || '',
      businessUnit: handoff.intake.businessUnit || ''
    },
    notesForLex: handoff.notesForLex || '',
    approvedImportNotes: handoff.approvedImportNotes || '',
    currency: handoff.currency,
    ariUserStoriesUrl: ''
  };
}

function normalizeProcessFlowForLex(processFlow) {
  return {
    title: processFlow?.title || 'Process Flow',
    description: processFlow?.summary || '',
    steps: Array.isArray(processFlow?.steps)
      ? processFlow.steps.map((step, index) => ({
          label: clean(step.label || `Step ${index + 1}`),
          actor: clean(step.actor || 'Owner TBD'),
          description: clean(step.description)
        })).filter(step => step.label || step.description)
      : []
  };
}

function asPlainArray(value) {
  return Array.isArray(value) ? value.map(item => clean(item)).filter(Boolean) : [];
}

async function appendUploadedFile(form, field, file) {
  if (!file) return;
  const buffer = await fs.readFile(file.path);
  form.append(field, new Blob([buffer], { type: file.mimetype || 'application/octet-stream' }), file.originalname);
}

function buildLexProjectBrief(handoff) {
  return [
    `Prepared by Ari, Devbox's analyst bot, for Lex contract drafting.`,
    '',
    `Request type: ${handoff.intake.projectType === 'extension' ? 'Extension of an existing tool' : 'New tool'}`,
    `Customer: ${handoff.customerName || handoff.intake.customerName || 'Not provided'}`,
    `Existing tool reference: ${handoff.intake.existingToolReference || 'Not provided'}`,
    `Requester: ${handoff.intake.requesterName || 'Not provided'}`,
    `Business unit: ${handoff.intake.businessUnit || 'Not provided'}`,
    '',
    `Business problem: ${handoff.intake.businessProblem || 'Not provided'}`,
    `Desired outcome: ${handoff.intake.desiredOutcome || 'Not provided'}`,
    `Users / roles: ${handoff.intake.users || 'Not provided'}`,
    `Data, reports, and integrations: ${handoff.intake.dataAndIntegrations || 'Not provided'}`,
    `Constraints: ${handoff.intake.constraints || 'Not provided'}`,
    `Target timeline: ${handoff.intake.timeline || 'Not provided'}`,
    '',
    `Ari technical summary: ${handoff.analysis.executiveSummary}`,
    handoff.ariUserStoriesUrl ? `Ari user story summary link: ${handoff.ariUserStoriesUrl}` : 'Ari user story summary link: Not available',
    handoff.ariUserStoriesUrl ? 'Lex: show this link as a button so users can open Ari\'s generated story summary.' : '',
    '',
    'Technical approach:',
    ...asList(handoff.analysis.technicalApproach),
    '',
    'MEAN/Ionic fit:',
    `- Frontend: ${handoff.analysis.meanIonicFit?.frontend || 'Not provided'}`,
    `- Backend: ${handoff.analysis.meanIonicFit?.backend || 'Not provided'}`,
    `- Database: ${handoff.analysis.meanIonicFit?.database || 'Not provided'}`,
    `- Mobile: ${handoff.analysis.meanIonicFit?.mobile || 'Not provided'}`,
    '',
    'Manday and commercial basis:',
    `- Ari estimate: ${handoff.analysis.totalMinDays}-${handoff.analysis.totalMaxDays} mandays (${handoff.analysis.confidence} confidence)`,
    `- Selected basis: ${handoff.estimateBasis} estimate (${handoff.selectedDays} mandays)`,
    `- Computed one-time total: ${handoff.currency} ${handoff.oneTimeTotal}`,
    `- Monthly running cost: ${handoff.currency} ${handoff.monthlyRunningCost}`,
    '',
    'Assumptions:',
    ...asList(handoff.analysis.assumptions),
    '',
    'Risks:',
    ...asList(handoff.analysis.risks),
    '',
    'Open questions:',
    ...asList(handoff.analysis.openQuestions),
    '',
    'APPENDIX PROCESS FLOW:',
    'Lex: include this as Appendix Process Flow in the generated contract when a workflow is relevant.',
    buildProcessFlowAppendix(handoff.analysis.processFlow),
    '',
    `Recommendation: ${handoff.analysis.recommendation || 'Not provided'}`,
    '',
    `Additional notes for Lex: ${handoff.notesForLex || 'None'}`
  ].join('\n');
}

function buildProcessFlowAppendix(processFlow) {
  if (!processFlow?.steps?.length) {
    return `No visual process flow identified. ${processFlow?.summary || ''}`.trim();
  }
  const steps = processFlow.steps.map((step, index) => `
    <div class="process-step">
      <strong>${escapeText(index + 1)}. ${escapeText(step.label)}</strong>
      <span>${escapeText(step.actor || 'Owner TBD')}</span>
      <p>${escapeText(step.description)}</p>
    </div>`).join('\n    <div class="process-arrow">→</div>\n');
  return `<section class="appendix-process-flow">
  <h2>${escapeText(processFlow.title || 'Appendix Process Flow')}</h2>
  <p>${escapeText(processFlow.summary || 'Business process flow prepared by Ari.')}</p>
  <div class="process-flow">
    ${steps}
  </div>
</section>`;
}

function escapeText(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function buildLexUserStories(handoff) {
  return [
    'Ari interpreted these business needs for Lex. Convert them into contract scope, milestones, assumptions, and acceptance criteria.',
    '',
    'Requested features from business user:',
    handoff.intake.keyFeatures || 'No feature notes provided.',
    '',
    'Interpreted scope:',
    ...asList(handoff.analysis.interpretedScope),
    '',
    'Drafted user stories:',
    ...formatUserStoriesForText(handoff.analysis.draftedUserStories),
    '',
    handoff.ariUserStoriesUrl ? `View Ari story summary: ${handoff.ariUserStoriesUrl}` : 'View Ari story summary: Not available',
    '',
    'Work package estimate:',
    ...(handoff.analysis.workPackages || []).map(pkg => `- ${pkg.name}: ${pkg.minDays}-${pkg.maxDays} mandays. ${pkg.description}`)
  ].join('\n');
}

function asList(value) {
  return Array.isArray(value) && value.length ? value.map(item => `- ${item}`) : ['- None provided.'];
}

async function extractUploadedFiles(files) {
  const extracted = [];
  for (const file of files) {
    const text = await extractText(file);
    extracted.push({
      originalName: file.originalname,
      mimeType: file.mimetype,
      text: text.slice(0, MAX_CONTEXT_CHARS)
    });
  }
  return extracted;
}

async function extractText(file) {
  const buffer = await fs.readFile(file.path);
  if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
    const parsed = await pdfParse(buffer);
    return parsed.text || '';
  }
  if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || file.originalname.toLowerCase().endsWith('.docx')) {
    const parsed = await mammoth.extractRawText({ buffer });
    return parsed.value || '';
  }
  return buffer.toString('utf8');
}

async function cleanupFiles(files) {
  await Promise.all(files.map(file => fs.unlink(file.path).catch(() => {})));
}

async function createTechnicalAnalysis(request, files) {
  if (!hasUsableOpenAIKey()) {
    throw Object.assign(new Error('OPENAI_API_KEY is not configured. Add it to .env before running an analysis.'), { status: 500 });
  }

  const prompt = buildPrompt(request, files);
  const response = await getOpenAI().responses.create({
    model: DEFAULT_MODEL,
    input: [
      {
        role: 'system',
        content: [
          'You are Devbox Analyst, a senior business analyst and technical solution architect.',
          'The delivery stack is MEAN and Ionic: MongoDB, Express, Angular, Node.js, and Ionic mobile/web where relevant.',
          'When files are uploaded, treat them as primary source material. Read them meticulously and extract concrete facts before interpreting, estimating, or summarizing.',
          'Users may write in non-technical business language. Translate intent into clear technical scope without shaming or overcomplicating.',
          'Estimate in mandays using realistic delivery activities: discovery, UX/UI, Angular/Ionic frontend, Express/Node API, MongoDB/data model, integrations, QA, UAT support, deployment, project management, and contingency.',
          'For extensions, account for repository/documentation review, existing architecture constraints, regression testing, migration, and backwards compatibility.',
          'Return only valid JSON matching the requested schema. Do not wrap it in markdown.'
        ].join(' ')
      },
      { role: 'user', content: prompt }
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'technical_analysis',
        strict: true,
        schema: analysisSchema()
      }
    }
  }, { timeout: OPENAI_TIMEOUT_MS });

  return JSON.parse(response.output_text);
}

function createAnalysisJob(request, files, user) {
  pruneAnalysisJobs();
  const job = {
    id: randomId(),
    status: 'RUNNING',
    message: 'Ari is reading the document and preparing the analysis.',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    analysis: null,
    savedStorySet: null
  };
  analysisJobs.set(job.id, job);
  runAnalysisJob(job, request, files, user);
  return job;
}

async function runAnalysisJob(job, request, files, user) {
  try {
    const analysis = await createTechnicalAnalysis(request, files);
    const savedStorySet = await saveCustomerUserStories(request, analysis, user);
    Object.assign(job, {
      status: 'COMPLETE',
      message: 'Analysis ready.',
      analysis,
      savedStorySet,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    const normalized = normalizeServerError(error);
    Object.assign(job, {
      status: 'FAILED',
      message: normalized.message,
      updatedAt: new Date().toISOString()
    });
  }
}

function clientAnalysisJob(job) {
  return {
    id: job.id,
    status: job.status,
    message: job.message,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    analysis: job.status === 'COMPLETE' ? job.analysis : null,
    savedStorySet: job.status === 'COMPLETE' ? job.savedStorySet : null
  };
}

function pruneAnalysisJobs() {
  const cutoff = Date.now() - ANALYSIS_JOB_TTL_MS;
  for (const [id, job] of analysisJobs.entries()) {
    if (new Date(job.updatedAt || job.createdAt).getTime() < cutoff) {
      analysisJobs.delete(id);
    }
  }
}

async function createClarifyingQuestions(request, files) {
  if (!hasUsableOpenAIKey()) {
    throw Object.assign(new Error('OPENAI_API_KEY is not configured. Add it to .env before asking Ari for clarifying questions.'), { status: 500 });
  }

  const response = await getOpenAI().responses.create({
    model: DEFAULT_MODEL,
    input: [
      {
        role: 'system',
        content: [
          'You are Ari, Devbox\'s analyst bot.',
          'Ask only the few questions that would materially sharpen Ari\'s analysis of the request or uploaded document.',
          'When files are uploaded, read the document content carefully before asking. Avoid questions that are already answered or reasonably inferable from the file.',
          'When an uploaded document has unclear workflow, billing, delivery obligations, milestones, handoffs, statuses, forms, dashboards, operations, or multiple user roles, prioritize one simple question about that gap.',
          'The audience is business users. Use simple language, avoid jargon, and make it okay if they do not know.',
          'Return at most 3 questions. Do not ask questions already clearly answered by the intake.'
        ].join(' ')
      },
      { role: 'user', content: buildClarifyingQuestionPrompt(request, files) }
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'clarifying_questions',
        strict: true,
        schema: clarifyingQuestionsSchema()
      }
    }
  }, { timeout: OPENAI_TIMEOUT_MS });

  const parsed = JSON.parse(response.output_text);
  return (parsed.questions || []).slice(0, 3);
}

function createClarificationJob(request, files) {
  pruneClarificationJobs();
  const job = {
    id: randomId(),
    status: 'RUNNING',
    message: 'Ari is reading the document before deciding what to ask.',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    questions: []
  };
  clarificationJobs.set(job.id, job);
  runClarificationJob(job, request, files);
  return job;
}

async function runClarificationJob(job, request, files) {
  try {
    const questions = await createClarifyingQuestions(request, files);
    Object.assign(job, {
      status: 'COMPLETE',
      message: questions.length ? 'Ari has a few questions.' : 'Ari has enough detail.',
      questions,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    const normalized = normalizeServerError(error);
    Object.assign(job, {
      status: 'FAILED',
      message: normalized.message,
      updatedAt: new Date().toISOString()
    });
  }
}

function clientClarificationJob(job) {
  return {
    id: job.id,
    status: job.status,
    message: job.message,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    questions: job.status === 'COMPLETE' ? job.questions : []
  };
}

function pruneClarificationJobs() {
  const cutoff = Date.now() - ANALYSIS_JOB_TTL_MS;
  for (const [id, job] of clarificationJobs.entries()) {
    if (new Date(job.updatedAt || job.createdAt).getTime() < cutoff) {
      clarificationJobs.delete(id);
    }
  }
}

function buildClarifyingQuestionPrompt(request, files) {
  const fileNames = files.length ? files.map(file => file.originalName).join(', ') : 'No files uploaded';
  const fileContext = files.length
    ? files.map(file => `FILE: ${file.originalName}\nCONTENT:\n${file.text.slice(0, QUESTION_FILE_CONTEXT_CHARS) || '(No readable text extracted.)'}`).join('\n\n---\n\n')
    : '(No files uploaded.)';
  return `Create a short list of clarifying questions before Ari analyzes this request.

CONTRACT PATH: ${request.contractPath === 'refine' ? 'Refine uploaded draft' : request.contractPath === 'approved-upload' ? 'Record approved contract' : 'Generate contract'}
REQUEST TYPE: ${request.projectType === 'extension' ? 'Extension of an existing tool' : 'New tool'}
CUSTOMER: ${request.customerName}
TOOL / PROJECT NAME: ${request.toolName}
EXISTING TOOL REFERENCE: ${request.existingToolReference || 'Not provided'}
BUSINESS PROBLEM: ${request.businessProblem || 'Not provided'}
DESIRED OUTCOME: ${request.desiredOutcome || 'Not provided'}
USERS / ROLES: ${request.users || 'Not provided'}
KEY FEATURES: ${request.keyFeatures || 'Not provided'}
DATA, REPORTS, AND INTEGRATIONS: ${request.dataAndIntegrations || 'Not provided'}
CONSTRAINTS: ${request.constraints || 'Not provided'}
TARGET TIMELINE: ${request.timeline || 'Not provided'}
ASSUMPTIONS: ${request.assumptions || 'Not provided'}
FILES: ${fileNames}
FILE CONTENT:
${fileContext}

Rules:
- Ask 0 to 3 questions only.
- If a file is uploaded, read it meticulously first. The user has already done work in that document and will be frustrated by shallow or duplicate questions.
- Ask a question only when the missing answer would materially change Ari's analysis, estimate, billing metadata, operational handoff, or risk assessment.
- For uploaded drafts or approved contracts, base questions on the file content. Do not ask the user to re-enter business problem, desired outcome, user stories, feature lists, data needs, or other details already visible in the file.
- For "Refine uploaded draft", ask about document substance only when unclear: intended scope changes, missing appendices, unclear commercials, acceptance milestones, obligations, exclusions, dependencies, implementation flow, or support handoff. Do not ask about how to get the file to Lex.
- For "Record approved contract", the contract must not be changed. Ari still needs a full analytical summary of the contract context. Ask only if the document is unclear about metadata needed for next stages: invoicing, billing milestones, renewal reminders, finance handoff, contract owner, customer/project labeling, operational handoff, or internal tracking.
- If the request or document appears to involve a process flow, operational workflow, implementation handoff, status tracking, or multiple roles and the flow is unclear, include one simple question asking what happens first, next, and last. Keep it business-friendly.
- Each question must help Ari produce a better analysis: effort, scope, commercials, billing, integrations, regression risk, mobile effort, roles/permissions, reports, data migration, finance handoff, operational handoff, or UAT complexity.
- Phrase each question so a business user can answer in one sentence.
- Include a short whyItMatters field.
- If there is enough detail in the uploaded document or intake, return an empty questions array.`;
}

function buildPrompt(request, files) {
  const fileContext = files.length
    ? files.map(file => `FILE: ${file.originalName}\nMIME: ${file.mimeType}\nCONTENT:\n${file.text || '(No readable text extracted.)'}`).join('\n\n---\n\n')
    : '(No files uploaded.)';

  return `Analyze this request and produce a business-friendly technical analysis with manday estimates.

CONTRACT PATH: ${request.contractPath === 'refine' ? 'Refine uploaded draft' : request.contractPath === 'approved-upload' ? 'Record approved contract' : 'Generate contract'}
REQUEST TYPE: ${request.projectType === 'extension' ? 'Extension of an existing tool' : 'New tool'}
CUSTOMER: ${request.customerName}
REQUESTER: ${request.requesterName || 'Not provided'}
BUSINESS UNIT: ${request.businessUnit || 'Not provided'}
TOOL / PROJECT NAME: ${request.toolName}
EXISTING TOOL REFERENCE: ${request.existingToolReference || 'Not provided'}
BUSINESS PROBLEM:
${request.businessProblem || 'Not provided'}

DESIRED OUTCOME:
${request.desiredOutcome || 'Not provided'}

USERS / ROLES:
${request.users || 'Not provided'}

KEY FEATURES:
${request.keyFeatures || 'Not provided'}

DATA, REPORTS, AND INTEGRATIONS:
${request.dataAndIntegrations || 'Not provided'}

CONSTRAINTS, RISKS, OR POLICIES:
${request.constraints || 'Not provided'}

TARGET TIMELINE:
${request.timeline || 'Not provided'}

USER ASSUMPTIONS:
${request.assumptions || 'Not provided'}

CLARIFYING ANSWERS:
${formatClarificationAnswers(request.clarificationAnswers)}

SUPPORTING FILES:
${fileContext}

Guidance:
- Uploaded files are primary evidence. Before producing the analysis, extract and rely on concrete document facts: parties, project names, scope sections, appendices, deliverables, fees, recurring charges, payment triggers, milestones, dates, dependencies, responsibilities, exclusions, acceptance criteria, renewal/termination language, integrations, reports, dashboards, operational handoffs, and support obligations where present.
- Do not skim uploaded files or replace them with generic assumptions. If a document mentions a specific amount, milestone, appendix, date, role, platform, report, or obligation, reflect it in the analysis unless it is irrelevant.
- Distinguish clearly between facts found in the uploaded file and Ari's assumptions or inferences.
- If the uploaded text appears incomplete, truncated, scanned, or unreadable, say so in assumptions/openQuestions and explain what analysis may be affected.
- If language is vague, infer likely technical work and label those items as assumptions.
- Treat "I don't know" clarification answers as uncertainty, not as missing user effort. Add reasonable contingency and list the uncertainty plainly.
- Use MEAN/Ionic terminology in the technical sections, but keep summaries clear enough for business stakeholders.
- Break estimates into small work packages with minDays, maxDays, and confidence.
- totalMinDays and totalMaxDays must equal the sum of the work package minDays and maxDays.
- Include open questions that would materially change scope or estimate.
- Draft business-readable user stories using the format "As a [role], I want [goal], so that [benefit]" with acceptance criteria that can later become contract scope.
- If the contract path is "Refine uploaded draft", analyze the uploaded draft/supporting file as the source of truth. Produce a full summary of the current draft context, inferred scope, commercials, process flow, risks, gaps, and refinement effort. Do not focus on Lex routing.
- If the contract path is "Record approved contract", the approved contract must not be changed, but Ari must still analyze it deeply as if preparing a reusable contract-intelligence package. Extract and summarize scope, business outcomes, commercials, billing milestones, payment triggers, renewal/termination dates, parties, obligations, service/operational handoffs, process flow, risks, missing metadata, implementation needs, and downstream finance/delivery actions. Estimate the operational/implementation/recording effort required for next stages; do not force mandays to 0.
- For uploaded approved contracts, draftedUserStories may be derived as business outcomes or operational stories if useful for future metadata and delivery handoff, but mark assumptions clearly and do not imply they change the signed contract.
- Always include a processFlow object. If the request has no meaningful workflow, use an empty steps array and explain that no workflow was identified in the summary. If it does have workflow, create a simple business-readable flow from the intake and clarifying answers.
- Keep the recommendation practical: MVP, phased delivery, or needs discovery.`;
}

function formatClarificationAnswers(answers) {
  if (!Array.isArray(answers) || !answers.length) return 'No clarifying answers provided.';
  return answers.map(item => {
    const answer = item.unknown ? "I don't know" : (item.answer || 'No answer provided');
    return `Q: ${item.question}\nA: ${answer}`;
  }).join('\n\n');
}

function analysisSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'projectClassification',
      'executiveSummary',
      'interpretedScope',
      'technicalApproach',
      'processFlow',
      'draftedUserStories',
      'meanIonicFit',
      'workPackages',
      'totalMinDays',
      'totalMaxDays',
      'confidence',
      'assumptions',
      'risks',
      'openQuestions',
      'recommendation'
    ],
    properties: {
      projectClassification: { type: 'string', enum: ['New tool', 'Extension'] },
      executiveSummary: { type: 'string' },
      interpretedScope: { type: 'array', items: { type: 'string' } },
      technicalApproach: { type: 'array', items: { type: 'string' } },
      processFlow: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'summary', 'steps'],
        properties: {
          title: { type: 'string' },
          summary: { type: 'string' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['label', 'actor', 'description'],
              properties: {
                label: { type: 'string' },
                actor: { type: 'string' },
                description: { type: 'string' }
              }
            }
          }
        }
      },
      draftedUserStories: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['role', 'goal', 'benefit', 'acceptanceCriteria'],
          properties: {
            role: { type: 'string' },
            goal: { type: 'string' },
            benefit: { type: 'string' },
            acceptanceCriteria: { type: 'array', items: { type: 'string' } }
          }
        }
      },
      meanIonicFit: {
        type: 'object',
        additionalProperties: false,
        required: ['frontend', 'backend', 'database', 'mobile'],
        properties: {
          frontend: { type: 'string' },
          backend: { type: 'string' },
          database: { type: 'string' },
          mobile: { type: 'string' }
        }
      },
      workPackages: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'description', 'minDays', 'maxDays', 'confidence'],
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            minDays: { type: 'number' },
            maxDays: { type: 'number' },
            confidence: { type: 'string', enum: ['High', 'Medium', 'Low'] }
          }
        }
      },
      totalMinDays: { type: 'number' },
      totalMaxDays: { type: 'number' },
      confidence: { type: 'string', enum: ['High', 'Medium', 'Low'] },
      assumptions: { type: 'array', items: { type: 'string' } },
      risks: { type: 'array', items: { type: 'string' } },
      openQuestions: { type: 'array', items: { type: 'string' } },
      recommendation: { type: 'string' }
    }
  };
}

function clarifyingQuestionsSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['questions'],
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['question', 'whyItMatters'],
          properties: {
            question: { type: 'string' },
            whyItMatters: { type: 'string' }
          }
        }
      }
    }
  };
}

function getOpenAI() {
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

function hasUsableOpenAIKey() {
  const key = String(process.env.OPENAI_API_KEY || '').trim();
  return Boolean(key && key !== 'your-api-key-here');
}

function normalizeBaseUrl(value) {
  return String(value || '').replace(/\/+$/g, '');
}

function lexAuthHeaders(req) {
  const headers = LEX_API_TOKEN ? { Authorization: `Bearer ${LEX_API_TOKEN}` } : {};
  const portalUser = req.get('x-dbsi-portal-user');

  if (portalUser) {
    headers['x-dbsi-portal-user'] = portalUser;
  }

  return headers;
}

function randomId() {
  return crypto.randomUUID();
}

function getMsalClient() {
  if (!msalClient) {
    msalClient = new msal.ConfidentialClientApplication({
      auth: {
        clientId: MICROSOFT_CLIENT_ID,
        authority: `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}`,
        clientSecret: MICROSOFT_CLIENT_SECRET
      }
    });
  }
  return msalClient;
}

function publicBaseUrl(req) {
  const forwardedHost = req.get('x-forwarded-host');
  if (!forwardedHost) return ARI_PUBLIC_BASE_URL;
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const prefix = req.get('x-forwarded-prefix') || '';
  return `${proto}://${forwardedHost}${prefix || ''}/`;
}

function microsoftRedirectUri(req) {
  const forwardedHost = req.get('x-forwarded-host');
  if (!forwardedHost) return MICROSOFT_REDIRECT_URI;
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const prefix = req.get('x-forwarded-prefix') || '';
  return `${proto}://${forwardedHost}${prefix}/auth/callback`;
}

function requireAuth(req, res, next) {
  if (!AUTH_ENABLED || req.session.user) return next();
  if (req.accepts('html') && req.method === 'GET') {
    req.session.returnTo = req.originalUrl;
    res.redirect('/auth/signin');
    return;
  }
  res.status(401).json({ success: false, message: 'Sign in with Microsoft to use Ari.' });
}

function applyPortalUser(req, res, next) {
  if (!req.session.user) {
    const portalUser = parsePortalUser(req.get('x-dbsi-portal-user'));
    if (portalUser) {
      req.session.user = portalUser;
    }
  }
  next();
}

function parsePortalUser(value) {
  if (!value) return null;
  try {
    const user = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    const email = String(user.email || '').trim().toLowerCase();
    if (!email) return null;
    return {
      name: String(user.name || email),
      email,
      tenantId: String(user.tenantId || ''),
      homeAccountId: String(user.homeAccountId || '')
    };
  } catch {
    return null;
  }
}

function saveSession(req) {
  if (!req.session?.save) return Promise.resolve();
  return new Promise((resolve, reject) => {
    req.session.save(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function safeReturnTo(value) {
  const target = String(value || '').trim();
  if (!target || !target.startsWith('/') || target.startsWith('//')) return '/';
  return target;
}

function parseBooleanEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function storageStatus() {
  return {
    configured: Boolean(MONGODB_URI),
    orgSlug: ORG_SLUG,
    database: MONGODB_URI ? MONGODB_DB_NAME : '',
    collection: MONGODB_URI ? MONGODB_STORIES_COLLECTION : ''
  };
}

async function getStoriesCollection() {
  if (!MONGODB_URI) {
    throw Object.assign(new Error('MongoDB is not configured. Add MONGODB_URI to .env to save customer user stories.'), { status: 503 });
  }
  if (!mongoClient) {
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
  }
  const collection = mongoClient.db(MONGODB_DB_NAME).collection(MONGODB_STORIES_COLLECTION);
  if (!storiesIndexesReady) {
    await collection.createIndex({ orgSlug: 1, customerKey: 1, createdAt: -1 });
    await collection.createIndex({ orgSlug: 1, id: 1 }, { unique: true });
    storiesIndexesReady = true;
  }
  return collection;
}

async function saveCustomerUserStories(request, analysis, user) {
  const contractPath = request.contractPath || 'details';
  const userStories = normalizeUserStories(analysis.draftedUserStories);
  if (!MONGODB_URI) {
    return {
      saved: false,
      reason: 'MongoDB is not configured. Add MONGODB_URI to .env to save customer user stories.',
      customerName: request.customerName,
      userStories
    };
  }

  const now = new Date();
  const record = {
    id: randomId(),
    orgSlug: ORG_SLUG,
    customerName: request.customerName,
    customerKey: normalizeKey(request.customerName),
    projectName: request.toolName || inferProjectNameFromAnalysis(analysis) || `${contractPath} analysis`,
    contractPath,
    projectType: request.projectType,
    businessUnit: request.businessUnit || '',
    requesterName: request.requesterName || '',
    summary: analysis.executiveSummary || '',
    projectClassification: analysis.projectClassification || '',
    interpretedScope: Array.isArray(analysis.interpretedScope) ? analysis.interpretedScope : [],
    technicalApproach: Array.isArray(analysis.technicalApproach) ? analysis.technicalApproach : [],
    processFlow: analysis.processFlow || { title: 'Process Flow', summary: '', steps: [] },
    userStories,
    workPackages: Array.isArray(analysis.workPackages) ? analysis.workPackages : [],
    totalMinDays: Number(analysis.totalMinDays || 0),
    totalMaxDays: Number(analysis.totalMaxDays || 0),
    confidence: analysis.confidence || '',
    assumptions: Array.isArray(analysis.assumptions) ? analysis.assumptions : [],
    risks: Array.isArray(analysis.risks) ? analysis.risks : [],
    openQuestions: Array.isArray(analysis.openQuestions) ? analysis.openQuestions : [],
    recommendation: analysis.recommendation || '',
    analysisSnapshot: analysis,
    source: {
      toolName: request.toolName,
      keyFeatures: request.keyFeatures || '',
      createdBy: user?.email || user?.name || 'Ari user'
    },
    createdAt: now,
    updatedAt: now
  };

  const collection = await getStoriesCollection();
  await collection.insertOne(record);
  return clientStorySet(record);
}

async function getStorySetById(storySetId) {
  const id = clean(storySetId);
  if (!id) throw Object.assign(new Error('Story set id is required.'), { status: 400 });
  const collection = await getStoriesCollection();
  const record = await collection.findOne({ orgSlug: ORG_SLUG, id });
  if (!record) throw Object.assign(new Error('User story summary was not found.'), { status: 404 });
  return clientStorySet(record);
}

function normalizeUserStories(stories) {
  if (!Array.isArray(stories)) return [];
  return stories.map(story => ({
    role: clean(story.role),
    goal: clean(story.goal),
    benefit: clean(story.benefit),
    acceptanceCriteria: Array.isArray(story.acceptanceCriteria)
      ? story.acceptanceCriteria.map(clean).filter(Boolean)
      : []
  })).filter(story => story.role || story.goal || story.benefit || story.acceptanceCriteria.length);
}

function clientStorySet(record) {
  return {
    saved: true,
    id: record.id,
    orgSlug: record.orgSlug || ORG_SLUG,
    userStoriesUrl: storySetUrl(record.id),
    customerName: record.customerName,
    projectName: record.projectName,
    contractPath: record.contractPath || '',
    projectType: record.projectType,
    summary: record.summary,
    processFlow: record.processFlow,
    userStories: record.userStories || [],
    totalMinDays: record.totalMinDays || 0,
    totalMaxDays: record.totalMaxDays || 0,
    confidence: record.confidence || '',
    workPackages: record.workPackages || [],
    risks: record.risks || [],
    assumptions: record.assumptions || [],
    openQuestions: record.openQuestions || [],
    recommendation: record.recommendation || '',
    createdBy: record.source?.createdBy || '',
    createdAt: record.createdAt
  };
}

function normalizeKey(value) {
  return clean(value).toLowerCase();
}

function normalizeOrgSlug(value) {
  return String(value || 'devboxph')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'devboxph';
}

function inferProjectNameFromAnalysis(analysis) {
  const title = clean(analysis.processFlow?.title || '');
  if (title && title !== 'Process Flow') return title;
  return '';
}

function formatUserStoriesForText(stories) {
  const normalized = normalizeUserStories(stories);
  if (!normalized.length) return ['- None drafted.'];
  return normalized.flatMap((story, index) => [
    `- Story ${index + 1}: As a ${story.role || 'user'}, I want ${story.goal || 'the requested capability'}, so that ${story.benefit || 'the business outcome is achieved'}.`,
    ...story.acceptanceCriteria.map(criteria => `  Acceptance criteria: ${criteria}`)
  ]);
}

function storySetUrl(id) {
  return id ? `${ARI_PUBLIC_BASE_URL}/user-stories/${encodeURIComponent(id)}` : '';
}

function renderStorySetPage(storySet) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Ari User Stories - ${escapeText(storySet.customerName)}</title>
  <style>
    :root { --ink: #1f2933; --muted: #607080; --line: #d8e0e6; --navy: #173b5b; --teal: #14a99a; --soft: #f7fafb; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #eef3f5; color: var(--ink); font-family: Arial, Helvetica, sans-serif; }
    header { padding: 18px max(22px, calc((100% - 980px) / 2)); background: #fff; border-top: 7px solid var(--teal); border-bottom: 1px solid var(--line); }
    .brand { color: var(--navy); font-size: 26px; font-weight: 900; }
    .tagline { color: var(--muted); font-size: 11px; font-weight: 800; letter-spacing: .16em; }
    main { max-width: 980px; margin: 24px auto; padding: 0 20px 36px; }
    section { background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 18px; margin-bottom: 14px; }
    h1, h2, h3 { color: var(--navy); margin-top: 0; }
    h1 { font-size: 28px; margin-bottom: 6px; }
    p, li { line-height: 1.45; }
    .meta { color: var(--muted); margin: 0; }
    .story { background: var(--soft); }
    .story strong { color: var(--navy); }
    .process-flow { display: grid; gap: 10px; }
    .step { border-left: 4px solid var(--teal); padding-left: 12px; }
  </style>
</head>
<body>
  <header>
    <div class="brand">DEVBOX</div>
    <div class="tagline">ARI USER STORY SUMMARY</div>
  </header>
  <main>
    <section>
      <h1>${escapeText(storySet.projectName || 'User Stories')}</h1>
      <p class="meta">${escapeText(storySet.customerName)}${storySet.createdAt ? ` &middot; ${escapeText(new Date(storySet.createdAt).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }))}` : ''}</p>
      <p>${escapeText(storySet.summary || 'No summary provided.')}</p>
    </section>
    <section>
      <h2>Manday And Risk Summary</h2>
      <p><strong>${escapeText(storySet.totalMinDays)}-${escapeText(storySet.totalMaxDays)} mandays</strong>${storySet.confidence ? ` (${escapeText(storySet.confidence)} confidence)` : ''}</p>
      ${renderStorySetList('Work Packages', (storySet.workPackages || []).map(pkg => `${pkg.name}: ${pkg.minDays}-${pkg.maxDays} mandays. ${pkg.description}`))}
      ${renderStorySetList('Risks', storySet.risks)}
      ${renderStorySetList('Open Questions', storySet.openQuestions)}
      ${storySet.recommendation ? `<p><strong>Recommendation:</strong> ${escapeText(storySet.recommendation)}</p>` : ''}
    </section>
    <section>
      <h2>Drafted User Stories</h2>
      ${renderStorySetStories(storySet.userStories)}
    </section>
    <section>
      <h2>${escapeText(storySet.processFlow?.title || 'Process Flow')}</h2>
      <p>${escapeText(storySet.processFlow?.summary || 'No process flow summary provided.')}</p>
      ${renderStorySetProcessFlow(storySet.processFlow)}
    </section>
  </main>
</body>
</html>`;
}

function renderStorySetStories(stories) {
  const normalized = normalizeUserStories(stories);
  if (!normalized.length) return '<p>No user stories were drafted.</p>';
  return normalized.map((story, index) => `<article class="story">
    <strong>Story ${escapeText(index + 1)}</strong>
    <p>As a ${escapeText(story.role || 'user')}, I want ${escapeText(story.goal || 'the requested capability')}, so that ${escapeText(story.benefit || 'the business outcome is achieved')}.</p>
    <ul>${story.acceptanceCriteria.map(item => `<li>${escapeText(item)}</li>`).join('')}</ul>
  </article>`).join('');
}

function renderStorySetList(title, items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return '';
  return `<h3>${escapeText(title)}</h3><ul>${list.map(item => `<li>${escapeText(item)}</li>`).join('')}</ul>`;
}

function renderStorySetProcessFlow(processFlow) {
  if (!processFlow?.steps?.length) return '<p>No process flow steps were identified.</p>';
  return `<div class="process-flow">${processFlow.steps.map((step, index) => `<div class="step">
    <strong>${escapeText(index + 1)}. ${escapeText(step.label)}</strong>
    <p><b>${escapeText(step.actor || 'Owner TBD')}</b>: ${escapeText(step.description)}</p>
  </div>`).join('')}</div>`;
}

app.use((err, req, res, next) => {
  const normalized = normalizeServerError(err);
  const status = normalized.status;
  res.status(status).json({
    success: false,
    message: normalized.message
  });
});

function normalizeServerError(err) {
  const status = Number(err.status || err.statusCode || 500);
  const rawMessage = String(err.message || '').trim();
  const rawType = String(err.type || err.name || '').trim();
  const combined = `${rawType} ${rawMessage}`;
  const isTimeout =
    status === 504 ||
    /timeout|timed out|gateway time-?out|etimedout|abort/i.test(combined);

  if (isTimeout) {
    return {
      status: status >= 400 ? status : 504,
      message: 'Ari timed out while reading and analyzing the document. The file may be large or the analysis request took longer than the server gateway allows. Please try again, or split very large supporting files before analysis.'
    };
  }

  if (status >= 500) {
    return {
      status,
      message: rawMessage || 'Ari hit a server error while preparing the analysis. Please try again; if it repeats, check the server logs.'
    };
  }

  return {
    status,
    message: rawMessage || 'Ari could not complete the request.'
  };
}

app.listen(PORT, () => {
  console.log(`Ari running on http://localhost:${PORT}`);
});
