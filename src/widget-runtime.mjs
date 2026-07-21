/**
 * Renderer 内用量组件。此函数会被序列化后通过 CDP 执行，因此函数体不能引用模块外变量。
 * 作者：liujl
 * 创建时间：2026-07-21 13:47:34
 *
 * @param {string} revision 当前注入版本，用于让过期的 early script 自动失效。
 */
export function usageWidgetBootstrap(revision) {
  /** 全局控制器键，宿主通过它更新、查询和移除组件。 */
  const STATE_KEY = "__CODEX_USAGE_WIDGET__";
  /** localStorage 中的当前有效版本；恢复操作清除它后，旧 early script 不会重新安装。 */
  const ACTIVE_REVISION_KEY = "codex-usage-injector-active-revision";
  /** 徽标节点 id，确保同一 Renderer 内最多存在一个组件实例。 */
  const BADGE_ID = "codex-usage-badge";
  /** 样式节点 id，恢复时只删除本项目拥有的规则。 */
  const STYLE_ID = "codex-usage-style";
  /** 侧栏底部候选区域高度；账户行位于侧栏底部，超出该区域的按钮不得成为锚点。 */
  const FOOTER_ZONE_PX = 190;
  /**
   * 账户按钮允许的最小高度。Codex 26.715.61943 的实际行高是 29px，保留 1px
   * 布局取整余量；更矮的图标按钮仍会被排除，避免把帮助按钮等节点误判为账户行。
   * 修改人：liujl
   * 修改时间：2026-07-21 14:32:40
   * 修改说明：兼容新版 Codex 将账户行从 32px 调整为 29px 的 DOM 结构。
   */
  const MIN_ACCOUNT_ROW_HEIGHT_PX = 28;
  /** 合格账户按钮的最低结构评分，低于该值时宁可不显示也不能挂错位置。 */
  const MIN_ANCHOR_SCORE = 70;
  /** DOM 兜底检查周期，用于覆盖浏览器未产生 childList 变更但节点被整体替换的极少数情况。 */
  const ENSURE_INTERVAL_MS = 4_000;

  if (localStorage.getItem(ACTIVE_REVISION_KEY) !== revision) return;
  window[STATE_KEY]?.remove?.({ preserveRevision: true });

  let observer = null;
  let timer = null;
  let scheduled = false;
  let latestSnapshot = { status: "loading" };
  let lastAnchorScore = null;

  /**
   * 判断元素当前是否可见并具有可用尺寸。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   *
   * @param {Element} element 待检查的 DOM 元素。
   * @returns {boolean} 元素可用于定位时返回 true。
   */
  const isVisible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden"
    );
  };

  /**
   * 根据侧栏位置、文本、头像和按钮尺寸给候选账户行评分。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   *
   * @param {Element} candidate 侧栏内的按钮候选。
   * @param {DOMRect} sidebarRect 侧栏矩形。
   * @returns {number} 结构评分；负数表示明确不合格。
   */
  const scoreCandidate = (candidate, sidebarRect) => {
    if (
      !isVisible(candidate) ||
      candidate.id === BADGE_ID ||
      candidate.closest(`#${BADGE_ID}`)
    )
      return -1;
    const rect = candidate.getBoundingClientRect();
    if (
      rect.bottom < sidebarRect.bottom - FOOTER_ZONE_PX ||
      rect.width < 120 ||
      rect.height < MIN_ACCOUNT_ROW_HEIGHT_PX ||
      rect.height > 80
    )
      return -1;
    const text = String(candidate.innerText ?? candidate.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text || text.length > 100) return -1;

    let score = 0;
    const bottomDistance = Math.abs(sidebarRect.bottom - rect.bottom);
    if (bottomDistance <= 24) score += 35;
    else if (bottomDistance <= 80) score += 25;
    else score += 10;
    if (rect.width >= sidebarRect.width * 0.55) score += 25;
    if (candidate.querySelector("img")) score += 25;
    if (candidate.querySelector('[class*="rounded-full"], [class*="avatar"]'))
      score += 20;
    if (candidate.matches("button")) score += 10;
    if (candidate.getAttribute("aria-haspopup")) score += 15;
    return score;
  };

  /**
   * 在侧栏底部选择最符合“头像＋用户名”的账户按钮。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   *
   * @returns {{element: Element, score: number} | null} 合格锚点及评分。
   */
  const findAnchor = () => {
    const sidebar = document.querySelector("aside.app-shell-left-panel");
    if (!sidebar || !isVisible(sidebar)) return null;
    const sidebarRect = sidebar.getBoundingClientRect();
    const candidates = Array.from(
      sidebar.querySelectorAll('button, [role="button"]'),
    );
    let best = null;
    for (const candidate of candidates) {
      const score = scoreCandidate(candidate, sidebarRect);
      if (!best || score > best.score) best = { element: candidate, score };
    }
    return best && best.score >= MIN_ANCHOR_SCORE ? best : null;
  };

  /**
   * 安装徽标所需样式。全部规则以唯一 id 为入口，不污染 Codex 其他组件。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   */
  const ensureStyle = () => {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    /*
     * 修改人：liujl
     * 修改时间：2026-07-21 15:10:12
     * 修改说明：用零延迟的自绘 Tooltip 替代系统 title，缩短悬停等待时间；
     * 同时保留短淡入并尊重减少动态效果设置，避免弹层突现和无障碍退化。
     */
    style.textContent = `
      #${BADGE_ID} {
        position: relative;
        display: inline-flex;
        flex: 0 0 auto;
        align-items: center;
        justify-content: center;
        min-width: 58px;
        height: 24px;
        margin-left: auto;
        padding: 0 8px;
        border: 1px solid color-mix(in srgb, var(--color-token-text-secondary) 20%, transparent);
        border-radius: 999px;
        background: color-mix(in srgb, var(--color-token-surface-secondary) 82%, transparent);
        color: var(--color-token-text-secondary);
        font-size: 11px;
        font-weight: 500;
        line-height: 1;
        white-space: nowrap;
        pointer-events: auto;
        cursor: help;
      }
      #${BADGE_ID}::after {
        content: attr(data-tooltip);
        position: absolute;
        right: 0;
        bottom: calc(100% + 8px);
        z-index: 50;
        width: max-content;
        min-width: 180px;
        max-width: min(280px, calc(100vw - 24px));
        padding: 8px 10px;
        border: 1px solid var(--color-token-border-default, rgba(230, 237, 243, 0.12));
        border-radius: 8px;
        background: var(--color-token-main-surface-primary, #202123);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
        color: var(--color-token-text-primary, #f4f4f5);
        font-size: 12px;
        font-weight: 400;
        line-height: 1.5;
        letter-spacing: normal;
        text-align: left;
        white-space: pre-line;
        opacity: 0;
        visibility: hidden;
        pointer-events: none;
        transform: translateY(2px);
        transition: opacity 80ms ease-out, transform 80ms ease-out, visibility 0s;
        transition-delay: 0s;
      }
      #${BADGE_ID}:hover::after,
      button:focus-visible #${BADGE_ID}::after {
        opacity: 1;
        visibility: visible;
        transform: translateY(0);
      }
      #${BADGE_ID}[data-level="healthy"] { color: #238636; border-color: color-mix(in srgb, #238636 35%, transparent); }
      #${BADGE_ID}[data-level="warning"] { color: #b76e00; border-color: color-mix(in srgb, #b76e00 38%, transparent); }
      #${BADGE_ID}[data-level="danger"] { color: var(--color-token-error-foreground, #d1242f); border-color: color-mix(in srgb, #d1242f 38%, transparent); }
      #${BADGE_ID}[data-level="unknown"] { opacity: .72; }
      @media (prefers-reduced-motion: reduce) {
        #${BADGE_ID}::after { transition: none; transform: none; }
      }
    `;
    document.head.appendChild(style);
  };

  /**
   * 将 Unix 秒时间戳转换为本地重置时间。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   *
   * @param {number | null | undefined} timestampSeconds Unix 秒时间戳。
   * @returns {string | null} 本地化时间文本。
   */
  const formatResetTime = (timestampSeconds) => {
    if (!Number.isInteger(timestampSeconds) || timestampSeconds <= 0)
      return null;
    return new Intl.DateTimeFormat(undefined, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(timestampSeconds * 1_000));
  };

  /**
   * 根据最新数据更新徽标文本、颜色和提示信息。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   *
   * @param {HTMLElement} badge 用量徽标节点。
   */
  const render = (badge) => {
    if (
      latestSnapshot.status !== "ready" ||
      !Number.isInteger(latestSnapshot.remainingPercent)
    ) {
      badge.textContent =
        latestSnapshot.status === "loading" ? "用量…" : "用量 --";
      badge.dataset.level = "unknown";
      badge.dataset.tooltip =
        latestSnapshot.status === "error"
          ? "暂时无法读取 Codex 用量"
          : "正在读取 Codex 用量";
      badge.removeAttribute("title");
      return;
    }

    const remaining = latestSnapshot.remainingPercent;
    badge.textContent = `剩余 ${remaining}%`;
    badge.dataset.level =
      remaining < 20 ? "danger" : remaining < 50 ? "warning" : "healthy";
    const lines = [`Codex 剩余 ${remaining}%`];
    const resetTime = formatResetTime(latestSnapshot.resetsAt);
    if (resetTime) lines.push(`重置时间：${resetTime}`);
    if (latestSnapshot.resetCreditsAvailable > 0)
      lines.push(`可用重置券：${latestSnapshot.resetCreditsAvailable}`);
    for (const bucket of latestSnapshot.buckets ?? []) {
      if (!bucket.limitName || bucket.limitId === "codex") continue;
      lines.push(`${bucket.limitName}：剩余 ${bucket.remainingPercent}%`);
    }
    // 修改人：liujl
    // 修改时间：2026-07-21 15:10:12
    // 修改说明：data-tooltip 由 CSS 即时渲染，移除 title 可避免延迟出现的系统提示与自绘提示重叠。
    badge.dataset.tooltip = lines.join("\n");
    badge.removeAttribute("title");
  };

  /**
   * 确认锚点和徽标存在；React 重建侧栏后会在新账户按钮上重新挂载。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   */
  const ensure = () => {
    if (localStorage.getItem(ACTIVE_REVISION_KEY) !== revision) return;
    ensureStyle();
    const anchor = findAnchor();
    if (!anchor) {
      document.getElementById(BADGE_ID)?.remove();
      lastAnchorScore = null;
      return;
    }
    lastAnchorScore = anchor.score;
    let badge = document.getElementById(BADGE_ID);
    if (!badge) {
      badge = document.createElement("span");
      badge.id = BADGE_ID;
      badge.setAttribute("aria-hidden", "true");
    }
    if (badge.parentElement !== anchor.element)
      anchor.element.appendChild(badge);
    render(badge);
  };

  /**
   * 合并高频 DOM 变更，在下一帧只执行一次结构检查。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   */
  const scheduleEnsure = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      ensure();
    });
  };

  /**
   * 移除当前组件拥有的节点和监听器；preserveRevision 仅用于同版本热重装。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   *
   * @param {{preserveRevision?: boolean}} [options] 是否保留有效版本标记。
   */
  const remove = (options = {}) => {
    observer?.disconnect();
    if (timer) clearInterval(timer);
    document.getElementById(BADGE_ID)?.remove();
    document.getElementById(STYLE_ID)?.remove();
    if (!options.preserveRevision) localStorage.removeItem(ACTIVE_REVISION_KEY);
    if (window[STATE_KEY]?.revision === revision) delete window[STATE_KEY];
  };

  observer = new MutationObserver(scheduleEnsure);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  timer = setInterval(ensure, ENSURE_INTERVAL_MS);
  window[STATE_KEY] = {
    revision,
    /**
     * 接收宿主推送的最新标准化用量并立即刷新徽标。
     * 作者：liujl
     * 创建时间：2026-07-21 13:47:34
     */
    update(snapshot) {
      if (!snapshot || typeof snapshot !== "object")
        throw new TypeError("用量更新必须是对象");
      latestSnapshot = snapshot;
      ensure();
      return this.status();
    },
    /**
     * 返回当前挂载和数据状态，供状态命令做真实 DOM 验证。
     * 作者：liujl
     * 创建时间：2026-07-21 13:47:34
     */
    status() {
      return {
        active: true,
        revision,
        mounted: Boolean(document.getElementById(BADGE_ID)),
        anchorScore: lastAnchorScore,
        snapshotStatus: latestSnapshot.status,
      };
    },
    remove,
  };
  ensure();
}

/**
 * 生成可直接交给 Runtime.evaluate 或 early script 注册的自包含脚本。
 * 作者：liujl
 * 创建时间：2026-07-21 13:47:34
 *
 * @param {string} revision 当前运行版本。
 * @returns {string} 自执行 Renderer 脚本。
 */
export function buildWidgetSource(revision) {
  return `(${usageWidgetBootstrap.toString()})(${JSON.stringify(revision)});`;
}
