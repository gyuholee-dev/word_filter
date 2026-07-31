/**
 * service_worker.js
 * ---------------------------------------------------------------------------
 * 역할은 두 가지뿐이다(가볍게 유지해야 서비스워커가 자주 깨지 않는다).
 *  1) content script 가 보고한 "숨긴 개수"를 확장 아이콘 배지에 표시한다.
 *  2) 최초 설치 시 기본 설정을 저장하고 옵션 화면을 한 번 열어 준다.
 */

// MV3 service worker(비모듈)는 importScripts 로 공용 스크립트를 불러올 수 있다.
importScripts('/src/shared/filter_settings_storage.js');

const { seedDefaultFilterSettingsIfMissing } = globalThis.wordFilterSettingsStorage;

const MESSAGE_TYPE = {
  REPORT_FILTERED_TARGET_COUNT: 'REPORT_FILTERED_TARGET_COUNT',
};

/**
 * 배지 색.
 * 강조 컬러를 "어두운 배경 위 텍스트"로 쓰면 파란색은 명암비가 부족해 배지 숫자가
 * 뭉개진다(9px 내외로 아주 작게 렌더링된다). 그래서 강조 컬러를 배경으로 쓰고
 * 숫자를 검정으로 얹어 명암비 4.76:1 을 확보했다.
 */
const BADGE_BACKGROUND_COLOR = '#2F7CF6';
const BADGE_TEXT_COLOR = '#101216';

/**
 * 탭 배지에 처리 개수를 표시한다. 0이면 배지를 비운다.
 * (opacity 모드는 숨긴 엘리먼트 수, 칠하기 모드는 칠한 단어 수)
 * @param {number} tabId
 * @param {number} filteredTargetCount
 */
async function updateBadgeForTab(tabId, filteredTargetCount) {
  const badgeText = filteredTargetCount > 0 ? String(Math.min(filteredTargetCount, 9999)) : '';
  try {
    await chrome.action.setBadgeText({ tabId, text: badgeText });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_BACKGROUND_COLOR });
    if (chrome.action.setBadgeTextColor) {
      await chrome.action.setBadgeTextColor({ tabId, color: BADGE_TEXT_COLOR });
    }
  } catch {
    /* 탭이 이미 닫힌 경우 등은 무시 */
  }
}

chrome.runtime.onMessage.addListener((requestMessage, sender) => {
  if (requestMessage?.type !== MESSAGE_TYPE.REPORT_FILTERED_TARGET_COUNT) return false;
  if (typeof sender.tab?.id !== 'number') return false;
  updateBadgeForTab(sender.tab.id, Number(requestMessage.filteredTargetCount) || 0);
  return false;
});

// 페이지를 새로 열면 이전 카운트가 남지 않도록 배지를 비운다.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') updateBadgeForTab(tabId, 0);
});

chrome.runtime.onInstalled.addListener(async (installDetails) => {
  // 저장된 설정이 없을 때만 기본값을 넣는다.
  // 여기서 무조건 다시 쓰면 사용자가 맞춰 둔 설정이 덮어써질 수 있다.
  await seedDefaultFilterSettingsIfMissing();

  if (installDetails.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});
