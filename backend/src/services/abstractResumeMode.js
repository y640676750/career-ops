export const ABSTRACT_AWARD_POOL = Object.freeze([
  '1999年星球大战参与者',
  '2006年美国周刊年度风云人物',
  '2008年感动中国组委会特别奖',
  '2009年年度地球卫士奖',
  '2012年世界末日生存者',
  '2022年纪念碑杯获得者',
  '2022年奥密克戎战争胜利者',
  '诺贝尔文学奖读者'
]);

export const ABSTRACT_SKILL_POOL = Object.freeze([
  'MBTI-ISFJ',
  '清华大学包括国家学生',
  '世界500强简历投递者',
  '亿万资深彩票项目参与者',
  '四大平台买手',
  '瑞幸咖啡购物品鉴师',
  '黄金正脸拥有者',
  '淘宝88VIP',
  '前爱奇艺会员现醒图年费会员',
  '0.011百万粉丝网红博主',
  '和平精英当过几年特种兵',
  'B站收藏夹首席整理官',
  '会议纪要文学常驻作者',
  '地铁通勤冥想型选手',
  '公司下午茶战略观察家'
]);

export const ABSTRACT_STYLE_POOL = Object.freeze([
  '一本正经的年度人物传记腔',
  '互联网黑话混搭梗图播报腔',
  '像行业峰会演讲稿一样夸张但冷静的语气',
  '仿佛高管内推信却每句话都带梗的风格',
  '春晚主持词混搭晋升述职的喜庆风格',
  '朋友圈凡尔赛战报混搭行业白皮书的正经抽象风',
  '县城文学配上市公司复盘会纪要的沉浸式叙事风'
]);

export const ABSTRACT_SUMMARY_HOOK_POOL = Object.freeze([
  '把普通工作经历说出年度人物纪录片的厚重感',
  '让每段项目都像全网热榜现场连麦',
  '把通勤打工写成银河级战略远征',
  '把一次普通复盘写出上市敲钟前夜的紧张感',
  '把周会纪要写成顶流综艺幕后花絮',
  '把日常推进讲出大型史诗片尾字幕的气势'
]);

export const ABSTRACT_BULLET_TAIL_POOL = Object.freeze([
  '并把现场气氛稳成年度名场面',
  '顺便完成了从执行到封神的闭环',
  '最终把项目推进成部门茶水间传说',
  '并留下足以写进组会传记的高光片段',
  '主打一个既交付结果也交付谈资',
  '把普通流程走出了互联网热搜预备役的节奏'
]);

export const ABSTRACT_CLOSING_POOL = Object.freeze([
  '关键时刻能交付，次关键时刻能整活，主打一个情绪价值和结果价值双拉满。',
  '习惯在严肃场景里稳定输出，顺手给团队留下一点值得复述的传奇素材。',
  '既能把事情做完，也能把故事讲满，让简历自带一种荒诞却可信的节奏感。',
  '在看似专业的履历里偷偷埋梗，但交付结果依然稳得像项目周报里的最后一页。',
  '适合需要战斗力、情绪价值和一点点节目效果同时在线的岗位。'
]);

function shuffle(items) {
  const next = [...items];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

export function isAbstractModeEnabled(payload) {
  return payload?.isAbstractMode === true || payload?.options?.isAbstractMode === true;
}

export function pickRandomItems(items, count) {
  return shuffle(items).slice(0, Math.max(0, Math.min(count, items.length)));
}

export function buildAbstractPromptPack() {
  return {
    style: pickRandomItems(ABSTRACT_STYLE_POOL, 1)[0] || ABSTRACT_STYLE_POOL[0],
    awards: pickRandomItems(ABSTRACT_AWARD_POOL, 4),
    skills: pickRandomItems(ABSTRACT_SKILL_POOL, 6),
    summaryHook: pickRandomItems(ABSTRACT_SUMMARY_HOOK_POOL, 1)[0] || ABSTRACT_SUMMARY_HOOK_POOL[0],
    bulletTail: pickRandomItems(ABSTRACT_BULLET_TAIL_POOL, 1)[0] || ABSTRACT_BULLET_TAIL_POOL[0],
    closingLine: pickRandomItems(ABSTRACT_CLOSING_POOL, 1)[0] || ABSTRACT_CLOSING_POOL[0]
  };
}
