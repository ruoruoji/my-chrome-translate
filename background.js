// background.js - MV3 Service Worker
// 负责：
// 1. 接收内容脚本消息
// 2. 调用翻译 / 字典 API（跨域）
// 3. 维护内存缓存，减少重复请求

// 默认配置（与 options 同步，防御性兜底）
const DEFAULT_SETTINGS = {
  provider: "auto", // auto | libre | mymemory
  theme: "auto",    // 仅内容脚本使用，这里只透传
  ttsRate: 1.0,
  ttsVoice: "auto",   // auto | en-US | en-GB
  showPronounce: true
};

// 内存缓存（仅当前浏览器会话生效）
// 键："providerKey::text"
const translationCache = new Map();
// 键："DICT::word"
const dictCache = new Map();

// 读取用户设置（从 chrome.storage.sync），失败时使用默认值
function getUserSettings() {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get("settings", (result) => {
        if (chrome.runtime.lastError) {
          console.warn("读取设置失败，使用默认设置", chrome.runtime.lastError);
          resolve({ ...DEFAULT_SETTINGS });
          return;
        }
        const stored = result.settings || {};
        const settings = {
          provider: stored.provider || DEFAULT_SETTINGS.provider,
          theme: stored.theme || DEFAULT_SETTINGS.theme,
          ttsRate:
            typeof stored.ttsRate === "number" && !Number.isNaN(stored.ttsRate)
              ? stored.ttsRate
              : DEFAULT_SETTINGS.ttsRate,
          ttsVoice: stored.ttsVoice || DEFAULT_SETTINGS.ttsVoice,
          showPronounce:
            typeof stored.showPronounce === "boolean"
              ? stored.showPronounce
              : DEFAULT_SETTINGS.showPronounce
        };
        resolve(settings);
      });
    } catch (e) {
      console.error("读取设置出现异常", e);
      resolve({ ...DEFAULT_SETTINGS });
    }
  });
}

// 根据设置得到翻译 provider 调用顺序
function getProvidersOrder(providerSetting) {
  switch (providerSetting) {
    case "libre":
      return ["libre"];
    case "mymemory":
      return ["mymemory"];
    case "auto":
    default:
      return ["libre", "mymemory"]; // 默认：优先 LibreTranslate，失败回退 MyMemory
  }
}

// 调用 LibreTranslate 公共实例
async function translateWithLibre(text) {
  // 这里选择 libretranslate.de 公共实例
  const url = "https://libretranslate.de/translate";
  const payload = {
    q: text,
    source: "en",
    target: "zh",
    format: "text"
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error("LibreTranslate HTTP " + response.status);
  }

  const data = await response.json();
  // 不同公共实例字段可能略有差异，做兼容处理
  const translated = data.translatedText || data.translation || data.translated_text;
  if (!translated) {
    throw new Error("LibreTranslate 未返回翻译结果");
  }

  return {
    translation: translated,
    provider: "LibreTranslate"
  };
}

// 调用 MyMemory 翻译
async function translateWithMyMemory(text) {
  const url =
    "https://api.mymemory.translated.net/get?q=" +
    encodeURIComponent(text) +
    "&langpair=en|zh-CN";

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("MyMemory HTTP " + response.status);
  }

  const data = await response.json();
  let translated =
    data?.responseData?.translatedText ||
    (Array.isArray(data?.matches) && data.matches.length > 0
      ? data.matches[0].translation
      : "");

  if (!translated) {
    throw new Error("MyMemory 未返回翻译结果");
  }

  return {
    translation: translated,
    provider: "MyMemory"
  };
}

// 调用 Free Dictionary API 获取单词音标和音频
async function fetchDictionary(word) {
  const lower = word.toLowerCase();
  const url =
    "https://api.dictionaryapi.dev/api/v2/entries/en/" +
    encodeURIComponent(lower);

  const response = await fetch(url);

  if (!response.ok) {
    // 404 等视为无词典结果，不抛致命错误
    throw new Error("Dictionary HTTP " + response.status);
  }

  const data = await response.json();
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Dictionary 响应格式异常");
  }

  const entry = data[0] || {};
  const phonetics = Array.isArray(entry.phonetics) ? entry.phonetics : [];

  let ipa = "";
  let audio = "";

  // 优先找到带音标的记录
  for (const p of phonetics) {
    if (p && typeof p.text === "string" && p.text.trim()) {
      ipa = p.text.trim();
      break;
    }
  }

  // 再找一个可用的音频链接
  for (const p of phonetics) {
    if (p && typeof p.audio === "string" && p.audio.trim()) {
      audio = p.audio.trim();
      break;
    }
  }

  if (!ipa && !audio) {
    // 没有可用音标/音频时返回 null，让前端仅使用 TTS
    return null;
  }

  return {
    ipa: ipa || null,
    audio: audio || null
  };
}

// 统一处理翻译 + 字典
async function handleTranslateAndDefine(message) {
  const { text, isWord } = message;

  const settings = await getUserSettings();
  const order = getProvidersOrder(settings.provider);

  let translationResult = null;
  let lastError = null;

  // 按顺序尝试各个 Provider
  for (const providerKey of order) {
    const cacheKey = providerKey + "::" + text;
    if (translationCache.has(cacheKey)) {
      translationResult = translationCache.get(cacheKey);
      break;
    }

    try {
      let result = null;
      if (providerKey === "libre") {
        result = await translateWithLibre(text);
      } else if (providerKey === "mymemory") {
        result = await translateWithMyMemory(text);
      }

      if (result && result.translation) {
        translationCache.set(cacheKey, result);
        translationResult = result;
        break;
      }
    } catch (err) {
      console.warn("翻译 Provider 失败", providerKey, err);
      lastError = err;
      // 继续尝试下一个 Provider
    }
  }

  // 字典查询（仅当选择的是单词时才查）
  let dictResult = null;
  if (isWord) {
    const dictKey = "DICT::" + text.toLowerCase();
    if (dictCache.has(dictKey)) {
      dictResult = dictCache.get(dictKey);
    } else {
      try {
        const r = await fetchDictionary(text);
        if (r) {
          dictCache.set(dictKey, r);
          dictResult = r;
        }
      } catch (err) {
        console.warn("字典查询失败（忽略）", err);
        // 不阻断整体流程
      }
    }
  }

  if (!translationResult) {
    return {
      success: false,
      error: "翻译失败，请稍后重试。",
      provider: null,
      translation: null,
      dict: dictResult
    };
  }

  return {
    success: true,
    translation: translationResult.translation,
    provider: translationResult.provider,
    dict: dictResult || null
  };
}

// 监听来自内容脚本的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return; // 不是我们关心的消息
  }

  if (message.type === "TRANSLATE_AND_DEFINE") {
    handleTranslateAndDefine(message)
      .then((result) => {
        sendResponse(result);
      })
      .catch((err) => {
        console.error("处理 TRANSLATE_AND_DEFINE 失败", err);
        sendResponse({
          success: false,
          error: "翻译失败，请稍后重试。",
          provider: null,
          translation: null,
          dict: null
        });
      });

    // 声明将异步调用 sendResponse
    return true;
  }

  // 其他类型可在后续扩展
});
