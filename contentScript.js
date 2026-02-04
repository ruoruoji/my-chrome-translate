// contentScript.js
// 负责：
// 1. 监听页面双击，读取选中文本并判断是否为英文
// 2. 通过消息与 background 通信获取翻译和字典信息
// 3. 在页面上创建 Shadow DOM 浮层，展示翻译、发音和来源
// 4. 使用 Web Speech API 播放 TTS，失败时回退到字典音频

// 默认设置，与 background / options 对应
const DEFAULT_SETTINGS = {
  provider: "auto",
  theme: "auto", // light | dark | auto
  ttsRate: 1.0,
  ttsVoice: "auto", // auto | en-US | en-GB
  showPronounce: true,
  autoPopupOnSelect: true
};

let userSettings = { ...DEFAULT_SETTINGS };

// TTS 相关状态
const speechSupported =
  typeof window !== "undefined" &&
  "speechSynthesis" in window &&
  typeof window.SpeechSynthesisUtterance === "function";

let voices = [];
let voicesLoaded = false;

// 当前浮层数据（用于复制与播放）
let currentData = {
  text: "",
  translation: "",
  provider: "",
  ipa: null,
  audio: null
};

// 浮层相关 DOM 与 ShadowRoot 引用
let hostElement = null; // 挂在 document.body 下的宿主元素
let shadowRoot = null;
let ui = {
  wrapper: null,
  overlay: null,
  headerText: null,
  btnCopy: null,
  btnClose: null,
  translation: null,
  translationLabel: null,
  pronunciation: null,
  btnPlay: null,
  ipa: null,
  provider: null,
  error: null
};

let systemDarkMedia = null;

// 音频回退元素（播放字典音频）
let audioElement = null;

// 最近一次用于定位的选区矩形与事件坐标
// - 优先使用 range.getClientRects() 中“最后一个可见片段”作为浮层锚点
// - 若矩形无效，则回退到 range.getBoundingClientRect()，再回退到双击事件的 clientX/clientY
let lastSelectionRect = null;
let lastClickClientX = 0;
let lastClickClientY = 0;

// 最近一次触发翻译的时间与文本，用于防止短时间内重复触发
let lastTriggerAt = 0;
let lastTriggerText = "";
// 当前最新翻译请求的自增编号，用于丢弃过期响应
let currentRequestId = 0;

// 初始化逻辑
initSettings();
initVoices();
setupGlobalListeners();

// ------------------ 设置与主题 ------------------

function initSettings() {
  try {
    chrome.storage.sync.get("settings", (result) => {
      if (chrome.runtime.lastError) {
        console.warn("内容脚本读取设置失败，使用默认值", chrome.runtime.lastError);
        userSettings = { ...DEFAULT_SETTINGS };
        return;
      }
      userSettings = normalizeSettings(result.settings || {});
      applyTheme();
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync" && changes.settings) {
        userSettings = normalizeSettings(changes.settings.newValue || {});
        applyTheme();
      }
    });
  } catch (e) {
    console.error("内容脚本读取设置出现异常", e);
    userSettings = { ...DEFAULT_SETTINGS };
  }

  if (window.matchMedia) {
    systemDarkMedia = window.matchMedia("(prefers-color-scheme: dark)");
    systemDarkMedia.addEventListener("change", () => {
      applyTheme();
    });
  }
}

function normalizeSettings(raw) {
  return {
    provider: raw.provider || DEFAULT_SETTINGS.provider,
    theme: raw.theme || DEFAULT_SETTINGS.theme,
    ttsRate:
      typeof raw.ttsRate === "number" && !Number.isNaN(raw.ttsRate)
        ? raw.ttsRate
        : DEFAULT_SETTINGS.ttsRate,
    ttsVoice: raw.ttsVoice || DEFAULT_SETTINGS.ttsVoice,
    showPronounce:
      typeof raw.showPronounce === "boolean"
        ? raw.showPronounce
        : DEFAULT_SETTINGS.showPronounce,
    autoPopupOnSelect:
      typeof raw.autoPopupOnSelect === "boolean"
        ? raw.autoPopupOnSelect
        : DEFAULT_SETTINGS.autoPopupOnSelect
  };
}

function getEffectiveTheme() {
  const t = userSettings.theme || "auto";
  if (t === "light" || t === "dark") return t;
  if (systemDarkMedia && systemDarkMedia.matches) return "dark";
  return "light";
}

function applyTheme() {
  ensureOverlayCreated();
  if (!ui.overlay) return;

  ui.overlay.classList.remove("dtp-theme-light", "dtp-theme-dark");
  const theme = getEffectiveTheme();
  ui.overlay.classList.add(
    theme === "dark" ? "dtp-theme-dark" : "dtp-theme-light"
  );
}

// ------------------ 语音（TTS） ------------------

function initVoices() {
  if (!speechSupported) return;

  function loadVoices() {
    const list = window.speechSynthesis.getVoices();
    if (Array.isArray(list) && list.length > 0) {
      voices = list;
      voicesLoaded = true;
    }
  }

  loadVoices();

  // 某些浏览器需要等待 voiceschanged 事件才有语音列表
  window.speechSynthesis.onvoiceschanged = () => {
    loadVoices();
  };
}

function getPreferredVoice() {
  if (!voicesLoaded || !voices.length) return null;

  const pref = userSettings.ttsVoice || "auto";

  const candidates = [];
  if (pref === "en-US" || pref === "en-GB") {
    candidates.push((v) => v.lang === pref);
  }
  // 退而求其次：任何英文语音
  candidates.push((v) => v.lang && v.lang.toLowerCase().startsWith("en"));

  for (const check of candidates) {
    const voice = voices.find(check);
    if (voice) return voice;
  }

  return null;
}

function handlePlayClick() {
  if (!currentData || !currentData.text) return;

  const text = currentData.text;

  // 针对全大写缩略词（2~10 位），按字母逐个朗读
  let speakText = text;
  if (/^[A-Z]{2,10}$/.test(text)) {
    speakText = text.split("").join(" ");
  }

  // 优先尝试 Web Speech API TTS
  if (speechSupported) {
    try {
      const utterance = new window.SpeechSynthesisUtterance(speakText);
      const rate =
        typeof userSettings.ttsRate === "number" && !Number.isNaN(userSettings.ttsRate)
          ? userSettings.ttsRate
          : 1.0;
      utterance.rate = rate;

      const preferredVoice = getPreferredVoice();
      if (preferredVoice) {
        utterance.voice = preferredVoice;
        if (preferredVoice.lang) {
          utterance.lang = preferredVoice.lang;
        }
      } else {
        // 没有匹配到时，按设置大类选择
        utterance.lang =
          userSettings.ttsVoice === "en-GB"
            ? "en-GB"
            : "en-US";
      }

      utterance.onerror = (event) => {
        console.warn("TTS 播放出错，尝试回退到字典音频", event);
        if (currentData.audio) {
          playDictionaryAudio(currentData.audio);
        }
      };

      // 若已有语音播放，先取消以避免重叠
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
      return;
    } catch (e) {
      console.warn("TTS 调用失败，尝试回退到字典音频", e);
    }
  }

  // 回退到字典音频
  if (currentData.audio) {
    playDictionaryAudio(currentData.audio);
  } else {
    console.warn("无可用音频用于播放");
  }
}

function playDictionaryAudio(url) {
  try {
    if (!audioElement) {
      audioElement = document.createElement("audio");
      audioElement.style.display = "none";
      document.documentElement.appendChild(audioElement);
    }
    audioElement.src = url;
    audioElement.play().catch((err) => {
      console.warn("播放字典音频失败", err);
    });
  } catch (e) {
    console.warn("创建/播放音频元素失败", e);
  }
}

// ------------------ 浮层 UI 与 Shadow DOM ------------------

function ensureOverlayCreated() {
  if (hostElement && shadowRoot && ui.wrapper) return;

  hostElement = document.createElement("div");
  hostElement.id = "dtp-overlay-host";
  hostElement.style.position = "fixed";
  hostElement.style.top = "0";
  hostElement.style.left = "0";
  hostElement.style.zIndex = "2147483647"; // 最高层级，尽量不被页面覆盖
  hostElement.style.pointerEvents = "none"; // 由内部元素决定是否可点击

  shadowRoot = hostElement.attachShadow({ mode: "open" });

  // 注入独立样式，避免与宿主页面冲突
  const linkEl = document.createElement("link");
  linkEl.rel = "stylesheet";
  linkEl.href = chrome.runtime.getURL("overlay.css");
  shadowRoot.appendChild(linkEl);

  const wrapper = document.createElement("div");
  wrapper.className = "dtp-wrapper dtp-hidden"; // 默认隐藏
  wrapper.style.pointerEvents = "auto";
  wrapper.style.display = "none";

  wrapper.innerHTML = `
    <div class="dtp-overlay dtp-theme-light">
      <button class="dtp-close" type="button" aria-label="关闭">×</button>
      <div class="dtp-header">
        <div class="dtp-header-text" title=""></div>
      </div>
      <div class="dtp-body">
        <div class="dtp-translation-label">中文翻译</div>
        <div class="dtp-translation" data-placeholder="正在翻译..."></div>
        <div class="dtp-pronunciation">
          <span class="dtp-ipa"></span>
        </div>
        <div class="dtp-actions">
          <button class="dtp-action-btn dtp-action-copy" type="button">复制原文</button>
          <button class="dtp-action-btn dtp-action-play" type="button">▶ 播放</button>
        </div>
        <div class="dtp-provider"></div>
        <div class="dtp-error"></div>
      </div>
    </div>
  `;

  shadowRoot.appendChild(wrapper);
  document.documentElement.appendChild(hostElement);

  ui.wrapper = wrapper;
  ui.overlay = wrapper.querySelector(".dtp-overlay");
  ui.headerText = wrapper.querySelector(".dtp-header-text");
  ui.translationLabel = wrapper.querySelector(".dtp-translation-label");
  ui.translation = wrapper.querySelector(".dtp-translation");
  ui.pronunciation = wrapper.querySelector(".dtp-pronunciation");
  ui.ipa = wrapper.querySelector(".dtp-ipa");
  ui.provider = wrapper.querySelector(".dtp-provider");
  ui.error = wrapper.querySelector(".dtp-error");
  ui.btnCopy = wrapper.querySelector(".dtp-action-copy");
  ui.btnClose = wrapper.querySelector(".dtp-close");
  ui.btnPlay = wrapper.querySelector(".dtp-action-play");

  // 阻止浮层内部点击向页面冒泡，用于实现点击外部关闭
  wrapper.addEventListener("mousedown", (e) => {
    e.stopPropagation();
  });

  // 复制按钮
  ui.btnCopy.addEventListener("click", () => {
    if (!currentData.text) return;
    const text = currentData.text;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch((err) => {
        console.warn("使用 Clipboard API 复制失败，尝试回退方法", err);
        fallbackCopyText(text);
      });
    } else {
      fallbackCopyText(text);
    }
  });

  // 关闭按钮
  ui.btnClose.addEventListener("click", () => {
    hideOverlay();
  });

  // 播放按钮
  ui.btnPlay.addEventListener("click", () => {
    handlePlayClick();
  });

  applyTheme();
}

function fallbackCopyText(text) {
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  } catch (e) {
    console.warn("回退复制方式失败", e);
  }
}

// 根据选区矩形或事件坐标定位浮层
// 定位策略：
// 1. 优先使用 selection range.getClientRects() 中“最后一个宽高>0 的 rect”作为锚点，
//    在其下方（bottom + 8px）展示浮层，并以矩形水平居中对齐。
// 2. 若 getClientRects() 无效，再回退到 range.getBoundingClientRect()；仍无效时回退到双击事件的 clientX/clientY。
// 3. 通过浮层自身尺寸做左右/上下边界约束，保证浮层始终在视口内预留 margin。
// 4. 为避免初始 (0,0) 闪烁，计算位置时保持 .dtp-hidden，先设置 left/top 再移除 .dtp-hidden。
function showOverlayAtRect(anchorRect, fallbackClientX, fallbackClientY, options) {
  ensureOverlayCreated();
  if (!ui.wrapper || !ui.overlay) return;

  const opts = options || {};
  const initialShow = !!opts.initial;

  const applyPosition = () => {
    const overlayRect = ui.wrapper.getBoundingClientRect();
    const margin = 8;

    let left;
    let top;

    // 优先使用选区矩形作为锚点
    if (
      anchorRect &&
      typeof anchorRect.left === "number" &&
      typeof anchorRect.right === "number" &&
      typeof anchorRect.top === "number" &&
      typeof anchorRect.bottom === "number"
    ) {
      const width =
        typeof anchorRect.width === "number"
          ? anchorRect.width
          : Math.max(0, anchorRect.right - anchorRect.left);
      const centerX = anchorRect.left + width / 2;
      left = centerX - overlayRect.width / 2;
      top = anchorRect.bottom + margin; // 优先放在选区下方
    } else {
      // 矩形无效时回退到事件坐标
      const baseX =
        typeof fallbackClientX === "number" ? fallbackClientX : window.innerWidth / 2;
      const baseY =
        typeof fallbackClientY === "number" ? fallbackClientY : window.innerHeight / 2;

      left = baseX - overlayRect.width / 2;
      top = baseY + margin;
    }

    // 边界约束：保证浮层不超出视口
    const minLeft = margin;
    const maxLeft = window.innerWidth - overlayRect.width - margin;
    if (!Number.isNaN(maxLeft)) {
      if (left < minLeft) left = minLeft;
      if (left > maxLeft) left = Math.max(minLeft, maxLeft);
    }

    const minTop = margin;
    const maxTop = window.innerHeight - overlayRect.height - margin;
    if (!Number.isNaN(maxTop)) {
      if (top < minTop) top = minTop;
      if (top > maxTop) top = Math.max(minTop, maxTop);
    }

    ui.wrapper.style.left = left + "px";
    ui.wrapper.style.top = top + "px";
  };

  if (initialShow) {
    // 初次展示：保持 .dtp-hidden，避免在 (0,0) 的短暂闪烁
    ui.wrapper.classList.add("dtp-hidden");
    ui.wrapper.style.visibility = "hidden";
    ui.wrapper.style.opacity = "0";

    // 使用 rAF 确保 DOM 内容（例如“正在翻译...”）已参与布局后再计算尺寸
    requestAnimationFrame(() => {
      // 从 display:none 恢复为可见，以便正确计算尺寸
      ui.wrapper.style.display = "block";
      applyPosition();

      // 位置计算完毕后再显示
      ui.wrapper.classList.remove("dtp-hidden");
      ui.wrapper.style.visibility = "visible";
      ui.wrapper.style.opacity = "1";
    });
  } else {
    // 已经显示时的重定位：只调整 left/top，不动可见性，避免闪烁
    requestAnimationFrame(() => {
      applyPosition();
    });
  }
}

function hideOverlay() {
  if (!ui.wrapper) return;
  ui.wrapper.classList.add("dtp-hidden");
  ui.wrapper.style.display = "none";

  // 停止当前所有语音播放，避免残留朗读
  if (speechSupported) {
    try {
      window.speechSynthesis.cancel();
    } catch (e) {
      console.warn("停止语音朗读失败", e);
    }
  }

  // 清空当前数据，避免后续误显示旧数据
  currentData = {
    text: "",
    translation: "",
    provider: "",
    ipa: null,
    audio: null
  };
}

function updateOverlayLoading(text) {
  ensureOverlayCreated();
  if (!ui.overlay) return;

  currentData = {
    text,
    translation: "",
    provider: "",
    ipa: null,
    audio: null
  };

  const displayText = text.length > 80 ? text.slice(0, 77) + "..." : text;

  ui.headerText.textContent = displayText;
  ui.headerText.title = text;

  if (ui.translationLabel) {
    ui.translationLabel.textContent = "中文翻译";
  }

  ui.translation.textContent = "正在翻译...";
  ui.error.textContent = "";
  ui.provider.textContent = "";

  const enablePronounce = !!userSettings.showPronounce;

  if (ui.ipa) {
    ui.ipa.textContent = "";
  }
  if (ui.pronunciation) {
    ui.pronunciation.style.display = enablePronounce ? "block" : "none";
  }
  if (ui.btnPlay) {
    ui.btnPlay.style.display = enablePronounce ? "flex" : "none";
    ui.btnPlay.disabled = !enablePronounce;
  }
}

function updateOverlaySuccess(text, payload) {
  ensureOverlayCreated();
  if (!ui.overlay) return;

  currentData = {
    text,
    translation: payload.translation || "",
    provider: payload.provider || "",
    ipa: payload.dict && payload.dict.ipa ? payload.dict.ipa : null,
    audio: payload.dict && payload.dict.audio ? payload.dict.audio : null
  };

  const displayText = text.length > 80 ? text.slice(0, 77) + "..." : text;

  ui.headerText.textContent = displayText;
  ui.headerText.title = text;

  if (ui.translationLabel) {
    ui.translationLabel.textContent = "中文翻译";
  }

  ui.translation.textContent = currentData.translation || "(无翻译结果)";
  ui.error.textContent = "";

  if (currentData.provider) {
    ui.provider.textContent = "翻译来源：" + currentData.provider;
  } else {
    ui.provider.textContent = "";
  }

  const enablePronounce = !!userSettings.showPronounce;

  if (ui.pronunciation) {
    ui.pronunciation.style.display = enablePronounce ? "block" : "none";
  }
  if (ui.ipa) {
    ui.ipa.textContent = currentData.ipa || "";
  }

  if (ui.btnPlay) {
    ui.btnPlay.style.display = enablePronounce ? "flex" : "none";
    ui.btnPlay.disabled = !enablePronounce;
  }

  applyTheme();
}

function updateOverlayFailure(text, errorMessage) {
  ensureOverlayCreated();
  if (!ui.overlay) return;

  currentData = {
    text,
    translation: "",
    provider: "",
    ipa: null,
    audio: null
  };

  const displayText = text.length > 80 ? text.slice(0, 77) + "..." : text;
  ui.headerText.textContent = displayText;
  ui.headerText.title = text;

  if (ui.translationLabel) {
    ui.translationLabel.textContent = "中文翻译";
  }

  ui.translation.textContent = "翻译失败，请稍后重试。";
  ui.error.textContent = errorMessage || "接口不可用，已回退/请稍后重试";
  ui.provider.textContent = "";

  const enablePronounce = !!userSettings.showPronounce;

  if (ui.ipa) {
    ui.ipa.textContent = "";
  }
  if (ui.pronunciation) {
    ui.pronunciation.style.display = enablePronounce ? "block" : "none";
  }
  if (ui.btnPlay) {
    ui.btnPlay.style.display = enablePronounce ? "flex" : "none";
    ui.btnPlay.disabled = !enablePronounce;
  }

  applyTheme();
}

// ------------------ 双击监听与英文判定 ------------------

function setupGlobalListeners() {
  // 监听双击事件
  document.addEventListener(
    "dblclick",
    (event) => {
      handleDoubleClick(event);
    },
    false
  );

  // 鼠标抬起时（结束划词）根据设置自动弹出
  document.addEventListener(
    "mouseup",
    (event) => {
      handleMouseUpForSelection(event);
    },
    false
  );

  // 点击页面其他区域时关闭浮层（捕获阶段 click + composedPath 判断是否命中浮层）
  document.addEventListener(
    "click",
    (event) => {
      if (!ui.wrapper || !hostElement) return;

      const path =
        typeof event.composedPath === "function" ? event.composedPath() : null;

      if (path) {
        if (path.includes(hostElement) || path.includes(ui.wrapper)) {
          // 点击在浮层内部，忽略
          return;
        }
      } else {
        // 退化处理：通过 target.contains 判断
        if (
          hostElement.contains(event.target) ||
          (ui.wrapper && ui.wrapper.contains(event.target))
        ) {
          return;
        }
      }

      hideOverlay();
    },
    true
  );

  // ESC 关闭
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideOverlay();
    }
  });
}

function handleDoubleClick(event) {
  triggerTranslateFromSelection(event);
}

function handleMouseUpForSelection(event) {
  try {
    // 若点击发生在浮层内部（包括 Shadow DOM），不触发“划词自动弹出”
    if (hostElement && ui.wrapper) {
      const path =
        typeof event.composedPath === "function" ? event.composedPath() : null;

      if (path) {
        if (path.includes(hostElement) || path.includes(ui.wrapper)) {
          return;
        }
      } else if (
        hostElement.contains(event.target) ||
        ui.wrapper.contains(event.target)
      ) {
        return;
      }
    }

    // 仅在开启“划词自动弹出”时生效
    if (!userSettings.autoPopupOnSelect) {
      return;
    }

    // 只处理左键
    if (event.button !== 0) return;

    // 双击/多击场景由 dblclick 处理，这里避免重复触发
    if (event.detail && event.detail > 1) {
      return;
    }

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      return;
    }

    const newText = selection.toString().trim();
    // 选区为空，不触发自动弹出
    if (!newText) {
      return;
    }

    // 文本未变化：不再触发自动弹出（保持当前选区但不重复弹窗）
    if (newText === lastTriggerText) {
      return;
    }

    // 可选增强：比较当前选区矩形与上次矩形是否几乎相同
    let selectionRect = null;
    try {
      if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        const r = range.getBoundingClientRect && range.getBoundingClientRect();
        if (r && !(r.width === 0 && r.height === 0 && r.top === 0 && r.left === 0)) {
          selectionRect = {
            left: r.left,
            top: r.top,
            right: r.right,
            bottom: r.bottom,
            width: r.width,
            height: r.height
          };
        }
      }
    } catch (err) {
      console.warn("获取选区矩形用于对比失败", err);
    }

    if (isRectAlmostSame(selectionRect, lastSelectionRect, 2)) {
      return;
    }

    triggerTranslateFromSelection(event);
  } catch (e) {
    console.error("处理划词 mouseup 事件出错", e);
  }
}

function triggerTranslateFromSelection(anchorEvent) {
  try {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      return;
    }

    const text = selection.toString().trim();
    if (!text) return;

    if (!isProbablyEnglish(text)) {
      // 非英文，直接忽略
      return;
    }

    const now = Date.now();
    if (text === lastTriggerText && now - lastTriggerAt < 300) {
      // 短时间内对同一选区重复触发，直接跳过
      return;
    }
    lastTriggerText = text;
    lastTriggerAt = now;

    const isWord = isSingleWord(text);

    // 使用选区矩形作为浮层定位锚点：
    // 1. 优先使用 range.getClientRects() 中“最后一个可见片段”的 rect
    // 2. getClientRects 无效时回退到 range.getBoundingClientRect()
    let rect = null;
    try {
      if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);

        // 优先：从 getClientRects() 尾部开始找一个 width>0 && height>0 的片段，尽量贴近用户结束选择的位置
        const clientRects = range.getClientRects && range.getClientRects();
        if (clientRects && clientRects.length > 0) {
          for (let i = clientRects.length - 1; i >= 0; i -= 1) {
            const cr = clientRects[i];
            if (cr && cr.width > 0 && cr.height > 0) {
              rect = {
                left: cr.left,
                top: cr.top,
                right: cr.right,
                bottom: cr.bottom,
                width: cr.width,
                height: cr.height
              };
              break;
            }
          }
        }

        // 回退：getClientRects 得不到有效 rect 时，使用 getBoundingClientRect()
        if (!rect) {
          const r = range.getBoundingClientRect && range.getBoundingClientRect();
          // 某些情况下未真正选中文本时 width/height 可能为 0，这里认为是无效矩形
          if (r && !(r.width === 0 && r.height === 0 && r.top === 0 && r.left === 0)) {
            rect = {
              left: r.left,
              top: r.top,
              right: r.right,
              bottom: r.bottom,
              width: r.width,
              height: r.height
            };
          }
        }
      }
    } catch (e) {
      console.warn("获取选区矩形失败，将回退到事件坐标", e);
    }

    // 缓存本次锚点信息，供翻译完成后再次定位使用
    lastSelectionRect = rect;
    lastClickClientX = anchorEvent.clientX;
    lastClickClientY = anchorEvent.clientY;

    // 每次触发新的翻译请求前，先停止当前语音播放，避免播放残留
    if (speechSupported) {
      try {
        window.speechSynthesis.cancel();
      } catch (e) {
        console.warn("停止语音朗读失败", e);
      }
    }

    const requestId = ++currentRequestId;

    updateOverlayLoading(text);
    // 初次展示时，根据选区矩形定位；若矩形无效，在函数内部回退到事件坐标
    showOverlayAtRect(lastSelectionRect, lastClickClientX, lastClickClientY, {
      initial: true
    });

    chrome.runtime.sendMessage(
      {
        type: "TRANSLATE_AND_DEFINE",
        text,
        isWord
      },
      (response) => {
        // 若期间用户已经触发了新的翻译请求，则当前响应视为过期，不再更新 UI
        if (requestId !== currentRequestId) {
          return;
        }

        if (chrome.runtime.lastError) {
          console.warn("发送消息失败", chrome.runtime.lastError);
          updateOverlayFailure(text, "翻译失败，请稍后重试。");
          return;
        }

        if (!response || !response.success) {
          updateOverlayFailure(text, response && response.error);
        } else {
          updateOverlaySuccess(text, response);
        }

        // 翻译完成后再次基于同一锚点定位，适配内容高度变化
        showOverlayAtRect(lastSelectionRect, lastClickClientX, lastClickClientY, {
          initial: false
        });
      }
    );
  } catch (e) {
    console.error("处理选区触发事件出错", e);
  }
}

function isRectAlmostSame(a, b, threshold) {
  if (!a || !b) return false;

  const t =
    typeof threshold === "number" && !Number.isNaN(threshold) ? threshold : 0;

  return (
    Math.abs(a.left - b.left) <= t &&
    Math.abs(a.top - b.top) <= t &&
    Math.abs(a.right - b.right) <= t &&
    Math.abs(a.bottom - b.bottom) <= t
  );
}

// 简单英文判定：去除空白和常见标点后，A-Z 字母占比 > 60% 视为英文
function isProbablyEnglish(text) {
  const cleaned = text.replace(/[\s,，。.!?？:：;；"'“”'()（）\[\]{}]/g, "");
  if (!cleaned) return false;

  const letters = (cleaned.match(/[A-Za-z]/g) || []).length;
  const total = cleaned.length;
  if (total === 0) return false;

  const ratio = letters / total;
  return letters > 0 && ratio >= 0.6;
}

// 判断是否为“单词”（不含空格，仅由字母/连字符/撇号组成）
function isSingleWord(text) {
  return /^[A-Za-z][A-Za-z\-']*$/.test(text.trim());
}
