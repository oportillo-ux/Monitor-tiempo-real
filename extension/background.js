// Recarga cada 15 min las pestañas del portal donde se detectaron rutas.
const ALARM = 'bdb-refresh';
const PERIOD_MIN = 15;

function ensureAlarm() {
  chrome.alarms.get(ALARM, (a) => {
    if (!a) chrome.alarms.create(ALARM, { delayInMinutes: PERIOD_MIN, periodInMinutes: PERIOD_MIN });
  });
}

chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
ensureAlarm();

async function getTabs() {
  const { tabs = {} } = await chrome.storage.local.get('tabs');
  return tabs;
}

async function reloadRegisteredTabs() {
  const tabs = await getTabs();
  for (const id of Object.keys(tabs)) {
    try {
      await chrome.tabs.reload(Number(id));
    } catch {
      delete tabs[id];
    }
  }
  await chrome.storage.local.set({ tabs });
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) reloadRegisteredTabs();
});

chrome.tabs.onRemoved.addListener(async (id) => {
  const tabs = await getTabs();
  if (tabs[id]) {
    delete tabs[id];
    await chrome.storage.local.set({ tabs });
  }
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'register' && sender.tab) {
    getTabs().then((tabs) => {
      tabs[sender.tab.id] = msg.station;
      chrome.storage.local.set({ tabs }).then(() => reply(true));
    });
    return true;
  }
  if (msg.type === 'nextRefresh') {
    chrome.alarms.get(ALARM, (a) => reply(a ? a.scheduledTime : null));
    return true;
  }
  if (msg.type === 'openDashboard') {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  }
  if (msg.type === 'refreshAll') {
    // Reinicia el ciclo de 15 min desde ahora.
    chrome.alarms.clear(ALARM, () => {
      chrome.alarms.create(ALARM, { delayInMinutes: PERIOD_MIN, periodInMinutes: PERIOD_MIN });
      reloadRegisteredTabs().then(() => reply(true));
    });
    return true;
  }
});
