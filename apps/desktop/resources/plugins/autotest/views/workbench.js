/*
 * 测试工作台 view 入口。沙箱页面：没有 Node、没有模块系统、没有打包器，
 * 所以这是一个纯 IIFE，所有 DOM 都是手写节点。
 *
 * 三条硬约定（破坏任意一条，页面会静默变成空白或永远读不到数据）：
 *  - 数据只能经 window.pluginBridge.invoke('autotest.*') 拿；页面里没有 fs。
 *  - 宿主只在 window.pluginBridge 上给 invoke；没有它说明这个页面被单独打开了。
 *  - 主题没有推送通道，只能轮询 autotest.appearance（同 Git Lens / File Manager）。
 */
(function () {
  'use strict';

  var STAGES = ['requirements', 'cases', 'scripts', 'run', 'verdict', 'report'];
  var STAGE_LABELS = {
    requirements: '需求',
    cases: '用例',
    scripts: '脚本',
    run: '执行',
    verdict: '诊断',
    report: '报告'
  };
  var STAGE_HINTS = {
    requirements: '把需求拆成 feature 与验收标准',
    cases: '按 feature 生成用例，等人审',
    scripts: '按已批准的用例逐个写脚本',
    run: '执行脚本并采集输出',
    verdict: '失败归类：环境/脚本/断言/产品/抖动',
    report: '生成 report.md'
  };
  var TABS = [
    ['overview', '概览'],
    ['requirement', '需求'],
    ['cases', '用例'],
    ['scripts', '脚本'],
    ['runs', '执行'],
    ['diagnosis', '诊断'],
    ['report', '报告'],
    ['knowledge', '知识库'],
    ['matrix', '追溯']
  ];
  var FAILURE_LABELS = {
    environment: '环境',
    script: '脚本',
    assertion: '断言',
    product: '产品',
    flaky: '抖动',
    unknown: '未知'
  };
  var FAILURE_TONES = {
    environment: 'warn',
    script: 'info',
    assertion: 'warn',
    product: 'bad',
    flaky: 'muted',
    unknown: 'muted'
  };
  var PLAN_STATUS = {
    draft: ['草稿', 'muted'],
    awaiting_review: ['等待审核', 'warn'],
    approved: ['已批准', 'ok'],
    running: ['执行中', 'info'],
    partial: ['部分通过', 'warn'],
    failed: ['失败', 'bad'],
    done: ['完成', 'ok'],
    corrupt: ['读取失败', 'bad']
  };
  // 两个轮询节奏。有活跃 job 时用快的（进度要动），空闲时用慢的（省一个 IPC 往返）。
  var POLL_MS = 4000;
  var JOB_POLL_MS = 1600;
  var BRIDGE_TIMEOUT_MS = 25000;

  // 长任务频道与它对应的 job kind。宿主给 panel.invoke 的预算是 30s（
  // PLUGIN_PANEL_TIMEOUT_MS，plugin-runtime.ts:698），而拆需求/生成用例/写脚本都要
  // 调模型，几分钟都正常。所以这些频道一律只发请求、拿票据，然后轮询 autotest.job。
  //
  // 前端不重实现门禁：哪个阶段能点由 plan.rail.stages[].state 决定（服务端算好的），
  // 点下去服务端要是拒绝，原样显示 code + message。
  var STAGE_CHANNEL = {
    requirements: 'autotest.start',
    cases: 'autotest.cases.generate',
    scripts: 'autotest.author',
    run: 'autotest.execute',
    verdict: 'autotest.diagnose',
    report: 'autotest.report'
  };

  // 一次最多写 3 个脚本：一个脚本一次模型调用，一批太多就撞 30s 宿主预算。
  var AUTHOR_BATCH = 3;

  var JOB_STATUS = {
    running: ['进行中', 'info'],
    done: ['完成', 'ok'],
    failed: ['失败', 'bad'],
    cancelled: ['已取消', 'muted']
  };

  var KB_TAG_MAX = 12;

  var state = {
    plans: [],
    planId: null,
    snapshot: null,
    tab: 'overview',
    search: '',
    busy: null,
    error: null,
    locale: 'zh',
    expandedCase: null,
    draft: null,
    drawer: null,
    // 作业：正在轮询的那个，以及按 plan 累积的历史（面板要显示「上一次跑的结果」）。
    job: null,
    jobTimer: null,
    jobLog: [],
    // 写脚本的分批队列：一条一条发，避免一次请求塞满 30s 预算。
    authorQueue: null,
    // 两个本地草稿：新建计划的表单，和「要写哪些脚本」的勾选。
    startDraft: null,
    authorDraft: null,
    // 知识库面板自己的状态。
    kb: {
      loaded: false,
      collections: [],
      items: [],
      total: 0,
      collection: '',
      query: '',
      selected: null,
      editing: null,
      hits: null,
      terms: [],
      error: null,
      busy: null
    }
  };

  /* ── 桥 ─────────────────────────────────────────────────────────── */

  function bridge() {
    var b = window.pluginBridge;
    if (!b || typeof b.invoke !== 'function') {
      throw Object.assign(new Error('plugin bridge unavailable (open this view inside PI-Desktop)'), {
        code: 'NO_BRIDGE'
      });
    }
    return b;
  }

  function invoke(channel, payload) {
    // 30s 是宿主给 panel.invoke 的预算；留 5s 让错误先到前台。
    return Promise.race([
      bridge().invoke(channel, payload || {}),
      new Promise(function (_resolve, reject) {
        window.setTimeout(function () {
          reject(Object.assign(new Error('宿主没有在 ' + BRIDGE_TIMEOUT_MS + 'ms 内回应 ' + channel), {
            code: 'BRIDGE_TIMEOUT'
          }));
        }, BRIDGE_TIMEOUT_MS);
      })
    ]);
  }

  /* ── DOM 小工具 ─────────────────────────────────────────────────── */

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value == null || value === false) return;
        if (key === 'text') node.textContent = String(value);
        else if (key === 'className') node.className = value;
        else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2).toLowerCase(), value);
        else node.setAttribute(key, value === true ? '' : String(value));
      });
    }
    (children || []).forEach(function (child) {
      if (child == null || child === false) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function pct(value) {
    var number = Number(value);
    if (!isFinite(number)) return '-';
    return Math.round(number * 100) + '%';
  }

  function shortTime(iso) {
    if (!iso) return '-';
    var text = String(iso);
    // state.json 里混着 UTC（带 Z）与本地时间，这里只做展示级裁剪。
    var match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(text);
    if (!match) return text;
    return match[2] + '-' + match[3] + ' ' + match[4] + ':' + match[5];
  }

  function shortDuration(ms) {
    var value = Number(ms);
    if (!isFinite(value) || value < 0) return '-';
    if (value < 1000) return Math.round(value) + ' ms';
    if (value < 60000) return (value / 1000).toFixed(1) + ' s';
    return Math.round(value / 60000) + ' min';
  }

  function toneOfPlan(status) {
    var entry = PLAN_STATUS[status];
    return entry ? entry[1] : 'muted';
  }

  function labelOfPlan(status) {
    var entry = PLAN_STATUS[status];
    return entry ? entry[0] : String(status || '-');
  }

  function tag(text, tone, title) {
    return el('span', { className: 'wb-tag', 'data-tone': tone || 'muted', title: title || null, text: text });
  }

  function empty(text) {
    return el('div', { className: 'wb-empty', text: text });
  }

  function group(title, actions, body, tight) {
    // Several call sites pass an array of nodes as the body. el() appends
    // children one by one and rejects a non-Node, so a bare array reached
    // appendChild() and threw "parameter 1 is not of type 'Node'".
    var bodyNodes = Array.isArray(body) ? body : [body];
    return el('section', { className: 'wb-group' }, [
      el('div', { className: 'wb-group-head' }, [
        el('span', { text: title }),
        el('span', { className: 'spacer' })
      ].concat(actions || [])),
      el('div', { className: tight ? 'wb-group-body tight' : 'wb-group-body' }, bodyNodes)
    ]);
  }

  function stat(key, value, hint) {
    return el('div', { className: 'wb-stat' }, [
      el('div', { className: 'k', text: key }),
      el('div', { className: 'v' }, [
        el('span', { text: String(value) }),
        hint ? el('small', { text: hint }) : null
      ])
    ]);
  }

  function meter(ratio, tone) {
    var value = Math.max(0, Math.min(1, Number(ratio) || 0));
    return el('div', { className: 'wb-meter', 'data-tone': tone || null }, [
      el('span', { style: 'width:' + Math.round(value * 100) + '%' })
    ]);
  }

  /* ── 状态读取 ───────────────────────────────────────────────────── */

  function snapshotPlan() {
    // panelSnapshot() already returns the reviewPlan() projection itself as
    // `plan` (main.js), so unwrapping `.plan` a second time always yielded
    // null: the rail drew but no tab ever had content.
    return state.snapshot || null;
  }

  function planState() {
    var plan = snapshotPlan();
    return plan && plan.state ? plan.state : null;
  }

  function toast(message, tone) {
    var node = document.getElementById('toast');
    node.textContent = message;
    node.setAttribute('data-tone', tone || 'ok');
    node.hidden = false;
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(function () {
      node.hidden = true;
    }, 2600);
  }

  function reload(preferredPlanId) {
    return invoke('autotest.snapshot', { planId: preferredPlanId || state.planId || null })
      .then(function (answer) {
        if (!answer || answer.ok !== true) {
          throw Object.assign(new Error((answer && answer.message) || 'snapshot failed'), {
            code: (answer && answer.code) || 'SNAPSHOT_FAILED'
          });
        }
        state.error = null;
        state.plans = answer.plans || [];
        state.snapshot = answer.plan || null;
        state.planId = answer.plan ? answer.planId : null;
        state.locale = answer.locale === 'en' ? 'en' : 'zh';
        applyAppearance(answer.base);
        if (!state.planId && state.tab !== 'knowledge') state.tab = 'overview';
        render();
        return answer;
      })
      .catch(function (error) {
        state.error = error.code || error.message || 'SNAPSHOT_FAILED';
        render();
        throw error;
      });
  }

  function mutate(channel, payload, label) {
    state.busy = label || channel;
    render();
    return invoke(channel, payload)
      .then(function (answer) {
        if (!answer || answer.ok !== true) {
          throw Object.assign(new Error((answer && answer.message) || 'failed'), {
            code: (answer && answer.code) || 'FAILED'
          });
        }
        return answer;
      })
      .then(function (answer) {
        state.draft = null;
        return reload(state.planId).then(function () {
          return answer;
        });
      })
      .catch(function (error) {
        toast(error.code ? error.code + ': ' + error.message : String(error.message || error), 'bad');
        return null;
      })
      .then(function (answer) {
        state.busy = null;
        render();
        return answer;
      });
  }

  /* ── 主题 ───────────────────────────────────────────────────────── */

  function applyAppearance(base) {
    var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var resolved = base === 'light' || base === 'dark' ? base : dark ? 'dark' : 'light';
    document.documentElement.setAttribute('data-base', resolved);
  }

  function pollAppearance() {
    invoke('autotest.appearance')
      .then(function (answer) {
        // The bridge answers {ok, appearance, base}; falling back to the
        // flattened key keeps this working if a host build drops the nested
        // object.
        if (answer && answer.ok) applyAppearance((answer.appearance && answer.appearance.base) || answer.base);
      })
      .catch(function () {
        /* 主题读不到就保持上一次的 */
      });
  }


  /* ── 顶栏 ───────────────────────────────────────────────────────── */

  /**
   * 阶段轨。
   *
   * 每一格同时是「跳到那个 tab」和「跑那个阶段」的入口：
   *  - 有活跃 job 并且这个 job 属于该阶段 → 显示转圈 + done/total，点了不重发；
   *  - 服务端给的 state 是 ready → 点了就发该阶段的频道；
   *  - locked/failed → 禁用，title 里带服务端给的 reason（前端不解释规则）。
   */

  /* ── 作业轮询 ───────────────────────────────────────────────────── */

  /**
   * 发一个长任务请求，把票据存进 state.job，然后开始轮询。
   *
   * 宿主 30s 预算只够「发请求 + 拿票据」，真正的阶段工作在插件进程里跑。所以这里
   * 拿到 job.id 就立刻返回，进度交给 pollJob()。票据要是没带 id（老后端），退回
   * 到普通快照刷新，不要让页面看起来卡住。
   */
  function startJob(channel, payload, label) {
    state.busy = label || channel;
    state.jobLog = [];
    render();
    return invoke(channel, payload || {})
      .then(function (answer) {
        if (!answer || answer.ok !== true) {
          // JOB_BUSY 会带正在跑的那个 job：接管它，而不是报一个没头没尾的错。
          if (answer && answer.code === 'JOB_BUSY' && answer.job) {
            state.job = answer.job;
            toast('这个阶段已经在跑了，接着看进度', 'warn');
            scheduleJobPoll();
            return answer;
          }
          throw Object.assign(new Error((answer && answer.message) || '启动失败'), {
            code: (answer && answer.code) || 'JOB_START_FAILED'
          });
        }
        state.job = answer.job || null;
        if (state.job && state.job.id) scheduleJobPoll();
        else return reload(state.planId).then(function () { return answer; });
        return answer;
      })
      .catch(function (error) {
        toast(error.code ? error.code + ': ' + error.message : String(error.message || error), 'bad');
        return null;
      })
      .then(function (answer) {
        state.busy = null;
        render();
        return answer;
      });
  }

  /**
   * 分批写脚本。
   *
   * autotest.author 一次最多写 AUTHOR_BATCH 条，所以选中的用例要切块顺序发。每发完
   * 一批等服务端把上一批跑完（轮到 done/failed）才发下一批：两个 author 作业撞在
   * 一起，服务端只会回 JOB_BUSY。
   */
  function startAuthorQueue(planId, testCaseIds) {
    var ids = (testCaseIds || []).map(String);
    if (ids.length === 0) {
      toast('先选用例再写脚本', 'warn');
      return Promise.resolve(null);
    }
    var batches = [];
    for (var index = 0; index < ids.length; index += AUTHOR_BATCH) {
      batches.push(ids.slice(index, index + AUTHOR_BATCH));
    }
    state.authorQueue = { planId: planId, batches: batches, index: 0, total: ids.length };
    return runAuthorBatch();
  }

  function runAuthorBatch() {
    var queue = state.authorQueue;
    if (!queue) return Promise.resolve(null);
    if (queue.index >= queue.batches.length) {
      state.authorQueue = null;
      toast('脚本写完了（' + queue.total + ' 条）');
      return reload(state.planId);
    }
    var batch = queue.batches[queue.index];
    return startJob(
      'autotest.author',
      { planId: queue.planId, testCaseIds: batch },
      'author ' + (queue.index + 1) + '/' + queue.batches.length
    ).then(function (answer) {
      if (!answer || answer.ok !== true) {
        // 一批失败就停：后面的批次同样会失败，继续发只会刷屏。
        state.authorQueue = null;
        return null;
      }
      return waitForJob().then(function () {
        if (state.authorQueue) state.authorQueue.index += 1;
        return runAuthorBatch();
      });
    });
  }

  /** 等到当前 job 不再是 running；给分批队列排序用。 */
  function waitForJob() {
    return new Promise(function (resolve) {
      var tick = function () {
        if (!state.job || state.job.status !== 'running') {
          resolve(state.job);
          return;
        }
        window.setTimeout(tick, JOB_POLL_MS);
      };
      tick();
    });
  }

  /**
   * 安排下一次进度查询。
   *
   * 有活跃 job 用 JOB_POLL_MS（1.6s），结束之后停掉自己的定时器，让通用的
   * 快照轮询接管——两条轮询链不能同时跑，否则一个页面会打两倍 IPC。
   */
  function scheduleJobPoll() {
    if (state.jobTimer) window.clearTimeout(state.jobTimer);
    state.jobTimer = window.setTimeout(pollJob, JOB_POLL_MS);
  }

  function stopJobPoll() {
    if (state.jobTimer) window.clearTimeout(state.jobTimer);
    state.jobTimer = null;
  }

  function pollJob() {
    state.jobTimer = null;
    if (!state.job || !state.job.id) return Promise.resolve(null);
    return invoke('autotest.job', { jobId: state.job.id })
      .then(function (answer) {
        if (!answer || answer.ok !== true) {
          // 作业丢了（插件进程重启）：停止轮询，让快照轮询接手。
          state.job = null;
          return null;
        }
        applyJob(answer.job);
        return answer.job;
      })
      .catch(function () {
        state.job = null;
        return null;
      });
  }

  /**
   * 把一次作业快照接进页面。
   *
   * 作业从 running 变到终态时顺手刷一次快照：阶段产物（feature/用例/脚本/结果）
   * 是快照给的，不刷的话进度条走完了而列表还是旧的。
   */
  function applyJob(job) {
    if (!job) return;
    var wasRunning = state.job && state.job.status === 'running';
    state.job = job;
    if (job.log && job.log.length) state.jobLog = job.log;
    var finished = job.status && job.status !== 'running';
    if (finished) {
      stopJobPoll();
      if (wasRunning || job.status === 'done') {
        reload(state.planId).catch(function () {});
      }
      if (job.status === 'failed') {
        var failure = job.error || {};
        toast(failure.code ? failure.code + ': ' + failure.message : '阶段失败', 'bad');
      }
    } else {
      scheduleJobPoll();
    }
    render();
  }

  function cancelJob() {
    var job = state.job;
    if (!job || !job.id) return;
    invoke('autotest.job.cancel', { jobId: job.id })
      .then(function (answer) {
        if (answer && answer.ok) {
          toast('已请求取消', 'warn');
          return pollJob();
        }
        return null;
      })
      .catch(function (error) {
        toast((error.code ? error.code + ': ' : '') + error.message, 'bad');
      });
  }

  /**
   * 页面刚打开（或切计划）时服务端可能已经在跑一个 job（用户从工具侧发起、再打开
   * 面板看进度）。问一次 autotest.job{planId} 把 running 的那个接管，否则进度条永远
   * 是空的。
   */
  function adoptRunningJob() {
    if (!state.planId) return Promise.resolve(null);
    return invoke('autotest.job', { planId: state.planId })
      .then(function (answer) {
        if (!answer || answer.ok !== true) return null;
        // 服务端在 {planId} 模式下回 {ok, planId, jobs, active}：active 就是
        // 仍在跑的那条（main.js 只在该 job 是 running 时给非空）。老版本没有
        // active 字段时退回从 jobs 里筛。
        var running =
          answer.active && answer.active.status === 'running'
            ? answer.active
            : (answer.jobs || []).filter(function (entry) {
                return entry.status === 'running';
              })[0];
        if (!running) return null;
        // 服务端的作业快照带 planId；用它对齐，否则切计划后进度条会画错计划。
        if (running.planId && running.planId !== state.planId) return null;
        state.job = running;
        scheduleJobPoll();
        render();
        return running;
      })
      .catch(function () {
        return null;
      });
  }

  function activeJob() {
    var job = state.job;
    if (job && job.status === 'running') return job;
    return null;
  }

  /**
   * 点某一格阶段轨要发什么。
   *
   * 这里不做「这个阶段能不能跑」的判断：rail 的 state 是服务端算的，locked 就禁用；
   * 允许点的时候服务端仍然可能拒绝（用例没批、没脚本），拒绝的 reason 原样显示。
   */
  function runStage(stageId) {
    var plan = snapshotPlan();
    if (!plan) return;
    if (activeJob()) {
      toast('还有任务在跑，等它结束', 'warn');
      return;
    }
    var channel = STAGE_CHANNEL[stageId];
    if (!channel) return;
    if (stageId === 'requirements') {
      // 需求阶段是「新建一个计划」，参数得从需求 tab 的表单来，不能凭空点。
      selectTab('requirement');
      toast('在需求页填原文或路径，然后点「拆需求」', 'warn');
      return;
    }
    if (stageId === 'scripts') {
      // 写脚本要选批次，跳到脚本页自己勾。
      selectTab('scripts');
      return;
    }
    startJob(channel, { planId: state.planId }, stageId);
  }

  function jobProgressText(job) {
    if (!job) return '';
    var progress = job.progress || {};
    var label = progress.label || job.kind || '';
    if (progress.total > 0) return label + ' ' + progress.done + '/' + progress.total;
    return label;
  }

  function renderRail() {
    var host = clear(document.getElementById('rail'));
    var plan = snapshotPlan();
    var snapshotRail = plan && plan.rail ? plan.rail.stages : null;
    var job = activeJob();
    STAGES.forEach(function (stageId) {
      var entry = null;
      if (snapshotRail) {
        snapshotRail.forEach(function (item) {
          if (item.stage === stageId) entry = item;
        });
      }
      var painted = entry ? entry.state : 'locked';
      var running = job && job.stage === stageId;
      var blocked = !plan || painted === 'locked' || painted === 'failed';
      var detail = [STAGE_LABELS[stageId], STAGE_HINTS[stageId]];
      if (entry && entry.note) detail.push(entry.note);
      if (entry && entry.reason) detail.push(entry.reason);
      if (running) detail.push(jobProgressText(job));
      else if (!blocked) detail.push('点击开始这个阶段');
      var children = [el('span', { className: 'dot' })];
      if (running) children.push(el('span', { className: 'wb-spin' }));
      children.push(el('span', { text: STAGE_LABELS[stageId] }));
      if (running) {
        var progress = job.progress || {};
        children.push(
          el('span', {
            className: 'wb-node-progress',
            text: progress.total > 0 ? progress.done + '/' + progress.total : '…'
          })
        );
      }
      var node = el(
        'button',
        {
          className: 'wb-node',
          type: 'button',
          'data-state': running ? 'running' : painted,
          'data-current': entry && entry.state === 'ready' ? 'yes' : 'no',
          disabled: blocked ? true : null,
          title: detail.join(' · ')
        },
        children
      );
      node.addEventListener('click', function () {
        if (running) {
          selectTab(TAB_OF_STAGE[stageId]);
          return;
        }
        if (blocked) return;
        var target = TAB_OF_STAGE[stageId];
        if (target) selectTab(target);
        runStage(stageId);
      });
      host.appendChild(node);
    });

    var chip = document.getElementById('gate-chip');
    var plan2 = snapshotPlan();
    if (!plan2) {
      chip.hidden = true;
      return;
    }
    var gate = plan2.gate || { ok: false, reason: 'no plan' };
    chip.hidden = false;
    chip.textContent = gate.ok ? '门已开' : '门关闭';
    chip.setAttribute('data-tone', gate.ok ? 'ok' : 'warn');
    chip.title = gate.ok ? '用例集已批准，可以生成脚本并执行' : gate.reason || '';
  }

  var TAB_OF_STAGE = {
    requirements: 'requirement',
    cases: 'cases',
    scripts: 'scripts',
    run: 'runs',
    verdict: 'diagnosis',
    report: 'report'
  };

  function renderPlans() {
    var host = clear(document.getElementById('plan-list'));
    var query = state.search.trim().toLowerCase();
    var plans = state.plans.filter(function (plan) {
      if (!query) return true;
      return (
        String(plan.id).toLowerCase().indexOf(query) !== -1 ||
        String(plan.title || '').toLowerCase().indexOf(query) !== -1
      );
    });
    if (plans.length === 0) {
      host.appendChild(
        empty(state.plans.length === 0 ? '还没有计划。在对话里让 agent 跑一次「需求分解」就会出现在这里。' : '没有匹配的计划')
      );
    }
    plans.forEach(function (plan) {
      var node = el(
        'button',
        {
          className: 'wb-plan',
          type: 'button',
          'data-active': plan.id === state.planId ? 'yes' : 'no',
          'data-status': plan.status,
          title: plan.id
        },
        [
          el('span', { className: 'pin' }),
          el('span', {}, [
            el('div', { className: 'wb-plan-title', text: plan.title || plan.id }),
            el('div', {
              className: 'wb-plan-meta',
              text:
                labelOfPlan(plan.status) +
                ' · ' +
                String(plan.cases || 0) +
                ' 用例 · ' +
                shortTime(plan.updatedAt)
            })
          ])
        ]
      );
      node.addEventListener('click', function () {
        if (plan.id === state.planId) return;
        state.planId = plan.id;
        state.tab = 'overview';
        state.draft = null;
        state.expandedCase = null;
        state.authorDraft = null;
        state.job = null;
        state.jobLog = [];
        stopJobPoll();
        reload(plan.id)
          .then(function () {
            return adoptRunningJob();
          })
          .catch(function () {});
      });
      host.appendChild(node);
    });
    document.getElementById('side-foot').textContent = state.plans.length + ' 个计划 · 数据在插件目录 plans/';
  }

  function renderHero() {
    var host = clear(document.getElementById('hero'));
    var plan = snapshotPlan();
    if (!plan) {
      host.appendChild(
        el('h1', { text: state.error ? '读取失败：' + state.error : '还没有选中的测试计划' })
      );
      host.appendChild(
        el('div', {
          className: 'wb-hero-meta',
          text:
            state.error === 'NO_BRIDGE'
              ? '这个页面需要从 PI-Desktop 的工作面板打开。'
              : '左侧选中一个计划，或在对话里让 agent 调用 autotest_requirement 新建一个。'
        })
      );
      return;
    }
    var summary = plan.summary || {};
    var current = plan.rail && plan.rail.cursor ? plan.rail.cursor : null;
    host.appendChild(el('h1', { text: plan.title || summary.title || plan.planId }));
    host.appendChild(
      el('div', { className: 'wb-hero-meta' }, [
        el('span', { text: '计划 ' }),
        el('b', { className: 'wb-mono', text: plan.planId }),
        el('span', { text: '状态 ' }),
        el('b', { text: labelOfPlan(summary.status) }),
        el('span', { text: '当前阶段 ' }),
        el('b', { text: current ? STAGE_LABELS[current] : '已全部完成' }),
        el('span', { text: '更新 ' }),
        el('b', { text: shortTime(summary.updatedAt || plan.updatedAt) })
      ])
    );
  }

  function renderBanner() {
    var node = document.getElementById('banner');
    var plan = snapshotPlan();
    if (state.error) {
      node.hidden = false;
      node.setAttribute('data-tone', 'bad');
      node.textContent = '读取失败：' + state.error;
      return;
    }
    if (!plan) {
      node.hidden = true;
      return;
    }
    var gate = plan.gate || {};
    if (gate.ok) {
      node.hidden = true;
      return;
    }
    node.hidden = false;
    node.setAttribute('data-tone', 'warn');
    node.textContent = '执行门关闭：' + (gate.reason || '用例集尚未批准');
  }

  function renderTabs() {
    var host = clear(document.getElementById('tabs'));
    var plan = snapshotPlan();
    var counts = {
      cases: plan && plan.state ? (plan.state.cases || []).length : 0,
      scripts: plan && plan.state ? (plan.state.scripts || []).length : 0,
      runs: plan && plan.state ? (plan.state.runs || []).length : 0
    };
    TABS.forEach(function (pair) {
      var id = pair[0];
      var node = el(
        'button',
        {
          className: 'wb-tab',
          type: 'button',
          role: 'tab',
          'aria-selected': state.tab === id ? 'true' : 'false',
          // 知识库不依赖计划：没有计划时也要能进（先攒资料再建计划是正常用法）。
          disabled: plan || id === 'knowledge' ? null : true
        },
        [el('span', { text: pair[1] }), counts[id] ? el('span', { className: 'count', text: String(counts[id]) }) : null]
      );
      node.addEventListener('click', function () {
        selectTab(id);
      });
      host.appendChild(node);
    });
  }


  /* ── 阶段操作条 ─────────────────────────────────────────────────── */

  /**
   * 每个阶段 tab 顶部的操作条。
   *
   * 按钮的可用性直接来自服务端：rail 里该阶段是 ready 才可点；被挡住时把 reason
   * 当成按钮的 title 和旁边的一行说明，前端不自己推规则（旧版本在这里比
   * revision/approvedRevision，规则一改前端就骗人）。
   */
  function stageBar(stageId, options) {
    var opts = options || {};
    var plan = snapshotPlan();
    if (!plan) return null;
    var entry = null;
    (plan.rail ? plan.rail.stages : []).forEach(function (item) {
      if (item.stage === stageId) entry = item;
    });
    var painted = entry ? entry.state : 'locked';
    var job = activeJob();
    var running = job && job.stage === stageId;
    var ready = painted === 'ready' || opts.allowWhenDone === true;
    var disabled = Boolean(state.busy) || running || (!ready && !opts.allowWhenDone);

    var buttons = [];
    var primary = el('button', {
      className: 'wb-btn',
      type: 'button',
      'data-kind': 'primary',
      text: opts.label || ('开始' + STAGE_LABELS[stageId])
    });
    primary.disabled = disabled;
    primary.title = ready ? '' : entry && entry.reason ? entry.reason : '这个阶段还不能跑';
    primary.addEventListener('click', function () {
      if (opts.onRun) opts.onRun();
    });
    buttons.push(primary);

    if (running) {
      var cancel = el('button', { className: 'wb-btn', type: 'button', 'data-kind': 'danger', text: '取消' });
      cancel.disabled = Boolean(state.busy);
      cancel.addEventListener('click', cancelJob);
      buttons.push(cancel);
    }

    var note = '';
    if (running) note = jobProgressText(job);
    else if (!ready) note = (entry && entry.reason) || '这个阶段还不能跑';
    else if (entry && entry.note) note = entry.note;

    return el('section', { className: 'wb-stage-bar' }, [
      el('div', { className: 'wb-btn-row' }, buttons.concat(opts.extra || [])),
      note ? el('div', { className: 'wb-stage-note', text: note }) : null,
      running ? meter(job.progress && job.progress.total > 0 ? job.progress.done / job.progress.total : 0, 'info') : null
    ]);
  }

  /** 作业日志：最后一次跑阶段的输出行，跟抽屉分开，就地显示。 */
  function jobLogBlock() {
    var job = state.job;
    if (!job) return null;
    var status = JOB_STATUS[job.status] || [String(job.status || '-'), 'muted'];
    var lines_ = (job.log || []).slice(-12).map(function (entry) {
      return shortTime(entry.at) + '  ' + entry.message;
    });
    var body = [
      el('div', { className: 'wb-btn-row', style: 'margin-bottom:6px' }, [
        tag(job.kind || '-', 'info'),
        tag(status[0], status[1]),
        tag(jobProgressText(job) || '排队中', 'muted'),
        el('span', { className: 'spacer' })
      ])
    ];
    if (job.error) {
      body.push(
        el('div', {
          className: 'wb-text',
          style: 'color:var(--bad)',
          text: (job.error.code ? job.error.code + ': ' : '') + (job.error.message || '')
        })
      );
    }
    body.push(el('div', { className: 'wb-log', text: lines_.join('\n') || '（还没有日志）' }));
    return group('本次任务 · ' + (job.id || '-'), null, body);
  }

  /**
   * 长任务结束时服务端会把结果放在 job.result 里。
   *
   * 前端的快照投影只带「已落盘的产物」，有些阶段结果（报告 markdown、诊断叙述）
   * 只在 job.result 里，所以这里单独渲染一次，避免用户以为什么都没发生。
   */
  function jobResultBlock(stageId, render) {
    var job = state.job;
    if (!job || job.status !== 'done' || !job.result || job.stage !== stageId) return null;
    try {
      return render(job.result);
    } catch (error) {
      return null;
    }
  }


  /* ── 知识库 ─────────────────────────────────────────────────────── */

  /**
   * 知识库面板的数据层。
   *
   * 条目在服务端是纯文件（lib/kb.js，<dataRoot>/kb/<collection>/<id>.json），面板
   * 这边只持有一份列表投影。所有写操作走 kb.write/kb.remove，写完重新拉一次列表，
   * 不在前端做乐观合并：服务端会重算 updatedAt、bytes 和 collection 计数。
   */
  function kbCall(channel, payload) {
    return invoke(channel, payload || {}).then(function (answer) {
      if (!answer || answer.ok !== true) {
        throw Object.assign(new Error((answer && answer.message) || '知识库调用失败'), {
          code: (answer && answer.code) || 'KB_FAILED'
        });
      }
      return answer;
    });
  }

  function loadCollections() {
    return kbCall('kb.collections').then(function (answer) {
      state.kb.collections = answer.items || [];
      return state.kb.collections;
    });
  }

  function loadKbItems() {
    var payload = { limit: 200 };
    if (state.kb.collection) payload.collection = state.kb.collection;
    if (state.kb.query) payload.query = state.kb.query;
    return kbCall('kb.list', payload).then(function (answer) {
      state.kb.items = answer.items || [];
      state.kb.total = typeof answer.total === 'number' ? answer.total : state.kb.items.length;
      state.kb.loaded = true;
      state.kb.error = null;
      return state.kb.items;
    });
  }

  function loadKb(options) {
    var force = options && options.force;
    // collections 只在第一次（或强制刷新）时拉一次：它按目录重算，代价是每个
    // collection 都要 stat 一遍。条目列表随每次过滤重拉。
    var work = state.kb.loaded && !force ? Promise.resolve(null) : loadCollections();
    return work
      .then(function () {
        return loadKbItems();
      })
      .catch(function (error) {
        state.kb.error = error.code ? error.code + ': ' + error.message : String(error.message || error);
      })
      .then(function () {
        render();
      });
  }

  function selectKbEntry(id) {
    state.kb.selected = id;
    state.kb.editing = null;
    state.kb.hits = null;
    render();
    return kbCall('kb.read', { id: id })
      .then(function (answer) {
        state.kb.editing = {
          id: answer.item.id,
          collection: answer.item.collection || 'default',
          title: answer.item.title || '',
          tags: (answer.item.tags || []).join(', '),
          sourceKind: (answer.item.source && answer.item.source.kind) || 'text',
          sourceRef: (answer.item.source && answer.item.source.ref) || '',
          text: answer.item.text || ''
        };
        render();
        return state.kb.editing;
      })
      .catch(function (error) {
        toast((error.code ? error.code + ': ' : '') + error.message, 'bad');
        return null;
      });
  }

  function newKbEntry() {
    state.kb.selected = null;
    state.kb.hits = null;
    state.kb.editing = {
      id: null,
      collection: state.kb.collection || 'default',
      title: '',
      tags: '',
      sourceKind: 'text',
      sourceRef: '',
      text: ''
    };
    render();
  }

  function saveKbEntry() {
    var draft = state.kb.editing;
    if (!draft) return Promise.resolve(null);
    var payload = {
      collection: String(draft.collection || 'default').trim() || 'default',
      title: String(draft.title || '').trim(),
      tags: String(draft.tags || '')
        .split(',')
        .map(function (item) {
          return item.trim();
        })
        .filter(Boolean),
      source: { kind: String(draft.sourceKind || 'text').trim() || 'text', ref: String(draft.sourceRef || '').trim() || null },
      text: String(draft.text || '')
    };
    if (draft.id) payload.id = draft.id;
    state.busy = 'kb.save';
    render();
    return kbCall('kb.write', payload)
      .then(function (answer) {
        toast(draft.id ? '已保存' : '已新建');
        state.kb.selected = answer.id;
        state.kb.editing.id = answer.id;
        return Promise.all([loadCollections(), loadKbItems()]).then(function () {
          return answer;
        });
      })
      .catch(function (error) {
        toast((error.code ? error.code + ': ' : '') + error.message, 'bad');
        return null;
      })
      .then(function (answer) {
        state.busy = null;
        render();
        return answer;
      });
  }

  function removeKbEntry() {
    var draft = state.kb.editing;
    if (!draft || !draft.id) return Promise.resolve(null);
    state.busy = 'kb.remove';
    render();
    return kbCall('kb.remove', { id: draft.id })
      .then(function () {
        toast('已删除');
        state.kb.selected = null;
        state.kb.editing = null;
        return Promise.all([loadCollections(), loadKbItems()]);
      })
      .catch(function (error) {
        toast((error.code ? error.code + ': ' : '') + error.message, 'bad');
        return null;
      })
      .then(function (answer) {
        state.busy = null;
        render();
        return answer;
      });
  }

  function kbSearch(query) {
    state.kb.query = query || '';
    if (!state.kb.query.trim()) {
      state.kb.hits = null;
      state.kb.terms = [];
      return loadKbItems().then(function () {
        render();
      });
    }
    state.busy = 'kb.search';
    render();
    return kbCall('kb.search', { query: state.kb.query, k: 20 })
      .then(function (answer) {
        state.kb.hits = answer.hits || [];
        // 服务端返回它实际切出来的词，比前端拿原始 query 再切一遍准确。
        state.kb.terms = answer.terms || [];
      })
      .catch(function (error) {
        toast((error.code ? error.code + ': ' : '') + error.message, 'bad');
      })
      .then(function () {
        state.busy = null;
        render();
      });
  }

  /**
   * 把知识库条目挂到当前计划。
   *
   * 服务端在 plan state 里记 knowledgeRefs（lib/plan.js attachKnowledge），所以挂完
   * 要刷一次快照，否则「已挂」标签和 hero 的计数都不会变。
   */
  function attachKbEntries(ids) {
    if (!state.planId) {
      toast('先选中一个计划', 'warn');
      return Promise.resolve(null);
    }
    if (!ids || ids.length === 0) {
      toast('先选条目', 'warn');
      return Promise.resolve(null);
    }
    state.busy = 'kb.attach';
    render();
    return kbCall('kb.attach', { planId: state.planId, ids: ids })
      .then(function (answer) {
        toast('已挂 ' + ids.length + ' 条到计划');
        return reload(state.planId).then(function () {
          return answer;
        });
      })
      .catch(function (error) {
        toast((error.code ? error.code + ': ' : '') + error.message, 'bad');
        return null;
      })
      .then(function (answer) {
        state.busy = null;
        render();
        return answer;
      });
  }

  function detachKbEntries(ids) {
    if (!state.planId) return Promise.resolve(null);
    if (!ids || ids.length === 0) return Promise.resolve(null);
    state.busy = 'kb.detach';
    render();
    return kbCall('kb.detach', { planId: state.planId, ids: ids })
      .then(function (answer) {
        toast('已摘掉 ' + ids.length + ' 条');
        return reload(state.planId).then(function () {
          return answer;
        });
      })
      .catch(function (error) {
        toast((error.code ? error.code + ': ' : '') + error.message, 'bad');
        return null;
      })
      .then(function (answer) {
        state.busy = null;
        render();
        return answer;
      });
  }

  function attachedRefs() {
    var plan = snapshotPlan();
    if (!plan || !plan.state) return [];
    return Array.isArray(plan.state.knowledgeRefs) ? plan.state.knowledgeRefs : [];
  }

  function isAttached(id) {
    return attachedRefs().indexOf(id) !== -1;
  }

  /** 把搜索片段里的命中词包成 <mark>，其余部分原样保留。 */
  function highlight(excerpt, terms) {
    var text = String(excerpt == null ? '' : excerpt);
    var words = (terms || []).map(String).filter(Boolean);
    if (words.length === 0) return [el('span', { text: text })];
    // 长词优先，避免 "plan" 先命中把 "planner" 切碎。
    words.sort(function (a, b) {
      return b.length - a.length;
    });
    var pattern = words
      .map(function (word) {
        return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('|');
    var regex = new RegExp('(' + pattern + ')', 'gi');
    var out = [];
    var cursor = 0;
    var match = regex.exec(text);
    while (match) {
      if (match.index > cursor) out.push(el('span', { text: text.slice(cursor, match.index) }));
      out.push(el('mark', { text: match[0] }));
      cursor = match.index + match[0].length;
      if (match[0].length === 0) regex.lastIndex += 1;
      match = regex.exec(text);
    }
    if (cursor < text.length) out.push(el('span', { text: text.slice(cursor) }));
    return out;
  }

  function selectTab(id) {
    state.tab = id;
    state.drawer = null;
    render();
  }

  /* ── 内容区 ─────────────────────────────────────────────────────── */

  function renderView() {
    var host = clear(document.getElementById('view'));
    var plan = snapshotPlan();
    // 概览要显示「引用知识」，那需要 collection/条目列表已经在手上。
    if (plan && !state.kb.loaded) loadKb();
    if (!plan && state.tab !== 'knowledge') {
      host.appendChild(empty(state.error ? '读取失败：' + state.error : '这个计划没有可显示的细节'));
      return;
    }
    var builder = VIEWS[state.tab] || VIEWS.overview;
    var nodes = builder(plan);
    (Array.isArray(nodes) ? nodes : [nodes]).forEach(function (node) {
      if (node) host.appendChild(node);
    });
  }

  function reviewGateBlock(plan) {
    var state0 = plan.state;
    var gate = plan.gate || {};
    if (gate.ok && !state.draft) return null;
    var cases = state0.cases || [];
    if (cases.length === 0) return null;
    if (!state.draft) state.draft = draftFrom(cases);
    var draft = state.draft;

    var rows = cases.map(function (entry) {
      var local = draft[entry.id] || draftFrom([entry])[entry.id];
      var dirty = isDirty(entry, local);
      var tr = el('tr', { 'data-active': dirty ? 'yes' : 'no' });

      var check = el('input', { className: 'wb-check', type: 'checkbox', disabled: state.busy ? true : null });
      check.checked = local.keep !== false;
      check.addEventListener('change', function () {
        local.keep = check.checked;
        render();
      });
      tr.appendChild(el('td', {}, [check]));
      tr.appendChild(el('td', { className: 'mono', text: entry.id }));

      var titleInput = el('input', {
        className: 'wb-input',
        type: 'text',
        value: local.title,
        'data-dirty': local.title !== entry.title ? 'yes' : null
      });
      titleInput.addEventListener('input', function () {
        local.title = titleInput.value;
        titleInput.setAttribute('data-dirty', local.title !== entry.title ? 'yes' : null);
      });
      tr.appendChild(el('td', {}, [titleInput]));

      var priority = el('select', { className: 'wb-input' });
      ['P0', 'P1', 'P2', 'P3'].forEach(function (value) {
        var option = el('option', { value: value, text: value });
        if (local.priority === value) option.selected = true;
        priority.appendChild(option);
      });
      priority.addEventListener('change', function () {
        local.priority = priority.value;
        render();
      });
      tr.appendChild(el('td', {}, [priority]));

      var steps = el('textarea', { className: 'wb-input', rows: '2' });
      steps.value = local.steps;
      steps.addEventListener('input', function () {
        local.steps = steps.value;
      });
      tr.appendChild(el('td', {}, [steps]));

      var expected = el('textarea', { className: 'wb-input', rows: '2' });
      expected.value = local.expected;
      expected.addEventListener('input', function () {
        local.expected = expected.value;
      });
      tr.appendChild(el('td', {}, [expected]));

      tr.appendChild(el('td', {}, [dirty ? tag('已编辑', 'warn', '同一次提交里被改过的行不会被算作批准') : tag('原样', 'muted')]));
      return tr;
    });

    var note = el('input', { className: 'wb-input', type: 'text', placeholder: '审核备注（可选）' });
    note.addEventListener('input', function () {
      draft.__note = note.value;
    });
    note.value = draft.__note || '';

    var coverage = plan.coverage || (plan.summary && plan.summary.coverage) || { covered: 0, total: 0 };
    var approveButton = el('button', { className: 'wb-btn', type: 'button', 'data-kind': 'primary', text: '批准这组用例' });
    approveButton.disabled = Boolean(state.busy);
    approveButton.addEventListener('click', function () {
      var payload = { planId: state.planId, decision: 'approved', cases: [], note: draft.__note || undefined };
      payload.cases = cases
        .filter(function (entry) {
          return draft[entry.id].keep !== false;
        })
        .map(function (entry) {
          var local = draft[entry.id];
          return {
            id: entry.id,
            title: local.title,
            priority: local.priority,
            steps: lines(local.steps),
            expected: lines(local.expected)
          };
        });
      mutate('autotest.approve', payload, 'approve');
    });

    var rejectButton = el('button', { className: 'wb-btn', type: 'button', 'data-kind': 'danger', text: '退回重做' });
    rejectButton.disabled = Boolean(state.busy);
    rejectButton.addEventListener('click', function () {
      mutate(
        'autotest.approve',
        { planId: state.planId, decision: 'rejected', note: draft.__note || 'rejected from the workbench' },
        'reject'
      );
    });

    var resetButton = el('button', { className: 'wb-btn', type: 'button', text: '还原本地编辑' });
    resetButton.addEventListener('click', function () {
      state.draft = draftFrom(cases);
      render();
    });

    return el('section', { className: 'wb-gate' }, [
      el('div', { className: 'wb-gate-head' }, [
        el('span', { className: 'title', text: gate.ok ? '已批准（可再改）' : '人工审核门' }),
        el('span', {
          className: 'reason',
          text: gate.ok ? '改任意一行会让门重新关闭' : gate.reason || '用例集尚未批准'
        })
      ]),
      el('div', { className: 'wb-gate-body' }, [
        el('table', { className: 'wb-table' }, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { text: '选' }),
              el('th', { text: 'ID' }),
              el('th', { text: '标题' }),
              el('th', { text: '优先级' }),
              el('th', { text: '步骤（每行一步）' }),
              el('th', { text: '预期（每行一条）' }),
              el('th', { text: '修订' })
            ])
          ]),
          el('tbody', {}, rows)
        ])
      ]),
      el('div', { className: 'wb-gate-foot' }, [
        approveButton,
        rejectButton,
        resetButton,
        note,
        el('span', {
          className: 'note',
          text:
            '覆盖 ' +
            String(coverage.covered || 0) +
            '/' +
            String(coverage.total || 0) +
            ' 个 feature · 勾选的行才会被执行'
        })
      ])
    ]);
  }

  function lines(value) {
    if (Array.isArray(value)) return value.map(String);
    return String(value == null ? '' : value)
      .split('\n')
      .map(function (item) {
        return item.replace(/\s+$/, '');
      })
      .filter(function (item) {
        return item.length > 0;
      });
  }

  function draftFrom(cases) {
    var draft = {};
    (cases || []).forEach(function (entry) {
      draft[entry.id] = {
        title: String(entry.title || ''),
        priority: entry.priority || 'P2',
        steps: lines(entry.steps).join('\n'),
        expected: lines(entry.expected).join('\n'),
        keep: entry.selected !== false
      };
    });
    return draft;
  }

  function isDirty(entry, local) {
    if (!local) return false;
    if (local.title !== String(entry.title || '')) return true;
    if (local.priority !== (entry.priority || 'P2')) return true;
    if (local.steps !== lines(entry.steps).join('\n')) return true;
    if (local.expected !== lines(entry.expected).join('\n')) return true;
    return false;
  }


  /* ── 需求页：新建计划 ───────────────────────────────────────────── */

  /**
   * 需求 tab 顶部的「拆需求」表单。
   *
   * 这是唯一能凭空创建计划的入口，所以它不依赖已有 plan：填标题 + 原文或文件路径，
   * 点一下发 autotest.start，拿票据轮询。
   */
  function startFormBlock() {
    var draft = state.startDraft || (state.startDraft = { title: '', source: '', sourceKind: 'text', sourceRef: '' });
    var busy = Boolean(state.busy) || Boolean(activeJob());

    var titleInput = el('input', { className: 'wb-input', type: 'text', placeholder: '计划标题（可留空）', value: draft.title });
    titleInput.addEventListener('input', function () {
      draft.title = titleInput.value;
    });

    var kindSelect = el('select', { className: 'wb-input' });
    [
      ['text', '需求原文'],
      ['file', '文件路径'],
      ['doc', '文档引用']
    ].forEach(function (pair) {
      var option = el('option', { value: pair[0], text: pair[1] });
      if (draft.sourceKind === pair[0]) option.selected = true;
      kindSelect.appendChild(option);
    });
    kindSelect.addEventListener('change', function () {
      draft.sourceKind = kindSelect.value;
    });

    var sourceArea = el('textarea', {
      className: 'wb-input kb-text',
      rows: '8',
      placeholder: '粘贴需求原文；如果选了文件路径，这里填绝对路径'
    });
    sourceArea.value = draft.source;
    sourceArea.addEventListener('input', function () {
      draft.source = sourceArea.value;
    });

    var refInput = el('input', { className: 'wb-input', type: 'text', placeholder: '来源位置（可选，写进 state.source.ref）', value: draft.sourceRef });
    refInput.addEventListener('input', function () {
      draft.sourceRef = refInput.value;
    });

    var submit = el('button', { className: 'wb-btn', type: 'button', 'data-kind': 'primary', text: '拆需求' });
    submit.disabled = busy || !String(draft.source).trim();
    submit.title = String(draft.source).trim() ? '' : '先填需求原文或文件路径';
    submit.addEventListener('click', function () {
      var payload = { source: draft.source, sourceKind: draft.sourceKind };
      if (String(draft.title).trim()) payload.title = draft.title;
      if (String(draft.sourceRef).trim()) payload.sourceRef = draft.sourceRef;
      startJob('autotest.start', payload, 'requirements');
    });

    var extra = [];
    if (state.planId) {
      var again = el('button', { className: 'wb-btn', type: 'button', text: '在当前计划上重跑需求' });
      again.disabled = busy;
      again.addEventListener('click', function () {
        startJob('autotest.start', { planId: state.planId, source: draft.source, sourceKind: draft.sourceKind }, 'requirements');
      });
      extra.push(again);
    }

    return group(
      '新建测试计划 · 拆需求',
      extra,
      [
        el('div', { className: 'kb-form' }, [
          kbField('标题', titleInput),
          kbField('来源类型', kindSelect),
          kbField('需求原文 / 路径', sourceArea),
          kbField('来源位置', refInput)
        ]),
        el('div', { className: 'wb-btn-row', style: 'margin-top:8px' }, [
          submit,
          el('span', { className: 'note', style: 'font-size:11.5px;color:var(--muted)', text: '这一步会调用模型，返回票据后在这里轮询进度' })
        ])
      ]
    );
  }


  /**
   * 报告正文只存在于 job.result 里（快照投影不带 markdown，报告可能很大）。
   *
   * 这里渲染的是「本次作业写出来的那份」，不落盘缓存；要看旧的产物用「报告产物」
   * 那一组里的文件名去 artifacts 目录找。
   */
  function reportResultBlock() {
    var job = state.job;
    if (!job || job.status !== 'done' || job.stage !== 'report' || !job.result) return null;
    var result = job.result;
    return group(
      '本次报告 · ' + (result.file ? String(result.file).split(/[\\/]/).pop() : 'report.md'),
      [
        el('button', {
          className: 'wb-btn',
          type: 'button',
          text: '打开全文',
          onclick: function () {
            openDrawer('report.md', result.markdown || '');
          }
        })
      ],
      [
        el('div', { className: 'wb-text wb-md', text: result.markdown || '' })
      ]
    );
  }

  /**
   * 兜底：作业结果还没到手上时，退回同步的 autotest.report。
   *
   * 新后端把它改成票据了，所以这里只在前端确实没有 markdown 时才请求一次，并且
   * 兼容两种返回形状（旧的 answer.markdown / 新的 job 票据）。
   */
  function promiseReport() {
    invoke('autotest.report', { planId: state.planId })
      .then(function (answer) {
        if (!answer || answer.ok !== true) {
          throw Object.assign(new Error((answer && answer.message) || '不可读取'), {
            code: (answer && answer.code) || 'REPORT_FAILED'
          });
        }
        if (typeof answer.markdown === 'string') {
          openDrawer('report.md', answer.markdown);
          return null;
        }
        if (answer.job) {
          state.job = answer.job;
          scheduleJobPoll();
          toast('报告正在生成，完成后点「打开全文」', 'warn');
          render();
          return null;
        }
        throw Object.assign(new Error('报告还在生成，稍后再看'), { code: 'REPORT_PENDING' });
      })
      .catch(function (error) {
        toast((error.code ? error.code + ': ' : '') + error.message, 'bad');
      });
  }

  /**
   * 脚本页的批次选择器。
   *
   * autotest.author 一次最多 3 条（一个脚本一次模型调用，宿主只给 30s 面板预算），
   * 所以这里让用户勾要写的用例，点一次就把勾中的切成 3 条一批顺序发出去。
   */
  function scriptsEditor(plan) {
    var state0 = plan.state || {};
    var cases = state0.cases || [];
    if (cases.length === 0) return null;
    if (!state.authorDraft) state.authorDraft = {};
    var scripts = state0.scripts || [];
    var written = {};
    scripts.forEach(function (entry) {
      written[entry.testCaseId] = true;
    });
    var busy = Boolean(state.busy) || Boolean(activeJob());

    var rows = cases.map(function (entry) {
      var picked = state.authorDraft[entry.id] === true;
      var check = el('input', { className: 'wb-check', type: 'checkbox', disabled: busy ? true : null });
      check.checked = picked;
      check.addEventListener('change', function () {
        state.authorDraft[entry.id] = check.checked;
        render();
      });
      var tr = el('tr', { 'data-active': picked ? 'yes' : 'no' });
      tr.appendChild(el('td', {}, [check]));
      tr.appendChild(el('td', { className: 'mono', text: entry.id }));
      tr.appendChild(el('td', { text: entry.title || '-' }));
      tr.appendChild(el('td', {}, [written[entry.id] ? tag('已有脚本', 'ok') : tag('待写', 'warn')]));
      return tr;
    });

    var pickedIds = cases
      .filter(function (entry) {
        return state.authorDraft[entry.id] === true;
      })
      .map(function (entry) {
        return entry.id;
      });

    var write = el('button', { className: 'wb-btn', type: 'button', 'data-kind': 'primary', text: '写脚本' });
    write.disabled = busy || pickedIds.length === 0;
    write.title = pickedIds.length === 0 ? '先勾要写的用例' : '';
    write.addEventListener('click', function () {
      startAuthorQueue(state.planId, pickedIds);
    });

    var all = el('button', { className: 'wb-btn', type: 'button', text: '全选未写' });
    all.disabled = busy;
    all.addEventListener('click', function () {
      cases.forEach(function (entry) {
        if (!written[entry.id]) state.authorDraft[entry.id] = true;
      });
      render();
    });
    var none = el('button', { className: 'wb-btn', type: 'button', text: '全不选' });
    none.disabled = busy;
    none.addEventListener('click', function () {
      state.authorDraft = {};
      render();
    });

    var queueNote = state.authorQueue
      ? '排队中：第 ' + (state.authorQueue.index + 1) + '/' + state.authorQueue.batches.length + ' 批'
      : pickedIds.length + ' 条勾选 · 每批 ' + AUTHOR_BATCH + ' 条，自动排队';

    return group(
      '选择要写脚本的用例',
      [all, none, write],
      [
        el('table', { className: 'wb-table' }, [
          el('thead', {}, [
            el('tr', {}, [el('th', { text: '选' }), el('th', { text: 'ID' }), el('th', { text: '标题' }), el('th', { text: '状态' })])
          ]),
          el('tbody', {}, rows)
        ]),
        el('div', { className: 'wb-stage-note', text: queueNote })
      ],
      true
    );
  }


  /* ── 视图表 ─────────────────────────────────────────────────────── */

  // tab id → 渲染函数。必须先声明再赋值：VIEWS.knowledge 就在下面，用 var 会
  // 提升成 undefined 而在赋值那一刻炸掉（"Cannot set properties of undefined"）。
  var VIEWS = {};

  /* ── 知识库视图 ─────────────────────────────────────────────────── */

  /**
   * 知识库 tab：左栏 collection + 搜索，中栏条目列表，右栏详情/编辑器。
   *
   * 面板不缓存条目正文：点一条就读一次 kb.read，编辑器里改的只是本地草稿，按保存
   * 才回写。这样两个面板同时开着也不会各写各的。
   */
  VIEWS.knowledge = function () {
    if (!state.kb.loaded && !state.kb.error) loadKb();
    var collections = state.kb.collections || [];
    var items = state.kb.hits !== null ? state.kb.hits : state.kb.items || [];
    var attached = attachedRefs();

    var collectionNodes = [
      el('button', {
        className: 'kb-collection',
        type: 'button',
        'data-active': state.kb.collection ? 'no' : 'yes',
        text: '全部'
      })
    ];
    collectionNodes[0].addEventListener('click', function () {
      state.kb.collection = '';
      loadKbItems().then(function () {
        render();
      });
    });
    collections.forEach(function (entry) {
      var node = el('button', {
        className: 'kb-collection',
        type: 'button',
        'data-active': state.kb.collection === entry.name ? 'yes' : 'no',
        title: '更新于 ' + shortTime(entry.updatedAt)
      }, [
        el('span', { className: 'name', text: entry.name }),
        el('span', { className: 'count', text: String(entry.count || 0) })
      ]);
      node.addEventListener('click', function () {
        state.kb.collection = entry.name;
        loadKbItems().then(function () {
          render();
        });
      });
      collectionNodes.push(node);
    });

    var searchInput = el('input', {
      className: 'wb-search kb-search',
      type: 'search',
      placeholder: '搜索标题、标签与正文（BM25）',
      value: state.kb.query
    });
    searchInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') kbSearch(searchInput.value);
    });
    searchInput.addEventListener('input', function () {
      state.kb.query = searchInput.value;
    });
    var searchButton = el('button', { className: 'wb-btn', type: 'button', text: '搜索' });
    searchButton.addEventListener('click', function () {
      kbSearch(searchInput.value);
    });
    var clearButton = el('button', { className: 'wb-btn', type: 'button', text: '清除' });
    clearButton.addEventListener('click', function () {
      state.kb.query = '';
      state.kb.hits = null;
      state.kb.terms = [];
      loadKbItems().then(function () {
        render();
      });
    });

    var listNodes = [];
    if (state.kb.error) {
      listNodes.push(empty('知识库读取失败：' + state.kb.error));
    } else if (items.length === 0) {
      listNodes.push(empty(state.kb.query ? '没有命中' : '这个 collection 还是空的'));
    }
    items.forEach(function (entry) {
      var isAttached = attached.indexOf(entry.id) !== -1;
      var node = el('button', {
        className: 'kb-item',
        type: 'button',
        'data-active': state.kb.selected === entry.id ? 'yes' : 'no',
        title: entry.id
      }, [
        el('div', { className: 'kb-item-title', text: entry.title || entry.id }),
        el('div', { className: 'kb-item-meta' }, [
          tag(entry.collection || 'default', 'info'),
          entry.bytes != null ? el('span', { text: String(entry.bytes) + ' B' }) : null,
          el('span', { text: shortTime(entry.updatedAt) }),
          isAttached ? tag('已挂', 'ok') : null
        ]),
        (entry.tags || []).length
          ? el('div', { className: 'kb-item-tags' }, entry.tags.slice(0, KB_TAG_MAX).map(function (value) {
              return tag(value, 'muted');
            }))
          : null,
        entry.excerpt
          ? el('div', { className: 'kb-item-excerpt' }, highlight(entry.excerpt, state.kb.terms))
          : null,
        entry.source ? el('div', { className: 'kb-item-source', text: '来源 ' + (entry.source.kind || 'text') + (entry.source.ref ? ' · ' + entry.source.ref : '') }) : null
      ]);
      node.addEventListener('click', function () {
        selectKbEntry(entry.id);
      });
      listNodes.push(node);
    });

    var editor = kbEditor();
    var newButton = el('button', { className: 'wb-btn', type: 'button', 'data-kind': 'primary', text: '新建条目' });
    newButton.addEventListener('click', newKbEntry);

    return [
      el('div', { className: 'kb-body' }, [
        el('aside', { className: 'kb-collections' }, [
          el('div', { className: 'kb-collections-head', text: '知识库' }),
          el('div', { className: 'kb-collections-list' }, collectionNodes)
        ]),
        el('section', { className: 'kb-list' }, [
          el('div', { className: 'kb-list-head' }, [
            el('div', { className: 'wb-btn-row' }, [searchInput, searchButton, clearButton]),
            el('div', { className: 'kb-list-meta', text: entriesLabel(items.length, state.kb.total) })
          ]),
          el('div', { className: 'kb-list-body' }, listNodes)
        ]),
        el('section', { className: 'kb-detail' }, [
          el('div', { className: 'kb-detail-head' }, [
            el('span', { className: 'title', text: editor && editor.id ? editor.id : '新建条目' }),
            el('span', { className: 'spacer' }),
            newButton
          ]),
          el('div', { className: 'kb-detail-body' }, [editor ? kbEditorForm(editor) : empty('左边选一条，或新建')])
        ])
      ])
    ];
  };

  function entriesLabel(shown, total) {
    var base = shown + ' 条';
    if (typeof total === 'number' && total !== shown) base += ' / 共 ' + total;
    return state.kb.query ? base + ' · 搜索「' + state.kb.query + '」' : base;
  }

  function kbEditor() {
    return state.kb.editing;
  }

  function kbEditorForm(draft) {
    var fields = [];
    var titleInput = el('input', { className: 'wb-input', type: 'text', placeholder: '标题', value: draft.title });
    titleInput.addEventListener('input', function () {
      draft.title = titleInput.value;
    });
    fields.push(kbField('标题', titleInput));

    var collectionInput = el('input', { className: 'wb-input', type: 'text', placeholder: 'default', value: draft.collection });
    collectionInput.addEventListener('input', function () {
      draft.collection = collectionInput.value;
    });
    fields.push(kbField('Collection', collectionInput));

    var tagsInput = el('input', { className: 'wb-input', type: 'text', placeholder: '逗号分隔', value: draft.tags });
    tagsInput.addEventListener('input', function () {
      draft.tags = tagsInput.value;
    });
    fields.push(kbField('标签', tagsInput));

    var kindInput = el('input', { className: 'wb-input', type: 'text', placeholder: 'text / file / url', value: draft.sourceKind });
    kindInput.addEventListener('input', function () {
      draft.sourceKind = kindInput.value;
    });
    var refInput = el('input', { className: 'wb-input', type: 'text', placeholder: '来源位置（可选）', value: draft.sourceRef });
    refInput.addEventListener('input', function () {
      draft.sourceRef = refInput.value;
    });
    fields.push(kbField('来源类型', kindInput));
    fields.push(kbField('来源位置', refInput));

    var textArea = el('textarea', { className: 'wb-input kb-text', rows: '14', placeholder: '正文（markdown）' });
    textArea.value = draft.text;
    textArea.addEventListener('input', function () {
      draft.text = textArea.value;
    });
    fields.push(kbField('正文', textArea));

    var actions = [];
    var save = el('button', { className: 'wb-btn', type: 'button', 'data-kind': 'primary', text: draft.id ? '保存' : '新建并保存' });
    save.disabled = Boolean(state.busy);
    save.addEventListener('click', saveKbEntry);
    actions.push(save);

    if (draft.id) {
      var attach = el('button', { className: 'wb-btn', type: 'button', text: '挂到当前计划' });
      attach.disabled = Boolean(state.busy) || !state.planId;
      attach.title = state.planId ? '' : '先选中一个计划';
      attach.addEventListener('click', function () {
        attachKbEntries([draft.id]);
      });
      actions.push(attach);
      if (isAttached(draft.id)) {
        var detach = el('button', { className: 'wb-btn', type: 'button', text: '从计划摘掉' });
        detach.disabled = Boolean(state.busy);
        detach.addEventListener('click', function () {
          detachKbEntries([draft.id]);
        });
        actions.push(detach);
      }
      var remove = el('button', { className: 'wb-btn', type: 'button', 'data-kind': 'danger', text: '删除' });
      remove.disabled = Boolean(state.busy);
      remove.addEventListener('click', removeKbEntry);
      actions.push(remove);
      actions.push(el('span', { className: 'spacer' }));
      actions.push(tag(isAttached(draft.id) ? '已挂到 ' + state.planId : '未挂到任何计划', isAttached(draft.id) ? 'ok' : 'muted'));
    } else {
      actions.push(el('span', { className: 'wb-btn-row', text: '保存后会生成 id' }));
    }

    return el('div', { className: 'kb-form' }, fields.concat([el('div', { className: 'wb-btn-row kb-form-actions' }, actions)]));
  }

  function kbField(label, control) {
    return el('label', { className: 'kb-field' }, [el('span', { className: 'kb-field-label', text: label }), control]);
  }

  /** 挂到当前计划的知识库条目，在概览里显示成一组。 */
  function attachedBlock() {
    var refs = attachedRefs();
    if (refs.length === 0) return null;
    var byId = {};
    (state.kb.items || []).forEach(function (entry) {
      byId[entry.id] = entry;
    });
    return group(
      '引用知识 · ' + refs.length,
      [
        el('button', {
          className: 'wb-btn',
          type: 'button',
          text: '管理',
          onclick: function () {
            selectTab('knowledge');
          }
        })
      ],
      el('div', { className: 'wb-btn-row' }, refs.map(function (id) {
        var known = byId[id];
        return tag(known ? known.title || id : id, known ? 'info' : 'muted', id);
      }))
    );
  }

  VIEWS.overview = function (plan) {
    var summary = plan.summary || {};
    var state0 = plan.state || {};
    var coverage = summary.coverage || { covered: 0, total: 0, ratio: 0, missing: [] };
    var runs = state0.runs || [];
    var lastRun = runs.length ? runs[runs.length - 1] : null;
    var results = lastRun && Array.isArray(lastRun.results) ? lastRun.results : [];
    var passed = results.filter(function (entry) {
      return entry.status === 'passed';
    }).length;
    var verdicts = state0.verdicts || [];
    var verdict = verdicts.length ? verdicts[verdicts.length - 1] : null;
    var coverageTone = coverage.ratio >= 0.999 ? 'ok' : coverage.ratio >= 0.5 ? 'warn' : 'bad';

    var nodes = [jobLogBlock()].filter(Boolean);

    nodes.push(
      group('整体', null, [
        el('div', { className: 'wb-row' }, [
          stat('用例', summary.cases || 0, String(summary.selectedCases || 0) + ' 选中'),
          stat('脚本', summary.scripts || 0, String(summary.runnableScripts || 0) + ' 可执行'),
          stat('执行轮次', summary.runs || 0),
          stat('最近通过', lastRun ? passed + '/' + results.length : '-'),
          stat('覆盖', pct(coverage.ratio))
        ]),
        el('div', { style: 'margin-top:10px' }, [
          meter(coverage.ratio, coverageTone),
          el('div', {
            className: 'wb-hero-meta',
            style: 'margin-top:6px',
            text:
              'feature 覆盖 ' +
              String(coverage.covered || 0) +
              '/' +
              String(coverage.total || 0) +
              (coverage.missing && coverage.missing.length ? ' · 未覆盖 ' + coverage.missing.join(', ') : ' · 无缺口')
          })
        ])
      ])
    );

    if (lastRun) {
      nodes.push(
        group(
          '最近一次执行 · ' + shortTime(lastRun.at),
          [el('button', { className: 'wb-btn', type: 'button', text: '打开执行', onclick: function () { selectTab('runs'); } })],
          el('div', { className: 'wb-row' }, [
            stat('通过', passed),
            stat('失败', results.length - passed),
            stat('总耗时', shortDuration(results.reduce(function (sum, entry) { return sum + (Number(entry.durationMs) || 0); }, 0)))
          ])
        )
      );
    }

    if (verdict) {
      var counts = verdict.counts || {};
      nodes.push(
        group(
          '最近一次诊断 · ' + shortTime(verdict.at),
          [el('button', { className: 'wb-btn', type: 'button', text: '打开诊断', onclick: function () { selectTab('diagnosis'); } })],
          [
            el('div', { className: 'wb-btn-row', style: 'margin-bottom:8px' }, Object.keys(FAILURE_LABELS).map(function (key) {
              var value = counts[key] || 0;
              return tag(FAILURE_LABELS[key] + ' ' + value, value > 0 ? FAILURE_TONES[key] : 'muted');
            })),
            el('div', { className: 'wb-text', text: verdict.recommendation || '-' }),
            verdict.blocking && verdict.blocking.length
              ? el('div', { className: 'wb-text', style: 'margin-top:6px;color:var(--bad)', text: '阻塞项：' + verdict.blocking.join('; ') })
              : null
          ]
        )
      );
    }

    var attached = attachedBlock();
    if (attached) nodes.push(attached);

    var source = state0.source || {};
    nodes.push(
      group('需求来源', null, [
        el('dl', { className: 'wb-kv' }, [
          el('dt', { text: '类型' }),
          el('dd', { text: source.kind || '-' }),
          el('dt', { text: '位置' }),
          el('dd', { className: 'wb-mono', text: source.ref || '-' }),
          el('dt', { text: '原文' }),
          el('dd', '', [el('div', { className: 'wb-text wb-clip', style: 'max-width:none', text: source.text || '-' })])
        ])
      ])
    );

    return nodes;
  };

  VIEWS.requirement = function (plan) {
    var state0 = plan.state || {};
    var features = state0.features || [];
    var notes = state0.notes || [];
    // 「拆需求」表单永远在页首：没有 feature 时它是唯一出路，有 feature 时它可以重跑。
    var nodes = [startFormBlock(), stageBar('requirements', { label: '重新拆需求' })];
    nodes.push(jobLogBlock());
    var resultBlock = jobResultBlock('requirements', function (result) {
      return group(
        '本次拆出的 feature · ' + (result.features || []).length,
        null,
        el('ul', { style: 'margin:0;padding-left:18px' }, (result.features || []).map(function (feature) {
          return el('li', { className: 'wb-text', text: (feature.id || '') + ' · ' + (feature.title || '') });
        }))
      );
    });
    if (resultBlock) nodes.push(resultBlock);
    if (features.length === 0) {
      nodes.push(empty('还没有 feature。在上面填需求原文或路径，点「拆需求」。'));
      return nodes;
    }
    features.forEach(function (feature) {
      var relatedCases = (state0.cases || []).filter(function (entry) {
        return entry.featureId === feature.id;
      });
      nodes.push(
        group(
          feature.id + ' · ' + (feature.title || ''),
          [tag(relatedCases.length + ' 用例', relatedCases.length ? 'ok' : 'warn')],
          [
            el('div', { className: 'wb-text', text: feature.description || '-' }),
            el('div', { style: 'margin-top:8px;font-size:11.5px;color:var(--muted)', text: '验收标准' }),
            el(
              'ul',
              { style: 'margin:4px 0 0 0;padding-left:18px' },
              (feature.acceptance || []).map(function (item) {
                return el('li', { className: 'wb-text', text: item });
              })
            ),
            feature.requirementRefs && feature.requirementRefs.length
              ? el('div', { className: 'wb-btn-row', style: 'margin-top:8px' }, feature.requirementRefs.map(function (ref) {
                  return tag(ref, 'muted');
                }))
              : null
          ]
        )
      );
    });
    if (notes.length) {
      nodes.push(
        group(
          '缺口与备注',
          null,
          el(
            'ul',
            { style: 'margin:0;padding-left:18px' },
            notes.map(function (note) {
              return el('li', { className: 'wb-text', text: typeof note === 'string' ? note : note.text || JSON.stringify(note) });
            })
          )
        )
      );
    }
    return nodes;
  };

  VIEWS.cases = function (plan) {
    var state0 = plan.state || {};
    var cases = state0.cases || [];
    // 审核门的开/关由服务端 gate.ok 决定；这里只显示它给的 reason，
    // 不再自己比 revision 与 approvedRevision —— 旧代码那样做，规则一改前端就说谎。
    var nodes = [
      stageBar('cases', {
        label: cases.length ? '重新生成用例' : '生成用例',
        allowWhenDone: true,
        onRun: function () {
          startJob('autotest.cases.generate', { planId: state.planId, regenerate: cases.length > 0 }, 'cases');
        }
      }),
      reviewGateBlock(plan)
    ].filter(Boolean);
    nodes.push(jobLogBlock());
    if (cases.length === 0) {
      nodes.push(empty('还没有用例。点上面的「生成用例」。'));
      return nodes;
    }
    var runStatus = {};
    var lastRun = (state0.runs || []).slice(-1)[0];
    if (lastRun && Array.isArray(lastRun.results)) {
      lastRun.results.forEach(function (entry) {
        runStatus[entry.testCaseId] = entry;
      });
    }
    var featureTitle = {};
    (state0.features || []).forEach(function (feature) {
      featureTitle[feature.id] = feature.title;
    });
    var rows = cases.map(function (entry) {
      var result = runStatus[entry.id];
      var expanded = state.expandedCase === entry.id;
      var tr = el('tr', {
        'data-active': expanded ? 'yes' : 'no',
        style: 'cursor:pointer',
        title: '点击展开步骤与预期'
      });
      tr.appendChild(el('td', { className: 'mono', text: entry.id }));
      tr.appendChild(el('td', {}, [el('span', { text: entry.title || '' })]));
      tr.appendChild(el('td', {}, [tag(entry.priority || '-', entry.priority === 'P0' ? 'bad' : entry.priority === 'P1' ? 'warn' : 'muted')]));
      tr.appendChild(el('td', { text: featureTitle[entry.featureId] || entry.featureId || '-' }));
      // 服务端 gate 才是权威：这里只显示这一行有没有被批准记录覆盖，不做规则判断。
      tr.appendChild(el('td', {}, [entry.approvedRevision == null ? tag('待批', 'warn') : tag('已批准', 'ok')]));
      tr.appendChild(el('td', {}, [entry.selected === false ? tag('不执行', 'muted') : tag('执行', 'info')]));
      tr.appendChild(el('td', {}, [result ? statusTag(result) : tag('-', 'muted')]));
      tr.addEventListener('click', function () {
        state.expandedCase = expanded ? null : entry.id;
        render();
      });
      var out = [tr];
      if (expanded) {
        out.push(
          el('tr', {}, [
            el('td', { colspan: '7', style: 'background:var(--surface-raised)' }, [
              (entry.preconditions || []).length
                ? el('div', { className: 'wb-text', style: 'margin-bottom:6px', text: '前置：' + entry.preconditions.join(' / ') })
                : null,
              el('div', { style: 'font-size:11.5px;color:var(--muted)', text: '步骤' }),
              el(
                'ol',
                { style: 'margin:4px 0 8px 0;padding-left:18px' },
                lines(entry.steps).map(function (item) {
                  return el('li', { className: 'wb-text', text: item });
                })
              ),
              el('div', { style: 'font-size:11.5px;color:var(--muted)', text: '预期' }),
              el(
                'ul',
                { style: 'margin:4px 0 0 0;padding-left:18px' },
                lines(entry.expected).map(function (item) {
                  return el('li', { className: 'wb-text', text: item });
                })
              )
            ])
          ])
        );
      }
      return out;
    });
    var flat = [];
    rows.forEach(function (pair) {
      pair.forEach(function (node) {
        flat.push(node);
      });
    });
    nodes.push(
      group('用例库 · ' + cases.length, null, el('table', { className: 'wb-table' }, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', { text: 'ID' }),
            el('th', { text: '标题' }),
            el('th', { text: '优先级' }),
            el('th', { text: '所属 feature' }),
            el('th', { text: '审核' }),
            el('th', { text: '选择' }),
            el('th', { text: '最近结果' })
          ])
        ]),
        el('tbody', {}, flat)
      ]), true)
    );
    return nodes;
  };

  /** 诊断依据的 evidence 是字符串数组；容错处理，字段缺失时不要整页炸。 */
  function evidenceText(evidence) {
    if (!evidence) return '-';
    if (Array.isArray(evidence)) return evidence.join('; ') || '-';
    return String(evidence);
  }

  function statusTag(result) {
    var map = { passed: ['通过', 'ok'], failed: ['失败', 'bad'], errored: ['出错', 'bad'], skipped: ['跳过', 'muted'], timeout: ['超时', 'warn'] };
    var entry = map[result.status] || [String(result.status || '-'), 'muted'];
    return tag(entry[0], entry[1], result.reason || null);
  }

  VIEWS.scripts = function (plan) {
    var state0 = plan.state || {};
    var scripts = state0.scripts || [];
    var nodes = [stageBar('scripts', { label: '写脚本（每批最多 ' + AUTHOR_BATCH + ' 条）' }), jobLogBlock(), scriptsEditor(plan)];
    nodes = nodes.filter(Boolean);
    if (scripts.length === 0) {
      nodes.push(empty('还没有脚本。勾上面的用例，点「写脚本」——一次最多 ' + AUTHOR_BATCH + ' 条，多了会自动排队。'));
      return nodes;
    }
    var rows = scripts.map(function (entry) {
      var tr = el('tr', { style: 'cursor:pointer', title: '点击查看脚本内容' });
      tr.appendChild(el('td', { className: 'mono', text: entry.testCaseId }));
      tr.appendChild(el('td', { text: entry.title || '-' }));
      tr.appendChild(el('td', {}, [tag(entry.language || '-', 'info')]));
      tr.appendChild(el('td', { className: 'mono wb-clip', text: entry.command || '-' }));
      tr.appendChild(el('td', { className: 'num', text: String((entry.body || '').split('\n').length) }));
      tr.appendChild(el('td', { className: 'num', text: 'r' + String(entry.revision || 1) }));
      tr.addEventListener('click', function () {
        openDrawer(entry.testCaseId + ' · ' + (entry.title || ''), entry.body || '');
      });
      return tr;
    });
    nodes.push(
      group(
        '脚本库 · ' + scripts.length,
        null,
        el('table', { className: 'wb-table' }, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { text: '用例' }),
              el('th', { text: '标题' }),
              el('th', { text: '语言' }),
              el('th', { text: '命令' }),
              el('th', { text: '行数' }),
              el('th', { text: '修订' })
            ])
          ]),
          el('tbody', {}, rows)
        ]),
        true
      )
    );
    return nodes;
  };

  VIEWS.runs = function (plan) {
    var state0 = plan.state || {};
    var runs = (state0.runs || []).slice().reverse();
    // 执行条始终在：第一次跑之前「开始执行」也得点得到，否则这个 tab 永远空着。
    var nodes = [
      stageBar('run', {
        label: runs.length === 0 ? '开始执行' : '再跑一轮',
        onRun: function () {
          startJob('autotest.execute', { planId: state.planId }, 'run');
        }
      }),
      jobLogBlock(),
      jobResultBlock('run', function (result) {
        return group(
          '本轮结果 · ' + (result.runId || ''),
          [tag(String((result.summary && result.summary.passed) || 0) + '/' + String((result.summary && result.summary.total) || 0) + ' 通过', 'info')],
          el('div', { className: 'wb-text', text: '执行完成，下方「执行记录」已刷新。' })
        );
      })
    ].filter(Boolean);
    if (runs.length === 0) {
      nodes.push(empty('还没有执行记录。点上面的「开始执行」，每跑完一轮这里会出现一条记录。'));
      return nodes;
    }
    runs.slice(0, 5).forEach(function (run, index) {
      var results = Array.isArray(run.results) ? run.results : [];
      var passed = results.filter(function (entry) {
        return entry.status === 'passed';
      }).length;
      var rows = results.map(function (entry) {
        var tr = el('tr', { style: 'cursor:pointer', title: '点击查看 stdout / stderr' });
        tr.appendChild(el('td', { className: 'mono', text: entry.testCaseId }));
        tr.appendChild(el('td', { text: entry.title || '-' }));
        tr.appendChild(el('td', {}, [statusTag(entry)]));
        tr.appendChild(el('td', { className: 'num', text: String(entry.exitCode == null ? '-' : entry.exitCode) }));
        tr.appendChild(el('td', { className: 'num', text: shortDuration(entry.durationMs) }));
        tr.appendChild(el('td', { className: 'wb-clip', text: entry.reason || '-' }));
        tr.addEventListener('click', function () {
          openDrawer(
            entry.testCaseId + ' · ' + (entry.status || ''),
            renderResultText(entry)
          );
        });
        return tr;
      });
      nodes.push(
        group(
          run.id + ' · ' + shortTime(run.at) + (index === 0 ? ' · 最近' : ''),
          [tag(passed + '/' + results.length + ' 通过', passed === results.length ? 'ok' : 'warn')],
          el('table', { className: 'wb-table' }, [
            el('thead', {}, [
              el('tr', {}, [
                el('th', { text: '用例' }),
                el('th', { text: '标题' }),
                el('th', { text: '状态' }),
                el('th', { text: '退出码' }),
                el('th', { text: '耗时' }),
                el('th', { text: '原因' })
              ])
            ]),
            el('tbody', {}, rows)
          ]),
          true
        )
      );
    });
    return nodes;
  };

  function renderResultText(entry) {
    var parts = [];
    parts.push('status   : ' + String(entry.status || '-'));
    if (entry.exitCode != null) parts.push('exitCode : ' + String(entry.exitCode));
    if (entry.durationMs != null) parts.push('duration : ' + shortDuration(entry.durationMs));
    if (entry.reason) parts.push('reason   : ' + String(entry.reason));
    if (entry.file) parts.push('file     : ' + String(entry.file));
    if (entry.truncated) parts.push('truncated: true (输出被截断)');
    parts.push('');
    parts.push('--- stdout ---');
    parts.push(String(entry.stdout || '(empty)'));
    parts.push('');
    parts.push('--- stderr ---');
    parts.push(String(entry.stderr || '(empty)'));
    return parts.join('\n');
  }

  VIEWS.diagnosis = function (plan) {
    var state0 = plan.state || {};
    var verdicts = (state0.verdicts || []).slice().reverse();
    var nodes = [
      stageBar('verdict', {
        label: '诊断失败',
        onRun: function () {
          startJob('autotest.diagnose', { planId: state.planId }, 'verdict');
        }
      }),
      jobLogBlock(),
      jobResultBlock('verdict', function (result) {
        var counts = result.counts || {};
        return group(
          '本次诊断',
          Object.keys(FAILURE_LABELS).map(function (key) {
            var value = counts[key] || 0;
            return value > 0 ? tag(FAILURE_LABELS[key] + ' ' + value, FAILURE_TONES[key]) : null;
          }).filter(Boolean),
          [
            el('div', { className: 'wb-text', text: result.recommendation || '-' }),
            result.blocking && result.blocking.length
              ? el('div', { className: 'wb-text', style: 'margin-top:6px;color:var(--bad)', text: '阻塞（不是脚本问题，别改写绕过）：' + result.blocking.join('; ') })
              : null,
            result.repairAllowed ? tag('可以改写脚本后重跑', 'warn') : null
          ]
        );
      })
    ].filter(Boolean);
    if (verdicts.length === 0) {
      nodes.push(empty('还没有诊断结论。点上面的「诊断失败」。'));
      return nodes;
    }
    verdicts.slice(0, 3).forEach(function (verdict) {
      var counts = verdict.counts || {};
      var rows = (verdict.entries || []).map(function (entry) {
        // 服务端的分类字段叫 kind（lib/diagnose.js classifyRun），不是 category。
        var kind = entry.kind || entry.category || 'unknown';
        var tr = el('tr');
        tr.appendChild(el('td', { className: 'mono', text: entry.testCaseId }));
        tr.appendChild(el('td', {}, [tag(FAILURE_LABELS[kind] || kind, FAILURE_TONES[kind] || 'muted')]));
        tr.appendChild(el('td', { className: 'num', text: String(entry.confidence == null ? '-' : entry.confidence) }));
        tr.appendChild(el('td', { text: entry.reason || '-' }));
        tr.appendChild(el('td', {}, [entry.needsRepair ? tag('可改写', 'warn') : tag('人工判断', 'bad')]));
        tr.appendChild(el('td', { className: 'wb-clip', text: evidenceText(entry.evidence) }));
        return tr;
      });
      nodes.push(
        group(
          verdict.runId + ' · ' + shortTime(verdict.at),
          Object.keys(FAILURE_LABELS)
            .map(function (key) {
              var value = counts[key] || 0;
              return value > 0 ? tag(FAILURE_LABELS[key] + ' ' + value, FAILURE_TONES[key]) : null;
            })
            .filter(Boolean),
          [
            el('div', { className: 'wb-text', style: 'margin-bottom:8px', text: verdict.recommendation || '-' }),
            verdict.blocking && verdict.blocking.length
              ? el('div', { className: 'wb-text', style: 'margin-bottom:8px;color:var(--bad)', text: '阻塞（不是脚本问题，别改写绕过）：' + verdict.blocking.join('; ') })
              : null,
            el('table', { className: 'wb-table' }, [
              el('thead', {}, [
                el('tr', {}, [
                  el('th', { text: '用例' }),
                  el('th', { text: '分类' }),
                  el('th', { text: '置信' }),
                  el('th', { text: '依据' }),
                  el('th', { text: '处理' }),
                  el('th', { text: '证据' })
                ])
              ]),
              el('tbody', {}, rows)
            ])
          ]
        )
      );
    });
    return nodes;
  };

  VIEWS.report = function (plan) {
    var markdown = (plan.artifacts || []).filter(function (entry) {
      return entry.stage === 'report';
    });
    var state0 = plan.state || {};
    var summary = plan.summary || {};
    var nodes = [stageBar('report', { label: '生成报告' }), jobLogBlock(), reportResultBlock()].filter(Boolean);
    // autotest.report 现在是异步票据（lead 改了契约）：点击只发请求，markdown 从
    // job.result 里取。旧代码同步读 answer.markdown，契约一变就会永远弹出空抽屉。
    var actions = [
      el('button', {
        className: 'wb-btn',
        type: 'button',
        'data-kind': 'primary',
        text: '生成报告',
        onclick: function () {
          startJob('autotest.report', { planId: state.planId }, 'report');
        }
      }),
      el('button', {
        className: 'wb-btn',
        type: 'button',
        text: '查看 report.md',
        onclick: function () {
          var job = state.job;
          if (job && job.result && job.result.markdown) {
            openDrawer('report.md', job.result.markdown);
            return;
          }
          promiseReport();
        }
      })
    ];
    var rows = (state0.stages ? Object.keys(state0.stages) : []).map(function (stageId) {
      var entry = state0.stages[stageId] || {};
      var tr = el('tr');
      tr.appendChild(el('td', { text: STAGE_LABELS[stageId] || stageId }));
      tr.appendChild(el('td', {}, [statusTag({ status: mapStageStatus(entry.status) })]));
      tr.appendChild(el('td', { text: shortTime(entry.updatedAt) }));
      tr.appendChild(el('td', { text: entry.artifactId || '-' }));
      tr.appendChild(el('td', { className: 'wb-clip', text: entry.note || '-' }));
      return tr;
    });
    nodes.push(
      group('阶段记录', actions, el('table', { className: 'wb-table' }, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', { text: '阶段' }),
            el('th', { text: '状态' }),
            el('th', { text: '时间' }),
            el('th', { text: '产物' }),
            el('th', { text: '备注' })
          ])
        ]),
        el('tbody', {}, rows)
      ]), true)
    );
    if ((state0.approvals || []).length) {
      nodes.push(
        group(
          '审批痕迹 · ' + state0.approvals.length,
          null,
          el(
            'ul',
            { style: 'margin:0;padding-left:18px' },
            state0.approvals.map(function (entry) {
              return el('li', {
                className: 'wb-text',
                text:
                  shortTime(entry.at) +
                  ' · ' +
                  entry.actor +
                  ' · ' +
                  (entry.decision === 'approved' ? '批准' : '退回') +
                  ' · ' +
                  (entry.selected || []).length +
                  ' 用例' +
                  (entry.note ? ' · ' + entry.note : '')
              });
            })
          )
        )
      );
    }
    if (markdown.length) {
      nodes.push(
        group('报告产物', null, el('div', { className: 'wb-btn-row' }, markdown.map(function (entry) {
          return tag(entry.name || entry.id || 'report.md', 'muted');
        })))
      );
    }
    if (summary.gate && !summary.gate.ok) {
      nodes.push(group('执行门', null, el('div', { className: 'wb-text', text: summary.gate.reason || '未关闭' })));
    }
    return nodes;
  };

  function mapStageStatus(status) {
    if (!status) return 'skipped';
    if (status === 'done') return 'passed';
    if (status === 'running') return 'timeout';
    if (status === 'failed') return 'failed';
    if (status === 'awaiting_review') return 'timeout';
    return 'skipped';
  }

  VIEWS.matrix = function (plan) {
    var state0 = plan.state || {};
    var features = state0.features || [];
    var cases = state0.cases || [];
    if (features.length === 0 && cases.length === 0) return [empty('还没有可追溯的内容。')];
    var scripts = state0.scripts || [];
    var lastRun = (state0.runs || []).slice(-1)[0];
    var results = {};
    if (lastRun && Array.isArray(lastRun.results)) {
      lastRun.results.forEach(function (entry) {
        results[entry.testCaseId] = entry;
      });
    }
    var verdictEntries = {};
    var lastVerdict = (state0.verdicts || []).slice(-1)[0];
    if (lastVerdict && Array.isArray(lastVerdict.entries)) {
      lastVerdict.entries.forEach(function (entry) {
        verdictEntries[entry.testCaseId] = entry;
      });
    }
    var head = ['需求'];
    features.forEach(function (feature) {
      head.push(feature.id);
    });
    var rows = cases.map(function (entry) {
      var script = null;
      scripts.forEach(function (item) {
        if (item.testCaseId === entry.id) script = item;
      });
      var result = results[entry.id];
      var verdict = verdictEntries[entry.id];
      var cells = [];
      cells.push(el('td', { className: 'mono', style: 'padding-right:8px;white-space:nowrap', text: entry.id + ' ' + (entry.priority || '') }));
      features.forEach(function (feature) {
        var linked = entry.featureId === feature.id;
        var tone = 'muted';
        var glyph = '·';
        if (linked) {
          if (result && result.status === 'passed') {
            tone = 'ok';
            glyph = '✓';
          } else if (result) {
            tone = 'bad';
            glyph = '✕';
          } else if (script) {
            tone = 'info';
            glyph = '⚙';
          } else if (entry.approvedRevision != null) {
            // 有批准记录（服务端写的）就是半圆；前端不判断它是不是已陈旧。
            tone = 'warn';
            glyph = '◑';
          } else {
            tone = 'warn';
            glyph = '○';
          }
        }
        cells.push(
          el('td', {}, [
            el('div', {
              className: 'wb-cell',
              'data-tone': tone,
              title:
                (linked ? entry.id + ' → ' + feature.id : '') +
                (result ? ' · ' + result.status : '') +
                (verdict ? ' · ' + (FAILURE_LABELS[verdict.kind] || verdict.kind) : ''),
              text: glyph
            })
          ])
        );
      });
      return el('tr', {}, cells);
    });
    return [
      group(
        '追溯矩阵',
        [tag('○ 待批准 · ◑ 已批准 · ⚙ 有脚本 · ✓ 通过 · ✕ 失败', 'muted')],
        el('table', { className: 'wb-table wb-matrix' }, [
          el('thead', {}, [
            el('tr', {}, head.map(function (label, index) {
              return el('th', { text: label, style: index === 0 ? 'text-align:left' : 'text-align:center' });
            }))
          ]),
          el('tbody', {}, rows)
        ]),
        true
      )
    ];
  };

  /* ── 侧滑明细 ───────────────────────────────────────────────────── */

  function openDrawer(title, body) {
    state.drawer = { title: title, body: String(body == null ? '' : body) };
    renderDrawer();
  }

  function closeDrawer() {
    state.drawer = null;
    renderDrawer();
  }

  function renderDrawer() {
    var node = document.getElementById('drawer');
    if (!state.drawer) {
      node.hidden = true;
      return;
    }
    node.hidden = false;
    document.getElementById('drawer-title').textContent = state.drawer.title;
    var body = document.getElementById('drawer-body');
    body.textContent = state.drawer.body;
    body.scrollTop = 0;
  }

  /* ── 渲染总入口 ─────────────────────────────────────────────────── */

  function render() {
    renderRail();
    renderBanner();
    renderPlans();
    renderHero();
    renderTabs();
    renderView();
    renderDrawer();
    document.documentElement.removeAttribute('data-booting');
  }

  /* ── 启动 ───────────────────────────────────────────────────────── */

  function bindChrome() {
    document.getElementById('refresh').addEventListener('click', function () {
      reload(state.planId).catch(function () {});
    });
    document.getElementById('search').addEventListener('input', function (event) {
      state.search = event.target.value || '';
      renderPlans();
    });
    document.getElementById('drawer-close').addEventListener('click', closeDrawer);
    document.getElementById('drawer-copy').addEventListener('click', function () {
      if (!state.drawer) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(state.drawer.body).then(
          function () {
            toast('已复制');
          },
          function () {
            toast('复制失败', 'bad');
          }
        );
      }
    });
    window.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && state.drawer) closeDrawer();
      else if (event.key === 'r' && !event.metaKey && !event.ctrlKey && event.target === document.body) {
        reload(state.planId).catch(function () {});
      }
    });
    // 停靠视图没有外观推送通道（appearance:changed 不会到这里），只能轮询。
    // 两条轮询链分开：快照每 POLL_MS 一次；作业进度只在有活跃 job 时由
    // scheduleJobPoll 用 JOB_POLL_MS 驱动。两边都只发一个 IPC，不叠加。
    window.setInterval(function () {
      pollAppearance();
      if (!activeJob()) reload(state.planId).catch(function () {});
    }, POLL_MS);
  }

  function boot() {
    bindChrome();
    applyAppearance(null);
    reload(null)
      .then(function () {
        pollAppearance();
        adoptRunningJob();
        return null;
      })
      .catch(function (error) {
        var host = clear(document.getElementById('view'));
        host.appendChild(
          empty(
            error.code === 'NO_BRIDGE'
              ? '这个页面必须从 PI-Desktop 的工作面板打开。'
              : '读取失败：' + (error.code || '') + ' ' + (error.message || '')
          )
        );
        document.documentElement.removeAttribute('data-booting');
      });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
