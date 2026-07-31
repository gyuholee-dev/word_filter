/**
 * theme_preference.js
 * ---------------------------------------------------------------------------
 * 저장된 테마 설정을 문서에 반영한다. 설정 화면·팝업·패턴 편집 페이지가 함께 쓴다.
 *
 * 실제 색 전환은 theme.css 가 <html> 의 data-theme 속성을 보고 처리한다.
 * 이 모듈은 속성을 붙이고 떼는 일만 한다.
 *
 * data-theme 없음(= system) 이면 CSS 의 prefers-color-scheme 규칙이 그대로 동작하므로,
 * 시스템 설정 따르기가 기본이 된다.
 */
(() => {
  if (globalThis.wordFilterThemePreference) return;

  const { THEME_PREFERENCE, FILTER_SETTINGS_STORAGE_KEY, normalizeFilterSettings, loadFilterSettings } =
    globalThis.wordFilterSettingsStorage;

  /**
   * 테마 설정을 문서에 적용한다.
   * @param {string} themePreference
   */
  function applyThemePreference(themePreference) {
    const rootElement = document.documentElement;
    if (themePreference === THEME_PREFERENCE.SYSTEM) {
      rootElement.removeAttribute('data-theme');
      return;
    }
    rootElement.setAttribute('data-theme', themePreference);
  }

  /**
   * 저장된 테마를 즉시 적용하고, 이후 변경도 따라가게 한다.
   * 한 화면에서 테마를 바꾸면 열려 있는 다른 화면도 함께 바뀐다.
   */
  function startFollowingThemePreference() {
    loadFilterSettings().then((settings) => applyThemePreference(settings.themePreference));

    chrome.storage.onChanged.addListener((changeMap, areaName) => {
      if (areaName !== 'sync' || !changeMap[FILTER_SETTINGS_STORAGE_KEY]) return;
      const settings = normalizeFilterSettings(changeMap[FILTER_SETTINGS_STORAGE_KEY].newValue);
      applyThemePreference(settings.themePreference);
    });
  }

  globalThis.wordFilterThemePreference = { applyThemePreference, startFollowingThemePreference };
})();
