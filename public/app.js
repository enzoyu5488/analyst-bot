const isPortalEmbed = new URLSearchParams(window.location.search).get('embed') === '1';

if (isPortalEmbed) {
  document.body.classList.add('portal-embed');
}

const form = document.getElementById('analysisForm');
const submitBtn = document.getElementById('submitBtn');
const skipQuestionsBtn = document.getElementById('skipQuestionsBtn');
const questionsPanel = document.getElementById('questionsPanel');
const questionsList = document.getElementById('questionsList');
const statusNode = document.getElementById('status');
const output = document.getElementById('output');
const copyBtn = document.getElementById('copyBtn');
const showLexBtn = document.getElementById('showLexBtn');
const lexForm = document.getElementById('lexForm');
const sendLexBtn = document.getElementById('sendLexBtn');
const lexStatus = document.getElementById('lexStatus');
const ratePanel = document.getElementById('ratePanel');
const finalDayRate = document.getElementById('finalDayRate');
const supplierEntity = document.getElementById('supplierEntity');
const signatoryName = document.getElementById('signatoryName');
const signatoryTitle = document.getElementById('signatoryTitle');
const estimateBasis = document.getElementById('estimateBasis');
const healthBadge = document.getElementById('healthBadge');
const existingToolField = document.getElementById('existingToolField');
const lexGenerateFields = document.getElementById('lexGenerateFields');
const lexRefineFields = document.getElementById('lexRefineFields');
const lexApprovedFields = document.getElementById('lexApprovedFields');
const lexSourceReuseNotice = document.getElementById('lexSourceReuseNotice');
const lexApprovedSourceReuseNotice = document.getElementById('lexApprovedSourceReuseNotice');
const lexDraftContractLabel = document.getElementById('lexDraftContractLabel');
const lexCompletedContractLabel = document.getElementById('lexCompletedContractLabel');
const requestTypeRow = document.getElementById('requestTypeRow');
const toolNameField = document.getElementById('toolNameField');
const refineUploadPrompt = document.getElementById('refineUploadPrompt');
const documentUploadTitle = document.getElementById('documentUploadTitle');
const documentUploadHelp = document.getElementById('documentUploadHelp');
const supportingFilesLabel = document.getElementById('supportingFilesLabel');

const supplierDefaults = {
  'Devbox Solutions Inc.': { signatoryName: 'Romeo Patawaran Jr.', signatoryTitle: 'Client Manager' },
  'Kaitech Solutions OPC': { signatoryName: 'Bryan Reyes', signatoryTitle: 'Client Manager' },
  'Kaitech Pty Ltd': { signatoryName: 'Jose Lorenzo Yu', signatoryTitle: 'Client Manager' }
};

let lastAnalysis = null;
let lastIntake = null;
let lastSavedStorySet = null;
let defaultDayRate = 10000;
let clarificationQuestions = [];
let clarificationStepReady = false;

loadHealth();
syncMode();
syncContractPath();

document.querySelectorAll('input[name="projectType"]').forEach(input => {
  input.addEventListener('change', syncMode);
});

document.querySelectorAll('input[name="contractPath"]').forEach(input => {
  input.addEventListener('change', syncContractPath);
});

document.querySelectorAll('#lexForm input[name="draftingMode"]').forEach(input => {
  input.addEventListener('change', updateLexMode);
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!clarificationStepReady) {
    await askClarifyingQuestions();
    return;
  }
  await generateAnalysis();
});

skipQuestionsBtn.addEventListener('click', async () => {
  clarificationStepReady = true;
  clarificationQuestions = [];
  questionsPanel.classList.add('hidden');
  skipQuestionsBtn.classList.add('hidden');
  await generateAnalysis();
});

async function askClarifyingQuestions() {
  submitBtn.disabled = true;
  status('Ari is checking whether a few details would sharpen the estimate...');
  output.className = 'empty-state';
  output.textContent = 'Ari is reading the request before estimating.';
  copyBtn.classList.add('hidden');
  showLexBtn.classList.add('hidden');
  lexForm.classList.add('hidden');

  try {
    const response = await fetch('/api/clarifying-questions', {
      method: 'POST',
      body: new FormData(form),
      headers: { Accept: 'application/json' }
    });
    const payload = await parseApiResponse(response);
    if (!response.ok) throw new Error(payload.message);
    clarificationQuestions = payload.questions || [];
    clarificationStepReady = true;
    renderClarifyingQuestions(clarificationQuestions);
    if (!clarificationQuestions.length) {
      status('Ari has enough detail. Generating the estimate...', false, true);
      await generateAnalysis();
      return;
    }
    submitBtn.textContent = 'Generate analysis';
    skipQuestionsBtn.classList.remove('hidden');
    status("Answer what you can. It is fine to choose \"I don't know\".", false, true);
  } catch (error) {
    status(error.message, true);
    output.className = 'empty-state error-box';
    output.textContent = error.message;
  } finally {
    submitBtn.disabled = false;
  }
}

async function generateAnalysis() {
  submitBtn.disabled = true;
  skipQuestionsBtn.disabled = true;
  status('Preparing technical analysis...');
  output.className = 'empty-state';
  output.textContent = 'Ari is estimating the work with the available answers.';
  copyBtn.classList.add('hidden');
  showLexBtn.classList.add('hidden');
  lexForm.classList.add('hidden');

  try {
    const body = new FormData(form);
    body.set('clarificationAnswers', JSON.stringify(readClarificationAnswers()));
    const response = await fetch('/api/analyses', {
      method: 'POST',
      body,
      headers: { Accept: 'application/json' }
    });
    const payload = await parseApiResponse(response);
    if (!response.ok) throw new Error(payload.message);
    lastAnalysis = payload.analysis;
    lastSavedStorySet = payload.savedStorySet || null;
    lastIntake = readIntake();
    lastIntake.clarificationAnswers = readClarificationAnswers();
    renderAnalysis(payload.analysis, lastSavedStorySet);
    prepareLexForm();
    status('Analysis ready.', false, true);
  } catch (error) {
    status(error.message, true);
    output.className = 'empty-state error-box';
    output.textContent = error.message;
  } finally {
    submitBtn.disabled = false;
    skipQuestionsBtn.disabled = false;
  }
}

showLexBtn.addEventListener('click', () => {
  lexForm.classList.toggle('hidden');
  hideRatePanel();
});

lexForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!lastAnalysis || !lastIntake) return;
  const draftingMode = currentLexMode();
  const needsRate = draftingMode !== 'approved-upload';
  if (needsRate && ratePanel.classList.contains('hidden')) {
    showRatePanel();
    return;
  }
  sendLexBtn.disabled = true;
  lexStatus.textContent = currentLexMode() === 'approved-upload'
    ? 'Sending approved contract to Lex...'
    : 'Sending Ari package to Lex...';
  lexStatus.className = 'status';

  try {
    const selectedRate = needsRate ? readFinalDayRate() : null;
    if (needsRate && !selectedRate) {
      return;
    }
    const body = new FormData(lexForm);
    if (selectedRate) body.set('dayRate', String(selectedRate));
    body.set('analysis', JSON.stringify(lastAnalysis));
    body.set('intake', JSON.stringify(lastIntake));
    body.set('savedStorySet', JSON.stringify(lastSavedStorySet || {}));
    if (lastSavedStorySet?.userStoriesUrl) {
      body.set('ariUserStoriesUrl', lastSavedStorySet.userStoriesUrl);
    }
    appendDocumentLedFile(body, draftingMode);
    body.set('vatExclusive', lexForm.vatExclusive.checked ? 'true' : 'false');
    const response = await fetch('/api/lex-handoffs', {
      method: 'POST',
      body,
      headers: { Accept: 'application/json' }
    });
    const payload = await parseApiResponse(response);
    if (!response.ok) throw new Error(payload.message);
    const jobId = payload.lex?.job?.id;
    if (!jobId) throw new Error('Lex did not return a draft job id.');
    await pollLexJob(jobId);
  } catch (error) {
    lexStatus.textContent = error.message;
    lexStatus.className = 'status error';
  } finally {
    sendLexBtn.disabled = false;
  }
});

async function pollLexJob(jobId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 300000) {
    const payload = await json(`/api/lex-jobs/${encodeURIComponent(jobId)}`, { method: 'GET' });
    const job = payload.lex?.job;
    if (!job) throw new Error('Lex job status was not returned.');
    if (job.status === 'FAILED') throw new Error(job.message || 'Lex contract generation failed.');
    if (job.status === 'CANCELLED') throw new Error(job.message || 'Lex contract generation was cancelled.');
    if (job.status === 'COMPLETE') {
      const contractId = payload.lex?.engagement?.contractId;
      showLexHandoffComplete({
        contractId,
        redirectUrl: payload.redirectUrl,
        lexApiBaseUrl: payload.lexApiBaseUrl
      });
      return;
    }
    const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    lexStatus.textContent = `Lex is processing the contract... ${job.status.toLowerCase()} (${elapsedSeconds}s)`;
    await wait(3000);
  }
  throw new Error('Lex contract generation is still running. Open contract-bot and check the Lex job status.');
}

function showLexHandoffComplete({ contractId, redirectUrl, lexApiBaseUrl }) {
  const label = contractId || 'the new Lex contract';
  lexStatus.className = 'status ok lex-handoff-complete';
  lexStatus.innerHTML = `
    <strong>Lex now has the details and drafted the contract.</strong>
    <span>Continue in Lex with contract ${escapeHtml(label)} for review, refinement, approval, and tracking.</span>
    <button type="button" id="openLexHandoffBtn">Continue in Lex</button>
  `;

  document.getElementById('openLexHandoffBtn')?.addEventListener('click', () => {
    openLexHandoff({ contractId, redirectUrl, lexApiBaseUrl });
  });

  if (isPortalEmbed && window.parent !== window) {
    window.parent.postMessage({
      type: 'ari:lex-handoff-ready',
      contractId,
      redirectUrl,
      lexApiBaseUrl
    }, window.location.origin);
  }
}

function openLexHandoff({ contractId, redirectUrl, lexApiBaseUrl }) {
  if (isPortalEmbed && window.parent !== window) {
    window.parent.postMessage({
      type: 'ari:open-lex-handoff',
      contractId,
      redirectUrl,
      lexApiBaseUrl
    }, window.location.origin);
    return;
  }

  location.href = redirectUrl || lexApiBaseUrl || '/';
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

copyBtn.addEventListener('click', async () => {
  if (!lastAnalysis) return;
  await navigator.clipboard.writeText(toPlainText(lastAnalysis));
  copyBtn.textContent = 'Copied';
  setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
});

async function loadHealth() {
  try {
    const response = await fetch('/api/health');
    const payload = await response.json();
    healthBadge.textContent = payload.openaiConfigured ? `Ari ready: ${payload.model}` : 'Add OPENAI_API_KEY to .env';
    healthBadge.classList.toggle('warning', !payload.openaiConfigured);
  } catch {
    healthBadge.textContent = 'Server unavailable';
    healthBadge.classList.add('warning');
  }
}

supplierEntity.addEventListener('change', () => {
  const defaults = supplierDefaults[supplierEntity.value];
  if (!defaults) return;
  signatoryName.value = defaults.signatoryName;
  signatoryTitle.value = defaults.signatoryTitle;
});

function syncMode() {
  const mode = new FormData(form).get('projectType');
  document.querySelectorAll('.mode').forEach(label => {
    label.classList.toggle('active', label.querySelector('input').checked);
  });
  existingToolField.classList.toggle('hidden', mode !== 'extension');
  resetClarificationStep();
}

function resetClarificationStep() {
  clarificationStepReady = false;
  clarificationQuestions = [];
  questionsPanel.classList.add('hidden');
  questionsList.innerHTML = '';
  submitBtn.textContent = 'Ask Ari';
  skipQuestionsBtn.classList.add('hidden');
  if (lastAnalysis) {
    lastAnalysis = null;
    lastIntake = null;
    lastSavedStorySet = null;
    copyBtn.classList.add('hidden');
    showLexBtn.classList.add('hidden');
    lexForm.classList.add('hidden');
    hideRatePanel();
    output.className = 'empty-state';
    output.textContent = 'The request changed. Ask Ari again to refresh the estimate.';
  }
}

form.addEventListener('input', event => {
  if (event.target.closest('#questionsPanel') || event.target.closest('#lexForm')) return;
  resetClarificationStep();
});

function renderClarifyingQuestions(questions) {
  if (!questions.length) {
    questionsPanel.classList.add('hidden');
    questionsList.innerHTML = '';
    return;
  }
  questionsPanel.classList.remove('hidden');
  questionsList.innerHTML = questions.map((item, index) => `
    <div class="question-item">
      <label>${escapeHtml(item.question)}
        <textarea data-question-index="${index}" rows="3" placeholder="Answer if you know. A short sentence is enough."></textarea>
      </label>
      <small>${escapeHtml(item.whyItMatters)}</small>
      <label class="check compact"><input type="checkbox" data-unknown-index="${index}"> I don't know</label>
    </div>
  `).join('');
  questionsList.querySelectorAll('[data-unknown-index]').forEach(input => {
    input.addEventListener('change', () => {
      const answer = questionsList.querySelector(`[data-question-index="${input.dataset.unknownIndex}"]`);
      answer.disabled = input.checked;
      if (input.checked) answer.value = '';
    });
  });
}

function readClarificationAnswers() {
  return clarificationQuestions.map((item, index) => {
    const answer = questionsList.querySelector(`[data-question-index="${index}"]`);
    const unknown = questionsList.querySelector(`[data-unknown-index="${index}"]`);
    return {
      question: item.question,
      answer: answer?.value || '',
      unknown: Boolean(unknown?.checked)
    };
  });
}

function renderAnalysis(analysis, savedStorySet) {
  output.className = 'analysis';
  output.innerHTML = `
    <section class="summary-band">
      <div>
        <span>${escapeHtml(analysis.projectClassification)}</span>
        <h2>${escapeHtml(analysis.totalMinDays)}-${escapeHtml(analysis.totalMaxDays)} mandays</h2>
        <p>${escapeHtml(analysis.executiveSummary)}</p>
      </div>
      <strong>${escapeHtml(analysis.confidence)} confidence</strong>
    </section>

    ${renderList('Interpreted Scope', analysis.interpretedScope)}
    ${renderList('Technical Approach', analysis.technicalApproach)}
    ${renderProcessFlow(analysis.processFlow)}
    ${renderUserStories(analysis.draftedUserStories)}
    ${renderSavedStorySet(savedStorySet)}

    <section>
      <h3>MEAN/Ionic Fit</h3>
      <div class="fit-grid">
        ${renderFit('Angular/Ionic', analysis.meanIonicFit.frontend)}
        ${renderFit('Express/Node', analysis.meanIonicFit.backend)}
        ${renderFit('MongoDB', analysis.meanIonicFit.database)}
        ${renderFit('Mobile', analysis.meanIonicFit.mobile)}
      </div>
    </section>

    <section>
      <h3>Manday Breakdown</h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Work package</th><th>Estimate</th><th>Confidence</th></tr></thead>
          <tbody>
            ${analysis.workPackages.map(pkg => `
              <tr>
                <td><b>${escapeHtml(pkg.name)}</b><small>${escapeHtml(pkg.description)}</small></td>
                <td>${escapeHtml(pkg.minDays)}-${escapeHtml(pkg.maxDays)}</td>
                <td>${escapeHtml(pkg.confidence)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </section>

    ${renderList('Assumptions', analysis.assumptions)}
    ${renderList('Risks', analysis.risks)}
    ${renderList('Open Questions', analysis.openQuestions)}

    <section class="recommendation">
      <h3>Recommendation</h3>
      <p>${escapeHtml(analysis.recommendation)}</p>
    </section>
  `;
  copyBtn.classList.remove('hidden');
  showLexBtn.classList.remove('hidden');
}

function readIntake() {
  const data = new FormData(form);
  return {
    projectType: data.get('projectType') || '',
    customerName: data.get('customerName') || '',
    requesterName: data.get('requesterName') || '',
    businessUnit: data.get('businessUnit') || '',
    toolName: data.get('toolName') || '',
    existingToolReference: data.get('existingToolReference') || '',
    businessProblem: data.get('businessProblem') || '',
    desiredOutcome: data.get('desiredOutcome') || '',
    users: data.get('users') || '',
    keyFeatures: data.get('keyFeatures') || '',
    dataAndIntegrations: data.get('dataAndIntegrations') || '',
    constraints: data.get('constraints') || '',
    timeline: data.get('timeline') || '',
    assumptions: data.get('assumptions') || ''
  };
}

function prepareLexForm() {
  lexForm.customerName.value = lastIntake.customerName || '';
  lexForm.projectName.value = lastIntake.toolName || '';
  supplierEntity.dispatchEvent(new Event('change'));
  syncLexModeFromContractPath();
  updateLexMode();
  hideRatePanel();
}

function currentContractPath() {
  return new FormData(form).get('contractPath') || 'details';
}

function syncContractPath() {
  const mode = currentContractPath();
  const refineMode = mode === 'refine';
  const approvedMode = mode === 'approved-upload';
  const documentLedMode = refineMode || approvedMode;
  document.querySelectorAll('input[name="contractPath"]').forEach(input => {
    input.closest('.mode')?.classList.toggle('active', input.checked);
  });
  form.toolName.required = mode === 'details';
  form.supportingFiles.required = documentLedMode;
  requestTypeRow.classList.toggle('hidden', documentLedMode);
  toolNameField.classList.toggle('hidden', documentLedMode);
  refineUploadPrompt.classList.toggle('hidden', !documentLedMode);
  if (approvedMode) {
    documentUploadTitle.textContent = 'Upload the approved contract file';
    documentUploadHelp.textContent = 'Ari will fully analyze the approved contract for reusable metadata, billing milestones, renewal tracking, finance handoff, delivery context, and next-stage operations. Ari will not change the signed contract.';
  } else {
    documentUploadTitle.textContent = 'Upload the draft or supporting file';
    documentUploadHelp.textContent = 'Ari will read the file first and only ask a few questions if something is unclear.';
  }
  document.querySelectorAll('.requirements-field').forEach(label => {
    label.classList.toggle('optional-for-approved', documentLedMode);
  });
  supportingFilesLabel.childNodes[0].textContent = approvedMode ? 'Approved contract file' : (refineMode ? 'Draft or supporting file' : 'Supporting files');
  syncLexModeFromContractPath();
}

function syncLexModeFromContractPath() {
  const mode = currentContractPath();
  const target = lexForm.querySelector(`input[name="draftingMode"][value="${CSS.escape(mode)}"]`);
  if (target) target.checked = true;
  updateLexMode();
}

function currentLexMode() {
  return new FormData(lexForm).get('draftingMode') || 'details';
}

function updateLexMode() {
  const mode = currentLexMode();
  const sourceFile = getDocumentLedSourceFile();
  document.querySelectorAll('#lexForm input[name="draftingMode"]').forEach(input => {
    input.closest('.mode')?.classList.toggle('active', input.checked);
  });
  lexGenerateFields.classList.toggle('hidden', mode !== 'details');
  lexRefineFields.classList.toggle('hidden', mode !== 'refine');
  lexApprovedFields.classList.toggle('hidden', mode !== 'approved-upload');
  lexForm.projectName.required = mode !== 'approved-upload';
  lexForm.signatoryName.required = mode !== 'approved-upload';
  lexForm.signatoryTitle.required = mode !== 'approved-upload';
  lexForm.draftContract.required = false;
  lexForm.completedContract.required = false;
  lexForm.projectName.closest('label')?.classList.toggle('hidden', mode === 'approved-upload');
  estimateBasis.closest('label')?.classList.toggle('hidden', mode === 'approved-upload');
  lexForm.monthlyRunningCost.closest('label')?.classList.toggle('hidden', mode === 'approved-upload');
  lexForm.vatExclusive.closest('label')?.classList.toggle('hidden', mode === 'approved-upload');
  lexForm.signatoryName.closest('label')?.classList.toggle('hidden', mode === 'approved-upload');
  lexForm.signatoryTitle.closest('label')?.classList.toggle('hidden', mode === 'approved-upload');
  syncDocumentReuseNotice(mode, sourceFile);
  hideRatePanel();
  if (mode === 'approved-upload') sendLexBtn.textContent = 'Record approved contract in Lex';
  if (mode === 'refine') sendLexBtn.textContent = 'Refine draft in Lex';
}

function appendDocumentLedFile(body, draftingMode) {
  const sourceFile = getDocumentLedSourceFile();
  if (!sourceFile) return;
  if (draftingMode === 'refine' && !lexForm.draftContract.files?.length) {
    body.set('draftContract', sourceFile, sourceFile.name);
  }
  if (draftingMode === 'approved-upload' && !lexForm.completedContract.files?.length) {
    body.set('completedContract', sourceFile, sourceFile.name);
  }
}

function getDocumentLedSourceFile() {
  return form.supportingFiles.files?.[0] || null;
}

function syncDocumentReuseNotice(mode, sourceFile) {
  const refineReuse = mode === 'refine' && sourceFile && !lexForm.draftContract.files?.length;
  const approvedReuse = mode === 'approved-upload' && sourceFile && !lexForm.completedContract.files?.length;
  lexSourceReuseNotice.classList.toggle('hidden', !refineReuse);
  lexApprovedSourceReuseNotice.classList.toggle('hidden', !approvedReuse);
  lexDraftContractLabel.classList.toggle('hidden', Boolean(refineReuse));
  lexCompletedContractLabel.classList.toggle('hidden', Boolean(approvedReuse));
  if (refineReuse) {
    lexSourceReuseNotice.textContent = `Ari will send the draft you already uploaded: ${sourceFile.name}`;
  }
  if (approvedReuse) {
    lexApprovedSourceReuseNotice.textContent = `Ari will send the approved contract you already uploaded: ${sourceFile.name}`;
  }
}

function renderUserStories(stories) {
  const list = Array.isArray(stories) && stories.length ? stories : [];
  if (!list.length) {
    return '<section><h3>Drafted User Stories</h3><p class="muted-flow">No user stories were drafted from this request.</p></section>';
  }
  return `<section>
    <h3>Drafted User Stories</h3>
    <div class="story-list">
      ${list.map((story, index) => `
        <article class="story-card">
          <strong>Story ${escapeHtml(index + 1)}</strong>
          <p>As a ${escapeHtml(story.role || 'user')}, I want ${escapeHtml(story.goal || 'the requested capability')}, so that ${escapeHtml(story.benefit || 'the business outcome is achieved')}.</p>
          <ul>${(story.acceptanceCriteria || []).map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
        </article>
      `).join('')}
    </div>
  </section>`;
}

function renderSavedStorySet(savedStorySet) {
  if (!savedStorySet) return '';
  if (savedStorySet.saved === false) {
    return `<section class="save-notice warning"><h3>User Story Save</h3><p>${escapeHtml(savedStorySet.reason || 'MongoDB is not configured, so stories were not saved.')}</p></section>`;
  }
  const link = savedStorySet.userStoriesUrl
    ? ` <a href="${escapeHtml(savedStorySet.userStoriesUrl)}" target="_blank" rel="noopener">View summary</a>`
    : '';
  const storyCount = savedStorySet.userStories?.length || 0;
  const label = storyCount
    ? `Saved Ari analysis and ${storyCount} user stories for ${escapeHtml(savedStorySet.customerName)}.`
    : `Saved Ari analysis package for ${escapeHtml(savedStorySet.customerName)}.`;
  return `<section class="save-notice"><h3>Ari Analysis Save</h3><p>${label}${link}</p></section>`;
}

function selectedMandays() {
  const min = Number(lastAnalysis.totalMinDays || 0);
  const max = Number(lastAnalysis.totalMaxDays || 0);
  if (estimateBasis.value === 'min') return min;
  if (estimateBasis.value === 'mid') return Math.round(((min + max) / 2) * 10) / 10;
  return max;
}

function showRatePanel() {
  if (currentLexMode() === 'approved-upload') return;
  const days = selectedMandays();
  ratePanel.classList.remove('hidden');
  finalDayRate.value = String(defaultDayRate);
  finalDayRate.focus();
  sendLexBtn.textContent = 'Send to Lex now';
  lexStatus.textContent = `Ari will compute the contract total from ${days} mandays. Enter the daily rate, then send to Lex.`;
  lexStatus.className = 'status';
}

function hideRatePanel() {
  ratePanel.classList.add('hidden');
  const mode = currentLexMode();
  sendLexBtn.textContent = mode === 'approved-upload'
    ? 'Record approved contract in Lex'
    : (mode === 'refine' ? 'Refine draft in Lex' : 'Create contract in Lex');
  lexStatus.textContent = '';
  finalDayRate.value = '';
}

function readFinalDayRate() {
  const rate = Number(String(finalDayRate.value || '').replace(/,/g, '').trim());
  if (!Number.isFinite(rate) || rate <= 0) {
    lexStatus.textContent = 'Enter a valid daily rate before sending to Lex.';
    lexStatus.className = 'status error';
    finalDayRate.focus();
    return null;
  }
  return rate;
}

function renderList(title, items) {
  const list = Array.isArray(items) && items.length ? items : ['None called out.'];
  return `<section><h3>${escapeHtml(title)}</h3><ul>${list.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></section>`;
}

function renderFit(label, value) {
  return `<div class="fit-card"><strong>${escapeHtml(label)}</strong><p>${escapeHtml(value)}</p></div>`;
}

function renderProcessFlow(processFlow) {
  if (!processFlow || !Array.isArray(processFlow.steps) || !processFlow.steps.length) {
    return `<section><h3>Process Flow</h3><p class="muted-flow">${escapeHtml(processFlow?.summary || 'No process flow identified for this request.')}</p></section>`;
  }
  return `<section>
    <h3>${escapeHtml(processFlow.title || 'Process Flow')}</h3>
    <p class="muted-flow">${escapeHtml(processFlow.summary || '')}</p>
    <div class="process-flow">
      ${processFlow.steps.map((step, index) => `
        <div class="process-node">
          <b>${escapeHtml(index + 1)}. ${escapeHtml(step.label)}</b>
          <span>${escapeHtml(step.actor || 'Owner TBD')}</span>
          <p>${escapeHtml(step.description)}</p>
        </div>
      `).join('<div class="process-arrow">→</div>')}
    </div>
  </section>`;
}

function toPlainText(analysis) {
  const lines = [
    `${analysis.projectClassification} analysis`,
    `${analysis.totalMinDays}-${analysis.totalMaxDays} mandays (${analysis.confidence} confidence)`,
    '',
    analysis.executiveSummary,
    '',
    'Manday breakdown:',
    ...analysis.workPackages.map(pkg => `- ${pkg.name}: ${pkg.minDays}-${pkg.maxDays} days (${pkg.confidence}) - ${pkg.description}`),
    '',
    'Process flow:',
    ...(analysis.processFlow?.steps?.length
      ? analysis.processFlow.steps.map((step, index) => `- ${index + 1}. ${step.label} (${step.actor || 'Owner TBD'}): ${step.description}`)
      : [`- ${analysis.processFlow?.summary || 'No process flow identified.'}`]),
    '',
    'Drafted user stories:',
    ...((analysis.draftedUserStories || []).length
      ? analysis.draftedUserStories.flatMap((story, index) => [
          `- Story ${index + 1}: As a ${story.role || 'user'}, I want ${story.goal || 'the requested capability'}, so that ${story.benefit || 'the business outcome is achieved'}.`,
          ...(story.acceptanceCriteria || []).map(item => `  Acceptance criteria: ${item}`)
        ])
      : ['- None drafted.']),
    '',
    'Open questions:',
    ...(analysis.openQuestions || []).map(item => `- ${item}`),
    '',
    `Recommendation: ${analysis.recommendation}`
  ];
  return lines.join('\n');
}

async function parseApiResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return response.json();
  const text = await response.text();
  return { message: humanizeHttpError(response, text) };
}

function humanizeHttpError(response, text) {
  const compactText = String(text || '').replace(/\s+/g, ' ').trim();
  const strippedText = compactText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const messageSource = strippedText || compactText || `${response.status} ${response.statusText}`;
  const looksLikeGatewayTimeout =
    response.status === 504 ||
    /gateway time-?out/i.test(messageSource) ||
    /upstream.*timed out/i.test(messageSource);

  if (looksLikeGatewayTimeout) {
    return 'Ari timed out while reading and analyzing the document. The upload may be large or the AI request took longer than the server gateway allows. Please try again, or split very large supporting files before analysis.';
  }

  if (response.status >= 500) {
    return 'Ari hit a server error while preparing the analysis. Please try again; if it repeats, check the server logs.';
  }

  return messageSource;
}

async function json(url, options) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options?.headers || {})
    }
  });
  const payload = await parseApiResponse(response);
  if (!response.ok) throw new Error(payload.message);
  return payload;
}

function status(message, isError = false, isOk = false) {
  statusNode.textContent = message;
  statusNode.className = `status ${isError ? 'error' : isOk ? 'ok' : ''}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
