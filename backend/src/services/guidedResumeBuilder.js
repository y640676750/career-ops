import { env } from '../config/env.js';
import { generateStructuredResumeFromGuidedInput, hasDeepSeekConfig } from './deepseekClient.js';

function normalizeString(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function toArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function mergeUniqueStrings(items, limit = 12) {
  const seen = new Set();
  const merged = [];

  for (const item of items) {
    const text = normalizeString(item);
    if (!text) {
      continue;
    }

    const key = text.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(text);
    if (merged.length >= limit) {
      break;
    }
  }

  return merged;
}

function hasMeaningfulStoryText(text) {
  const normalized = normalizeString(text).replace(/\s+/g, '');
  if (!normalized) {
    return false;
  }

  return !/^(无|暂无|没有|没写|无项目|没有项目|没有经历|无工作经验|无实习|none|null|na|n\/a)$/i.test(normalized);
}

function splitStoryIntoBullets(text) {
  const normalized = normalizeString(text);
  if (!normalized) {
    return [];
  }

  const items = normalized
    .split(/\r?\n|[；;]+|(?<=[。！？.!?])/u)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 6);

  if (items.length) {
    return items;
  }

  return [normalized];
}

function pickCompetencies(builderData) {
  return [
    builderData.targetRole,
    builderData.educationMajor,
    builderData.storyRole,
    builderData.storyTitle
  ]
    .map((item) => normalizeString(item))
    .filter(Boolean)
    .slice(0, 6);
}

function inferRoleToolkit(targetRole) {
  const role = normalizeString(targetRole);

  if (/产品|PM|prd|经理/i.test(role)) {
    return {
      competencies: ['需求分析', '用户调研', '竞品分析', 'PRD 文档', '数据复盘', '跨部门沟通', '原型表达', '业务拆解'],
      skills: [
        { category: '产品方法', items: ['需求拆解', '用户旅程', '竞品分析', 'PRD 撰写', 'MVP 验证'] },
        { category: '数据与工具', items: ['Excel', '问卷调研', '漏斗分析', '原型图', '复盘报告'] }
      ],
      projectFocus: ['岗位需求拆解', '用户场景分析', '竞品体验复盘']
    };
  }

  if (/运营|增长|内容|新媒体|社群/i.test(role)) {
    return {
      competencies: ['内容策划', '活动运营', '用户增长', '数据复盘', '社群维护', '热点捕捉', '转化链路', '执行推进'],
      skills: [
        { category: '运营方法', items: ['内容选题', '活动策划', '用户分层', '转化复盘', '社群 SOP'] },
        { category: '工具能力', items: ['Excel', '数据看板', '文案表达', '素材整理', '复盘报告'] }
      ],
      projectFocus: ['内容选题库搭建', '活动方案设计', '用户增长复盘']
    };
  }

  if (/前端|后端|开发|工程师|Java|Python|Node|测试|算法|数据/i.test(role)) {
    return {
      competencies: ['技术学习能力', '问题拆解', '代码实现', '接口理解', '文档沉淀', '调试排障', '版本管理', '持续迭代'],
      skills: [
        { category: '工程基础', items: ['Git', '接口联调', '调试排障', '技术文档', '模块拆解'] },
        { category: '项目方法', items: ['需求理解', '任务拆分', '测试验证', '复盘迭代', '性能意识'] }
      ],
      projectFocus: ['个人技术项目', '接口联调练习', '问题排查复盘']
    };
  }

  return {
    competencies: ['学习能力', '结构化表达', '信息整理', '执行推进', '沟通协作', '数据意识', '复盘沉淀', '岗位匹配度'],
    skills: [
      { category: '通用能力', items: ['信息检索', '结构化表达', 'Excel', '文档整理', '复盘总结'] },
      { category: '协作能力', items: ['沟通协作', '任务拆解', '时间管理', '主动学习', '结果意识'] }
    ],
    projectFocus: ['岗位能力作品集', '课程调研项目', '公开资料分析']
  };
}

function buildFreshGraduateSummary(builderData, toolkit) {
  const school = normalizeString(builderData.educationSchool, '学校');
  const major = normalizeString(builderData.educationMajor, '相关专业');
  const role = normalizeString(builderData.targetRole, '目标岗位');
  const focus = toolkit.competencies.slice(0, 4).join('、');

  return `${builderData.name}正在应聘${role}方向，具备${school}${major}学习背景，已围绕岗位要求主动补齐${focus}等核心能力。虽然正式项目经历有限，但能通过课程实践、个人作品集和公开资料研究快速形成可交付方案，适合从助理/初级岗位切入并持续成长。`;
}

function buildFreshGraduateExperience(builderData, toolkit) {
  const role = normalizeString(builderData.targetRole, '目标岗位');
  const school = normalizeString(builderData.educationSchool, '校园');
  const focus = toolkit.projectFocus[0] || '岗位能力拆解';

  return [
    {
      company: `${school} · 校园与课程实践`,
      role: `${role}方向储备`,
      location: '',
      period: normalizeString(builderData.educationYear) ? `${builderData.educationYear}届` : '',
      bullets: [
        `围绕${role}岗位 JD 拆解核心要求，将能力项整理为学习清单、作品集主题和面试表达素材，形成清晰的求职准备路径。`,
        `基于公开资料完成${focus}，输出问题背景、目标用户、核心流程和可优化点，训练结构化分析与方案表达能力。`,
        `将课程作业、调研记录和个人练习沉淀为可复用文档，重点强化${toolkit.competencies.slice(0, 3).join('、')}能力。`
      ]
    }
  ];
}

function buildFreshGraduateProjects(builderData, toolkit) {
  const role = normalizeString(builderData.targetRole, '目标岗位');
  const major = normalizeString(builderData.educationMajor, '专业课程');
  const focus = toolkit.projectFocus;

  return [
    {
      title: `${role}岗位能力作品集`,
      badge: '个人作品集',
      description: `围绕目标岗位要求梳理行业案例、用户场景和核心流程，产出岗位能力地图、竞品观察和可执行优化建议，让零散学习成果变成可展示材料。`,
      tech: mergeUniqueStrings(['岗位 JD 拆解', focus[0], ...toolkit.competencies.slice(0, 4)], 7).join(' / ')
    },
    {
      title: `${major}课程调研与方案练习`,
      badge: '课程项目',
      description: `结合专业课程和公开资料完成主题调研，从背景、问题、对象、方案和复盘五个维度整理内容，突出学习能力、资料分析和结构化表达。`,
      tech: mergeUniqueStrings(['资料检索', '结构化分析', '汇报表达', focus[1], '复盘总结'], 6).join(' / ')
    },
    {
      title: `${role}入门实战模拟`,
      badge: '岗位模拟',
      description: `以真实招聘要求为参照，模拟完成从需求理解、任务拆分到成果复盘的完整链路，重点呈现可迁移的执行力和岗位理解力。`,
      tech: mergeUniqueStrings(['需求理解', '任务拆分', focus[2], 'Excel', '文档沉淀'], 6).join(' / ')
    }
  ];
}

function buildEducationDescription(builderData, toolkit) {
  const major = normalizeString(builderData.educationMajor);
  const focus = toolkit.competencies.slice(0, 4).join('、');
  if (major) {
    return `${major}背景，重点突出${focus}等与目标岗位相关的可迁移能力。`;
  }

  return `围绕目标岗位补充${focus}等基础能力，可在后续继续完善专业、课程和证书信息。`;
}

function ensureCandidateShape(input = {}) {
  return {
    name: normalizeString(input.name, '候选人'),
    birthDate: normalizeString(input.birthDate),
    email: normalizeString(input.email),
    linkedinUrl: normalizeString(input.linkedinUrl),
    portfolioUrl: normalizeString(input.portfolioUrl),
    location: normalizeString(input.location),
    summary: normalizeString(input.summary),
    competencies: toArray(input.competencies).map((item) => normalizeString(item)).filter(Boolean),
    experience: toArray(input.experience).map((item) => ({
      company: normalizeString(item.company),
      role: normalizeString(item.role),
      location: normalizeString(item.location),
      period: normalizeString(item.period),
      bullets: toArray(item.bullets).map((bullet) => normalizeString(bullet)).filter(Boolean)
    })),
    projects: toArray(input.projects).map((item) => ({
      title: normalizeString(item.title),
      badge: normalizeString(item.badge),
      description: normalizeString(item.description),
      tech: normalizeString(item.tech)
    })),
    education: toArray(input.education).map((item) => ({
      title: normalizeString(item.title),
      org: normalizeString(item.org),
      year: normalizeString(item.year),
      description: normalizeString(item.description)
    })),
    certifications: toArray(input.certifications).map((item) => ({
      title: normalizeString(item.title),
      org: normalizeString(item.org),
      year: normalizeString(item.year)
    })),
    skills: toArray(input.skills).map((item) => ({
      category: normalizeString(item.category),
      items: toArray(item.items).map((skill) => normalizeString(skill)).filter(Boolean)
    }))
  };
}

function createFallbackCandidate(builderData) {
  const hasStory = hasMeaningfulStoryText(builderData.storyText);
  const bullets = splitStoryIntoBullets(builderData.storyText);
  const toolkit = inferRoleToolkit(builderData.targetRole);
  const competencies = mergeUniqueStrings([...pickCompetencies(builderData), ...toolkit.competencies], 10);
  const fallbackProjects = buildFreshGraduateProjects(builderData, toolkit);

  return ensureCandidateShape({
    name: builderData.name,
    email: builderData.contact,
    summary: hasStory
      ? `${builderData.name}希望应聘${builderData.targetRole}，具备${builderData.educationMajor || '相关'}背景，并积累了可直接迁移到目标岗位的一线经验。`
      : buildFreshGraduateSummary(builderData, toolkit),
    competencies,
    experience: hasStory
      ? [
          {
            company: builderData.storyTitle || '经历亮点',
            role: builderData.storyRole || builderData.targetRole,
            location: '',
            period: '',
            bullets
          }
        ]
      : buildFreshGraduateExperience(builderData, toolkit),
    projects: hasStory
      ? [
          {
            title: builderData.storyTitle || `${builderData.targetRole}相关项目`,
            badge: builderData.storyRole || '经历亮点',
            description: bullets.join(' '),
            tech: competencies.slice(0, 6).join(' / ')
          },
          ...fallbackProjects.slice(0, 1)
        ]
      : fallbackProjects,
    education: [
      {
        title: builderData.educationMajor || '教育背景',
        org: builderData.educationSchool,
        year: builderData.educationYear,
        description: buildEducationDescription(builderData, toolkit)
      }
    ],
    skills: [
      {
        category: '求职方向',
        items: competencies.length ? competencies : [builderData.targetRole]
      },
      ...toolkit.skills
    ]
  });
}

function hasExperienceBullets(candidate) {
  return toArray(candidate.experience).some((item) => toArray(item.bullets).length > 0);
}

function mergeFreshGraduateFallback(candidate, fallback) {
  const candidateProjects = toArray(candidate.projects);
  const fallbackProjects = toArray(fallback.projects);
  const projects = candidateProjects.length >= 2
    ? candidateProjects
    : [...candidateProjects, ...fallbackProjects].slice(0, 3);
  const candidateSkills = toArray(candidate.skills);
  const fallbackSkills = toArray(fallback.skills);

  return ensureCandidateShape({
    ...fallback,
    ...candidate,
    summary: normalizeString(candidate.summary, fallback.summary),
    competencies: mergeUniqueStrings([
      ...toArray(candidate.competencies),
      ...toArray(fallback.competencies)
    ], 10),
    experience: hasExperienceBullets(candidate) ? candidate.experience : fallback.experience,
    projects,
    education: toArray(candidate.education).length ? candidate.education : fallback.education,
    certifications: toArray(candidate.certifications),
    skills: candidateSkills.length >= 2 ? candidateSkills : [...candidateSkills, ...fallbackSkills].slice(0, 4)
  });
}

function candidateToResumeText(candidate, builderData) {
  const sections = [
    `姓名：${candidate.name}`,
    candidate.birthDate ? `出生年月：${candidate.birthDate}` : '',
    `意向岗位：${builderData.targetRole}`,
    `联系方式：${builderData.contact}`,
    '',
    '个人概述',
    candidate.summary,
    '',
    '核心能力',
    candidate.competencies.join('、'),
    '',
    '教育背景',
    candidate.education
      .map((item) => [item.org, item.title, item.year].filter(Boolean).join(' / '))
      .filter(Boolean)
      .join('\n'),
    '',
    '经历 / 项目',
    candidate.experience
      .map((item) => {
        const header = [item.company, item.role, item.period].filter(Boolean).join(' / ');
        const bullets = item.bullets.map((bullet) => `- ${bullet}`).join('\n');
        return [header, bullets].filter(Boolean).join('\n');
      })
      .filter(Boolean)
      .join('\n\n'),
    '',
    '项目作品',
    candidate.projects
      .map((item) => [item.title, item.badge, item.description, item.tech].filter(Boolean).join('\n'))
      .filter(Boolean)
      .join('\n\n'),
    '',
    '技能',
    candidate.skills
      .map((item) => `${item.category}：${item.items.join('、')}`)
      .filter(Boolean)
      .join('\n')
  ]
    .map((item) => String(item || '').trim())
    .filter((item, index, list) => item || (index < list.length - 1 && list[index + 1]))
    .join('\n');

  if (sections.length <= env.maxResumeTextChars) {
    return {
      resumeText: sections,
      truncated: false
    };
  }

  return {
    resumeText: sections.slice(0, env.maxResumeTextChars),
    truncated: true
  };
}

function buildResumeSource(candidate, builderData, mode, notes) {
  const { resumeText, truncated } = candidateToResumeText(candidate, builderData);
  const safeName = normalizeString(builderData.name, 'guided-resume').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 40);

  return {
    origin: 'builder',
    fileName: `${safeName || 'guided-resume'}-builder.txt`,
    fileType: 'builder',
    textLength: resumeText.length,
    truncated,
    preview: resumeText.slice(0, 280),
    resumeText,
    candidate,
    mode,
    notes
  };
}

export async function createResumeSourceFromGuidedInput(builderData) {
  const normalized = {
    name: normalizeString(builderData.name, '候选人'),
    targetRole: normalizeString(builderData.targetRole || builderData.roleTitle, '目标岗位'),
    contact: normalizeString(builderData.contact, '待补充联系方式'),
    educationSchool: normalizeString(builderData.educationSchool || builderData.school, ''),
    educationMajor: normalizeString(builderData.educationMajor || builderData.major, ''),
    educationYear: normalizeString(builderData.educationYear || builderData.graduationYear, ''),
    storyTitle: normalizeString(builderData.storyTitle || builderData.organizationName, ''),
    storyRole: normalizeString(builderData.storyRole || builderData.roleName, ''),
    storyText: normalizeString(builderData.storyText || builderData.experienceSummary, ''),
    language: normalizeString(builderData.language, 'zh')
  };

  let candidate = createFallbackCandidate(normalized);
  let mode = 'heuristic';
  let notes = 'DeepSeek 未配置，已使用规则化扩写生成母本简历。';

  if (hasDeepSeekConfig()) {
    try {
      const deepseekResult = await generateStructuredResumeFromGuidedInput(normalized);
      candidate = ensureCandidateShape(deepseekResult.candidate || candidate);
      if (!hasMeaningfulStoryText(normalized.storyText)) {
        const fallbackCandidate = createFallbackCandidate(normalized);
        candidate = mergeFreshGraduateFallback(candidate, fallbackCandidate);
      }
      mode = 'deepseek';
      notes = normalizeString(deepseekResult.notes, '已通过 DeepSeek 完成白话润色与结构化。');
    } catch (error) {
      notes = `DeepSeek 润色失败，已回退为规则化生成：${error.message}`;
    }
  }

  return {
    mode,
    notes,
    candidate,
    source: buildResumeSource(candidate, normalized, mode, notes)
  };
}
