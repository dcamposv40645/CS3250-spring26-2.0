/**
 * @file background.js
 * @description
 * Background service worker for the Anonymous Theme Switcher extension.
 *
 * Responsibilities:
 * - Store and retrieve theme group data via browser.storage.local.
 * - Handle messages from the popup (getState, setActiveGroup, next).
 * - Populate default data on first install.
 *
 * @requires browser.storage.local
 * @requires browser.alarms
 * @requires browser.tabs
 * @requires browser.runtime
 */

// Storage key constants so we dont have to type strings everywhere
/** @type {{ GROUPS: string, ACTIVE_GROUP: string, CURRENT_INDEX: string }} */
const STORAGE_KEYS = {
	GROUPS: 'groups',
	ACTIVE_GROUP: 'activeGroupId',
	CURRENT_INDEX: 'currentIndex'
};

// Default sample data (used on install)
const DEFAULT_GROUPS = [
	{ id: 'g-default', name: 'Sample', images: [], intervalMs: 60000 }
];

/**
 * Retrieves one or more values from browser local storage.
 *
 * @async
 * @param {string[]} keys - Array of storage keys to retrieve.
 * @returns {Promise<Object>} Resolves with an object containing the requested key/value pairs.
 */
async function getStorage(keys) {
	const res = await browser.storage.local.get(keys);
	return res;
}

/**
 * Saves one or more values to browser local storage.
 *
 * @async
 * @param {Object} obj - Key/value pairs to store.
 * @returns {Promise<void>} Resolves after the data has been saved.
 */
async function setStorage(obj) {
	await browser.storage.local.set(obj);
}

/**
 * Calculates the next image index for a group, wrapping around at the end.
 *
 * @param {number} current - The current image index.
 * @param {number} length - The total number of images in the group.
 * @returns {number} The next index to display.
 */
function nextIndex(current, length) {
	if (length === 0) return 0;
	return (current + 1) % length;
}

/**
 * Sends a setBackground message to all open tabs.
 * Tabs without the content script will silently ignore it.
 *
 * @async
 * @param {string} url - The image URL to set as the background.
 * @returns {Promise<void>} Resolves after messaging all tabs.
 */
async function broadcastSetBackground(url) {
	const tabs = await browser.tabs.query({});
	for (const t of tabs) {
		try {
			await browser.tabs.sendMessage(t.id, { type: 'setBackground', url });
		} catch (_err) {
			// ignore tabs that don't have the content script
		}
	}
}

// Handle alarms - cycle active group's image
browser.alarms.onAlarm.addListener(async (alarm) => {
	if (alarm && alarm.name === 'cycle') {
		const store = await getStorage([STORAGE_KEYS.GROUPS, STORAGE_KEYS.ACTIVE_GROUP, STORAGE_KEYS.CURRENT_INDEX]);
		const groups = store[STORAGE_KEYS.GROUPS] || [];
		const activeId = store[STORAGE_KEYS.ACTIVE_GROUP];
		const idxMap = store[STORAGE_KEYS.CURRENT_INDEX] || {};
		const group = groups.find(g => g.id === activeId);
		if (!group || !group.images || group.images.length === 0) return;
		const cur = idxMap[activeId] || 0;
		const next = nextIndex(cur, group.images.length);
		idxMap[activeId] = next;
		await setStorage({ [STORAGE_KEYS.CURRENT_INDEX]: idxMap });
		const url = group.images[next];
		await broadcastSetBackground(url);
	}
});

/**
 * Listens for messages from the popup or content scripts.
 *
 * Supported message types:
 * - `getState` — returns the full current state from storage.
 * - `setActiveGroup` — switches the active group and resets the alarm.
 * - `next` — manually advances to the next image in the active group.
 *
 * @param {Object} msg - The message object sent from the popup or content script.
 * @param {string} msg.type - The message type ('getState' | 'setActiveGroup' | 'next').
 * @param {Object} sender - Info about the sender (tab, extension, etc).
 * @returns {Promise<Object|undefined>} Resolves with a response object or undefined.
 */
browser.runtime.onMessage.addListener((msg, _sender) => {
	return (async () => {
		if (!msg || !msg.type) return;
		if (msg.type === 'getState') {
			const store = await getStorage([STORAGE_KEYS.GROUPS, STORAGE_KEYS.ACTIVE_GROUP, STORAGE_KEYS.CURRENT_INDEX]);
			return store;
		}

		if (msg.type === 'setActiveGroup') {
			const { groupId } = msg;
			await setStorage({ [STORAGE_KEYS.ACTIVE_GROUP]: groupId });
			// reset index for new group
			const map = (await getStorage([STORAGE_KEYS.CURRENT_INDEX]))[STORAGE_KEYS.CURRENT_INDEX] || {};
			map[groupId] = map[groupId] || 0;
			await setStorage({ [STORAGE_KEYS.CURRENT_INDEX]: map });
			// set an alarm according to group's interval
			const groups = (await getStorage([STORAGE_KEYS.GROUPS]))[STORAGE_KEYS.GROUPS] || [];
			const group = groups.find(g => g.id === groupId);
			if (group && group.intervalMs && group.intervalMs >= 60000) {
				// use minutes for alarms API
				const minutes = Math.max(1, Math.floor(group.intervalMs / 60000));
				browser.alarms.create('cycle', { periodInMinutes: minutes });
			}
			return { ok: true };
		}

		if (msg.type === 'next') {
			const store = await getStorage([STORAGE_KEYS.GROUPS, STORAGE_KEYS.ACTIVE_GROUP, STORAGE_KEYS.CURRENT_INDEX]);
			const groups = store[STORAGE_KEYS.GROUPS] || [];
			const activeId = store[STORAGE_KEYS.ACTIVE_GROUP];
			const idxMap = store[STORAGE_KEYS.CURRENT_INDEX] || {};
			const group = groups.find(g => g.id === activeId);
			if (!group || !group.images || group.images.length === 0) return { ok: false };
			const cur = idxMap[activeId] || 0;
			const next = nextIndex(cur, group.images.length);
			idxMap[activeId] = next;
			await setStorage({ [STORAGE_KEYS.CURRENT_INDEX]: idxMap });
			await broadcastSetBackground(group.images[next]);
			return { ok: true };
		}
	})();
});

/**
 * Runs on extension install — populates default group data if none exists yet.
 *
 * @param {Object} details - Install details provided by the browser.
 * @param {string} details.reason - The reason for the event ('install', 'update', etc).
 * @returns {Promise<void>} Resolves after checking and optionally setting default data.
 */
browser.runtime.onInstalled.addListener(async (_details) => {
	const store = await getStorage([STORAGE_KEYS.GROUPS, STORAGE_KEYS.ACTIVE_GROUP]);
	if (!store[STORAGE_KEYS.GROUPS]) {
		await setStorage({ [STORAGE_KEYS.GROUPS]: DEFAULT_GROUPS, [STORAGE_KEYS.ACTIVE_GROUP]: DEFAULT_GROUPS[0].id });
	}
});

/* eslint-disable no-undef */
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { getStorage, setStorage, nextIndex, broadcastSetBackground };
}
/* eslint-enable no-undef */