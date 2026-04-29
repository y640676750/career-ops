import { hasDeepSeekConfig, generateResumeCustomizationWithDeepSeek } from './deepseekClient.js';
import {
  buildAbstractPromptPack,
  isAbstractModeEnabled,
  pickRandomItems,
  ABSTRACT_AWARD_POOL,
  ABSTRACT_SKILL_POOL
} from './abstractResumeMode.js';
import { createTemplateDataFromCandidate } from './resumeTemplateMapper.js';

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'you', 'our', 'their',
  'will', 'have', 'has', 'had', 'are', 'not', 'but', 'about', 'role', 'team', 'work', 'working',
  'years', 'year', 'experience', 'using', 'build', 'built', 'plus', 'very', 'more', 'than',
  'must', 'nice', 'able', 'across', 'through', 'within', 'what', 'when', 'where',
  'job', 'candidate', 'resume', 'cv', 'position', 'company', 'required', 'preferred', 'strong'
]);

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeString(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function toArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function tokenize(text) {
  return normalizeString(text)
    .toLowerCase()
    .match(/[a-z0-9+#./-]{2,}/g) || [];
}

function extractKeywords(text, limit = 12) {
  const counts = new Map();

  for (const token of tokenize(text)) {
    if (STOPWORDS.has(token) || /^\d+$/.test(token)) {
      continue;
    }

    counts.set(token, (counts.get(token) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([token]) => token);
}

function scoreText(text, keywords) {
  const haystack = tokenize(text);
  return keywords.reduce((score, keyword) => score + (haystack.includes(keyword) ? 1 : 0), 0);
}

function deriveCandidateFromMarkdown(resumeMarkdown, job) {
  const lines = normalizeString(resumeMarkdown)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const firstLine = lines[0] || 'Candidate';
  const summary = lines.slice(1, 4).join(' ');
  const keywords = extractKeywords(`${resumeMarkdown}\n${job.description}`, 10);

  return {
    name: firstLine.replace(/^#+\s*/, ''),
    birthDate: '',
    email: '',
    linkedinUrl: '',
    portfolioUrl: '',
    location: '',
    summary,
    competencies: keywords.slice(0, 8),
    experience: [],
    projects: [],
    education: [],
    certifications: [],
    skills: [
      {
        category: 'Keywords',
        items: keywords
      }
    ]
  };
}

function reorderStringsByKeywords(items, keywords, limit = null) {
  const ordered = toArray(items)
    .slice()
    .sort((a, b) => scoreText(b, keywords) - scoreText(a, keywords));

  return limit ? ordered.slice(0, limit) : ordered;
}

function reorderExperience(experience, keywords) {
  return toArray(experience)
    .map((item) => ({
      ...item,
      bullets: reorderStringsByKeywords(item.bullets, keywords, 5)
    }))
    .sort((a, b) => {
      const aScore = scoreText(`${a.role} ${a.company} ${(a.bullets || []).join(' ')}`, keywords);
      const bScore = scoreText(`${b.role} ${b.company} ${(b.bullets || []).join(' ')}`, keywords);
      return bScore - aScore;
    });
}

function reorderProjects(projects, keywords) {
  return toArray(projects)
    .slice()
    .sort((a, b) => scoreText(`${b.title} ${b.description} ${b.tech}`, keywords) - scoreText(`${a.title} ${a.description} ${a.tech}`, keywords));
}

function reorderSkills(skills, keywords) {
  return toArray(skills)
    .map((item) => ({
      ...item,
      items: reorderStringsByKeywords(item.items, keywords, 8)
    }))
    .sort((a, b) => scoreText(`${b.category} ${(b.items || []).join(' ')}`, keywords) - scoreText(`${a.category} ${(a.items || []).join(' ')}`, keywords));
}

function mergeUniqueStrings(items, limit = 12) {
  const seen = new Set();
  const merged = [];

  for (const item of toArray(items)) {
    const normalized = normalizeString(item);
    if (!normalized) {
      continue;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(normalized);
    if (merged.length >= limit) {
      break;
    }
  }

  return merged;
}

function buildHeuristicSummary(candidate, job, keywords) {
  const roleTitle = normalizeString(job.roleTitle || job.title, 'target role');
  const companyName = normalizeString(job.companyName, 'the company');
  const intro = normalizeString(candidate.summary, `${candidate.name || 'Candidate'} brings relevant experience for ${roleTitle}.`);
  const keywordText = keywords.slice(0, 5).join(', ');

  return `${intro} Tailored for ${roleTitle} at ${companyName}, emphasizing ${keywordText}.`.trim();
}

function applyHeuristicCustomization({ candidate, job }) {
  const baseCandidate = cloneJson(candidate);
  const keywords = extractKeywords(`${job.roleTitle || ''}\n${job.companyName || ''}\n${job.description || ''}`, 12);

  const customizedCandidate = {
    ...baseCandidate,
    summary: buildHeuristicSummary(baseCandidate, job, keywords),
    competencies: reorderStringsByKeywords(baseCandidate.competencies, keywords, 10),
    experience: reorderExperience(baseCandidate.experience, keywords),
    projects: reorderProjects(baseCandidate.projects, keywords),
    education: toArray(baseCandidate.education),
    certifications: toArray(baseCandidate.certifications),
    skills: reorderSkills(baseCandidate.skills, keywords)
  };

  return {
    mode: 'heuristic',
    keywords,
    notes: 'DeepSeek not configured, used heuristic keyword matching.',
    candidate: customizedCandidate
  };
}

function createAbstractSentence(text, fallback, tail) {
  const base = normalizeString(text, fallback);
  return `${base}，${tail}。`;
}

function buildAbstractBullet({ bullet, role, company, award, skill, promptPack }) {
  const base = normalizeString(bullet, `负责${company}${role}相关事项推进`);
  return [
    `${base}`,
    `把现场气氛稳成“${award}”级别的名场面`,
    `顺手以${skill}的视角完成从执行到封神的闭环`,
    promptPack.bulletTail
  ].join('，') + '。';
}

function buildAbstractProjects(baseProjects, roleTitle, companyName, awards, skillMemes) {
  const sourceProjects = toArray(baseProjects).length
    ? toArray(baseProjects)
    : [
        {
          title: `${roleTitle}宇宙级专项`,
          badge: '抽象重点项目',
          description: `围绕${companyName}与${roleTitle}做过一次看似严肃、实则节目效果拉满的项目推进。`,
          tech: `Excel / 汇报文学 / ${skillMemes[0]}`
        },
        {
          title: '跨部门名场面治理工程',
          badge: '热搜预备役',
          description: '在多人协同环境里稳定推进事项，并把过程沉淀成足以写进组会传记的高光片段。',
          tech: `沟通术 / 节奏感 / ${skillMemes[1] || skillMemes[0]}`
        }
      ];

  return sourceProjects.map((item, index) => ({
    ...item,
    title: normalizeString(item.title, `${roleTitle}宇宙级专项`),
    badge: normalizeString(item.badge, `抽象项目 ${index + 1}`),
    description: createAbstractSentence(
      item.description,
      `围绕${companyName}和${roleTitle}完成了一次戏剧张力与交付结果并存的项目推进`,
      `${awards[index % awards.length]}气质 + ${skillMemes[index % skillMemes.length]}视角双重加成`
    ),
    tech: normalizeString(item.tech, `Excel / 复盘文学 / ${skillMemes[(index + 1) % skillMemes.length]}`)
  }));
}

function buildAbstractEducation(baseEducation, roleTitle, companyName, awards) {
  const sourceEducation = toArray(baseEducation).length
    ? toArray(baseEducation)
    : [
        {
          title: `${roleTitle}相关修炼`,
          org: '社会大学',
          year: '持续进修',
          description: `在${companyName}相关语境下长期研究“如何把普通工作讲出大片预告片感”。`
        }
      ];

  return sourceEducation.map((item, index) => ({
    ...item,
    title: normalizeString(item.title, `${roleTitle}相关修炼`),
    org: normalizeString(item.org, '社会大学'),
    year: normalizeString(item.year, '持续进修'),
    description: createAbstractSentence(
      item.description,
      `围绕${roleTitle}和${companyName}方向补齐基础背景`,
      `${awards[index % awards.length]}风格的知识沉淀`
    )
  }));
}

function buildAbstractCertifications(baseCertifications, awards) {
  const normalizedBase = toArray(baseCertifications).map((item) => ({
    title: normalizeString(item.title, awards[0]),
    org: normalizeString(item.org, '抽象成就认证中心'),
    year: normalizeString(item.year, '长期有效')
  }));

  const generatedAwards = awards.slice(0, 3).map((title, index) => ({
    title,
    org: '抽象简历联合会',
    year: String(2022 + index)
  }));

  return [...normalizedBase, ...generatedAwards].slice(0, 6);
}

function buildAbstractSkillGroups(baseSkills, keywords, skillMemes, awards) {
  return [
    ...reorderSkills(baseSkills, keywords),
    {
      category: '抽象技能',
      items: skillMemes
    },
    {
      category: '整活荣誉',
      items: awards
    },
    {
      category: '互联网生存画像',
      items: [
        '会开复盘会，也会开玩笑',
        '懂交付，也懂情绪价值',
        '关键节点不掉线，次关键节点能出圈'
      ]
    }
  ];
}

function applyAbstractCustomization({ candidate, job }) {
  const baseCandidate = ensureStructuredCandidate(candidate);
  const keywords = extractKeywords(`${job.roleTitle || ''}\n${job.companyName || ''}\n${job.description || ''}`, 12);
  const promptPack = buildAbstractPromptPack();
  const awards = promptPack.awards.length ? promptPack.awards : pickRandomItems(ABSTRACT_AWARD_POOL, 4);
  const skillMemes = promptPack.skills.length ? promptPack.skills : pickRandomItems(ABSTRACT_SKILL_POOL, 6);
  const roleTitle = normalizeString(job.roleTitle || '全能选手');
  const companyName = normalizeString(job.companyName || '神秘甲方');
  const summary = [
    `${baseCandidate.name || '候选人'}表面上是来应聘${companyName}的${roleTitle}，实际上是一位能把日常工作写成年度人物特稿的整活型选手。`,
    `${promptPack.summaryHook}，擅长把普通事项包装成“${awards[0]}”级别的社会新闻现场，同时保持语气稳重得像真的。`,
    `自带${skillMemes[0]}与${skillMemes[1] || skillMemes[0]}双重气质，在汇报、复盘、推进、救火等场景里都能把节目效果和完成度一起拉满。`,
    promptPack.closingLine
  ].join('');

  const competencies = mergeUniqueStrings(
    [
      ...reorderStringsByKeywords(baseCandidate.competencies, keywords, 6),
      ...skillMemes.slice(0, 4),
      '一本正经地输出离谱亮点',
      '高压场景下稳定制造名场面',
      '会议纪要文学',
      '跨部门气氛组管理'
    ],
    10
  );

  const sourceExperience = toArray(baseCandidate.experience).length
    ? toArray(baseCandidate.experience)
    : [
        {
          company: companyName,
          role: roleTitle,
          location: '',
          period: '',
          bullets: [
            `负责${roleTitle}相关事项推进`,
            `在多线程环境里稳定串联上下游`,
            '把复杂需求整理成大家愿意转发的版本'
          ]
        }
      ];

  const experience = sourceExperience.map((item, index) => {
    const role = normalizeString(item.role, roleTitle);
    const company = normalizeString(item.company, companyName);
    const sourceBullets = toArray(item.bullets);
    const bullets = (sourceBullets.length ? sourceBullets : [
      `负责${role}方向的关键推进`,
      `在${company}的多线程场景中稳定交付`,
      '把复杂需求整理成大家都能听懂的版本'
    ]).slice(0, 5).map((bullet, bulletIndex) => buildAbstractBullet({
      bullet,
      role,
      company,
      award: awards[(index + bulletIndex) % awards.length],
      skill: skillMemes[(index + bulletIndex) % skillMemes.length],
      promptPack
    }));

    return {
      ...item,
      company,
      role,
      bullets
    };
  });

  return {
    mode: 'abstract-heuristic',
    keywords: mergeUniqueStrings([...keywords.slice(0, 6), ...skillMemes.slice(0, 4)], 12),
    notes: `Abstract mode enabled with ${promptPack.style}.`,
    candidate: {
      ...baseCandidate,
      summary,
      competencies,
      experience,
      projects: buildAbstractProjects(baseCandidate.projects, roleTitle, companyName, awards, skillMemes),
      education: buildAbstractEducation(baseCandidate.education, roleTitle, companyName, awards),
      certifications: buildAbstractCertifications(baseCandidate.certifications, awards),
      skills: buildAbstractSkillGroups(baseCandidate.skills, keywords, skillMemes, awards)
    }
  };
}

function ensureStructuredCandidate(input) {
  return {
    name: normalizeString(input?.name, 'Candidate'),
    birthDate: normalizeString(input?.birthDate),
    email: normalizeString(input?.email),
    linkedinUrl: normalizeString(input?.linkedinUrl),
    portfolioUrl: normalizeString(input?.portfolioUrl),
    location: normalizeString(input?.location),
    summary: normalizeString(input?.summary),
    competencies: toArray(input?.competencies),
    experience: toArray(input?.experience).map((item) => ({
      company: normalizeString(item.company),
      role: normalizeString(item.role),
      location: normalizeString(item.location),
      period: normalizeString(item.period),
      bullets: toArray(item.bullets).map((bullet) => normalizeString(bullet)).filter(Boolean)
    })),
    projects: toArray(input?.projects).map((item) => ({
      title: normalizeString(item.title),
      badge: normalizeString(item.badge),
      description: normalizeString(item.description),
      tech: normalizeString(item.tech)
    })),
    education: toArray(input?.education).map((item) => ({
      title: normalizeString(item.title),
      org: normalizeString(item.org),
      year: normalizeString(item.year),
      description: normalizeString(item.description)
    })),
    certifications: toArray(input?.certifications).map((item) => ({
      title: normalizeString(item.title),
      org: normalizeString(item.org),
      year: normalizeString(item.year)
    })),
    skills: toArray(input?.skills).map((item) => ({
      category: normalizeString(item.category),
      items: toArray(item.items).map((skill) => normalizeString(skill)).filter(Boolean)
    }))
  };
}

export async function customizeResume(payload) {
  const abstractMode = isAbstractModeEnabled(payload);
  const job = {
    companyName: normalizeString(payload.job?.companyName),
    roleTitle: normalizeString(payload.job?.roleTitle || payload.job?.title),
    description: normalizeString(payload.job?.description),
    language: normalizeString(payload.job?.language, 'zh-CN')
  };

  const baseCandidate = payload.candidate
    ? ensureStructuredCandidate(payload.candidate)
    : deriveCandidateFromMarkdown(payload.resumeMarkdown, job);

  let customization;

  if (hasDeepSeekConfig()) {
    try {
      const deepseekResult = await generateResumeCustomizationWithDeepSeek({
        candidate: baseCandidate,
        resumeMarkdown: normalizeString(payload.resumeMarkdown),
        job,
        isAbstractMode: abstractMode
      });

      const structuredCandidate = ensureStructuredCandidate(deepseekResult.candidate || baseCandidate);

      if (abstractMode) {
        const abstractPolish = applyAbstractCustomization({ candidate: structuredCandidate, job });
        customization = {
          mode: 'deepseek-abstract',
          keywords: mergeUniqueStrings([...toArray(deepseekResult.keywords), ...toArray(abstractPolish.keywords)], 12),
          notes: [
            normalizeString(deepseekResult.notes),
            normalizeString(abstractPolish.notes),
            'Abstract polish applied.'
          ].filter(Boolean).join(' | '),
          candidate: abstractPolish.candidate
        };
      } else {
        customization = {
          mode: 'deepseek',
          keywords: toArray(deepseekResult.keywords).slice(0, 12),
          notes: normalizeString(deepseekResult.notes),
          candidate: structuredCandidate
        };
      }
    } catch (error) {
      customization = {
        ...(abstractMode
          ? applyAbstractCustomization({ candidate: baseCandidate, job })
          : applyHeuristicCustomization({ candidate: baseCandidate, job })),
        notes: `DeepSeek fallback triggered: ${error.message}`
      };
    }
  } else {
    customization = abstractMode
      ? applyAbstractCustomization({ candidate: baseCandidate, job })
      : applyHeuristicCustomization({ candidate: baseCandidate, job });
  }

  return {
    ...customization,
    templateData: createTemplateDataFromCandidate(customization.candidate, {
      language: job.language
    })
  };
}
