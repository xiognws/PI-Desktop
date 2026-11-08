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
  var POLL_MS = 4000;
  var BRIDGE_TIMEOUT_MS = 25000;

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
    drawer: null
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
        if (!state.planId) state.tab = 'overview';
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

  function renderRail() {
    var host = clear(document.getElementById('rail'));
    var plan = snapshotPlan();
    var snapshotRail = plan && plan.rail ? plan.rail.stages : null;
    STAGES.forEach(function (stageId) {
      var entry = null;
      if (snapshotRail) {
        snapshotRail.forEach(function (item) {
          if (item.stage === stageId) entry = item;
        });
      }
      var painted = entry ? entry.state : 'locked';
      var detail = [STAGE_LABELS[stageId], STAGE_HINTS[stageId]];
      if (entry && entry.note) detail.push(entry.note);
      if (entry && entry.reason) detail.push(entry.reason);
      var node = el(
        'button',
        {
          className: 'wb-node',
          type: 'button',
          'data-state': painted,
          'data-current': entry && entry.state === 'ready' ? 'yes' : 'no',
          title: detail.join(' · ')
        },
        [el('span', { className: 'dot' }), el('span', { text: STAGE_LABELS[stageId] })]
      );
      node.addEventListener('click', function () {
        var target = TAB_OF_STAGE[stageId];
        if (target) selectTab(target);
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
        reload(plan.id).catch(function () {});
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
          disabled: plan ? null : true
        },
        [el('span', { text: pair[1] }), counts[id] ? el('span', { className: 'count', text: String(counts[id]) }) : null]
      );
      node.addEventListener('click', function () {
        selectTab(id);
      });
      host.appendChild(node);
    });
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
    if (!plan) {
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

  var VIEWS = {};

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

    var nodes = [];

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
    var nodes = [];
    if (features.length === 0) {
      nodes.push(empty('还没有 feature。让 agent 调用 autotest_requirement 做需求分解。'));
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
    var nodes = [reviewGateBlock(plan)].filter(Boolean);
    if (cases.length === 0) {
      nodes.push(empty('还没有用例。批准 feature 后调用 autotest_cases 生成。'));
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
      var approved = typeof entry.approvedRevision === 'number' && entry.revision <= entry.approvedRevision;
      tr.appendChild(el('td', { className: 'mono', text: entry.id }));
      tr.appendChild(el('td', {}, [el('span', { text: entry.title || '' })]));
      tr.appendChild(el('td', {}, [tag(entry.priority || '-', entry.priority === 'P0' ? 'bad' : entry.priority === 'P1' ? 'warn' : 'muted')]));
      tr.appendChild(el('td', { text: featureTitle[entry.featureId] || entry.featureId || '-' }));
      tr.appendChild(el('td', {}, [approved ? tag('已批准', 'ok') : tag('待批', 'warn')]));
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

  function statusTag(result) {
    var map = { passed: ['通过', 'ok'], failed: ['失败', 'bad'], errored: ['出错', 'bad'], skipped: ['跳过', 'muted'], timeout: ['超时', 'warn'] };
    var entry = map[result.status] || [String(result.status || '-'), 'muted'];
    return tag(entry[0], entry[1], result.reason || null);
  }

  VIEWS.scripts = function (plan) {
    var state0 = plan.state || {};
    var scripts = state0.scripts || [];
    if (scripts.length === 0) return [empty('还没有脚本。用例批准后调用 autotest_author 生成（每次最多 3 个）。')];
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
    return [
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
    ];
  };

  VIEWS.runs = function (plan) {
    var state0 = plan.state || {};
    var runs = (state0.runs || []).slice().reverse();
    if (runs.length === 0) return [empty('还没有执行记录。')];
    var nodes = [];
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
    if (verdicts.length === 0) return [empty('还没有诊断结论。执行之后调用 autotest_diagnose。')];
    var nodes = [];
    verdicts.slice(0, 3).forEach(function (verdict) {
      var counts = verdict.counts || {};
      var rows = (verdict.entries || []).map(function (entry) {
        var tr = el('tr');
        tr.appendChild(el('td', { className: 'mono', text: entry.testCaseId }));
        tr.appendChild(el('td', {}, [tag(FAILURE_LABELS[entry.kind] || entry.kind, FAILURE_TONES[entry.kind] || 'muted')]));
        tr.appendChild(el('td', { className: 'num', text: String(entry.confidence == null ? '-' : entry.confidence) }));
        tr.appendChild(el('td', { text: entry.reason || '-' }));
        tr.appendChild(el('td', {}, [entry.needsRepair ? tag('可改写', 'warn') : tag('人工判断', 'bad')]));
        tr.appendChild(el('td', { className: 'wb-clip', text: (entry.evidence || []).join('; ') || '-' }));
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
    var nodes = [];
    var actions = [
      el('button', {
        className: 'wb-btn',
        type: 'button',
        text: '查看 report.md',
        onclick: function () {
          invoke('autotest.report', { planId: state.planId })
            .then(function (answer) {
              if (!answer || answer.ok !== true) throw new Error((answer && answer.message) || '不可读取');
              openDrawer('report.md', answer.markdown || '');
            })
            .catch(function (error) {
              toast((error.code ? error.code + ': ' : '') + error.message, 'bad');
            });
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
          } else if (typeof entry.approvedRevision === 'number' && entry.revision <= entry.approvedRevision) {
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
    window.setInterval(pollAppearance, POLL_MS);
  }

  function boot() {
    bindChrome();
    applyAppearance(null);
    reload(null)
      .then(function () {
        pollAppearance();
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
