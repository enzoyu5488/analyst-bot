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
const chatMessages = document.getElementById('chatMessages');
const chatChips = document.getElementById('chatChips');
const chatStatusLine = document.getElementById('chatStatusLine');
const chatInput = document.getElementById('chatInput');
const chatSendBtn = document.getElementById('chatSendBtn');
const chatAttachBtn = document.getElementById('chatAttachBtn');
const chatGenerateBtn = document.getElementById('chatGenerateBtn');
const chatResetBtn = document.getElementById('chatResetBtn');
const chatSupportingFiles = document.getElementById('chatSupportingFiles');
const chatAttachmentList = document.getElementById('chatAttachmentList');
const chatConfidenceLabel = document.getElementById('chatConfidenceLabel');
const chatConfidenceBar = document.getElementById('chatConfidenceBar');
const chatConfidenceText = document.getElementById('chatConfidenceText');

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
let chatStep = 'start';
let chatState = {};
let chatConfidence = 0;
let chatBusy = false;

loadHealth();
syncMode();
syncContractPath();
startChat();

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

chatSendBtn.addEventListener('click', async () => {
  await handleChatText(chatInput.value);
});

chatInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    handleChatText(chatInput.value);
  }
});

chatGenerateBtn.addEventListener('click', async () => {
  commitChatStateToForm();
  clarificationStepReady = true;
  clarificationQuestions = [];
  questionsPanel.classList.add('hidden');
  skipQuestionsBtn.classList.add('hidden');
  addBotMessage(`Please wait a minute while I generate the Ari summary. I am at ${chatConfidence}% confidence for an initial package, and I will keep open questions visible where I am not fully certain.`);
  await generateAnalysis();
});

chatResetBtn.addEventListener('click', () => {
  startChat();
  resetClarificationStep();
});

chatAttachBtn.addEventListener('click', () => {
  chatSupportingFiles.click();
});

chatSupportingFiles.addEventListener('change', () => {
  const names = Array.from(chatSupportingFiles.files || []).map(file => file.name);
  if (!names.length) return;
  chatState.hasFiles = true;
  chatState.attachmentsAcknowledged = false;
  renderAttachmentList(names);
  updateChatConfidence();
});

skipQuestionsBtn.addEventListener('click', async () => {
  clarificationStepReady = true;
  clarificationQuestions = [];
  questionsPanel.classList.add('hidden');
  skipQuestionsBtn.classList.add('hidden');
  await generateAnalysis();
});

function startChat() {
  chatStep = 'start';
  chatState = {
    contractPath: 'details',
    projectType: 'new-tool',
    customerName: '',
    requesterName: '',
    businessUnit: '',
    toolName: '',
    existingToolReference: '',
    businessProblem: '',
    desiredOutcome: '',
    users: '',
    keyFeatures: '',
    dataAndIntegrations: '',
    constraints: '',
    timeline: '',
    assumptions: '',
    attachmentsAcknowledged: false,
    adaptiveTurns: 0,
    lexReferenceFiles: [],
    lexDraftFiles: [],
    lexApprovedFiles: []
  };
  chatConfidence = 0;
  chatMessages.innerHTML = '';
  chatInput.value = '';
  chatAttachmentList.classList.add('hidden');
  chatAttachmentList.innerHTML = '';
  chatGenerateBtn.classList.add('hidden');
  if (chatSupportingFiles) chatSupportingFiles.value = '';
  updateChatConfidence();
  addBotMessage('Hi, I am Ari. We can continue previous user stories that you created, or start something new.');
  addBotMessage('Small privacy note: I can only show user stories created under your signed-in email.');
  renderChatChips([
    { label: 'Continue previous work', value: 'continue' },
    { label: 'Start new', value: 'new' }
  ]);
}

function renderChatChips(items) {
  chatChips.innerHTML = items.map(item => `<button type="button" data-chat-value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</button>`).join('');
  chatChips.querySelectorAll('button').forEach(button => {
    button.addEventListener('click', () => handleChatChoice(button.dataset.chatValue, button.textContent));
  });
}

function clearChatChips() {
  chatChips.innerHTML = '';
}

function setChatBusy(isBusy, message = '') {
  chatBusy = Boolean(isBusy);
  chatInput.disabled = chatBusy;
  chatSendBtn.disabled = chatBusy;
  chatAttachBtn.disabled = chatBusy;
  chatGenerateBtn.disabled = chatBusy;
  chatResetBtn.disabled = chatBusy;
  if (message) setChatStatus(message);
  if (!chatBusy && !message) clearChatStatus();
}

function setChatStatus(message) {
  if (!chatStatusLine) return;
  chatStatusLine.textContent = message || '';
  chatStatusLine.classList.toggle('hidden', !message);
}

function clearChatStatus() {
  setChatStatus('');
}

function addBotMessage(message) {
  appendChatMessage('ari', message);
}

function addUserMessage(message) {
  appendChatMessage('user', message);
}

function appendChatMessage(author, message) {
  const row = document.createElement('div');
  row.className = `chat-message ${author}`;
  row.innerHTML = author === 'ari'
    ? `<img src="/assets/ari-avatar.png" alt=""><div>${escapeHtml(message)}</div>`
    : `<div>${escapeHtml(message)}</div>`;
  chatMessages.appendChild(row);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function handleChatChoice(value, label) {
  if (chatBusy) return;
  addUserMessage(label || value);
  clearChatChips();

  if (chatStep === 'start') {
    if (value === 'continue') {
      await showMyStorySets();
      return;
    }
    askSourceMaterial();
    return;
  }

  if (chatStep === 'source') {
    setSourceMaterial(value);
    return;
  }

  if (chatStep === 'continue-selection') {
    if (value === 'start-new') {
      askSourceMaterial();
      return;
    }
    const story = (chatState.availableStories || []).find(item => item.id === value);
    if (story) {
      applyStorySetToChat(story);
      askPreviousStoryNextStep(story);
    }
    return;
  }

  if (chatStep === 'previous-story-next') {
    if (value === 'previous-use-as-is') {
      usePreviousStoryAsCurrent();
      askSummaryReview();
      return;
    }
    if (value === 'previous-update') {
      askPreviousStoryUpdate();
      return;
    }
    if (value === 'previous-send-lex') {
      usePreviousStoryAsCurrent();
      await startLexHandoffChat();
      return;
    }
    if (value === 'start-new') {
      askSourceMaterial();
      return;
    }
  }

  if (value === 'generate-now') {
    chatGenerateBtn.click();
    return;
  }

  if (chatStep === 'summary-review') {
    if (value === 'summary-ok') {
      await startLexHandoffChat();
      return;
    }
    if (value === 'summary-revise') {
      askSummaryRevision();
      return;
    }
  }

  if (chatStep === 'lex-supplier') {
    if (value === 'lex-use-default-supplier') {
      chatState.lexSupplierConfirmed = true;
      askNextLexQuestion();
      return;
    }
    if (value === 'lex-change-supplier') {
      addBotMessage('Type the supplier entity, signatory name, and title. Example: Devbox Solutions Inc., Romeo Patawaran Jr., Client Manager.');
      return;
    }
  }
}

async function handleChatText(rawValue) {
  if (chatBusy) return;
  const value = rawValue.trim();
  const attachedNames = chatState.attachmentsAcknowledged ? [] : selectedAttachmentNames();
  if (!value && !attachedNames.length) return;
  chatInput.value = '';
  addUserMessage([value, attachedNames.length ? `Attached: ${attachedNames.join(', ')}` : ''].filter(Boolean).join('\n'));

  if (chatStep === 'summary-revision') {
    if (attachedNames.length) {
      chatState.hasFiles = true;
      chatState.attachmentsAcknowledged = true;
    }
    appendToField('assumptions', `User requested Ari summary revision: ${value || `Review attached file(s): ${attachedNames.join(', ')}`}`);
    updateChatConfidence();
    addBotMessage('Understood. I will revise the Ari summary using that correction.');
    chatGenerateBtn.click();
    return;
  }

  if (chatStep === 'source') {
    handleSourceFreeText(value);
    return;
  }

  if (chatStep === 'previous-story-next') {
    if (isNextStepQuestion(value)) {
      askPreviousStoryNextStep(chatState.selectedStory, 'You can use the saved summary as-is, update it with changes, send it to Lex, or start a new request.');
      return;
    }
    if (isPreviousStoryQuestion(value) && chatState.selectedStory) {
      addPreviousStoryRecap(chatState.selectedStory);
      askPreviousStoryNextStep(chatState.selectedStory, 'What would you like to do with that saved Ari package?');
      return;
    }
    appendToField('assumptions', `Continuation note from user: ${value}`);
    preparePreviousStoryUpdateForAnalysis();
    addBotMessage('Got it. I will treat that as an update to the previous Ari package and regenerate the summary.');
    chatStep = 'summary-revision';
    chatGenerateBtn.click();
    return;
  }

  if (chatStep === 'previous-story-update') {
    appendToField('assumptions', `Update to previous Ari package: ${value || `Review attached file(s): ${attachedNames.join(', ')}`}`);
    if (attachedNames.length) {
      chatState.hasFiles = true;
      chatState.attachmentsAcknowledged = true;
    }
    preparePreviousStoryUpdateForAnalysis();
    addBotMessage('Understood. I will update the previous Ari package with that change.');
    chatStep = 'summary-revision';
    chatGenerateBtn.click();
    return;
  }

  if (chatStep && chatStep.startsWith('lex-')) {
    await handleLexChatAnswer(value, attachedNames);
    return;
  }

  if (attachedNames.length) {
    chatState.hasFiles = true;
    chatState.attachmentsAcknowledged = true;
    advanceAfterUpload();
  }
  if (!value) {
    updateChatConfidence();
    if (attachedNames.length) await askAdaptiveQuestionFromContext({ reason: 'attachment' });
    return;
  }

  if (attachedNames.length) {
    captureChatValue(value);
    updateChatConfidence();
    await askAdaptiveQuestionFromContext({ reason: 'attachment', recentAnswer: value, answeredStep: chatStep });
    return;
  }

  const answeredStep = chatStep;
  captureChatValue(value);
  updateChatConfidence();
  if (shouldAskAdaptiveAfterAnswer(answeredStep, value)) {
    await askAdaptiveQuestionFromContext({ reason: 'answer', recentAnswer: value, answeredStep });
    return;
  }
  askNextStepAfterAnswer(answeredStep);
}

function captureChatValue(value) {
  switch (chatStep) {
    case 'customer':
      chatState.customerName = value;
      break;
    case 'requester':
      parseRequesterLine(value);
      break;
    case 'project':
      chatState.toolName = value;
      break;
    case 'existing-reference':
      chatState.existingToolReference = value;
      break;
    case 'problem':
      if (chatState.hasFiles && /\b(process|flow|diagram|journey|attached|screenshot)\b/i.test(value)) {
        appendToField('keyFeatures', `Supporting attachment note: ${value}`);
      } else {
        chatState.businessProblem = value;
      }
      break;
    case 'outcome':
      chatState.desiredOutcome = value;
      break;
    case 'users':
      chatState.users = value;
      break;
    case 'features':
      chatState.keyFeatures = value;
      break;
    case 'process':
      appendToField('keyFeatures', `Process flow / handoff: ${value}`);
      break;
    case 'data':
      chatState.dataAndIntegrations = value;
      break;
    case 'constraints':
      chatState.constraints = value;
      break;
    case 'timeline':
      parseTimelineLine(value);
      break;
    case 'document-label':
      chatState.customerName = value;
      break;
    case 'document-project':
      chatState.toolName = value;
      break;
    case 'document-notes':
      appendDocumentNotes(value);
      break;
    case 'adaptive':
      captureAdaptiveAnswer(value);
      break;
    default:
      appendToField('assumptions', value);
  }
}

function captureAdaptiveAnswer(value) {
  const question = chatState.lastAdaptiveQuestion || 'Ari follow-up';
  const normalized = question.toLowerCase();
  const entry = `${question}: ${value}`;
  if (/role|who.*use|user|stakeholder|team|approver|operator|admin/.test(normalized)) {
    appendToField('users', value);
    appendToField('keyFeatures', entry);
    return;
  }
  if (/outcome|result|success|benefit|once this works/.test(normalized)) {
    appendToField('desiredOutcome', value);
    return;
  }
  if (/process|flow|first|next|last|handoff|journey|approval|step/.test(normalized)) {
    appendToField('keyFeatures', `Process flow / handoff: ${value}`);
    return;
  }
  if (/data|report|dashboard|export|integration|system|source/.test(normalized)) {
    appendToField('dataAndIntegrations', value);
    return;
  }
  if (/constraint|policy|access|deadline|risk|dependency|security|approval/.test(normalized)) {
    appendToField('constraints', value);
    return;
  }
  if (/feature|activity|must.*have|function|capabilit/.test(normalized)) {
    appendToField('keyFeatures', value);
    return;
  }
  appendToField('keyFeatures', entry);
}

async function askAdaptiveQuestionFromContext({ reason, recentAnswer = '', answeredStep = '' } = {}) {
  chatSendBtn.disabled = true;
  chatAttachBtn.disabled = true;
  setChatStatus(reason === 'attachment'
    ? 'Ari is reading the attachment and checking what it already explains...'
    : 'Ari is adapting the next question to what you just said...');
  try {
    const body = buildChatPartialFormData({ recentAnswer, answeredStep });
    body.set('chatPartial', 'true');
    const response = await fetch('/api/clarifying-question-jobs', {
      method: 'POST',
      body,
      headers: { Accept: 'application/json' }
    });
    const payload = await parseApiResponse(response);
    if (!response.ok) throw new Error(payload.message);
    const jobId = payload.job?.id;
    if (!jobId) throw new Error('Ari did not return a question job id.');
    const completedJob = await pollClarificationJob(jobId, {
      onProgress: elapsedSeconds => setChatStatus(`Ari is reading and adapting... ${elapsedSeconds}s`)
    });
    clearChatStatus();
    const nextQuestion = completedJob.questions?.[0]?.question;
    if (nextQuestion) {
      chatState.adaptiveTurns = Number(chatState.adaptiveTurns || 0) + 1;
      chatStep = 'adaptive';
      chatState.lastAdaptiveQuestion = nextQuestion;
      addBotMessage(nextQuestion);
      return;
    }
    addBotMessage('The attachment answered the next obvious gaps. I can generate the Ari summary now, or you can add anything else you want me to consider.');
    finishChatIntake();
  } catch (error) {
    clearChatStatus();
    addBotMessage(`I could not read the attachment cleanly yet: ${error.message}`);
    askNextMissingQuestion();
  } finally {
    clearChatStatus();
    chatSendBtn.disabled = false;
    chatAttachBtn.disabled = false;
  }
}

function shouldAskAdaptiveAfterAnswer(step, value) {
  if (!value || /^none$|not sure|unknown|n\/a$/i.test(value.trim())) return false;
  if (chatState.adaptiveTurns >= 4) return false;
  return [
    'problem',
    'outcome',
    'users',
    'features',
    'process',
    'data',
    'constraints',
    'document-notes',
    'adaptive'
  ].includes(step);
}

function askNextStepAfterAnswer(step) {
  switch (step) {
    case 'customer':
      askRequester();
      break;
    case 'requester':
      askProjectName();
      break;
    case 'project':
      askExistingToolReference();
      break;
    case 'existing-reference':
      askBusinessProblem();
      break;
    case 'document-label':
      askDocumentProjectLabel();
      break;
    case 'document-project':
      askDocumentNotes();
      break;
    case 'timeline':
    case 'document-notes':
      finishChatIntake();
      break;
    default:
      askNextMissingQuestion();
  }
}

function askNextMissingQuestion() {
  if (!chatState.customerName || chatState.customerName === 'Not provided yet') return askCustomer();
  if (!chatState.toolName || chatState.toolName === 'Ari chat intake in progress') return askProjectName();
  if (chatState.projectType === 'extension' && !chatState.existingToolReference) return askExistingToolReference();
  if (!chatState.businessProblem) return askBusinessProblem();
  if (!chatState.desiredOutcome) return askOutcome();
  if (!chatState.users) return askUsers();
  if (!chatState.keyFeatures) return askFeatures();
  if (!chatState.dataAndIntegrations) return askDataIntegrations();
  if (!chatState.constraints) return askConstraints();
  if (!chatState.timeline) return askTimelineAssumptions();
  finishChatIntake();
}

async function showMyStorySets() {
  chatStep = 'continue-selection';
  addBotMessage('Let me check the user stories created under your signed-in email.');
  try {
    const payload = await json('/api/my-user-stories', { method: 'GET' });
    const stories = payload.stories || [];
    chatState.availableStories = stories;
    if (!payload.storageConfigured) {
      addBotMessage('MongoDB storage is not configured yet, so I cannot retrieve previous user stories here.');
      askSourceMaterial();
      return;
    }
    if (!stories.length) {
      addBotMessage(payload.reason || 'I did not find previous user stories under your signed-in email. We can start a new one.');
      askSourceMaterial();
      return;
    }
    addBotMessage('Here are the most recent story sets I can show you.');
    renderChatChips([
      ...stories.slice(0, 6).map(story => ({
        label: `${story.customerName} - ${story.projectName || 'Untitled'} (${formatShortDate(story.createdAt)})`,
        value: story.id
      })),
      { label: 'Start new instead', value: 'start-new' }
    ]);
  } catch (error) {
    addBotMessage(`I could not load prior stories right now: ${error.message}`);
    askSourceMaterial();
  }
}

function applyStorySetToChat(story) {
  chatState.selectedStory = story;
  chatState.sourceMaterial = 'previous-story';
  chatState.contractPath = story.contractPath || 'details';
  chatState.projectType = story.projectType || 'new-tool';
  chatState.customerName = story.customerName || '';
  chatState.toolName = story.projectName || '';
  chatState.businessProblem = story.summary || '';
  chatState.desiredOutcome = inferOutcomeFromStory(story);
  chatState.users = inferUsersFromStory(story);
  chatState.keyFeatures = [
    ...(story.userStories || []).map(item => `As a ${item.role}, I want ${item.goal}, so that ${item.benefit}.`),
    story.processFlow?.summary ? `Previous process flow: ${story.processFlow.summary}` : ''
  ].filter(Boolean).join('\n');
  chatState.assumptions = `Continuing from Ari story set ${story.id}. Prior confidence: ${story.confidence || 'not stated'}.`;
  addBotMessage(`Okay. I will use the previous ${story.customerName} / ${story.projectName || 'project'} context as a starting point.`);
  updateChatConfidence();
}

function askPreviousStoryNextStep(story, prompt = '') {
  chatStep = 'previous-story-next';
  chatGenerateBtn.classList.add('hidden');
  addPreviousStoryRecap(story);
  addBotMessage(prompt || 'This one already has a saved Ari package. What would you like to do next?');
  renderChatChips([
    { label: 'Use last summary', value: 'previous-use-as-is' },
    { label: 'Update it', value: 'previous-update' },
    { label: 'Send to Lex', value: 'previous-send-lex' },
    { label: 'Start new instead', value: 'start-new' }
  ]);
}

function askPreviousStoryUpdate() {
  chatStep = 'previous-story-update';
  addBotMessage('What changed since the last Ari summary? You can type it in plain language or attach an updated document/diagram.');
}

function preparePreviousStoryUpdateForAnalysis() {
  const previousPath = chatState.contractPath || 'details';
  chatState.previousStoryUpdate = true;
  chatState.sourceMaterial = 'previous-story-update';
  chatState.contractPath = 'details';
  chatState.projectType = chatState.projectType || 'new-tool';
  appendToField('assumptions', `Previous saved Ari package came from contract path "${previousPath}". This update should refresh Ari's analysis from saved context and new user inputs; do not require the original draft/supporting file unless the user attaches one now.`);
}

function usePreviousStoryAsCurrent() {
  const story = chatState.selectedStory;
  if (!story) return;
  lastAnalysis = story.analysisSnapshot || buildAnalysisFromStory(story);
  lastSavedStorySet = story;
  commitChatStateToForm();
  lastIntake = readIntake();
  renderAnalysis(lastAnalysis, lastSavedStorySet);
  prepareLexForm();
  status('Loaded previous Ari package.', false, true);
}

function buildAnalysisFromStory(story) {
  return {
    projectClassification: story.projectType || 'Previous Ari package',
    totalMinDays: story.totalMinDays || 0,
    totalMaxDays: story.totalMaxDays || 0,
    executiveSummary: story.summary || '',
    confidence: story.confidence || 'saved',
    interpretedScope: story.summary ? [story.summary] : [],
    technicalApproach: [],
    processFlow: story.processFlow || { title: 'Process Flow', summary: '', steps: [] },
    draftedUserStories: story.userStories || [],
    meanIonicFit: { frontend: '', backend: '', database: '', mobile: '' },
    workPackages: story.workPackages || [],
    assumptions: story.assumptions || [],
    risks: story.risks || [],
    openQuestions: story.openQuestions || [],
    recommendation: story.recommendation || ''
  };
}

function handleSourceFreeText(value) {
  if (isPreviousStoryQuestion(value) && chatState.selectedStory) {
    addPreviousStoryRecap(chatState.selectedStory);
    askPreviousStoryNextStep(chatState.selectedStory, 'What would you like to do with that saved Ari package?');
    return;
  }
  if (chatState.selectedStory) {
    appendToField('assumptions', `Continuation note from user: ${value}`);
    askPreviousStoryNextStep(chatState.selectedStory, 'Got it. I will carry that forward with the previous story context. What would you like to do next?');
    return;
  }
  addBotMessage('Please choose one of the options below so I know whether this is from scratch, from documents, an approved contract, or an existing tool.');
  askSourceMaterial();
}

function isPreviousStoryQuestion(value) {
  return /\b(last|previous|prior|recap|summary|where.*left|what.*had|what.*generated|what.*story|what.*done)\b/i.test(String(value || ''));
}

function isNextStepQuestion(value) {
  return /\b(what.*next|next step|do next|where.*go|how.*proceed|proceed|continue)\b/i.test(String(value || ''));
}

function addPreviousStoryRecap(story) {
  const stories = Array.isArray(story.userStories) ? story.userStories : [];
  const storyPreview = stories.slice(0, 3).map(item => {
    const role = item.role || 'user';
    const goal = item.goal || 'the requested capability';
    const benefit = item.benefit || 'the business outcome is achieved';
    return `As a ${role}, I want ${goal}, so that ${benefit}.`;
  });
  const pieces = [
    `Last Ari summary for ${story.customerName || 'this customer'} / ${story.projectName || 'this project'}: ${story.summary || 'No summary text was saved.'}`,
    story.totalMinDays || story.totalMaxDays ? `Prior estimate: ${story.totalMinDays || 0}-${story.totalMaxDays || 0} mandays, ${story.confidence || 'confidence not stated'}.` : '',
    story.processFlow?.summary ? `Process flow: ${story.processFlow.summary}` : '',
    storyPreview.length ? `User stories captured: ${storyPreview.join(' ')}` : '',
    Array.isArray(story.openQuestions) && story.openQuestions.length ? `Open questions: ${story.openQuestions.slice(0, 3).join(' ')}` : ''
  ].filter(Boolean);
  addBotMessage(pieces.join('\n\n'));
}

function inferOutcomeFromStory(story) {
  const benefits = (story.userStories || []).map(item => item.benefit).filter(Boolean);
  return benefits.slice(0, 4).join('\n');
}

function inferUsersFromStory(story) {
  const roles = (story.userStories || []).map(item => item.role).filter(Boolean);
  return Array.from(new Set(roles)).join(', ');
}

function askSourceMaterial() {
  chatStep = 'source';
  chatGenerateBtn.classList.add('hidden');
  addBotMessage('What should I base this on?');
  renderChatChips([
    { label: 'Start from scratch', value: 'scratch' },
    { label: 'Draft or supporting docs', value: 'draft' },
    { label: 'Approved contract to read', value: 'approved' },
    { label: 'Existing tool or repository', value: 'extension' }
  ]);
}

function setSourceMaterial(value) {
  chatState.sourceMaterial = value;
  updateChatConfidence();
  if (value === 'draft') {
    chatState.contractPath = 'refine';
    chatState.projectType = 'new-tool';
    addBotMessage('Please upload the draft or supporting document. I will read it first and only ask what remains unclear.');
    chatStep = 'document-label';
    if (!chatState.customerName) addBotMessage('While that uploads, who is the customer?');
    else askDocumentProjectLabel();
    return;
  }
  if (value === 'approved') {
    chatState.contractPath = 'approved-upload';
    chatState.projectType = 'new-tool';
    addBotMessage('Please upload the approved contract. I will not change the signed contract; I will read it for metadata, billing milestones, obligations, and next-stage handoff.');
    chatStep = 'document-label';
    if (!chatState.customerName) addBotMessage('Who should I label this approved contract under?');
    else askDocumentProjectLabel();
    return;
  }
  if (value === 'extension') {
    chatState.contractPath = 'details';
    chatState.projectType = 'extension';
    if (!chatState.customerName) askCustomer();
    else askProjectName();
    return;
  }
  chatState.contractPath = 'details';
  chatState.projectType = 'new-tool';
  if (!chatState.customerName) askCustomer();
  else askProjectName();
}

function askCustomer() {
  chatStep = 'customer';
  addBotMessage('Who is the customer for this request?');
}

function askRequester() {
  chatStep = 'requester';
  addBotMessage('Who is requesting this, and what business unit are they from? If you do not know, you can say "not sure".');
}

function askProjectName() {
  chatStep = 'project';
  addBotMessage('What should we call this tool or project? A working name is fine.');
}

function askExistingToolReference() {
  if (chatState.projectType !== 'extension') {
    askBusinessProblem();
    return;
  }
  chatStep = 'existing-reference';
  addBotMessage('Please share the existing repository, documentation link, or a short description of where the current tool lives.');
}

function askBusinessProblem() {
  chatStep = 'problem';
  addBotMessage('What business problem should this solve? Say it in everyday language.');
}

function askOutcome() {
  chatStep = 'outcome';
  addBotMessage('What outcome should users get once this works?');
}

function askUsers() {
  chatStep = 'users';
  addBotMessage('Who will use it? Roles or teams are enough.');
}

function askFeatures() {
  chatStep = 'features';
  addBotMessage('What are the must-have features or activities? Bullet-style text is fine.');
}

function askProcessFlow() {
  chatStep = 'process';
  addBotMessage('If there is a process flow, what happens first, next, and last? You can also attach a process diagram here instead of typing it out. If there is no real workflow, say "none".');
}

function renderAttachmentList(names) {
  chatAttachmentList.classList.toggle('hidden', !names.length);
  chatAttachmentList.innerHTML = names.map(name => `<span>${escapeHtml(name)}</span>`).join('');
}

function selectedAttachmentNames() {
  return Array.from(chatSupportingFiles?.files || []).map(file => file.name);
}

function askDataIntegrations() {
  chatStep = 'data';
  addBotMessage('Any data, reports, dashboards, exports, or integrations Ari should consider?');
}

function askConstraints() {
  chatStep = 'constraints';
  addBotMessage('Any constraints, policies, access rules, deadlines, or risks? "Not sure" is okay.');
}

function askTimelineAssumptions() {
  chatStep = 'timeline';
  addBotMessage('Last one before I can summarize: any target timeline or assumptions Ari should include?');
}

function askDocumentProjectLabel() {
  chatStep = 'document-project';
  addBotMessage('What project name or contract label should I use? If it is obvious from the document, you can say "infer from document".');
}

function askDocumentNotes() {
  chatStep = 'document-notes';
  const approved = chatState.contractPath === 'approved-upload';
  addBotMessage(approved
    ? 'Any internal notes for metadata tracking, billing, renewal, or finance handoff? If none, say "none".'
    : 'Anything you want Ari to pay special attention to in the draft? If none, say "none".');
}

function advanceAfterUpload() {
  updateChatConfidence();
  if (chatStep === 'source') {
    chatStep = 'document-label';
    addBotMessage('Who is the customer for this document?');
  }
}

function finishChatIntake() {
  commitChatStateToForm();
  updateChatConfidence();
  addBotMessage(`I am at ${chatConfidence}% confidence for an initial Ari package. We cannot be 100% at this stage, but this should be enough for a useful first summary if you want to proceed.`);
  chatGenerateBtn.classList.remove('hidden');
  renderChatChips([
    { label: 'Generate summary now', value: 'generate-now' }
  ]);
}

function askSummaryReview() {
  chatStep = 'summary-review';
  chatGenerateBtn.classList.add('hidden');
  clearChatChips();
  addBotMessage('Are you happy with this Ari summary so I can send it to Lex for contracting and to the rest of the team for reference?');
  renderChatChips([
    { label: 'Yes, send to Lex', value: 'summary-ok' },
    { label: 'Revise summary', value: 'summary-revise' }
  ]);
}

function askSummaryRevision() {
  chatStep = 'summary-revision';
  addBotMessage('What should I change or add? You can type the correction in plain language, or attach a file and tell me what to use it for.');
}

async function startLexHandoffChat() {
  if (!lastAnalysis || !lastIntake) {
    addBotMessage('I need to generate the Ari summary first before I can send anything to Lex.');
    return;
  }
  prepareLexForm();
  lexForm.classList.add('hidden');
  clearChatChips();
  addBotMessage('Great. I will collect only the Lex details that are still missing.');
  askNextLexQuestion();
}

function askNextLexQuestion() {
  const mode = currentLexMode();
  updateLexMode();
  if (mode === 'refine' && !getDocumentLedSourceFile() && !chatState.lexDraftFiles.length) {
    chatStep = 'lex-draft-file';
    addBotMessage('Please attach the draft contract Lex should refine, then press Send.');
    return;
  }
  if (mode === 'approved-upload' && !getDocumentLedSourceFile() && !chatState.lexApprovedFiles.length) {
    chatStep = 'lex-approved-file';
    addBotMessage('Please attach the approved contract Lex should record, then press Send.');
    return;
  }
  if (mode !== 'approved-upload' && !chatState.lexSupplierConfirmed) {
    chatStep = 'lex-supplier';
    addBotMessage(`For Lex, should I use ${supplierEntity.value}, signed by ${signatoryName.value} (${signatoryTitle.value})?`);
    renderChatChips([
      { label: 'Use default supplier', value: 'lex-use-default-supplier' },
      { label: 'I will type changes', value: 'lex-change-supplier' }
    ]);
    return;
  }
  if (mode !== 'approved-upload' && !chatState.lexCommercialsConfirmed) {
    chatStep = 'lex-commercials';
    addBotMessage('What daily rate should Lex use? Default is PHP 10,000/day. Also mention monthly running/support cost if any; otherwise say "default".');
    return;
  }
  if (mode === 'details' && !chatState.lexReferenceConfirmed) {
    chatStep = 'lex-reference';
    addBotMessage('Do you have a reference contract or user-story file for Lex? Attach it here and press Send, or say "none".');
    return;
  }
  if (mode === 'refine' && !chatState.lexRefineNotesConfirmed) {
    chatStep = 'lex-refine-notes';
    addBotMessage('Any notes for Lex on how to refine the draft? If none, say "none".');
    return;
  }
  if (mode === 'approved-upload' && !chatState.lexApprovedNotesConfirmed) {
    chatStep = 'lex-approved-notes';
    addBotMessage('Any metadata, billing, renewal, or finance handoff notes Lex should know for this approved contract? If none, say "none".');
    return;
  }
  if (!chatState.lexFinalNotesConfirmed) {
    chatStep = 'lex-final-notes';
    addBotMessage('Anything else Lex or the project team should know before I send this? If none, say "none".');
    return;
  }
  sendLexFromChat();
}

async function handleLexChatAnswer(value, attachedNames) {
  if (chatStep === 'lex-draft-file') {
    if (attachedNames.length) {
      chatState.lexDraftFiles = currentChatFiles();
      chatState.attachmentsAcknowledged = true;
      askNextLexQuestion();
      return;
    }
    addBotMessage('Please attach the draft file first, or tell me where it is if you cannot upload it here.');
    return;
  }
  if (chatStep === 'lex-approved-file') {
    if (attachedNames.length) {
      chatState.lexApprovedFiles = currentChatFiles();
      chatState.attachmentsAcknowledged = true;
      askNextLexQuestion();
      return;
    }
    addBotMessage('Please attach the approved contract first, or tell me where it is if you cannot upload it here.');
    return;
  }
  if (chatStep === 'lex-supplier') {
    applySupplierAnswer(value);
    chatState.lexSupplierConfirmed = true;
    clearChatChips();
    askNextLexQuestion();
    return;
  }
  if (chatStep === 'lex-commercials') {
    applyCommercialsAnswer(value);
    chatState.lexCommercialsConfirmed = true;
    askNextLexQuestion();
    return;
  }
  if (chatStep === 'lex-reference') {
    if (attachedNames.length) {
      chatState.lexReferenceFiles = currentChatFiles();
      chatState.attachmentsAcknowledged = true;
    }
    chatState.lexReferenceConfirmed = true;
    askNextLexQuestion();
    return;
  }
  if (chatStep === 'lex-refine-notes') {
    if (!isNoneAnswer(value)) lexForm.refinementNotes.value = appendLines(lexForm.refinementNotes.value, value);
    chatState.lexRefineNotesConfirmed = true;
    askNextLexQuestion();
    return;
  }
  if (chatStep === 'lex-approved-notes') {
    if (!isNoneAnswer(value)) lexForm.approvedImportNotes.value = appendLines(lexForm.approvedImportNotes.value, value);
    chatState.lexApprovedNotesConfirmed = true;
    askNextLexQuestion();
    return;
  }
  if (chatStep === 'lex-final-notes') {
    if (!isNoneAnswer(value)) lexForm.notesForLex.value = appendLines(lexForm.notesForLex.value, value);
    chatState.lexFinalNotesConfirmed = true;
    askNextLexQuestion();
  }
}

function currentChatFiles() {
  return Array.from(chatSupportingFiles?.files || []);
}

function isNoneAnswer(value) {
  return /^none$|^default$|not sure|unknown|n\/a/i.test(String(value || '').trim());
}

function isAffirmativeAnswer(value) {
  return /^(yes|yep|yeah|ok|okay|correct|use default|default|that's fine|that is fine)$/i.test(String(value || '').trim());
}

function applySupplierAnswer(value) {
  if (isNoneAnswer(value) || isAffirmativeAnswer(value) || /use default/i.test(value)) return;
  const parts = value.split(/,| - |\n/).map(part => part.trim()).filter(Boolean);
  if (parts[0]) supplierEntity.value = parts[0];
  if (parts[1]) signatoryName.value = parts[1];
  if (parts[2]) signatoryTitle.value = parts.slice(2).join(' ');
}

function applyCommercialsAnswer(value) {
  const text = String(value || '');
  const rateMatch = text.match(/(?:php|p|₱)?\s*([0-9][0-9,]*(?:\.\d+)?)\s*(?:\/?\s*day|per day|daily|rate)?/i);
  const monthlyMatch = text.match(/monthly[^0-9]*(?:php|p|₱)?\s*([0-9][0-9,]*(?:\.\d+)?)/i);
  finalDayRate.value = rateMatch ? rateMatch[1].replace(/,/g, '') : String(defaultDayRate);
  if (monthlyMatch) lexForm.monthlyRunningCost.value = monthlyMatch[1].replace(/,/g, '');
  if (/no monthly|none|default|zero/i.test(text)) lexForm.monthlyRunningCost.value = '0';
}

function parseRequesterLine(value) {
  if (/not sure|unknown|none/i.test(value)) return;
  const parts = value.split(/,| - | from /i).map(part => part.trim()).filter(Boolean);
  chatState.requesterName = parts[0] || value;
  chatState.businessUnit = parts.slice(1).join(' ') || '';
}

function parseTimelineLine(value) {
  if (/not sure|unknown|none/i.test(value)) return;
  chatState.timeline = value;
}

function appendDocumentNotes(value) {
  if (/^none$|not sure|unknown/i.test(value)) return;
  if (chatState.contractPath === 'approved-upload') {
    chatState.assumptions = appendLines(chatState.assumptions, `Approved contract metadata notes: ${value}`);
  } else {
    chatState.constraints = appendLines(chatState.constraints, `Draft review notes: ${value}`);
  }
}

function appendToField(field, value) {
  if (/^none$|not sure|unknown/i.test(value)) return;
  chatState[field] = appendLines(chatState[field], value);
}

function appendLines(existing, next) {
  return [existing, next].filter(Boolean).join('\n');
}

function updateChatConfidence() {
  chatConfidence = calculateChatConfidence();
  chatConfidenceLabel.textContent = `${chatConfidence}%`;
  chatConfidenceBar.style.width = `${chatConfidence}%`;
  chatConfidenceText.textContent = confidenceText(chatConfidence);
}

function calculateChatConfidence() {
  let score = 0;
  if (chatState.customerName) score += 12;
  if (chatState.sourceMaterial) score += 10;
  if (chatState.toolName) score += 10;
  if (chatState.hasFiles) score += chatState.contractPath === 'details' ? 12 : 30;
  if (chatState.existingToolReference) score += 12;
  if (chatState.businessProblem) score += 12;
  if (chatState.desiredOutcome) score += 12;
  if (chatState.users) score += 8;
  if (chatState.keyFeatures) score += 14;
  if (chatState.dataAndIntegrations) score += 6;
  if (chatState.constraints) score += 4;
  if (chatState.timeline) score += 2;
  return Math.max(0, Math.min(90, score));
}

function confidenceText(value) {
  if (value >= 80) return 'This is enough for an initial scope, estimate, and Lex-ready handoff. Later delivery discovery can refine the last details.';
  if (value >= 60) return 'Ari has the shape of the request. A few more details may sharpen scope, risk, or cost.';
  if (value >= 35) return 'Ari understands the direction, but still needs core context before estimating responsibly.';
  return 'Ari will aim for a useful 80% view, not perfect certainty.';
}

function commitChatStateToForm() {
  setRadioValue('contractPath', chatState.contractPath || 'details');
  setRadioValue('projectType', chatState.projectType || 'new-tool');
  setFormValue('customerName', chatState.customerName || 'Customer not provided');
  setFormValue('requesterName', chatState.requesterName);
  setFormValue('businessUnit', chatState.businessUnit);
  setFormValue('toolName', chatState.toolName || inferToolNameFromChat());
  setFormValue('existingToolReference', chatState.existingToolReference);
  setFormValue('businessProblem', chatState.businessProblem);
  setFormValue('desiredOutcome', chatState.desiredOutcome);
  setFormValue('users', chatState.users);
  setFormValue('keyFeatures', chatState.keyFeatures);
  setFormValue('dataAndIntegrations', chatState.dataAndIntegrations);
  setFormValue('constraints', chatState.constraints);
  setFormValue('timeline', chatState.timeline);
  setFormValue('assumptions', appendLines(chatState.assumptions, `Ari chat confidence before analysis: ${chatConfidence}%. Ari targets an initial 80% view, not 100% certainty.`));
  syncMode();
  syncContractPath();
}

function setFormValue(name, value) {
  const field = form.elements[name];
  if (field) field.value = value || '';
}

function setRadioValue(name, value) {
  const input = form.querySelector(`input[name="${name}"][value="${CSS.escape(value)}"]`);
  if (input) input.checked = true;
}

function inferToolNameFromChat() {
  if (chatState.contractPath === 'approved-upload') return 'Approved contract metadata';
  if (chatState.contractPath === 'refine') return 'Draft contract refinement';
  return 'Ari analysis';
}

function buildAnalysisFormData() {
  commitChatStateToForm();
  const body = new FormData(form);
  if (chatState.previousStoryUpdate) {
    body.set('previousStoryUpdate', 'true');
    body.set('contractPath', 'details');
  }
  if (chatSupportingFiles?.files?.length) {
    body.delete('supportingFiles');
    Array.from(chatSupportingFiles.files).forEach(file => {
      body.append('supportingFiles', file, file.name);
    });
  }
  return body;
}

function buildChatPartialFormData({ recentAnswer = '', answeredStep = '' } = {}) {
  const body = buildAnalysisFormData();
  body.set('chatPartial', 'true');
  if (recentAnswer || answeredStep) {
    const currentAssumptions = String(body.get('assumptions') || '');
    body.set('assumptions', appendLines(
      currentAssumptions,
      `Recent chat answer (${answeredStep || 'chat'}): ${recentAnswer || 'Attachment uploaded without text.'}`
    ));
  }
  return body;
}

function formatShortDate(value) {
  if (!value) return 'recent';
  try {
    return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return 'recent';
  }
}

async function askClarifyingQuestions() {
  submitBtn.disabled = true;
  status('Ari is checking whether a few details would sharpen the estimate...');
  output.className = 'empty-state';
  output.textContent = 'Ari is reading the request before estimating.';
  copyBtn.classList.add('hidden');
  showLexBtn.classList.add('hidden');
  lexForm.classList.add('hidden');

  try {
    const response = await fetch('/api/clarifying-question-jobs', {
      method: 'POST',
      body: buildAnalysisFormData(),
      headers: { Accept: 'application/json' }
    });
    const payload = await parseApiResponse(response);
    if (!response.ok) throw new Error(payload.message);
    const jobId = payload.job?.id;
    if (!jobId) throw new Error('Ari did not return a question job id.');
    const completedJob = await pollClarificationJob(jobId);
    clarificationQuestions = completedJob.questions || [];
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

async function pollClarificationJob(jobId, options = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 600000) {
    const payload = await json(`/api/clarifying-question-jobs/${encodeURIComponent(jobId)}`, { method: 'GET' });
    const job = payload.job;
    if (!job) throw new Error('Ari question job status was not returned.');
    if (job.status === 'FAILED') throw new Error(job.message || 'Ari could not prepare clarifying questions.');
    if (job.status === 'COMPLETE') return job;
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    if (typeof options.onProgress === 'function') {
      options.onProgress(elapsedSeconds, job);
    } else {
      status(`Ari is reading the document before asking questions... ${elapsedSeconds}s`);
      output.textContent = job.message || 'Ari is still reading the document.';
    }
    await wait(2500);
  }
  throw new Error('Ari is still reading the document. Please try again or use the full browser view for this upload.');
}

async function generateAnalysis() {
  setChatBusy(true, 'Ari is generating the summary...');
  submitBtn.disabled = true;
  skipQuestionsBtn.disabled = true;
  status('Preparing technical analysis...');
  output.className = 'empty-state';
  output.textContent = 'Ari is estimating the work with the available answers.';
  copyBtn.classList.add('hidden');
  showLexBtn.classList.add('hidden');
  lexForm.classList.add('hidden');

  try {
    const body = buildAnalysisFormData();
    body.set('clarificationAnswers', JSON.stringify(readClarificationAnswers()));
    const response = await fetch('/api/analysis-jobs', {
      method: 'POST',
      body,
      headers: { Accept: 'application/json' }
    });
    const payload = await parseApiResponse(response);
    if (!response.ok) throw new Error(payload.message);
    const jobId = payload.job?.id;
    if (!jobId) throw new Error('Ari did not return an analysis job id.');
    const completedJob = await pollAnalysisJob(jobId);
    lastAnalysis = completedJob.analysis;
    lastSavedStorySet = completedJob.savedStorySet || null;
    lastIntake = readIntake();
    lastIntake.clarificationAnswers = readClarificationAnswers();
    renderAnalysis(completedJob.analysis, lastSavedStorySet);
    prepareLexForm();
    status('Analysis ready.', false, true);
    askSummaryReview();
  } catch (error) {
    status(error.message, true);
    output.className = 'empty-state error-box';
    output.textContent = error.message;
    addBotMessage(`I could not generate the summary yet: ${error.message}`);
  } finally {
    submitBtn.disabled = false;
    skipQuestionsBtn.disabled = false;
    setChatBusy(false);
  }
}

async function pollAnalysisJob(jobId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 900000) {
    const payload = await json(`/api/analysis-jobs/${encodeURIComponent(jobId)}`, { method: 'GET' });
    const job = payload.job;
    if (!job) throw new Error('Ari analysis job status was not returned.');
    if (job.status === 'FAILED') throw new Error(job.message || 'Ari analysis failed.');
    if (job.status === 'COMPLETE') {
      if (!job.analysis) throw new Error('Ari completed without returning an analysis.');
      return job;
    }
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    status(`Ari is reading and analyzing the document... ${elapsedSeconds}s`);
    setChatStatus(`Ari is generating the summary... ${elapsedSeconds}s`);
    output.textContent = job.message || 'Ari is still working on the analysis.';
    await wait(3000);
  }
  throw new Error('Ari is still analyzing the document. Please check the server job status or try a smaller file.');
}

showLexBtn.addEventListener('click', () => {
  lexForm.classList.toggle('hidden');
  hideRatePanel();
});

lexForm.addEventListener('submit', async event => {
  event.preventDefault();
  await submitLexHandoff({ fromChat: false });
});

async function sendLexFromChat() {
  addBotMessage('Give me a minute while I send this to Lex. This may take 1-2 minutes, so coffee timing is honestly pretty good. I will redirect you to Lex when it is done, and I will keep the contract number handy.');
  await submitLexHandoff({ fromChat: true });
}

async function submitLexHandoff({ fromChat = false } = {}) {
  if (!lastAnalysis || !lastIntake) return;
  const draftingMode = currentLexMode();
  const needsRate = draftingMode !== 'approved-upload';
  if (needsRate && ratePanel.classList.contains('hidden')) {
    if (fromChat) {
      ratePanel.classList.remove('hidden');
      if (!finalDayRate.value) finalDayRate.value = String(defaultDayRate);
    } else {
      showRatePanel();
      return;
    }
  }
  sendLexBtn.disabled = true;
  setChatBusy(true, 'Sending to Lex...');
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
    appendChatLexFiles(body, draftingMode);
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
    await pollLexJob(jobId, { fromChat });
  } catch (error) {
    lexStatus.textContent = error.message;
    lexStatus.className = 'status error';
    if (fromChat) addBotMessage(`Lex handoff did not finish yet: ${error.message}`);
  } finally {
    sendLexBtn.disabled = false;
    setChatBusy(false);
  }
}

async function pollLexJob(jobId, { fromChat = false } = {}) {
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
        lexApiBaseUrl: payload.lexApiBaseUrl,
        autoRedirect: fromChat
      });
      return;
    }
    const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    lexStatus.textContent = `Lex is processing the contract... ${job.status.toLowerCase()} (${elapsedSeconds}s)`;
    if (fromChat) setChatStatus(`Lex is preparing the contract... ${elapsedSeconds}s`);
    await wait(3000);
  }
  throw new Error('Lex contract generation is still running. Open contract-bot and check the Lex job status.');
}

function showLexHandoffComplete({ contractId, redirectUrl, lexApiBaseUrl, autoRedirect = false }) {
  const label = contractId || 'the new Lex contract';
  chatState.lastLexContractId = contractId || '';
  lexStatus.className = 'status ok lex-handoff-complete';
  lexStatus.innerHTML = `
    <strong>Lex now has the details and drafted the contract.</strong>
    <span>Continue in Lex with contract ${escapeHtml(label)} for review, refinement, approval, and tracking.</span>
    <button type="button" id="openLexHandoffBtn">Continue in Lex</button>
  `;

  document.getElementById('openLexHandoffBtn')?.addEventListener('click', () => {
    openLexHandoff({ contractId, redirectUrl, lexApiBaseUrl });
  });

  addBotMessage(`Lex is ready. Contract number: ${label}. I am redirecting you now.`);

  if (isPortalEmbed && window.parent !== window) {
    window.parent.postMessage({
      type: 'ari:lex-handoff-ready',
      contractId,
      redirectUrl,
      lexApiBaseUrl
    }, window.location.origin);
  }

  if (autoRedirect) {
    setTimeout(() => openLexHandoff({ contractId, redirectUrl, lexApiBaseUrl }), 1200);
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
  if (event.target.closest('.chat-shell') || event.target.closest('#questionsPanel') || event.target.closest('#lexForm')) return;
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
  showLexBtn.classList.add('hidden');
}

function readIntake() {
  const data = new FormData(form);
  return {
    contractPath: data.get('contractPath') || '',
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

function appendChatLexFiles(body, draftingMode) {
  if (draftingMode === 'details') {
    chatState.lexReferenceFiles.forEach((file, index) => {
      body.append(index === 0 ? 'referenceContract' : 'userStoriesFile', file, file.name);
    });
  }
  if (draftingMode === 'refine') {
    chatState.lexDraftFiles.forEach(file => {
      body.set('draftContract', file, file.name);
    });
  }
  if (draftingMode === 'approved-upload') {
    chatState.lexApprovedFiles.forEach(file => {
      body.set('completedContract', file, file.name);
    });
  }
}

function getDocumentLedSourceFile() {
  return chatSupportingFiles?.files?.[0] || form.supportingFiles.files?.[0] || null;
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
