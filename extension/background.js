// 点击工具栏图标 → 在新标签页打开热力图界面
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("newtab.html") });
});
