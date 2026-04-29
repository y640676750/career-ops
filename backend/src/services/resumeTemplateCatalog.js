const TEMPLATE_CATALOG = Object.freeze([
  {
    id: 'template-minimal',
    name: '留白',
    accent: '#007AFF',
    tone: '#E8F1FF',
    templateName: 'cv-template-minimal'
  },
  {
    id: 'template-aurora',
    name: '晨雾',
    accent: '#5E5CE6',
    tone: '#F0EEFF',
    templateName: 'cv-template-aurora'
  },
  {
    id: 'template-slate',
    name: '雾银',
    accent: '#34C759',
    tone: '#ECFFF1',
    templateName: 'cv-template-slate'
  },
  {
    id: 'template-column',
    name: '序章',
    accent: '#FF9F0A',
    tone: '#FFF5E6',
    templateName: 'cv-template-column'
  },
  {
    id: 'template-focus',
    name: '聚焦',
    accent: '#FF375F',
    tone: '#FFEAF0',
    templateName: 'cv-template-focus'
  }
]);

export function listResumeTemplates() {
  return TEMPLATE_CATALOG.map((item) => ({
    id: item.id,
    name: item.name,
    accent: item.accent,
    tone: item.tone
  }));
}

export function getResumeTemplate(templateId) {
  return TEMPLATE_CATALOG.find((item) => item.id === templateId) || TEMPLATE_CATALOG[0];
}
