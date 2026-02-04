// options.js
// 管理选项页中的 Provider / 主题 / TTS 设置

const DEFAULT_SETTINGS = {
  provider: "auto",
  theme: "auto",
  ttsRate: 1.0,
  ttsVoice: "auto",
  showPronounce: true,
  autoPopupOnSelect: true
};

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

function $(id) {
  return document.getElementById(id);
}

function loadSettings() {
  chrome.storage.sync.get("settings", (result) => {
    if (chrome.runtime.lastError) {
      console.warn("读取设置失败", chrome.runtime.lastError);
    }

    const settings = normalizeSettings(result.settings || {});

    $("provider").value = settings.provider;
    $("theme").value = settings.theme;
    $("ttsRate").value = settings.ttsRate.toFixed(1);
    $("ttsRateValue").textContent = settings.ttsRate.toFixed(1);
    $("ttsVoice").value = settings.ttsVoice;
    $("showPronounce").checked = settings.showPronounce;
    $("autoPopupOnSelect").checked = settings.autoPopupOnSelect;
  });
}

function saveSettings() {
  const provider = $("provider").value;
  const theme = $("theme").value;
  const ttsRateRaw = parseFloat($("ttsRate").value);
  const ttsVoice = $("ttsVoice").value;
  const showPronounce = $("showPronounce").checked;
  const autoPopupOnSelect = $("autoPopupOnSelect").checked;

  let ttsRate = !Number.isNaN(ttsRateRaw) ? ttsRateRaw : 1.0;
  if (ttsRate < 0.8) ttsRate = 0.8;
  if (ttsRate > 1.2) ttsRate = 1.2;

  const settings = {
    provider,
    theme,
    ttsRate,
    ttsVoice,
    showPronounce,
    autoPopupOnSelect
  };

  chrome.storage.sync.set({ settings }, () => {
    const status = $("status");
    if (chrome.runtime.lastError) {
      status.textContent = "保存失败：" + chrome.runtime.lastError.message;
      status.style.color = "#b91c1c";
    } else {
      status.textContent = "设置已保存";
      status.style.color = "#059669";
      setTimeout(() => {
        status.textContent = "";
      }, 2000);
    }
  });
}

function bindEvents() {
  $("save").addEventListener("click", () => {
    saveSettings();
  });

  $("ttsRate").addEventListener("input", () => {
    const v = parseFloat($("ttsRate").value);
    $("ttsRateValue").textContent = v.toFixed(1);
  });
}

window.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  loadSettings();
});
