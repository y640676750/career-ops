
const { ensureWechatAuthorizedLogin, clearSession, getStoredUser } = require('../../utils/auth');
const { request, uploadFile, downloadWithAuth, isSessionInvalidError } = require('../../utils/request');

const TEMPLATE_FALLBACK = [
  { id: 'template-minimal', name: '留白', accent: '#007AFF', tone: '#E8F1FF' },
  { id: 'template-aurora', name: '晨雾', accent: '#5E5CE6', tone: '#F0EEFF' },
  { id: 'template-slate', name: '雾银', accent: '#34C759', tone: '#ECFFF1' },
  { id: 'template-column', name: '序章', accent: '#FF9F0A', tone: '#FFF5E6' },
  { id: 'template-focus', name: '聚焦', accent: '#FF375F', tone: '#FFEAF0' }
];

const DEFAULT_QUEUE_STATS = [
  { label: '总计', value: 0, tone: 'neutral' },
  { label: '排队', value: 0, tone: 'muted' },
  { label: '进行中', value: 0, tone: 'info' },
  { label: '已完成', value: 0, tone: 'success' },
  { label: '失败', value: 0, tone: 'danger' }
];

const DELETED_RESULTS_STORAGE_KEY = 'careerOps.deletedResumeResults';
const FREE_GENERATION_STORAGE_KEY = 'careerOps.freeGenerationUsage';
const DAILY_FREE_GENERATION_LIMIT = 0;

const BUILDER_STEPS = [
  { key: 'basic', index: '01', label: '基本信息', title: '先告诉我们你是谁', hint: '只需要填写最基础的信息，简单白话就可以。' },
  { key: 'education', index: '02', label: '教育背景', title: '再补充学校和专业', hint: '如果暂时记不清，也可以先留空，后面再改。' },
  { key: 'story', index: '03', label: '经历亮点', title: '写过就填，没有也能生成', hint: '应届生没有项目也没关系，AI 会按岗位方向补成作品集和校园实践表达。' }
];

const JD_VISION_UPLOAD_TIMEOUT_MS = 90000;
const JD_VISION_CLIENT_TIMEOUT_MS = 120000;
const JD_VISION_POLL_INTERVAL_MS = 1200;
const RESUME_UPLOAD_TIMEOUT_MS = 90000;
const RESUME_PARSE_CLIENT_TIMEOUT_MS = 180000;
const RESUME_PARSE_POLL_INTERVAL_MS = 1200;

function createLocalId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function clampText(text, maxLength) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength)}...`;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function isJdVisionExpired(startedAt) {
  const timestamp = Number(startedAt || 0);
  return Boolean(timestamp && Date.now() - timestamp > JD_VISION_CLIENT_TIMEOUT_MS);
}

function isResumeParseExpired(startedAt) {
  const timestamp = Number(startedAt || 0);
  return Boolean(timestamp && Date.now() - timestamp > RESUME_PARSE_CLIENT_TIMEOUT_MS);
}

function normalizeJdVisionErrorMessage(message) {
  const text = normalizeText(message);
  if (!text) {
    return '岗位截图暂时没有识别完整，请换一张更清晰的截图，或直接粘贴岗位 JD。';
  }

  if (/json|unterminated|unexpected|parse|position/i.test(text)) {
    return '岗位截图内容已读到，但结果不完整，请换一张更清晰的截图，或直接粘贴岗位 JD。';
  }

  return text;
}

function formatFileSize(size) {
  const bytes = Number(size || 0);
  if (!bytes) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(bytes / 1024, 1).toFixed(0)} KB`;
}

function inferImageFileName(filePath, fallbackName) {
  const sourceName = normalizeText(fallbackName);
  if (/\.(png|jpe?g|webp)$/i.test(sourceName)) {
    return sourceName;
  }

  const pathText = normalizeText(filePath);
  const extensionMatch = pathText.match(/\.(png|jpe?g|webp)(?:\?.*)?$/i);
  const extension = extensionMatch ? extensionMatch[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
  return `jd-screenshot-${Date.now()}.${extension}`;
}

function formatDisplayTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function getLocalDateKey() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function loadFreeGenerationUsage() {
  try {
    const usage = wx.getStorageSync(FREE_GENERATION_STORAGE_KEY) || {};
    const today = getLocalDateKey();
    if (usage.date === today) {
      return { date: today, count: Number(usage.count || 0) };
    }

    return { date: today, count: 0 };
  } catch (_error) {
    return { date: getLocalDateKey(), count: 0 };
  }
}

function saveFreeGenerationUsage(usage) {
  try {
    wx.setStorageSync(FREE_GENERATION_STORAGE_KEY, {
      date: usage.date || getLocalDateKey(),
      count: Math.max(0, Number(usage.count || 0))
    });
  } catch (_error) {
    // A storage error should not block the user from submitting a queued job.
  }
}

function isPremiumAccessActive(state) {
  if (state.premiumAccessActive !== true) {
    return false;
  }

  if (!state.premiumExpiresAt) {
    return true;
  }

  return new Date(state.premiumExpiresAt).getTime() > Date.now();
}

function hasResumeData(source) {
  return Boolean(source && (source.resumeText || source.candidate));
}

function openDocumentFile(filePath) {
  return new Promise((resolve, reject) => {
    wx.openDocument({ filePath, showMenu: true, success: resolve, fail: reject });
  });
}

function saveFileLocally(tempFilePath) {
  return new Promise((resolve, reject) => {
    wx.saveFile({
      tempFilePath,
      success(res) { resolve(res.savedFilePath || tempFilePath); },
      fail: reject
    });
  });
}

function showSaveSuccessModal() {
  return new Promise((resolve) => {
    wx.showModal({
      title: '已保存',
      content: '简历已保存到微信本地文件，是否立即预览？',
      confirmText: '立即预览',
      cancelText: '稍后查看',
      success(res) { resolve(Boolean(res.confirm)); },
      fail() { resolve(false); }
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildTemplateViewModel(template, selectedTemplateId) {
  return Object.assign({}, template, {
    selected: template.id === selectedTemplateId,
    cardStyle: `background:${template.tone};`,
    accentStyle: `background:${template.accent};`
  });
}

function getTemplateById(templateId, templates) {
  const source = Array.isArray(templates) && templates.length ? templates : TEMPLATE_FALLBACK;
  return source.find((item) => item.id === templateId) || source[0];
}

function buildTargetJobCard(job, index) {
  return {
    id: job.id,
    companyName: job.companyName || '',
    roleTitle: job.roleTitle || '',
    description: job.description || '',
    descriptionPreview: clampText(job.description, 90),
    orderLabel: String(index + 1).padStart(2, '0')
  };
}

function normalizeTargetJob(job, fallbackIdPrefix = 'job') {
  const description = normalizeText(job && job.description);
  if (!description) {
    return null;
  }

  return {
    id: normalizeText(job && job.id) || createLocalId(fallbackIdPrefix),
    companyName: normalizeText(job && job.companyName),
    roleTitle: normalizeText(job && job.roleTitle),
    description
  };
}

function buildQueueItem(item) {
  const statusMap = { queued: '排队中', processing: '生成中', completed: '已完成', failed: '失败' };
  const hintText = item.status === 'completed'
    ? '排版与 PDF 已完成'
    : item.status === 'processing'
      ? '正在后台串行处理'
      : item.status === 'queued'
        ? '等待前面的任务处理完成'
        : '';

  return {
    id: item.itemId,
    companyName: item.companyName || '',
    roleTitle: item.roleTitle || '',
    status: item.status || 'queued',
    statusText: statusMap[item.status] || item.statusText || '排队中',
    hintText,
    errorMessage: item.errorMessage || ''
  };
}

function buildResultItem(item) {
  const mode = String(item.mode || '');
  const isAbstractResult = /abstract/i.test(mode);
  const pdf = item.pdf || {};
  const fileName = pdf.fileName || '';
  const downloadUrl = pdf.downloadUrl || '';
  const modeKey = isAbstractResult ? 'abstract' : 'normal';
  return {
    id: [item.itemId || 'item', modeKey, fileName || pdf.createdAt || Date.now()].filter(Boolean).join('_'),
    companyName: item.companyName || '',
    roleTitle: item.roleTitle || '',
    fileName,
    downloadUrl,
    createdAt: pdf.createdAt || '',
    createdText: pdf.createdAt ? `生成于 ${formatDisplayTime(pdf.createdAt)}` : '',
    isAbstractResult,
    abstractBadgeText: isAbstractResult ? '整活版' : ''
  };
}

function getResultMergeKey(result) {
  return result.downloadUrl || result.fileName || result.id;
}

function loadDeletedResultKeys() {
  try {
    const keys = wx.getStorageSync(DELETED_RESULTS_STORAGE_KEY);
    return Array.isArray(keys) ? keys.filter(Boolean) : [];
  } catch (_error) {
    return [];
  }
}

function persistDeletedResultKeys(keys) {
  try {
    wx.setStorageSync(DELETED_RESULTS_STORAGE_KEY, Array.isArray(keys) ? keys.filter(Boolean).slice(-120) : []);
  } catch (_error) {
    // Storage failure should not block the visual delete action.
  }
}

function isResultDeleted(result, deletedKeys) {
  const keys = Array.isArray(deletedKeys) ? deletedKeys : [];
  return keys.includes(result.id) || keys.includes(result.downloadUrl) || keys.includes(result.fileName) || keys.includes(getResultMergeKey(result));
}

function filterDeletedResults(results, deletedKeys) {
  return (Array.isArray(results) ? results : []).filter((result) => !isResultDeleted(result, deletedKeys));
}

function mergeGeneratedResults(currentResults, incomingResults) {
  const merged = new Map();
  const push = (result) => {
    const key = getResultMergeKey(result);
    if (!key) return;
    merged.set(key, Object.assign({}, merged.get(key) || {}, result));
  };

  (Array.isArray(currentResults) ? currentResults : []).forEach(push);
  (Array.isArray(incomingResults) ? incomingResults : []).forEach(push);

  return [...merged.values()].sort((a, b) => {
    const left = new Date(a.createdAt || 0).getTime();
    const right = new Date(b.createdAt || 0).getTime();
    return right - left;
  });
}
function buildQueueStats(queueItems) {
  const total = queueItems.length;
  const counts = { queued: 0, processing: 0, completed: 0, failed: 0 };
  queueItems.forEach((item) => {
    if (Object.prototype.hasOwnProperty.call(counts, item.status)) {
      counts[item.status] += 1;
    }
  });

  return {
    queueSummaryText: total ? `已完成 ${counts.completed}/${total}` : '等待批量生成',
    queueStats: [
      { label: '总计', value: total, tone: 'neutral' },
      { label: '排队', value: counts.queued, tone: 'muted' },
      { label: '进行中', value: counts.processing, tone: 'info' },
      { label: '已完成', value: counts.completed, tone: 'success' },
      { label: '失败', value: counts.failed, tone: 'danger' }
    ]
  };
}

function buildSummaryText(state) {
  const count = Array.isArray(state.targetJobs) ? state.targetJobs.length : 0;
  const template = getTemplateById(state.selectedTemplateId, state.templateCatalog);
  const modeLabel = state.isAbstractMode ? '抽象整活已开' : '专业模式';
  return `${count}个岗位，${template.name}，${hasResumeData(state.resumeSource) ? '母本已就绪' : '等待母本'}，${modeLabel}`;
}

function buildBatchButtonText(state) {
  if (state.batchGenerating) return state.isAbstractMode ? '整活进行中' : '正在批量生成';
  if (!state.isLoggedIn) return '先连接微信';
  if (state.uploadBusy) return '等待文件解析完成';
  if (state.builderSubmitting) return '等待母本生成完成';
  if (!isPremiumAccessActive(state)) return '输入激活码解锁';
  if (!hasResumeData(state.resumeSource)) return '先上传或创建母本';
  if (!Array.isArray(state.targetJobs) || !state.targetJobs.length) return '先添加岗位';
  return state.isAbstractMode ? '开始整活' : '一键批量生成 →';
}

function buildResumeViewModel(state) {
  const source = state.resumeSource || {};
  const resumeFile = state.resumeFile || {};
  const fileName = source.fileName || resumeFile.name || '';
  const fileType = source.fileType || resumeFile.fileType || '';
  const sizeLabel = resumeFile.sizeLabel || formatFileSize(source.sizeBytes);
  const metaParts = [];
  if (source.origin === 'builder') metaParts.push('傻瓜式创建');
  if (sizeLabel) metaParts.push(sizeLabel);
  if (fileType) metaParts.push(String(fileType).toUpperCase());
  const metaText = metaParts.join(' · ');

  if (state.uploadBusy && state.resumeStatus === 'uploading') {
    return { resumeStatusText: '上传中', resumeStatusTone: 'info', resumePanelTitle: fileName || '上传 PDF / Word', resumePanelSubtitle: '正在上传', resumePanelCaption: '点卡片可取消重试', resumeMetaText: metaText || '正在上传', uploadProgressDisplay: `${Math.max(1, Math.min(99, Number(state.uploadProgress || 0)))}%`, uploadProgressPercent: Math.max(2, Math.min(99, Number(state.uploadProgress || 0))), resumeReady: false };
  }
  if (state.uploadBusy && state.resumeStatus === 'queued') {
    return { resumeStatusText: '排队解析', resumeStatusTone: 'warning', resumePanelTitle: fileName || '上传 PDF / Word', resumePanelSubtitle: '等待解析', resumePanelCaption: '点卡片可取消重试', resumeMetaText: metaText || '等待解析', uploadProgressDisplay: '排队中', uploadProgressPercent: 24, resumeReady: false };
  }
  if (state.uploadBusy && state.resumeStatus === 'processing') {
    return { resumeStatusText: '解析中', resumeStatusTone: 'info', resumePanelTitle: fileName || '上传 PDF / Word', resumePanelSubtitle: '正在提取内容', resumePanelCaption: '点卡片可取消重试', resumeMetaText: metaText || '正在解析', uploadProgressDisplay: '解析中', uploadProgressPercent: 72, resumeReady: false };
  }
  if (state.builderSubmitting) {
    return { resumeStatusText: '创建中', resumeStatusTone: 'info', resumePanelTitle: '上传 PDF / Word', resumePanelSubtitle: '也可改用上传', resumePanelCaption: 'AI 正在整理内容', resumeMetaText: 'AI 整理中', uploadProgressDisplay: '可替换', uploadProgressPercent: 100, resumeReady: false };
  }
  if (hasResumeData(source) && source.origin === 'builder') {
    return { resumeStatusText: '已就绪', resumeStatusTone: 'success', resumePanelTitle: '上传 PDF / Word', resumePanelSubtitle: '当前使用填写版母本', resumePanelCaption: source.notes || '可继续添加岗位', resumeMetaText: metaText || '当前使用填写版', uploadProgressDisplay: '可替换', uploadProgressPercent: 100, resumeReady: true };
  }
  if (hasResumeData(source)) {
    return { resumeStatusText: source.truncated ? '已就绪' : '已上传', resumeStatusTone: 'success', resumePanelTitle: fileName || '上传 PDF / Word', resumePanelSubtitle: '可直接开始生成', resumePanelCaption: source.textLength ? `已提取 ${source.textLength} 字` : '解析完成', resumeMetaText: metaText || '解析完成', uploadProgressDisplay: '完成', uploadProgressPercent: 100, resumeReady: true };
  }
  if (state.resumeStatus === 'failed') {
    return { resumeStatusText: '处理失败', resumeStatusTone: 'danger', resumePanelTitle: '上传 PDF / Word', resumePanelSubtitle: '重新上传即可', resumePanelCaption: '支持 PDF / Word', resumeMetaText: '请重试', uploadProgressDisplay: '重试', uploadProgressPercent: 0, resumeReady: false };
  }
  return { resumeStatusText: '未准备', resumeStatusTone: 'muted', resumePanelTitle: '上传 PDF / Word', resumePanelSubtitle: '从微信文件中选择', resumePanelCaption: '支持 PDF / Word', resumeMetaText: '未上传', uploadProgressDisplay: '上传', uploadProgressPercent: 0, resumeReady: false };
}

function buildBuilderCardViewModel(state) {
  const source = state.resumeSource || {};
  const candidateName = source.candidate && source.candidate.name ? source.candidate.name : '';
  if (state.builderSubmitting) {
    return { builderCardTone: 'info', builderCardTag: 'AI 整理中', builderCardTitle: '正在生成母本', builderCardSubtitle: '稍等片刻', builderCardCaption: '完成后可直接生成', builderCardActionText: '请稍候' };
  }
  if (hasResumeData(source) && source.origin === 'builder') {
    return { builderCardTone: 'success', builderCardTag: '已创建', builderCardTitle: candidateName ? `${candidateName} 的母本已就绪` : '母本已就绪', builderCardSubtitle: source.notes || '已整理为专业表达', builderCardCaption: '可随时重新填写', builderCardActionText: '重新填写' };
  }
  return { builderCardTone: '', builderCardTag: '三步完成', builderCardTitle: '傻瓜式创建', builderCardSubtitle: '填几项基础信息', builderCardCaption: 'AI 自动整理成专业简历', builderCardActionText: '开始填写' };
}

function buildBuilderStepViewModel(state) {
  const stepIndex = Number(state.builderStepIndex || 0);
  const step = BUILDER_STEPS[stepIndex] || BUILDER_STEPS[0];
  return {
    builderSteps: BUILDER_STEPS.map((item, index) => ({ key: item.key, index: item.index, label: item.label, current: index === stepIndex, done: index < stepIndex })),
    builderStepTitle: step.title,
    builderStepHint: step.hint,
    isBuilderStepBasic: stepIndex === 0,
    isBuilderStepEducation: stepIndex === 1,
    isBuilderStepStory: stepIndex === 2,
    builderSecondaryText: stepIndex === 0 ? '取消' : '上一步',
    builderPrimaryText: stepIndex === BUILDER_STEPS.length - 1 ? '生成母本简历' : '下一步'
  };
}

function buildJdVisionViewModel(state) {
  const fileName = state.jdImageFileName || '';
  const companyName = normalizeText(state.draftCompanyName);
  const roleTitle = normalizeText(state.draftRoleTitle);
  const hasAutoFilledFields = Boolean(companyName || roleTitle);
  const autoFillTitle = companyName && roleTitle
    ? `已识别 ${companyName} · ${roleTitle}`
    : companyName
      ? `已识别 ${companyName}`
      : roleTitle
        ? `已识别 ${roleTitle}`
        : '已自动回填岗位信息';
  const autoFillSummary = hasAutoFilledFields
    ? '公司和岗位已写入下面的输入框，你只需要确认或微调 JD 文本即可。'
    : '已从截图提取出关键信息，你可以继续检查并补充细节。';

  if (state.jdImageStatus === 'uploading') return { jdImageStatusText: '上传中', jdImageStatusTone: 'info', jdImageHelperText: '截图已开始上传，请稍候。', jdImageFileName: fileName, jdVisionAutoFillVisible: false, jdVisionAutoFillTitle: '', jdVisionAutoFillSummary: '' };
  if (state.jdImageStatus === 'queued') return { jdImageStatusText: '排队识别', jdImageStatusTone: 'info', jdImageHelperText: '正在等待后台处理这张截图。', jdImageFileName: fileName, jdVisionAutoFillVisible: false, jdVisionAutoFillTitle: '', jdVisionAutoFillSummary: '' };
  if (state.jdImageStatus === 'processing') return { jdImageStatusText: '识别中', jdImageStatusTone: 'info', jdImageHelperText: '正在提取公司、岗位和任职要求。', jdImageFileName: fileName, jdVisionAutoFillVisible: false, jdVisionAutoFillTitle: '', jdVisionAutoFillSummary: '' };
  if (state.jdImageStatus === 'ready') {
    return {
      jdImageStatusText: '已识别',
      jdImageStatusTone: 'success',
      jdImageHelperText: '已自动回填岗位信息，你可以直接确认或继续微调。',
      jdImageFileName: fileName,
      jdVisionAutoFillVisible: true,
      jdVisionAutoFillTitle: autoFillTitle,
      jdVisionAutoFillSummary: autoFillSummary
    };
  }
  if (state.jdImageStatus === 'failed') return { jdImageStatusText: '识别失败', jdImageStatusTone: 'danger', jdImageHelperText: state.jdImageErrorMessage || '请重新上传一张更清晰的截图。', jdImageFileName: fileName, jdVisionAutoFillVisible: false, jdVisionAutoFillTitle: '', jdVisionAutoFillSummary: '' };
  return { jdImageStatusText: '待识别', jdImageStatusTone: 'muted', jdImageHelperText: '上传一张 JD 截图，系统会自动提取公司、岗位和任职要求。', jdImageFileName: fileName, jdVisionAutoFillVisible: false, jdVisionAutoFillTitle: '', jdVisionAutoFillSummary: '' };
}

function buildPageStatePatch(state, patch) {
  const nextState = Object.assign({}, state, patch);
  const templateCatalog = Array.isArray(nextState.templateCatalog) && nextState.templateCatalog.length ? nextState.templateCatalog : TEMPLATE_FALLBACK;
  const template = getTemplateById(nextState.selectedTemplateId, templateCatalog);
  const resumeView = buildResumeViewModel(nextState);
  const builderView = buildBuilderCardViewModel(nextState);
  const builderStepView = buildBuilderStepViewModel(nextState);
  const jdVisionView = buildJdVisionViewModel(nextState);
  const queueView = buildQueueStats(nextState.queueItems || []);

  return Object.assign({}, patch, resumeView, builderView, builderStepView, jdVisionView, queueView, {
    templateCatalog,
    selectedTemplateId: template.id,
    selectedTemplateName: template.name,
    templates: templateCatalog.map((item) => buildTemplateViewModel(item, template.id)),
    summaryText: buildSummaryText(Object.assign({}, nextState, { templateCatalog, selectedTemplateId: template.id })),
    batchButtonText: buildBatchButtonText(nextState),
    canGenerate: Boolean(nextState.isLoggedIn && !nextState.uploadBusy && !nextState.builderSubmitting && hasResumeData(nextState.resumeSource) && Array.isArray(nextState.targetJobs) && nextState.targetJobs.length)
  });
}

Page({
  data: {
    loginLoading: false,
    uploadBusy: false,
    uploadProgress: 0,
    resumeParseStartedAt: 0,
    batchGenerating: false,
    builderVisible: false,
    builderSubmitting: false,
    builderStepIndex: 0,
    jobSheetVisible: false,
    jdImageBusy: false,
    jdImageStatus: 'idle',
    jdImageFileName: '',
    jdImageErrorMessage: '',
    jdImageStartedAt: 0,
    isEditingJob: false,
    isLoggedIn: false,
    loginModeText: '未登录',
    userName: '微信用户',
    resumeStatus: 'idle',
    resumeStatusText: '未准备',
    resumeStatusTone: 'muted',
    resumePanelTitle: '上传简历 (PDF / Word)',
    resumePanelSubtitle: '从微信聊天中选择你现有的母本简历。',
    resumePanelCaption: '支持 PDF / Word，单个文件不超过 5MB',
    resumeMetaText: '未上传',
    uploadProgressDisplay: '上传',
    uploadProgressPercent: 0,
    resumeReady: false,
    builderCardTone: '',
    builderCardTag: '三步完成',
    builderCardTitle: '没有简历？傻瓜式创建',
    builderCardSubtitle: '只需填写基础信息、教育经历和白话版项目经历。',
    builderCardCaption: 'AI 会自动扩写、润色并整理成标准母本简历。',
    builderCardActionText: '开始创建',
    summaryText: `0个岗位，${TEMPLATE_FALLBACK[0].name}，等待母本`,
    batchButtonText: '先连接微信',
    canGenerate: false,
    isAbstractMode: false,
    premiumAccessActive: false,
    premiumExpiresAt: '',
    redeemVisible: false,
    redeemCode: '',
    redeemBusy: false,
    freeGenerationDate: getLocalDateKey(),
    freeGenerationCount: 0,
    resumeFile: null,
    resumeSource: null,
    targetJobs: [],
    queueItems: [],
    queueSummaryText: '等待批量生成',
    queueStats: DEFAULT_QUEUE_STATS,
    generatedResults: [],
    deletedResultKeys: [],
    activeBatchJobId: '',
    activeParseJobId: '',
    activeBuilderJobId: '',
    activeJdVisionJobId: '',
    selectedTemplateId: TEMPLATE_FALLBACK[0].id,
    selectedTemplateName: TEMPLATE_FALLBACK[0].name,
    templateCatalog: TEMPLATE_FALLBACK,
    templates: TEMPLATE_FALLBACK.map((item) => buildTemplateViewModel(item, TEMPLATE_FALLBACK[0].id)),
    draftCompanyName: '',
    draftRoleTitle: '',
    draftJobDescription: '',
    editingJobId: '',
    builderName: '',
    builderTargetRole: '',
    builderContact: '',
    builderEducationSchool: '',
    builderEducationMajor: '',
    builderEducationYear: '',
    builderStoryTitle: '',
    builderStoryRole: '',
    builderStoryText: '',
    builderSteps: BUILDER_STEPS.map((item, index) => ({ key: item.key, index: item.index, label: item.label, current: index === 0, done: false })),
    builderStepTitle: BUILDER_STEPS[0].title,
    builderStepHint: BUILDER_STEPS[0].hint,
    isBuilderStepBasic: true,
    isBuilderStepEducation: false,
    isBuilderStepStory: false,
    builderSecondaryText: '取消',
    builderPrimaryText: '下一步',
    jdImageStatusText: '待识别',
    jdImageStatusTone: 'muted',
    jdImageHelperText: '上传一张 JD 截图，系统会自动提取公司、岗位和任职要求。',
    jdVisionAutoFillVisible: false,
    jdVisionAutoFillTitle: '',
    jdVisionAutoFillSummary: ''
  },
  onLoad() {
    const freeUsage = loadFreeGenerationUsage();
    this.setPageData({ deletedResultKeys: loadDeletedResultKeys() });
    this.setPageData({ freeGenerationDate: freeUsage.date, freeGenerationCount: freeUsage.count });
    this.syncSessionState();
    this.loadTemplates();
    if (this.data.isLoggedIn) this.loadRemoteDashboard();
    if (this.data.isLoggedIn) this.loadRedeemStatus();
    this.applyDerivedState();
  },

  onShow() {
    const freeUsage = loadFreeGenerationUsage();
    this.setPageData({ freeGenerationDate: freeUsage.date, freeGenerationCount: freeUsage.count });
    this.setPageData({ deletedResultKeys: loadDeletedResultKeys() });
    this.syncSessionState();
    if (this.data.isLoggedIn) this.loadRemoteDashboard();
    if (this.data.isLoggedIn) this.loadRedeemStatus();
  },

  onUnload() {
    this.clearBatchPollTimer();
    this.clearParsePollTimer();
    this.clearBuilderPollTimer();
    this.clearJdVisionPollTimer();
  },

  async onPullDownRefresh() {
    try {
      this.syncSessionState();
      await this.loadTemplates();
      if (this.data.isLoggedIn) await this.loadRemoteDashboard();
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  setPageData(patch) {
    this.setData(buildPageStatePatch(this.data, patch));
  },

  applyDerivedState() {
    this.setPageData({});
  },

  clearBatchPollTimer() {
    if (this.batchPollTimer) {
      clearTimeout(this.batchPollTimer);
      this.batchPollTimer = null;
    }
  },

  clearParsePollTimer() {
    if (this.parsePollTimer) {
      clearTimeout(this.parsePollTimer);
      this.parsePollTimer = null;
    }
  },

  clearBuilderPollTimer() {
    if (this.builderPollTimer) {
      clearTimeout(this.builderPollTimer);
      this.builderPollTimer = null;
    }
  },

  clearJdVisionPollTimer() {
    if (this.jdVisionPollTimer) {
      clearTimeout(this.jdVisionPollTimer);
      this.jdVisionPollTimer = null;
    }
  },

  noop() {},

  syncSessionState() {
    const readStoredSession = () => {
      const app = getApp();
      return {
        token: app.getSessionToken ? app.getSessionToken() : wx.getStorageSync('careerOps.sessionToken'),
        user: getStoredUser(),
        expiresAt: wx.getStorageSync('careerOps.sessionExpiresAt')
      };
    };

    let session = readStoredSession();
    const expiryMs = session.expiresAt ? new Date(session.expiresAt).getTime() : 0;
    const expired = Boolean(expiryMs && expiryMs <= Date.now());
    const incomplete = Boolean((session.user && !session.token) || (session.token && !session.user));

    if (expired || incomplete) {
      clearSession();
      session = readStoredSession();
    }

    const user = session.token ? session.user : null;
    const profile = user && user.profile ? user.profile : {};
    this.setPageData({
      isLoggedIn: Boolean(session.token && user),
      loginModeText: user && user.source === 'wechat' ? '微信已连接' : user ? '开发联调' : '未登录',
      userName: profile.nickName || '微信用户'
    });
  },

  async ensureLoggedIn(options = {}) {
    if (this.data.isLoggedIn && !options.force) {
      if (options.toastIfAlready) {
        wx.showToast({ title: '微信已连接', icon: 'none' });
      }
      return true;
    }
    if (this.data.loginLoading) return false;

    this.setPageData({ loginLoading: true });
    try {
      await ensureWechatAuthorizedLogin();
      this.syncSessionState();
      await this.loadRemoteDashboard();
      if (!options.silent) {
        wx.showToast({ title: '登录成功', icon: 'success' });
      }
      await this.loadRedeemStatus({ silent: true });
      return true;
    } catch (error) {
      if (!options.silent) {
        wx.showToast({ title: error.message || '登录失败', icon: 'none' });
      }
      return false;
    } finally {
      this.setPageData({ loginLoading: false });
    }
  },

  async recoverSessionIfNeeded(error) {
    if (!isSessionInvalidError(error)) {
      return false;
    }

    clearSession();
    this.syncSessionState();
    wx.showToast({ title: '登录已过期，正在重连', icon: 'none' });
    return this.ensureLoggedIn({ silent: true, force: true });
  },

  async handleWechatLogin() {
    await this.ensureLoggedIn({ silent: false, force: true });
  },

  handleLogout() {
    clearSession();
    this.clearBatchPollTimer();
    this.clearParsePollTimer();
    this.clearBuilderPollTimer();
    this.clearJdVisionPollTimer();
    this.setPageData({
      isLoggedIn: false,
      loginModeText: '未登录',
      userName: '微信用户',
      resumeStatus: 'idle',
      resumeFile: null,
      resumeSource: null,
      uploadBusy: false,
      uploadProgress: 0,
      resumeParseStartedAt: 0,
      targetJobs: [],
      queueItems: [],
      generatedResults: [],
      activeBatchJobId: '',
      activeParseJobId: '',
      activeBuilderJobId: '',
      activeJdVisionJobId: '',
      batchGenerating: false,
      premiumAccessActive: false,
      premiumExpiresAt: '',
      redeemVisible: false,
      redeemCode: '',
      redeemBusy: false,
      builderVisible: false,
      builderSubmitting: false,
      builderStepIndex: 0,
      jobSheetVisible: false,
      jdImageBusy: false,
      jdImageStatus: 'idle',
      jdImageFileName: '',
      jdImageErrorMessage: '',
      draftCompanyName: '',
      draftRoleTitle: '',
      draftJobDescription: ''
    });
    wx.showToast({ title: '已退出', icon: 'none' });
  },

  refreshTemplates(selectedTemplateId, templates) {
    const catalog = Array.isArray(templates) && templates.length ? templates : this.data.templateCatalog;
    const template = getTemplateById(selectedTemplateId, catalog);
    this.setPageData({ templateCatalog: catalog, selectedTemplateId: template.id });
  },

  refreshTargetJobs(jobs) {
    this.setPageData({ targetJobs: jobs.map((job, index) => buildTargetJobCard(job, index)) });
  },

  async loadTemplates() {
    try {
      const response = await request({ url: '/api/v1/resume/templates', auth: false });
      const items = Array.isArray(response.items) && response.items.length ? response.items : TEMPLATE_FALLBACK;
      this.refreshTemplates(this.data.selectedTemplateId, items);
    } catch (error) {
      console.warn('[miniprogram] loadTemplates failed:', error.message || error);
      this.refreshTemplates(this.data.selectedTemplateId, TEMPLATE_FALLBACK);
    }
  },

  async loadRedeemStatus(options = {}) {
    const token = getApp().getSessionToken ? getApp().getSessionToken() : wx.getStorageSync('careerOps.sessionToken');
    if (!token || !this.data.isLoggedIn) {
      this.setPageData({ premiumAccessActive: false, premiumExpiresAt: '' });
      return null;
    }

    try {
      const response = await request({ url: '/api/v1/redeem/status' });
      const access = response.access || {};
      this.setPageData({
        premiumAccessActive: access.isActive === true,
        premiumExpiresAt: access.expiresAt || ''
      });
      return access;
    } catch (error) {
      if (isSessionInvalidError(error)) {
        clearSession();
        this.syncSessionState();
        return null;
      }

      if (!options.silent) {
        console.warn('[miniprogram] loadRedeemStatus failed:', error.message || error);
      }
      return null;
    }
  },

  async ensureInviteAccess(options = {}) {
    const loggedIn = await this.ensureLoggedIn({ silent: true });
    if (!loggedIn) {
      if (!options.silent) {
        wx.showToast({ title: '请先登录微信', icon: 'none' });
      }
      return false;
    }

    await this.loadRedeemStatus({ silent: true });
    if (isPremiumAccessActive(this.data)) {
      return true;
    }

    if (!options.silent) {
      wx.showToast({ title: '请输入激活码解锁', icon: 'none' });
    }
    this.openRedeemModal();
    return false;
  },

  async loadRemoteDashboard() {
    try {
      const response = await request({ url: '/api/v1/resume/jobs?limit=20&type=batch' });
      const items = Array.isArray(response.items) ? response.items : [];
      if (!items.length) {
        this.clearBatchPollTimer();
        this.setPageData({ activeBatchJobId: '', queueItems: [], batchGenerating: false });
        return;
      }

      const historicalResults = [];
      items.forEach((job) => {
        const batchItems = Array.isArray(job.items) ? job.items : [];
        batchItems
          .filter((item) => item.pdf && item.pdf.fileName)
          .forEach((item) => historicalResults.push(buildResultItem(item)));
      });
      if (historicalResults.length) {
        const deletedResultKeys = this.data.deletedResultKeys || [];
        this.setPageData({
          generatedResults: filterDeletedResults(
            mergeGeneratedResults(this.data.generatedResults, historicalResults),
            deletedResultKeys
          )
        });
      }

      const latest = items[0];
      this.applyBatchJobState(latest);
      if (latest.jobStatus === 'queued' || latest.jobStatus === 'processing') {
        this.scheduleBatchPoll(latest.jobId);
      } else {
        this.clearBatchPollTimer();
      }
    } catch (error) {
      if (isSessionInvalidError(error)) {
        clearSession();
        this.syncSessionState();
        return;
      }

      console.warn('[miniprogram] loadRemoteDashboard failed:', error.message || error);
    }
  },

  applyBatchJobState(job) {
    const items = Array.isArray(job.items) ? job.items : [];
    const queueItems = items.map((item) => buildQueueItem(item));
    const deletedResultKeys = this.data.deletedResultKeys || [];
    const currentResults = items
      .filter((item) => item.pdf && item.pdf.fileName)
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map((item) => buildResultItem(item));
    const generatedResults = filterDeletedResults(
      mergeGeneratedResults(this.data.generatedResults, currentResults),
      deletedResultKeys
    );
    this.setPageData({ activeBatchJobId: job.jobId || '', queueItems, generatedResults, batchGenerating: job.jobStatus === 'queued' || job.jobStatus === 'processing' });
  },

  scheduleBatchPoll(jobId) {
    this.clearBatchPollTimer();
    this.batchPollTimer = setTimeout(() => this.pollBatchJob(jobId), 1500);
  },

  async pollBatchJob(jobId) {
    try {
      const job = await request({ url: `/api/v1/resume/jobs/${jobId}` });
      this.applyBatchJobState(job);
      if (job.jobStatus === 'queued' || job.jobStatus === 'processing') {
        this.scheduleBatchPoll(jobId);
        return;
      }

      this.clearBatchPollTimer();
      wx.showToast({ title: job.jobStatus === 'completed' ? '批量生成完成' : (job.errorMessage || '批量生成失败'), icon: job.jobStatus === 'completed' ? 'success' : 'none' });
    } catch (error) {
      this.clearBatchPollTimer();
      if (await this.recoverSessionIfNeeded(error)) {
        this.scheduleBatchPoll(jobId);
        return;
      }

      this.setPageData({ batchGenerating: false });
      wx.showToast({ title: error.message || '任务轮询失败', icon: 'none' });
    }
  },

  scheduleParsePoll(jobId) {
    this.clearParsePollTimer();
    if (isResumeParseExpired(this.data.resumeParseStartedAt)) {
      this.handleResumeParseTimeout();
      return;
    }

    this.parsePollTimer = setTimeout(() => {
      if (this.data.activeParseJobId === jobId && this.data.uploadBusy) {
        this.pollParseJob(jobId);
      }
    }, RESUME_PARSE_POLL_INTERVAL_MS);
  },

  applyParsedResumeSource(job, fallbackFile) {
    const source = job.source || {};
    this.setPageData({
      activeParseJobId: job.jobId || '',
      uploadBusy: false,
      uploadProgress: 100,
      resumeParseStartedAt: 0,
      resumeStatus: source.truncated ? 'ready-truncated' : 'ready',
      resumeFile: { name: source.fileName || fallbackFile || '已上传简历', sizeLabel: formatFileSize(source.sizeBytes), fileType: source.fileType || '', textLength: source.textLength || 0 },
      resumeSource: source
    });
  },

  async pollParseJob(jobId) {
    if (this.data.activeParseJobId !== jobId) return;

    if (isResumeParseExpired(this.data.resumeParseStartedAt)) {
      this.handleResumeParseTimeout();
      return;
    }

    try {
      const job = await request({ url: `/api/v1/resume/files/parse/${jobId}` });
      if (this.data.activeParseJobId !== jobId) return;

      if (job.jobStatus === 'queued') {
        this.setPageData({ activeParseJobId: job.jobId, uploadBusy: true, resumeStatus: 'queued' });
        this.scheduleParsePoll(jobId);
        return;
      }
      if (job.jobStatus === 'processing') {
        this.setPageData({ activeParseJobId: job.jobId, uploadBusy: true, resumeStatus: 'processing' });
        this.scheduleParsePoll(jobId);
        return;
      }
      this.clearParsePollTimer();
      if (job.jobStatus === 'completed' && job.source) {
        this.applyParsedResumeSource(job, job.file && job.file.fileName);
        wx.showToast({ title: '母本已就绪', icon: 'success' });
        return;
      }
      this.setPageData({ activeParseJobId: '', uploadBusy: false, uploadProgress: 0, resumeStatus: 'failed', resumeParseStartedAt: 0 });
      wx.showToast({ title: job.errorMessage || '简历解析失败', icon: 'none' });
    } catch (error) {
      if (this.data.activeParseJobId !== jobId) return;

      if (await this.recoverSessionIfNeeded(error)) {
        this.setPageData({ activeParseJobId: jobId, uploadBusy: true, resumeStatus: 'processing' });
        this.scheduleParsePoll(jobId);
        return;
      }

      this.clearParsePollTimer();
      this.setPageData({ activeParseJobId: '', uploadBusy: false, uploadProgress: 0, resumeStatus: 'failed', resumeParseStartedAt: 0 });
      wx.showToast({ title: error.message || '解析轮询失败', icon: 'none' });
    }
  },

  handleResumeParseTimeout() {
    const errorMessage = '简历上传或解析超时，请检查网络后重新上传。';
    this.clearParsePollTimer();
    this.setPageData({
      activeParseJobId: '',
      uploadBusy: false,
      uploadProgress: 0,
      resumeStatus: 'failed',
      resumeParseStartedAt: 0
    });
    wx.showToast({ title: errorMessage, icon: 'none' });
  },

  handleCancelResumeUpload() {
    this.clearParsePollTimer();
    this.setPageData({
      activeParseJobId: '',
      uploadBusy: false,
      uploadProgress: 0,
      resumeStatus: hasResumeData(this.data.resumeSource) ? 'ready' : 'failed',
      resumeParseStartedAt: 0
    });
    wx.showToast({ title: '已取消，可重新上传', icon: 'none' });
  },

  async handleChooseResumeFile() {
    if (this.data.uploadBusy) {
      this.handleCancelResumeUpload();
      return;
    }
    const hasAccess = await this.ensureInviteAccess();
    if (!hasAccess) {
      return;
    }

    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['pdf', 'doc', 'docx'],
      success: async (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) {
          wx.showToast({ title: '未选择文件', icon: 'none' });
          return;
        }
        try {
          await this.uploadResumeFile(file);
        } catch (error) {
          wx.showToast({ title: error.message || '上传失败', icon: 'none' });
        }
      },
      fail: (error) => {
        if (error && error.errMsg && error.errMsg.includes('cancel')) return;
        wx.showToast({ title: '文件选择失败', icon: 'none' });
      }
    });
  },

  async uploadResumeFile(file, allowAuthRetry = true) {
    this.clearParsePollTimer();
    const startedAt = Date.now();
    this.setPageData({
      activeParseJobId: '',
      uploadBusy: true,
      uploadProgress: 0,
      resumeStatus: 'uploading',
      resumeParseStartedAt: startedAt,
      resumeFile: { name: file.name || '已上传简历', sizeLabel: formatFileSize(file.size), fileType: '', textLength: 0 },
      resumeSource: null
    });

    try {
      const response = await uploadFile({
        url: '/api/v1/resume/files/parse',
        filePath: file.path,
        name: 'resumeFile',
        timeout: RESUME_UPLOAD_TIMEOUT_MS,
        onProgress: (progressEvent) => {
          if (this.data.resumeParseStartedAt === startedAt) {
            this.setPageData({ uploadProgress: Number(progressEvent.progress || 0) });
          }
        }
      });

      if (this.data.resumeParseStartedAt !== startedAt) {
        return;
      }

      if (response.jobStatus === 'completed' && response.source) {
        this.applyParsedResumeSource(response, file.name);
        return;
      }

      if (!response.jobId) {
        throw new Error('简历解析任务创建失败，请重新上传。');
      }

      this.setPageData({ activeParseJobId: response.jobId, resumeStatus: 'queued' });
      this.scheduleParsePoll(response.jobId);
    } catch (error) {
      if (this.data.resumeParseStartedAt !== startedAt) {
        return;
      }

      this.clearParsePollTimer();
      this.setPageData({
        activeParseJobId: '',
        uploadBusy: false,
        uploadProgress: 0,
        resumeStatus: 'failed',
        resumeParseStartedAt: 0
      });
      if (allowAuthRetry && await this.recoverSessionIfNeeded(error)) {
        return this.uploadResumeFile(file, false);
      }

      throw error;
    }
  },
  async handleOpenBuilder() {
    const hasAccess = await this.ensureInviteAccess();
    if (!hasAccess) {
      return;
    }

    this.setPageData({ builderVisible: true });
  },

  closeBuilder() {
    if (this.data.builderSubmitting) {
      wx.showToast({ title: '正在生成中，请稍候', icon: 'none' });
      return;
    }
    this.setPageData({ builderVisible: false });
  },

  onBuilderFieldInput(event) {
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    this.setData({ [field]: event.detail.value });
  },

  validateBuilderStep(stepIndex) {
    if (stepIndex === 0) {
      if (!normalizeText(this.data.builderName)) {
        wx.showToast({ title: '请先填写姓名', icon: 'none' });
        return false;
      }
      if (!normalizeText(this.data.builderTargetRole)) {
        wx.showToast({ title: '请先填写意向岗位', icon: 'none' });
        return false;
      }
    }
    return true;
  },

  collectBuilderPayload() {
    return {
      name: normalizeText(this.data.builderName),
      targetRole: normalizeText(this.data.builderTargetRole),
      contact: normalizeText(this.data.builderContact),
      educationSchool: normalizeText(this.data.builderEducationSchool),
      educationMajor: normalizeText(this.data.builderEducationMajor),
      educationYear: normalizeText(this.data.builderEducationYear),
      storyTitle: normalizeText(this.data.builderStoryTitle),
      storyRole: normalizeText(this.data.builderStoryRole),
      storyText: normalizeText(this.data.builderStoryText),
      language: 'zh'
    };
  },

  handleBuilderSecondaryAction() {
    if (this.data.builderSubmitting) return;
    if (this.data.builderStepIndex === 0) {
      this.closeBuilder();
      return;
    }
    this.setPageData({ builderStepIndex: this.data.builderStepIndex - 1 });
  },

  async handleBuilderPrimaryAction() {
    if (this.data.builderSubmitting) return;
    const currentStep = this.data.builderStepIndex;
    if (!this.validateBuilderStep(currentStep)) return;
    if (currentStep < BUILDER_STEPS.length - 1) {
      this.setPageData({ builderStepIndex: currentStep + 1 });
      return;
    }

    const hasAccess = await this.ensureInviteAccess();
    if (!hasAccess) {
      return;
    }

    return this.submitBuilderGenerate(true);
  },

  async submitBuilderGenerate(allowAuthRetry = true) {
    this.clearBuilderPollTimer();
    this.setPageData({ builderSubmitting: true, resumeStatus: 'builder-processing' });
    try {
      const response = await request({ url: '/api/v1/resume/builder/generate', method: 'POST', data: this.collectBuilderPayload() });
      if (response.jobStatus === 'completed' && response.source) {
        this.applyBuilderResult(response);
        wx.showToast({ title: '母本创建完成', icon: 'success' });
        return;
      }

      this.setPageData({ activeBuilderJobId: response.jobId || '' });
      if (response.jobId) this.scheduleBuilderPoll(response.jobId);
    } catch (error) {
      this.setPageData({ builderSubmitting: false, resumeStatus: hasResumeData(this.data.resumeSource) ? 'ready' : 'idle' });
      if (allowAuthRetry && await this.recoverSessionIfNeeded(error)) {
        return this.submitBuilderGenerate(false);
      }

      wx.showToast({ title: error.message || '母本创建失败', icon: 'none' });
    }
  },

  scheduleBuilderPoll(jobId) {
    this.clearBuilderPollTimer();
    this.builderPollTimer = setTimeout(() => this.pollBuilderJob(jobId), 1400);
  },

  applyBuilderResult(job) {
    const source = job.source || {};
    this.setPageData({
      activeBuilderJobId: '',
      builderSubmitting: false,
      builderVisible: false,
      resumeStatus: 'builder-ready',
      uploadBusy: false,
      uploadProgress: 100,
      resumeFile: { name: source.fileName || 'AI 母本简历', sizeLabel: '', fileType: source.fileType || 'builder', textLength: source.textLength || 0 },
      resumeSource: source
    });
  },

  async pollBuilderJob(jobId) {
    try {
      const job = await request({ url: `/api/v1/resume/builder/jobs/${jobId}` });
      if (job.jobStatus === 'queued' || job.jobStatus === 'processing') {
        this.setPageData({ activeBuilderJobId: job.jobId, builderSubmitting: true, resumeStatus: 'builder-processing' });
        this.scheduleBuilderPoll(jobId);
        return;
      }

      this.clearBuilderPollTimer();
      if (job.jobStatus === 'completed' && job.source) {
        this.applyBuilderResult(job);
        wx.showToast({ title: '母本创建完成', icon: 'success' });
        return;
      }

      this.setPageData({ activeBuilderJobId: '', builderSubmitting: false, resumeStatus: hasResumeData(this.data.resumeSource) ? 'ready' : 'idle' });
      wx.showToast({ title: job.errorMessage || '母本创建失败', icon: 'none' });
    } catch (error) {
      this.clearBuilderPollTimer();
      if (await this.recoverSessionIfNeeded(error)) {
        this.setPageData({ activeBuilderJobId: jobId, builderSubmitting: true, resumeStatus: 'builder-processing' });
        this.scheduleBuilderPoll(jobId);
        return;
      }

      this.setPageData({ activeBuilderJobId: '', builderSubmitting: false, resumeStatus: hasResumeData(this.data.resumeSource) ? 'ready' : 'idle' });
      wx.showToast({ title: error.message || '创建轮询失败', icon: 'none' });
    }
  },

  async handleChooseJdImage() {
    if (!this.data.jobSheetVisible || this.data.jdImageBusy) return;
    const hasAccess = await this.ensureInviteAccess();
    if (!hasAccess) {
      return;
    }

    wx.chooseImage({
      count: this.data.isEditingJob ? 1 : 9,
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: async (res) => {
        const filePaths = Array.isArray(res.tempFilePaths) ? res.tempFilePaths : [];
        const tempFiles = Array.isArray(res.tempFiles) ? res.tempFiles : [];
        const files = filePaths
          .map((filePath, index) => ({
            path: filePath,
            name: inferImageFileName(filePath, tempFiles[index] && tempFiles[index].name)
          }))
          .filter((file) => file.path);
        if (!files.length) return;
        try {
          if (files.length > 1) {
            await this.uploadJdImagesToList(files);
            return;
          }

          await this.uploadJdImage(files[0]);
        } catch (error) {
          wx.showToast({ title: error.message || '截图上传失败', icon: 'none' });
        }
      },
      fail: (error) => {
        if (error && error.errMsg && error.errMsg.includes('cancel')) return;
        wx.showToast({ title: '图片选择失败', icon: 'none' });
      }
    });
  },

  async uploadJdImageAndWait(file, startedAt, allowAuthRetry = true) {
    let response;
    try {
      response = await uploadFile({
        url: '/api/v1/resume/job-targets/vision',
        filePath: file.path,
        name: 'jdImage',
        timeout: JD_VISION_UPLOAD_TIMEOUT_MS
      });
    } catch (error) {
      if (allowAuthRetry && await this.recoverSessionIfNeeded(error)) {
        return this.uploadJdImageAndWait(file, startedAt, false);
      }

      throw error;
    }

    if (this.data.jdImageStartedAt !== startedAt || !this.data.jobSheetVisible) {
      return null;
    }

    if (response.jobStatus === 'completed' && response.targetJob) {
      return response.targetJob;
    }

    if (!response.jobId) {
      throw new Error('截图识别任务创建失败，请重新上传。');
    }

    this.setPageData({ activeJdVisionJobId: response.jobId, jdImageStatus: 'queued' });

    let authRetryAvailable = allowAuthRetry;
    while (!isJdVisionExpired(startedAt)) {
      await delay(JD_VISION_POLL_INTERVAL_MS);
      if (this.data.jdImageStartedAt !== startedAt || !this.data.jobSheetVisible) {
        return null;
      }

      try {
        const job = await request({ url: `/api/v1/resume/job-targets/vision/${response.jobId}` });
        if (this.data.jdImageStartedAt !== startedAt || !this.data.jobSheetVisible) {
          return null;
        }

        if (job.jobStatus === 'queued' || job.jobStatus === 'processing') {
          this.setPageData({
            activeJdVisionJobId: job.jobId || response.jobId,
            jdImageBusy: true,
            jdImageStatus: job.jobStatus
          });
          continue;
        }

        if (job.jobStatus === 'completed' && job.targetJob) {
          return job.targetJob;
        }

        throw new Error(job.errorMessage || '截图识别失败，请换一张更清晰的图。');
      } catch (error) {
        if (authRetryAvailable && await this.recoverSessionIfNeeded(error)) {
          authRetryAvailable = false;
          continue;
        }

        if (/404|not found/i.test(String(error.message || ''))) {
          throw new Error('识别任务已过期，请重新上传这张截图。');
        }

        throw error;
      }
    }

    throw new Error('截图识别超时，请重新上传更清晰的截图，或直接粘贴岗位 JD。');
  },

  async uploadJdImagesToList(files) {
    this.clearJdVisionPollTimer();
    const startedAt = Date.now();
    const recognizedJobs = [];
    const failedFiles = [];

    this.setPageData({
      activeJdVisionJobId: '',
      jdImageBusy: true,
      jdImageStatus: 'uploading',
      jdImageFileName: `准备识别 ${files.length} 张截图`,
      jdImageErrorMessage: '',
      jdImageStartedAt: startedAt
    });

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      if (this.data.jdImageStartedAt !== startedAt || !this.data.jobSheetVisible) {
        return;
      }

      this.setPageData({
        jdImageStatus: 'uploading',
        jdImageFileName: `${index + 1}/${files.length} ${file.name || 'JD 截图'}`,
        jdImageErrorMessage: ''
      });

      try {
        const targetJob = await this.uploadJdImageAndWait(file, startedAt, true);
        const normalizedJob = normalizeTargetJob(targetJob, 'vision_job');
        if (normalizedJob) {
          recognizedJobs.push(normalizedJob);
        } else {
          failedFiles.push(file.name || `第 ${index + 1} 张`);
        }
      } catch (error) {
        failedFiles.push(file.name || `第 ${index + 1} 张`);
        console.warn('[miniprogram] jd vision batch item failed:', error.message || error);
      }
    }

    if (this.data.jdImageStartedAt !== startedAt || !this.data.jobSheetVisible) {
      return;
    }

    if (recognizedJobs.length) {
      const previous = (this.data.targetJobs || [])
        .map((item) => normalizeTargetJob(item))
        .filter(Boolean);
      const nextJobs = previous.concat(recognizedJobs);
      this.setPageData({
        targetJobs: nextJobs.map((job, index) => buildTargetJobCard(job, index)),
        jobSheetVisible: false,
        isEditingJob: false,
        editingJobId: '',
        draftCompanyName: '',
        draftRoleTitle: '',
        draftJobDescription: '',
        activeJdVisionJobId: '',
        jdImageBusy: false,
        jdImageStatus: 'idle',
        jdImageFileName: '',
        jdImageErrorMessage: '',
        jdImageStartedAt: 0
      });

      wx.showToast({
        title: failedFiles.length ? `已识别${recognizedJobs.length}个，${failedFiles.length}个失败` : `已加入${recognizedJobs.length}个岗位`,
        icon: failedFiles.length ? 'none' : 'success'
      });
      return;
    }

    const errorMessage = '这些截图暂时没识别出岗位，请换更清晰的图片或手动粘贴 JD。';
    this.setPageData({
      activeJdVisionJobId: '',
      jdImageBusy: false,
      jdImageStatus: 'failed',
      jdImageErrorMessage: errorMessage,
      jdImageStartedAt: 0
    });
    throw new Error(errorMessage);
  },

  async uploadJdImage(file, allowAuthRetry = true) {
    this.clearJdVisionPollTimer();
    const startedAt = Date.now();
    this.setPageData({
      activeJdVisionJobId: '',
      jdImageBusy: true,
      jdImageStatus: 'uploading',
      jdImageFileName: file.name || 'JD 截图',
      jdImageErrorMessage: '',
      jdImageStartedAt: startedAt
    });

    try {
      const targetJob = await this.uploadJdImageAndWait(file, startedAt, allowAuthRetry);
      if (this.data.jdImageStartedAt !== startedAt || !this.data.jobSheetVisible) {
        return;
      }

      this.applyJdVisionResult({ targetJob });
      wx.showToast({ title: '截图识别完成', icon: 'success' });
    } catch (error) {
      if (this.data.jdImageStartedAt !== startedAt) {
        return;
      }

      const errorMessage = normalizeJdVisionErrorMessage(error.message || '截图上传失败，请重新上传或手动粘贴 JD。');
      this.clearJdVisionPollTimer();
      this.setPageData({
        activeJdVisionJobId: '',
        jdImageBusy: false,
        jdImageStatus: 'failed',
        jdImageErrorMessage: errorMessage,
        jdImageStartedAt: 0
      });

      throw new Error(errorMessage);
    }
  },

  scheduleJdVisionPoll(jobId) {
    this.clearJdVisionPollTimer();
    if (isJdVisionExpired(this.data.jdImageStartedAt)) {
      this.handleJdVisionTimeout();
      return;
    }

    this.jdVisionPollTimer = setTimeout(() => {
      if (this.data.activeJdVisionJobId === jobId && this.data.jdImageBusy) {
        this.pollJdVisionJob(jobId);
      }
    }, JD_VISION_POLL_INTERVAL_MS);
  },

  applyJdVisionResult(job) {
    const targetJob = job.targetJob || {};
    this.setPageData({
      activeJdVisionJobId: '',
      jdImageBusy: false,
      jdImageStatus: 'ready',
      jdImageErrorMessage: '',
      jdImageStartedAt: 0,
      draftCompanyName: targetJob.companyName || this.data.draftCompanyName,
      draftRoleTitle: targetJob.roleTitle || this.data.draftRoleTitle,
      draftJobDescription: targetJob.description || this.data.draftJobDescription
    });
  },

  async pollJdVisionJob(jobId) {
    if (!this.data.jobSheetVisible || this.data.activeJdVisionJobId !== jobId) return;

    if (isJdVisionExpired(this.data.jdImageStartedAt)) {
      this.handleJdVisionTimeout();
      return;
    }

    try {
      const job = await request({ url: `/api/v1/resume/job-targets/vision/${jobId}` });
      if (!this.data.jobSheetVisible || this.data.activeJdVisionJobId !== jobId) return;

      if (job.jobStatus === 'queued') {
        this.setPageData({ activeJdVisionJobId: job.jobId, jdImageBusy: true, jdImageStatus: 'queued' });
        this.scheduleJdVisionPoll(jobId);
        return;
      }
      if (job.jobStatus === 'processing') {
        this.setPageData({ activeJdVisionJobId: job.jobId, jdImageBusy: true, jdImageStatus: 'processing' });
        this.scheduleJdVisionPoll(jobId);
        return;
      }

      this.clearJdVisionPollTimer();
      if (job.jobStatus === 'completed' && job.targetJob) {
        this.applyJdVisionResult(job);
        wx.showToast({ title: '截图识别完成', icon: 'success' });
        return;
      }

      const errorMessage = normalizeJdVisionErrorMessage(job.errorMessage || '截图识别失败，请换一张更清晰的图。');
      this.setPageData({ activeJdVisionJobId: '', jdImageBusy: false, jdImageStatus: 'failed', jdImageErrorMessage: errorMessage, jdImageStartedAt: 0 });
      wx.showToast({ title: errorMessage, icon: 'none' });
    } catch (error) {
      if (this.data.activeJdVisionJobId !== jobId) return;

      if (await this.recoverSessionIfNeeded(error)) {
        this.setPageData({ activeJdVisionJobId: jobId, jdImageBusy: true, jdImageStatus: 'processing' });
        this.scheduleJdVisionPoll(jobId);
        return;
      }

      this.clearJdVisionPollTimer();
      const errorMessage = normalizeJdVisionErrorMessage(error.message || '截图识别失败，请稍后再试。');
      this.setPageData({ activeJdVisionJobId: '', jdImageBusy: false, jdImageStatus: 'failed', jdImageErrorMessage: errorMessage, jdImageStartedAt: 0 });
      wx.showToast({ title: errorMessage, icon: 'none' });
    }
  },

  handleJdVisionTimeout() {
    const errorMessage = '截图识别超时，请重新上传更清晰的截图，或直接粘贴岗位 JD。';
    this.clearJdVisionPollTimer();
    this.setPageData({
      activeJdVisionJobId: '',
      jdImageBusy: false,
      jdImageStatus: 'failed',
      jdImageErrorMessage: errorMessage,
      jdImageStartedAt: 0
    });
    wx.showToast({ title: errorMessage, icon: 'none' });
  },

  handleCancelJdVision(event) {
    if (event && typeof event.stopPropagation === 'function') {
      event.stopPropagation();
    }

    this.clearJdVisionPollTimer();
    this.setPageData({
      activeJdVisionJobId: '',
      jdImageBusy: false,
      jdImageStatus: 'idle',
      jdImageFileName: '',
      jdImageErrorMessage: '',
      jdImageStartedAt: 0
    });
    wx.showToast({ title: '已取消识别', icon: 'none' });
  },

  onSelectTemplate(event) {
    const templateId = event.currentTarget.dataset.templateId;
    if (!templateId) return;
    this.refreshTemplates(templateId);
  },

  handleTemplateMore() {
    wx.showToast({ title: '模板中心稍后接入', icon: 'none' });
  },

  handleTemplateUpload() {
    wx.showToast({ title: '自定义模板稍后开放', icon: 'none' });
  },

  openJobSheet() {
    this.clearJdVisionPollTimer();
    this.setPageData({
      jobSheetVisible: true,
      isEditingJob: false,
      editingJobId: '',
      draftCompanyName: '',
      draftRoleTitle: '',
      draftJobDescription: '',
      jdImageBusy: false,
      jdImageStatus: 'idle',
      jdImageFileName: '',
      jdImageErrorMessage: '',
      jdImageStartedAt: 0,
      activeJdVisionJobId: ''
    });
  },

  closeJobSheet() {
    this.clearJdVisionPollTimer();
    this.setPageData({
      jobSheetVisible: false,
      isEditingJob: false,
      editingJobId: '',
      draftCompanyName: '',
      draftRoleTitle: '',
      draftJobDescription: '',
      jdImageBusy: false,
      jdImageStatus: 'idle',
      jdImageFileName: '',
      jdImageErrorMessage: '',
      jdImageStartedAt: 0,
      activeJdVisionJobId: ''
    });
  },

  onDraftCompanyInput(event) {
    this.setData({ draftCompanyName: event.detail.value });
  },

  onDraftRoleInput(event) {
    this.setData({ draftRoleTitle: event.detail.value });
  },

  onDraftJobDescriptionInput(event) {
    this.setData({ draftJobDescription: event.detail.value });
  },

  confirmAddJob() {
    const companyName = normalizeText(this.data.draftCompanyName);
    const roleTitle = normalizeText(this.data.draftRoleTitle);
    const description = normalizeText(this.data.draftJobDescription);
    if (!description) {
      wx.showToast({ title: '请先填写岗位 JD', icon: 'none' });
      return;
    }

    const nextJob = { id: this.data.editingJobId || createLocalId('job'), companyName, roleTitle, description };
    const previous = (this.data.targetJobs || []).map((item) => ({ id: item.id, companyName: item.companyName, roleTitle: item.roleTitle, description: item.description }));
    const nextJobs = this.data.isEditingJob ? previous.map((job) => (job.id === nextJob.id ? nextJob : job)) : previous.concat(nextJob);
    const isEditing = this.data.isEditingJob;

    this.clearJdVisionPollTimer();
    this.setPageData({
      targetJobs: nextJobs.map((job, index) => buildTargetJobCard(job, index)),
      jobSheetVisible: false,
      isEditingJob: false,
      editingJobId: '',
      draftCompanyName: '',
      draftRoleTitle: '',
      draftJobDescription: '',
      jdImageBusy: false,
      jdImageStatus: 'idle',
      jdImageFileName: '',
      jdImageErrorMessage: '',
      jdImageStartedAt: 0,
      activeJdVisionJobId: ''
    });

    wx.showToast({ title: isEditing ? '岗位已更新' : '岗位已加入', icon: 'success' });
  },

  handleEditJob(event) {
    const jobId = event.currentTarget.dataset.jobId;
    const target = (this.data.targetJobs || []).find((item) => item.id === jobId);
    if (!target) return;

    this.clearJdVisionPollTimer();
    this.setPageData({
      jobSheetVisible: true,
      isEditingJob: true,
      editingJobId: target.id,
      draftCompanyName: target.companyName || '',
      draftRoleTitle: target.roleTitle || '',
      draftJobDescription: target.description || '',
      jdImageBusy: false,
      jdImageStatus: 'idle',
      jdImageFileName: '',
      jdImageErrorMessage: '',
      jdImageStartedAt: 0,
      activeJdVisionJobId: ''
    });
  },

  handleDeleteJob(event) {
    const jobId = event.currentTarget.dataset.jobId;
    const nextJobs = (this.data.targetJobs || []).filter((item) => item.id !== jobId).map((item) => ({ id: item.id, companyName: item.companyName, roleTitle: item.roleTitle, description: item.description }));
    this.refreshTargetJobs(nextJobs);
    wx.showToast({ title: '岗位已删除', icon: 'none' });
  },

  handleAbstractModeChange(event) {
    this.setPageData({
      isAbstractMode: Boolean(event.detail.value)
    });
  },

  refreshFreeGenerationUsage() {
    const usage = loadFreeGenerationUsage();
    this.setPageData({ freeGenerationDate: usage.date, freeGenerationCount: usage.count });
    return usage;
  },

  markFreeGenerationUsed() {
    const usage = loadFreeGenerationUsage();
    const nextUsage = {
      date: usage.date,
      count: usage.count + 1
    };
    saveFreeGenerationUsage(nextUsage);
    this.setPageData({ freeGenerationDate: nextUsage.date, freeGenerationCount: nextUsage.count });
  },

  openRedeemModal() {
    this.setPageData({ redeemVisible: true });
  },

  closeRedeemModal() {
    if (this.data.redeemBusy) return;
    this.setPageData({ redeemVisible: false });
  },

  onRedeemCodeInput(event) {
    this.setData({ redeemCode: event.detail.value });
  },

  async handleRedeemCode() {
    if (this.data.redeemBusy) return;
    const code = normalizeText(this.data.redeemCode).toUpperCase();
    if (!code) {
      wx.showToast({ title: '请输入激活码', icon: 'none' });
      return;
    }

    const loggedIn = await this.ensureLoggedIn({ silent: true });
    if (!loggedIn) {
      wx.showToast({ title: '请先登录微信', icon: 'none' });
      return;
    }

    this.setPageData({ redeemBusy: true });
    try {
      const response = await request({
        url: '/api/v1/redeem',
        method: 'POST',
        data: { code }
      });
      const access = response.access || {};
      this.setPageData({
        premiumAccessActive: access.isActive === true,
        premiumExpiresAt: access.expiresAt || '',
        redeemVisible: false,
        redeemCode: ''
      });
      wx.showToast({ title: response.message || '兑换成功', icon: 'success' });
    } catch (error) {
      if (await this.recoverSessionIfNeeded(error)) {
        this.setPageData({ redeemBusy: false });
        return this.handleRedeemCode();
      }

      wx.showToast({ title: error.message || '兑换失败', icon: 'none' });
    } finally {
      this.setPageData({ redeemBusy: false });
    }
  },

  async handleBatchGenerate() {
    if (this.data.batchGenerating || !this.data.canGenerate) return;
    const hasAccess = await this.ensureInviteAccess();
    if (!hasAccess) {
      return;
    }

    return this.submitBatchGenerate(true, false);
  },

  async submitBatchGenerate(allowAuthRetry = true, countFreeUsage = false) {
    this.clearBatchPollTimer();
    this.setPageData({ batchGenerating: true });

    try {
      const response = await request({
        url: '/api/v1/resume/customize/batch',
        method: 'POST',
        data: {
          resumeSource: this.data.resumeSource,
          templateId: this.data.selectedTemplateId,
          isAbstractMode: this.data.isAbstractMode,
          jobs: (this.data.targetJobs || []).map((job) => ({ itemId: job.id, companyName: job.companyName, roleTitle: job.roleTitle, description: job.description, language: 'zh' })),
          options: { renderPdf: true, pdfFormat: 'a4' }
        }
      });

      this.applyBatchJobState(response);
      if (response.jobId) this.scheduleBatchPoll(response.jobId);
      if (countFreeUsage) {
        this.markFreeGenerationUsed();
      }
      wx.showToast({ title: '已加入生成队列', icon: 'success' });
    } catch (error) {
      this.setPageData({ batchGenerating: false });
      if (allowAuthRetry && await this.recoverSessionIfNeeded(error)) {
        return this.submitBatchGenerate(false, countFreeUsage);
      }

      wx.showToast({ title: error.message || '批量生成失败', icon: 'none' });
    }
  },

  async handlePreviewResult(event) {
    const url = event.currentTarget.dataset.url;
    const fileName = event.currentTarget.dataset.fileName || '简历文件.pdf';
    if (!url) {
      wx.showToast({ title: '文件还未生成', icon: 'none' });
      return;
    }

    try {
      const tempFilePath = await downloadWithAuth(url, fileName);
      await openDocumentFile(tempFilePath);
    } catch (error) {
      wx.showToast({ title: error.message || '预览失败', icon: 'none' });
    }
  },

  async handleDownloadResult(event) {
    const url = event.currentTarget.dataset.url;
    const fileName = event.currentTarget.dataset.fileName || '简历文件.pdf';
    if (!url) {
      wx.showToast({ title: '文件还未生成', icon: 'none' });
      return;
    }

    try {
      const tempFilePath = await downloadWithAuth(url, fileName);
      const savedFilePath = await saveFileLocally(tempFilePath);
      const shouldPreview = await showSaveSuccessModal();
      if (shouldPreview) {
        await openDocumentFile(savedFilePath);
      }
    } catch (error) {
      wx.showToast({ title: error.message || '下载失败', icon: 'none' });
    }
  },

  handleDeleteResult(event) {
    const dataset = event.currentTarget.dataset || {};
    const resultId = dataset.resultId || '';
    const url = dataset.url || '';
    const fileName = dataset.fileName || '';
    const deleteKeys = [resultId, url, fileName].filter(Boolean);
    if (!deleteKeys.length) return;

    const nextDeletedKeys = Array.from(new Set([...(this.data.deletedResultKeys || []), ...deleteKeys]));
    const nextResults = filterDeletedResults(
      this.data.generatedResults || [],
      nextDeletedKeys
    );

    persistDeletedResultKeys(nextDeletedKeys);
    this.setPageData({
      deletedResultKeys: nextDeletedKeys,
      generatedResults: nextResults
    });
    wx.showToast({ title: '已从列表删除', icon: 'none' });
  }
});
