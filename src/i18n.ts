import i18n from "i18next";
import { initReactI18next } from "react-i18next";
export const resources = {
	en: {
		translation: {
			settings: "Settings",
			language: "Interface language",
			debug: "OpenRouter debug logging (server terminal)",
			off: "Off",
			on: "On",
			close: "Close",
			retry: "Retry",
			debugReadFailed: "Unable to read logging settings. Please retry.",
			debugSaveFailed: "Unable to confirm logging settings. Please retry.",
			languageReadFailed: "Unable to read language settings. Please retry.",
			languageSaveFailed: "Unable to confirm language settings. Please retry.",
			loading: "Loading…",
		},
	},
	"zh-CN": {
		translation: {
			settings: "设置",
			language: "界面语言",
			debug: "OpenRouter 调试日志（服务端 terminal）",
			off: "关闭",
			on: "开启",
			close: "关闭",
			retry: "重试",
			debugReadFailed: "读取日志设置失败，请重试",
			debugSaveFailed: "无法确认日志设置，请重试",
			languageReadFailed: "读取语言设置失败，请重试",
			languageSaveFailed: "无法确认语言设置，请重试",
			loading: "加载中…",
		},
	},
};
await i18n.use(initReactI18next).init({
	resources,
	lng: "en",
	fallbackLng: "en",
	supportedLngs: ["en", "zh-CN"],
	interpolation: { escapeValue: false },
});
export default i18n;
