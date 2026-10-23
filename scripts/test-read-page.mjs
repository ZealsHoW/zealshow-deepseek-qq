// qq_read_page / webshot.readWebsite 的离线回归：只测纯函数与「拒绝本机地址」，
// 不启动浏览器（真正跑 Chrome 的那段留给手动 ``node scripts/smoke-read-page.mjs``）。
// 用法：node scripts/test-read-page.mjs
import { extractUrl, cleanPageText, buildPageRead, readWebsite } from '../src/webshot.js';
import { emptyWatchState, nextWatchState, shouldNotifyWatch, buildWatchNotice } from '../src/qqb/read-login-watch.mjs';

let failed = 0;
const assert = (name, cond, extra = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
};

// ── extractUrl：能吃纯链接、也能从整段抖音口令里抠 ────────────────────────
const share = '8.97 复制打开抖音，看看【小鲸鱼的日常的作品】今天也在摸鱼 # 日常 https://v.douyin.com/iAbCdEf12/ 复制此链接，打开Dou音搜索，直接观看视频！';
assert('抖音口令抠出短链', extractUrl(share) === 'https://v.douyin.com/iAbCdEf12/');
assert('纯 URL 原样', extractUrl('https://www.douyin.com/video/7450000000000000000') === 'https://www.douyin.com/video/7450000000000000000');
assert('裸域名补 https', extractUrl('v.douyin.com/iAbCdEf/') === 'https://v.douyin.com/iAbCdEf/');
assert('链接后面的中文标点被剥掉', extractUrl('看这个 https://www.bilibili.com/video/BV1xx411c7mD，好看') === 'https://www.bilibili.com/video/BV1xx411c7mD');
assert('没有链接时报错', (() => { try { extractUrl('今天天气不错'); return false; } catch (e) { return /没在提供的文本里找到网址/.test(e.message); } })());
assert('空输入报错', (() => { try { extractUrl('   '); return false; } catch (e) { return /请提供网页链接/.test(e.message); } })());

// ── cleanPageText：去导航噪音、去连续重复、压空行 ────────────────────
const messy = '首页\n推荐\n\n\n抖音\n  视频文案第一行  \n视频文案第一行\n\n\n第二段\n登录\n';
const cleaned = cleanPageText(messy);
assert('导航噪音被丢掉', !/首页|推荐|登录/.test(cleaned), JSON.stringify(cleaned));
assert('连续重复行只留一行', (cleaned.match(/视频文案第一行/g) || []).length === 1);
assert('空行压成单空行', cleaned === '抖音\n视频文案第一行\n\n第二段', JSON.stringify(cleaned));

// ── buildPageRead：通用网页 ──────────────────────────────────────────────
const generic = buildPageRead({
  url: 'https://news.example.com/a/1',
  title: '  一条  新闻  ',
  text: '首段内容。\n\n导航\n\n第二段内容。'
});
assert('通用页 title 归一化', generic.title === '一条 新闻', generic.title);
assert('通用页没有抖音字段', generic.author === '' && generic.comments.length === 0 && generic.statLine === '');
assert('通用页正文被清洗', generic.text === '首段内容。\n\n第二段内容。', JSON.stringify(generic.text));
assert('未知站点回落 hostname', generic.site === 'news.example.com', generic.site);

// ── buildPageRead：抖音视频页（有结构化字段时不用整页正文） ─────────────
const douyin = buildPageRead({
  url: 'https://www.douyin.com/video/7450000000000000000',
  title: '小鲸鱼的作品 - 抖音',
  text: '首页 推荐 搜索\n乱七八糟的推荐流\n更多视频',
  douyin: {
    desc: '今天也在摸鱼 #日常',
    author: '小鲸鱼',
    stats: { like: '1.2万', comment: '233', collect: '88', share: '12' },
    comments: ['第一条热评', '第二条热评']
  }
});
assert('抖音站点标签', douyin.site === '抖音', douyin.site);
assert('抖音作者提取', douyin.author === '小鲸鱼');
assert('抖音数据行', douyin.statLine === '点赞 1.2万 · 评论 233 · 收藏 88 · 分享 12', douyin.statLine);
assert('抖音文案优先于整页正文', douyin.text.startsWith('今天也在摸鱼 #日常'), JSON.stringify(douyin.text));
assert('抖音热评带序号', /热评：\n1\. 第一条热评\n2\. 第二条热评/.test(douyin.text), JSON.stringify(douyin.text));
assert('抖音推荐流噪音不进正文', !douyin.text.includes('乱七八糟'), JSON.stringify(douyin.text));
assert('有文案时不带 note', douyin.note === '', douyin.note);

// ── 现版抖音的真实节点形状（2026-10 实测抓下来的 innerText） ─────────────
const realDouyin = buildPageRead({
  url: 'https://www.douyin.com/video/7698217103421099304',
  title: '官府为何说只收一回 - 抖音',
  links: [
    'https://www.douyin.com/video/7698217103421099304',
    'https://www.douyin.com/video/7698003922942787746',
    'https://www.douyin.com/video/7698217103421099304',
    'https://www.douyin.com/hot'
  ],
  text: [
    '精选', 'AI抖音', '我的', '直播', '放映厅', '短剧', '小游戏',
    '官府为何说只收一回，竟年年加派压榨百姓？#历史',
    '智能', '清屏', '连播', '分享', '回复',
    '王清', '古代人就该造反', '2天前·浙江',
    '粉丝2062获赞2.8万', '违法和不良信息举报 400-140-2108',
    '推荐视频', '01:40', '古代光棍怎么解决需求？ #历史'
  ].join('\n'),
  douyin: {
    desc: '官府为何说只收一回，竟年年加派压榨百姓？#历史\n241\n10\n26\n7\n举报\n发布时间：2026-10-19 11:34',
    author: '故岁书粉丝2062获赞2.8万关注',
    stats: { like: '241', comment: '10', collect: '26', share: '7' },
    comments: ['王清\n...\n古代人就该造反\n2天前·浙江\n\n2\n\n分享\n回复\n展开2条回复']
  }
});
assert('真实节点：文案只留标题行', realDouyin.desc === '官府为何说只收一回，竟年年加派压榨百姓？#历史', realDouyin.desc);
assert('真实节点：作者去掉粉丝数', realDouyin.author === '故岁书', realDouyin.author);
assert('真实节点：热评拼成「昵称：内容」', realDouyin.text.includes('1. 王清：古代人就该造反'), JSON.stringify(realDouyin.text));
assert('真实节点：正文不重复热评', (realDouyin.text.match(/古代人就该造反/g) || []).length === 1, JSON.stringify(realDouyin.text));
assert('真实节点：播放器/页脚噪音不进正文', !/智能|清屏|连播|违法和不良信息|粉丝2062/.test(realDouyin.text), JSON.stringify(realDouyin.text));
assert('真实节点：推荐视频还在', realDouyin.text.includes('古代光棍怎么解决需求'));
assert('真实节点：视频链接去重且只留 video 页', realDouyin.videoLinks.length === 2 && realDouyin.videoLinks.every((h) => /\/video\/\d+/.test(h)), JSON.stringify(realDouyin.videoLinks));

// 热榜页：没有结构化文案，只去掉导航/页脚，时长和标题都留着
const hot = buildPageRead({
  url: 'https://www.douyin.com/hot',
  text: ['精选', 'AI抖音', '我的', '直播', '放映厅', '短剧', '小游戏',
    '热点视频', '03:31', '蹬轮子，撇球子 #豪赤一郎', '@东北老妈在日本', '· 3天前',
    '违法和不良信息举报 400-140-2108'].join('\n')
});
assert('热榜页保留视频标题与时长', /03:31/.test(hot.text) && /豪赤一郎/.test(hot.text), JSON.stringify(hot.text));
assert('热榜页导航被清掉', !/放映厅|短剧|违法和不良信息/.test(hot.text), JSON.stringify(hot.text));


const long = buildPageRead({ url: 'https://example.org/x', text: '啊'.repeat(9000) }, { maxChars: 500 });
assert('超长正文被截断', long.text.length === 501 && long.truncated && long.chars === 9000, `${long.text.length}/${long.chars}`);
assert('截断后带省略号', long.text.endsWith('…'));
const short = buildPageRead({ url: 'https://example.org/x', text: '很短' }, { maxChars: 500 });
assert('短正文不标记截断', short.truncated === false && short.text === '很短');
const wall = buildPageRead({ url: 'https://www.douyin.com/x', text: '请完成验证 登录后查看更多' });
assert('风控页给 note', /风控验证|要求登录/.test(wall.note), wall.note);
assert('风控页标记成登录墙', wall.loginWall === true, String(wall.loginWall));
const empty = buildPageRead({ url: 'https://www.douyin.com/x', text: '' });
assert('空页给 note', /没有可读正文/.test(empty.note), empty.note);
const douyinEmpty = buildPageRead({ url: 'https://www.douyin.com/hot', text: '' });
assert('抖音页读空也算登录墙（正常时热榜一定有内容）', douyinEmpty.loginWall === true, String(douyinEmpty.loginWall));
const douyinSparseVideo = buildPageRead({
  url: 'https://www.douyin.com/video/7450000000',
  title: '某个作品 - 抖音',
  text: '某个视频',
  douyin: { author: '某某', stats: { like: '3' } }
});
assert('抖音视频页只是正文短、但有作者/点赞数时不算登录墙', douyinSparseVideo.loginWall === false,
  `${douyinSparseVideo.loginWall}/${douyinSparseVideo.chars}字/${douyinSparseVideo.statLine}`);
const otherEmpty = buildPageRead({ url: 'https://example.org/x', text: '' });
assert('非抖音的空页不算登录墙（纯视频/图片页本来就空）', otherEmpty.loginWall === false, String(otherEmpty.loginWall));
// 反向误报：页面骨架里常年有「登录」两个字（抖音/微博都有登录按钮），
// 只要正文读到了就绝不能被算成撞墙 —— 否则主人会被无关紧要地打扰。
const goodWithLoginWord = buildPageRead({
  url: 'https://www.douyin.com/hot',
  text: ['登录', ...Array.from({ length: 30 }, (_, i) => `热点视频标题${i} 0${(i % 9) + 1}:${10 + i} 播放${i * 137}`)].join('\n')
});
assert('读到正文时不算登录墙', goodWithLoginWord.loginWall === false, `${goodWithLoginWord.loginWall}/${goodWithLoginWord.chars}字`);

// ── read-login-watch：掉登录的状态机（连续撞墙才提醒、去重不刷屏）─────────
let watch = emptyWatchState();
watch = nextWatchState(watch, { loginWall: true, url: 'https://www.douyin.com/hot', now: 1000 });
assert('撞一次登录墙计数为 1', watch.consecutive === 1 && watch.lastWallAt === 1000, JSON.stringify(watch));
assert('撞 1 次还不提醒', shouldNotifyWatch(watch, 2000, { threshold: 2 }).notify === false);
watch = nextWatchState(watch, { loginWall: true, url: 'https://www.douyin.com/hot', now: 2000 });
assert('连续撞 2 次就提醒', shouldNotifyWatch(watch, 3000, { threshold: 2 }).notify === true);
const deduped = shouldNotifyWatch({ ...watch, notifiedAt: 3000 }, 3000 + 3600_000, { threshold: 2 });
assert('提醒过之后 12 小时内不重复', deduped.notify === false, deduped.reason);
assert('过了 12 小时还能再提醒', shouldNotifyWatch({ ...watch, notifiedAt: 3000 }, 3000 + 13 * 3600_000, { threshold: 2 }).notify === true);
const recovered = nextWatchState(watch, { loginWall: false, url: 'https://www.douyin.com/hot', now: 5000 });
assert('读到正常内容计数清零', recovered.consecutive === 0 && recovered.lastOkAt === 5000, JSON.stringify(recovered));
assert('清了零就不再提醒', shouldNotifyWatch(recovered, 6000, { threshold: 2 }).notify === false);
const notice = buildWatchNotice({ ...watch, notifiedAt: 3000 }, 3000);
assert('提醒正文说明白 + 给出修法 + 说清多久不重复',
  /抖音登录态可能过期/.test(notice) && /douyin\.com\/hot/.test(notice) && /launchLoginBrowser/.test(notice) && /12 小时/.test(notice),
  notice.split('\n')[0]);
const bareNotice = buildWatchNotice(nextWatchState(emptyWatchState(), { loginWall: true, now: 1000 }), 2000);
assert('没有网址时正文也不会出现 undefined/空括号', !/undefined/.test(bareNotice) && /抖音登录态可能过期/.test(bareNotice));

// ── 安全：本机/内网地址在启动浏览器之前就被拒 ───────────────────────────
const t0 = Date.now();
let rejected = '';
try {
  await readWebsite({ url: 'http://127.0.0.1:3100/api/status' });
} catch (error) {
  rejected = String(error?.message ?? error);
}
assert('读取本机地址被拒', /不允许访问本机\/内网地址/.test(rejected), rejected);
assert('拒绝发生在启动浏览器之前（很快）', Date.now() - t0 < 2000, `${Date.now() - t0}ms`);

console.log(failed ? `\n${failed} 个断言失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
