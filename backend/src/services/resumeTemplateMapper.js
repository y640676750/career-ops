const EMPHASIS_KEYWORD_PATTERN = /(提升|增长|降低|优化|缩短|节省|完成|交付|主导|搭建|推动|实现|沉淀|负责|落地|上线|拿下|覆盖|支撑|服务|命中|获奖|封神|出圈|热搜|涨粉|提效|降本|转化|留存|复购|GMV|ROI|KPI|AARRR|闭环|成果|效率|成本)/i;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeText(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function normalizeInlineText(value) {
  return safeText(value).replace(/\s+/g, ' ').trim();
}

function normalizeList(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function deriveLinkDisplay(value, fallback) {
  const text = safeText(value, fallback);
  return text.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function joinNonEmpty(parts, separator = ' · ') {
  return parts.map((item) => safeText(item)).filter(Boolean).join(separator);
}

function shouldEmphasizeSegment(segment) {
  return /\d/.test(segment) || EMPHASIS_KEYWORD_PATTERN.test(segment);
}

function formatRichText(value, fallback = '') {
  const normalized = normalizeInlineText(value || fallback);
  if (!normalized) {
    return '';
  }

  const parts = normalized.split(/([，。；;])/);
  const formatted = [];

  for (let index = 0; index < parts.length; index += 2) {
    const segment = String(parts[index] || '').trim();
    const punctuation = String(parts[index + 1] || '');
    if (!segment) {
      continue;
    }

    const escapedSegment = escapeHtml(segment);
    const escapedPunctuation = escapeHtml(punctuation);
    formatted.push(
      shouldEmphasizeSegment(segment)
        ? `<strong>${escapedSegment}</strong>${escapedPunctuation}`
        : `${escapedSegment}${escapedPunctuation}`
    );
  }

  return formatted.join('');
}

function deriveMiniTitle(text, fallback) {
  const normalized = normalizeInlineText(text)
    .replace(/^[•·\-\d.\s、]+/, '')
    .replace(/\s+/g, ' ');

  if (!normalized) {
    return escapeHtml(fallback);
  }

  const firstChunk = normalized
    .split(/[，。；;：:]/)
    .map((item) => item.trim())
    .find(Boolean) || normalized;

  return escapeHtml(firstChunk.slice(0, 14));
}

function renderCompetencies(competencies) {
  return normalizeList(competencies)
    .map((item) => `<span class="competency-tag">${escapeHtml(item)}</span>`)
    .join('');
}

function renderExperience(experience) {
  return normalizeList(experience)
    .map((item) => {
      const bullets = normalizeList(item.bullets);
      const kicker = deriveMiniTitle(bullets[0] || item.role || item.company, '经历亮点');
      const roleLine = escapeHtml(joinNonEmpty([item.role, item.location]));
      const bulletHtml = (bullets.length ? bullets : ['负责核心事项推进并稳定交付结果'])
        .map((bullet) => `<li>${formatRichText(bullet)}</li>`)
        .join('');

      return `
        <div class="job avoid-break">
          <div class="job-header">
            <div class="job-company">${escapeHtml(safeText(item.company, '工作经历'))}</div>
            <div class="job-period">${escapeHtml(safeText(item.period))}</div>
          </div>
          <div class="job-role">${roleLine}</div>
          <div class="job-kicker">亮点概述 · ${kicker}</div>
          <ul>${bulletHtml}</ul>
        </div>
      `;
    })
    .join('');
}

function renderProjects(projects) {
  return normalizeList(projects)
    .map((item) => {
      const badge = safeText(item.badge)
        ? `<span class="project-badge">${escapeHtml(item.badge)}</span>`
        : '';
      const kicker = deriveMiniTitle(item.badge || item.description || item.title, '项目亮点');

      return `
        <div class="project avoid-break">
          <div class="project-title">${escapeHtml(safeText(item.title, '项目经历'))}${badge}</div>
          <div class="project-kicker">项目摘要 · ${kicker}</div>
          <div class="project-desc">${formatRichText(item.description)}</div>
          <div class="project-tech">${formatRichText(item.tech)}</div>
        </div>
      `;
    })
    .join('');
}

function renderEducation(education) {
  return normalizeList(education)
    .map((item) => `
      <div class="edu-item avoid-break">
        <div class="edu-header">
          <div class="edu-title">${escapeHtml(safeText(item.title, '教育背景'))} <span class="edu-org">${escapeHtml(safeText(item.org))}</span></div>
          <div class="edu-year">${escapeHtml(safeText(item.year))}</div>
        </div>
        <div class="edu-kicker">背景摘要 · ${deriveMiniTitle(item.description || item.org || item.title, '学历背景')}</div>
        <div class="edu-desc">${formatRichText(item.description)}</div>
      </div>
    `)
    .join('');
}

function renderCertifications(certifications) {
  return normalizeList(certifications)
    .map((item) => `
      <div class="cert-item avoid-break">
        <div class="cert-title">${escapeHtml(safeText(item.title, '证书荣誉'))} <span class="cert-org">${escapeHtml(safeText(item.org))}</span></div>
        <div class="cert-kicker">荣誉摘要 · ${deriveMiniTitle(item.title || item.org, '资格认证')}</div>
        <div class="cert-year">${escapeHtml(safeText(item.year))}</div>
      </div>
    `)
    .join('');
}

function renderSkills(skills) {
  return normalizeList(skills)
    .map((item) => {
      const category = escapeHtml(safeText(item.category, '技能清单'));
      const values = normalizeList(item.items)
        .map((skill) => `<span class="skill-value">${formatRichText(skill)}</span>`)
        .join('<span class="skill-sep"> / </span>');
      return `<div class="skill-item"><span class="skill-category">${category}</span><span class="skill-values">${values}</span></div>`;
    })
    .join('');
}

function renderContactItems(candidate) {
  const items = [];
  const birthDate = safeText(candidate.birthDate, '待补充');

  if (safeText(candidate.email)) {
    items.push(`<span class="contact-item">邮箱：${escapeHtml(candidate.email)}</span>`);
  }

  items.push(`<span class="contact-item">出生年月：${escapeHtml(birthDate)}</span>`);

  if (safeText(candidate.location)) {
    items.push(`<span class="contact-item">所在地：${escapeHtml(candidate.location)}</span>`);
  }

  if (safeText(candidate.linkedinUrl)) {
    items.push(`<a class="contact-item" href="${escapeHtml(candidate.linkedinUrl)}">${escapeHtml(deriveLinkDisplay(candidate.linkedinUrl, 'LinkedIn'))}</a>`);
  }

  if (safeText(candidate.portfolioUrl)) {
    items.push(`<a class="contact-item" href="${escapeHtml(candidate.portfolioUrl)}">${escapeHtml(deriveLinkDisplay(candidate.portfolioUrl, '作品集'))}</a>`);
  }

  return items.join('');
}

export function createTemplateDataFromCandidate(candidate, options = {}) {
  const name = safeText(candidate.name, '候选人');
  const linkedinUrl = safeText(candidate.linkedinUrl);
  const portfolioUrl = safeText(candidate.portfolioUrl);

  return {
    LANG: safeText(options.language, 'zh-CN'),
    NAME: name,
    EMAIL: safeText(candidate.email),
    LINKEDIN_URL: linkedinUrl,
    LINKEDIN_DISPLAY: linkedinUrl ? deriveLinkDisplay(linkedinUrl, 'LinkedIn') : '',
    PORTFOLIO_URL: portfolioUrl,
    PORTFOLIO_DISPLAY: portfolioUrl ? deriveLinkDisplay(portfolioUrl, '作品集') : '',
    LOCATION: safeText(candidate.location),
    BIRTH_DATE: safeText(candidate.birthDate, '待补充'),
    CONTACT_ITEMS: renderContactItems(candidate),
    PHOTO_BOX_TEXT: safeText(options.photoBoxText, '照片'),
    PAGE_WIDTH: safeText(options.pageWidth, '8.27in'),
    SECTION_SUMMARY: safeText(options.sectionSummaryLabel, '个人概述'),
    SUMMARY_TEXT: formatRichText(candidate.summary, '暂未填写个人概述。'),
    SECTION_COMPETENCIES: safeText(options.sectionCompetenciesLabel, '核心能力'),
    COMPETENCIES: renderCompetencies(candidate.competencies),
    SECTION_EXPERIENCE: safeText(options.sectionExperienceLabel, '工作经历'),
    EXPERIENCE: renderExperience(candidate.experience),
    SECTION_PROJECTS: safeText(options.sectionProjectsLabel, '项目经历'),
    PROJECTS: renderProjects(candidate.projects),
    SECTION_EDUCATION: safeText(options.sectionEducationLabel, '教育背景'),
    EDUCATION: renderEducation(candidate.education),
    SECTION_CERTIFICATIONS: safeText(options.sectionCertificationsLabel, '证书荣誉'),
    CERTIFICATIONS: renderCertifications(candidate.certifications),
    SECTION_SKILLS: safeText(options.sectionSkillsLabel, '技能清单'),
    SKILLS: renderSkills(candidate.skills)
  };
}
