/**
 * @jest-environment jsdom
 */
// I asked claude to guide me on how to make the test file
// Prompt: my test file isn't checking my popup.js how can I fix that?
'use strict';

// ── Step 1: Make a fake HTML element ──────────────────────────────────────────
// Since we're not in a real browser, we need to fake the DOM elements
// that popup.js creates and uses (buttons, divs, etc.)
function makeFakeElement(tag) {
    return {
        tagName: (tag || 'div').toUpperCase(),
        textContent: '',
        className: '',
        style: {},
        children: [],
        _listeners: {},  // stores event listeners like 'click', 'mouseenter'
        _value: '',
        firstChild: null,
        id: '',
        onclick: null,

        classList: { add: jest.fn(), remove: jest.fn() },

        // adds a child element (like appendChild in a real browser)
        appendChild(child) {
            this.children.push(child);
            this.firstChild = this.children[0] || null;
            // track the parent so anchor.parentElement works in showGroupDropdown
            if (child && typeof child === 'object') child.parentElement = this;
            return child;
        },

        // removes a child element
        removeChild(child) {
            this.children = this.children.filter(c => c !== child);
            this.firstChild = this.children[0] || null;
        },

        // no-op remove so dropdown.remove() doesn't crash
        remove() {},

        // saves event listeners so we can call them in tests
        addEventListener(event, fn) {
            if (!this._listeners[event]) this._listeners[event] = [];
            this._listeners[event].push(fn);
        },

        // simulates clicking the element
        click() {
            (this._listeners['click'] || []).forEach(fn => fn({}));
        },

        // finds all descendant elements matching a class selector like '.foo'
        querySelectorAll(selector) {
            const className = selector.startsWith('.') ? selector.slice(1) : null;
            const results = [];
            const search = (children) => {
                (children || []).forEach(child => {
                    if (className && child.className === className) results.push(child);
                    if (child.children) search(child.children);
                });
            };
            search(this.children);
            return results;
        },

        // makes .value work like a real input field
        get value() { return this._value; },
        set value(v) { this._value = v; },
    };
}

// ── Step 2: Create the fake page elements that popup.js needs ─────────────────
const fakeElements = {};

function setupFakeElements() {
    // These are the elements popup.js looks for by ID
    ['popup-content', 'theme-name', 'group-name', 'save-btn', 'shutdown'].forEach(id => {
        const el = makeFakeElement('div');
        el.id = id;
        fakeElements[id] = el;
    });

    // The status message paragraph
    const statusEl = makeFakeElement('p');
    statusEl.className = 'status';
    fakeElements['status'] = statusEl;
}

// Resets all fake elements back to empty before each test
function clearFakeElements() {
    Object.values(fakeElements).forEach(el => {
        el.children = [];
        el.firstChild = null;
        el._value = '';
        el.textContent = '';
        el._listeners = {};
        el.onclick = null;
    });
}

setupFakeElements();

// ── Step 3: Make document use our fake elements ───────────────────────────────
// We spy on document methods so popup.js gets our fake elements instead of real ones
jest.spyOn(document, 'getElementById').mockImplementation(id => fakeElements[id] || null);
jest.spyOn(document, 'querySelector').mockImplementation(sel => {
    if (sel === '.status') return fakeElements['status'];
    return null;
});
jest.spyOn(document, 'createElement').mockImplementation(tag => makeFakeElement(tag));
jest.spyOn(document, 'addEventListener').mockImplementation(() => {});

// ── Step 4: Fake the browser extension API ────────────────────────────────────
// popup.js uses browser.management and browser.storage — we fake these too
let fakeStorage = {};

global.browser = {
    management: {
        getAll: jest.fn(),
        setEnabled: jest.fn(async () => {}),
    },
    storage: {
        local: {
            get: jest.fn(),
            set: jest.fn(),
        },
    },
};

// Fake confirm() dialog — returns true by default (user clicked OK)
global.confirm = jest.fn(() => true);
global.window = { close: jest.fn() };

// ── Step 5: Load popup.js ─────────────────────────────────────────────────────
const {
    initializePopup,
    buildMenuItem,
    saveTheme,
    handleDeleteGroup,
    handleRemoveTheme,
    handleRenameGroup,
    reorderGroup,
    reorderThemeInGroup,
    reorderUngroupedTheme,
    getLockedInTheme,
    getOriginalThemeId,
    setLockedInTheme,
    setOriginalThemeId,
    setSearchQuery,
} = require('./popup');

// ── Helper: set up fake storage data for a test ───────────────────────────────
function setFakeStorage(data) {
    fakeStorage = { ...data };
    browser.storage.local.get.mockImplementation(async (key) => {
        const k = Array.isArray(key) ? key[0] : key;
        return { [k]: fakeStorage[k] };
    });
    browser.storage.local.set.mockImplementation(async (obj) => {
        Object.assign(fakeStorage, obj);
    });
}

// ── Helper: make a fake theme object ─────────────────────────────────────────
function makeTheme(overrides) {
    return Object.assign(
        { id: 'theme-1', name: 'Cool Theme', type: 'theme', enabled: true },
        overrides
    );
}

// ── Before each test: reset everything ───────────────────────────────────────
beforeEach(() => {
    clearFakeElements();
    setFakeStorage({});
    jest.clearAllMocks();

    // Re-apply our spies after clearAllMocks resets them
    document.getElementById.mockImplementation(id => fakeElements[id] || null);
    document.querySelector.mockImplementation(sel => {
        if (sel === '.status') return fakeElements['status'];
        return null;
    });
    document.createElement.mockImplementation(tag => makeFakeElement(tag));
    document.addEventListener.mockImplementation(() => {});

    browser.management.setEnabled.mockResolvedValue({});
    browser.storage.local.get.mockImplementation(async (key) => {
        const k = Array.isArray(key) ? key[0] : key;
        return { [k]: fakeStorage[k] };
    });
    browser.storage.local.set.mockImplementation(async (obj) => {
        Object.assign(fakeStorage, obj);
    });

    // Reset the global variables in popup.js
    setLockedInTheme(null);
    setOriginalThemeId(null);
    setSearchQuery('');
});

// =============================================================================
// TESTS FOR: initializePopup()
// =============================================================================
describe('initializePopup', () => {

    test('does nothing if popup-content div is missing from the page', async () => {
        // Return null for the first getElementById call to simulate missing element
        document.getElementById.mockReturnValueOnce(null);
        await initializePopup();
        // If it didn't crash and didn't call getAll, we know it returned early
        expect(browser.management.getAll).not.toHaveBeenCalled();
    });

    test('asks the browser for all addons and saved themes', async () => {
        browser.management.getAll.mockResolvedValue([]);
        setFakeStorage({ userThemes: [] });
        await initializePopup();
        expect(browser.management.getAll).toHaveBeenCalled();
        expect(browser.storage.local.get).toHaveBeenCalledWith('userThemes');
    });

    test('clears out the old list before building the new one', async () => {
        // Add an old element to popup-content
        const oldChild = makeFakeElement('p');
        fakeElements['popup-content'].appendChild(oldChild);

        browser.management.getAll.mockResolvedValue([]);
        setFakeStorage({ userThemes: [] });
        await initializePopup();

        // The old element should be gone
        expect(fakeElements['popup-content'].children).not.toContain(oldChild);
    });

    test('works fine when userThemes has never been saved (undefined)', async () => {
        browser.management.getAll.mockResolvedValue([makeTheme()]);
        setFakeStorage({}); // no userThemes key at all
        await expect(initializePopup()).resolves.not.toThrow();
    });

    test('ignores browser extensions — only counts themes', async () => {
        browser.management.getAll.mockResolvedValue([
            { id: 'ext-1', name: 'Some Extension', type: 'extension', enabled: true }
        ]);
        setFakeStorage({ userThemes: [] });
        await expect(initializePopup()).resolves.not.toThrow();
    });

    test('does not create a group if the saved theme is not installed', async () => {
        browser.management.getAll.mockResolvedValue([makeTheme({ id: 'real-theme' })]);
        setFakeStorage({ userThemes: [{ id: 'ghost-theme', group: 'Spooky' }] });
        await initializePopup();

        const groups = fakeElements['popup-content'].children.filter(
            el => el.className === 'group-container'
        );
        expect(groups.length).toBe(0);
    });

    test('creates one group-container for a saved + installed theme', async () => {
        browser.management.getAll.mockResolvedValue([makeTheme({ id: 'theme-1' })]);
        setFakeStorage({ userThemes: [{ id: 'theme-1', group: 'cats' }] });
        await initializePopup();

        const groups = fakeElements['popup-content'].children.filter(
            el => el.className === 'group-container'
        );
        expect(groups.length).toBe(1);
    });

    test('group names are always shown in uppercase', async () => {
        browser.management.getAll.mockResolvedValue([makeTheme({ id: 'theme-1' })]);
        setFakeStorage({ userThemes: [{ id: 'theme-1', group: 'cats' }] });
        await initializePopup();

        // Dig into the rendered group to find the header button
        const groupWrapper = fakeElements['popup-content'].children.find(el => el.className === 'group-container');
        const headerContainer = groupWrapper.children.find(el => el.className === 'group-header-container');
        const header = headerContainer.children.find(el => el.className === 'group-header');

        expect(header.textContent).toContain('CATS');
    });

    test('clicking a closed group header opens it', async () => {
        browser.management.getAll.mockResolvedValue([makeTheme({ id: 'theme-1' })]);
        setFakeStorage({ userThemes: [{ id: 'theme-1', group: 'cats' }] });
        await initializePopup();

        const groupWrapper = fakeElements['popup-content'].children.find(el => el.className === 'group-container');
        const headerContainer = groupWrapper.children.find(el => el.className === 'group-header-container');
        const header = headerContainer.children.find(el => el.className === 'group-header');
        const contentArea = groupWrapper.children.find(el => el.className === 'group-content');

        // Starts closed
        expect(contentArea.style.display).toBe('none');

        header.click();

        // Now should be open
        expect(contentArea.style.display).toBe('block');
    });

    test('clicking an open group header closes it again', async () => {
        browser.management.getAll.mockResolvedValue([makeTheme({ id: 'theme-1' })]);
        setFakeStorage({ userThemes: [{ id: 'theme-1', group: 'cats' }] });
        await initializePopup();

        const groupWrapper = fakeElements['popup-content'].children.find(el => el.className === 'group-container');
        const headerContainer = groupWrapper.children.find(el => el.className === 'group-header-container');
        const header = headerContainer.children.find(el => el.className === 'group-header');
        const contentArea = groupWrapper.children.find(el => el.className === 'group-content');

        header.click(); // open it
        header.click(); // close it again

        expect(contentArea.style.display).toBe('none');
    });

    test('the delete group button stops the click from bubbling up', async () => {
        browser.management.getAll.mockResolvedValue([makeTheme({ id: 'theme-1' })]);
        setFakeStorage({ userThemes: [{ id: 'theme-1', group: 'cats' }] });
        global.confirm.mockReturnValue(false); // cancel so we don't actually delete
        await initializePopup();

        const groupWrapper = fakeElements['popup-content'].children.find(el => el.className === 'group-container');
        const headerContainer = groupWrapper.children.find(el => el.className === 'group-header-container');
        const delBtn = headerContainer.children.find(el => el.className === 'delete-group-btn');

        const stopPropagation = jest.fn();
        delBtn.onclick({ stopPropagation });

        expect(stopPropagation).toHaveBeenCalled();
    });

    test('the delete group button asks the user to confirm before deleting', async () => {
        browser.management.getAll.mockResolvedValue([makeTheme({ id: 'theme-1' })]);
        setFakeStorage({ userThemes: [{ id: 'theme-1', group: 'cats' }] });
        global.confirm.mockReturnValue(false);
        await initializePopup();

        const groupWrapper = fakeElements['popup-content'].children.find(el => el.className === 'group-container');
        const headerContainer = groupWrapper.children.find(el => el.className === 'group-header-container');
        const delBtn = headerContainer.children.find(el => el.className === 'delete-group-btn');

        delBtn.onclick({ stopPropagation: jest.fn() });

        expect(global.confirm).toHaveBeenCalledWith(expect.stringContaining('CATS'));
    });

    test('the remove (x) button on a theme triggers a storage read', async () => {
        browser.management.getAll.mockResolvedValue([makeTheme({ id: 'theme-1' })]);
        setFakeStorage({ userThemes: [{ id: 'theme-1', group: 'cats' }] });
        await initializePopup();

        const groupWrapper = fakeElements['popup-content'].children.find(el => el.className === 'group-container');
        const contentArea = groupWrapper.children.find(el => el.className === 'group-content');
        const row = contentArea.children.find(el => el.className === 'theme-item-row');
        const removeBtn = row.children.find(el => el.className === 'remove-item-btn');

        removeBtn.onclick();
        await new Promise(r => setTimeout(r, 0)); // wait for async to finish

        expect(browser.storage.local.get).toHaveBeenCalled();
    });

    test('themes not in any group appear in the ungrouped section', async () => {
        browser.management.getAll.mockResolvedValue([makeTheme({ id: 'free-theme' })]);
        setFakeStorage({ userThemes: [] }); // nothing saved = ungrouped
        await initializePopup();

        // Looks for the drag-and-drop row containers instead of bare buttons
        const ungroupedRows = fakeElements['popup-content'].children.filter(
            el => el.className === 'theme-item-row'
        );
        expect(ungroupedRows.length).toBeGreaterThan(0);
    });

    test('two different groups each get their own container', async () => {
        browser.management.getAll.mockResolvedValue([
            makeTheme({ id: 'theme-1' }),
            makeTheme({ id: 'theme-2', name: 'Theme 2' }),
        ]);
        setFakeStorage({
            userThemes: [
                { id: 'theme-1', group: 'cats' },
                { id: 'theme-2', group: 'dogs' },
            ]
        });
        await initializePopup();

        const groups = fakeElements['popup-content'].children.filter(
            el => el.className === 'group-container'
        );
        expect(groups.length).toBe(2);
    });
});

// =============================================================================
// TESTS FOR: buildMenuItem()
// =============================================================================
describe('buildMenuItem', () => {

    test('creates a button showing the theme name', () => {
        const btn = buildMenuItem(makeTheme({ name: 'My Theme' }));
        expect(btn.tagName).toBe('BUTTON');
        expect(btn.textContent).toBe('My Theme');
        expect(btn.className).toBe('theme-button');
    });

    test('clicking a theme locks it in and clears the hover memory', async () => {
        const theme = makeTheme({ id: 'clicked-theme', name: 'Click Me' });
        setOriginalThemeId('some-original');
        const btn = buildMenuItem(theme);

        await btn._listeners['click'][0]();

        // originalThemeId should be cleared so mouseleave doesn't undo the click
        expect(getOriginalThemeId()).toBeNull();
        // lockedInTheme should be set to the clicked theme
        expect(getLockedInTheme()).toEqual(theme);
    });

    test('clicking a theme enables it in the browser', async () => {
        const btn = buildMenuItem(makeTheme({ id: 'clicked-id' }));

        await btn._listeners['click'][0]();

        expect(browser.management.setEnabled).toHaveBeenCalledWith('clicked-id', true);
    });

    test('clicking a theme fills in the theme name input box', async () => {
        const btn = buildMenuItem(makeTheme({ name: 'Auto Fill Me' }));

        await btn._listeners['click'][0]();

        expect(fakeElements['theme-name'].value).toBe('Auto Fill Me');
    });
});

// =============================================================================
// TESTS FOR: saveTheme()
// =============================================================================
describe('saveTheme', () => {

    test('shows an error if no theme has been clicked/locked in yet', async () => {
        setLockedInTheme(null);

        await saveTheme();

        expect(fakeElements['status'].textContent).toBe('Click a theme button first!');
        expect(browser.storage.local.set).not.toHaveBeenCalled();
    });

    test('saves the theme to the group name the user typed', async () => {
        setLockedInTheme(makeTheme({ id: 'save-id', name: 'Saveable' }));
        fakeElements['group-name']._value = 'Dogs';
        setFakeStorage({ userThemes: [] });
        browser.management.getAll.mockResolvedValue([]);

        await saveTheme();

        expect(fakeStorage.userThemes).toContainEqual(
            expect.objectContaining({ id: 'save-id', name: 'Saveable', group: 'Dogs' })
        );
    });

    test('uses "General" as the group name if the user left the input blank', async () => {
        setLockedInTheme(makeTheme({ id: 'save-id', name: 'X' }));
        fakeElements['group-name']._value = ''; // blank input
        setFakeStorage({ userThemes: [] });
        browser.management.getAll.mockResolvedValue([]);

        await saveTheme();

        expect(fakeStorage.userThemes).toContainEqual(
            expect.objectContaining({ group: 'General' })
        );
    });

    test('shows a success message after saving', async () => {
        setLockedInTheme(makeTheme({ name: 'My Theme' }));
        fakeElements['group-name']._value = 'Cats';
        setFakeStorage({ userThemes: [] });
        browser.management.getAll.mockResolvedValue([]);

        await saveTheme();

        expect(fakeElements['status'].textContent).toBe('Saved to Cats!');
    });

    test('adds to the existing list instead of replacing it', async () => {
        setLockedInTheme(makeTheme({ id: 'new-theme' }));
        fakeElements['group-name']._value = 'Cats';
        setFakeStorage({ userThemes: [{ id: 'old-theme', group: 'Dogs' }] });
        browser.management.getAll.mockResolvedValue([]);

        await saveTheme();

        expect(fakeStorage.userThemes).toHaveLength(2);
    });

    test('starts a fresh list if storage had no saved themes yet', async () => {
        setLockedInTheme(makeTheme({ id: 't1' }));
        fakeElements['group-name']._value = 'NewGroup';
        setFakeStorage({}); // nothing in storage
        browser.management.getAll.mockResolvedValue([]);

        await saveTheme();

        expect(fakeStorage.userThemes).toHaveLength(1);
    });
});

// =============================================================================
// TESTS FOR: handleDeleteGroup()
// =============================================================================
describe('handleDeleteGroup', () => {

    test('removes all themes that belong to the deleted group', async () => {
        global.confirm.mockReturnValue(true);
        setFakeStorage({
            userThemes: [
                { id: 't1', group: 'Cats' },
                { id: 't2', group: 'Dogs' },
            ]
        });
        browser.management.getAll.mockResolvedValue([]);

        await handleDeleteGroup('CATS');

        expect(fakeStorage.userThemes).toEqual([{ id: 't2', group: 'Dogs' }]);
    });

    test('works even if the group name has different capitalization', async () => {
        global.confirm.mockReturnValue(true);
        setFakeStorage({
            userThemes: [
                { id: 't1', group: 'dogs' },
                { id: 't2', group: 'cats' },
            ]
        });
        browser.management.getAll.mockResolvedValue([]);

        await handleDeleteGroup('DOGS');

        expect(fakeStorage.userThemes).toEqual([{ id: 't2', group: 'cats' }]);
    });

    test('does NOT delete anything if the user clicks Cancel on the confirm dialog', async () => {
        global.confirm.mockReturnValue(false); // user said no
        setFakeStorage({ userThemes: [{ id: 't1', group: 'Cats' }] });

        await handleDeleteGroup('CATS');

        expect(browser.storage.local.set).not.toHaveBeenCalled();
    });

    test('does not crash when there are no saved themes at all', async () => {
        global.confirm.mockReturnValue(true);
        setFakeStorage({}); // empty storage
        browser.management.getAll.mockResolvedValue([]);

        await expect(handleDeleteGroup('CATS')).resolves.not.toThrow();
    });
});

// =============================================================================
// TESTS FOR: handleRemoveTheme()
// =============================================================================
describe('handleRemoveTheme', () => {

    test('removes only the one theme that matches both id and group', async () => {
        setFakeStorage({
            userThemes: [
                { id: 't1', group: 'Cats' },
                { id: 't2', group: 'Cats' },
            ]
        });
        browser.management.getAll.mockResolvedValue([]);

        await handleRemoveTheme('t1', 'Cats');

        expect(fakeStorage.userThemes).toEqual([{ id: 't2', group: 'Cats' }]);
    });

    test('keeps a theme if the id matches but the group is different', async () => {
        setFakeStorage({
            userThemes: [
                { id: 't1', group: 'Cats' },
                { id: 't1', group: 'Dogs' }, // same id, different group — keep this one
            ]
        });
        browser.management.getAll.mockResolvedValue([]);

        await handleRemoveTheme('t1', 'Cats');

        expect(fakeStorage.userThemes).toEqual([{ id: 't1', group: 'Dogs' }]);
    });

    test('works even if the group name has different capitalization', async () => {
        setFakeStorage({
            userThemes: [
                { id: 't1', group: 'cats' },
                { id: 't2', group: 'Dogs' },
            ]
        });
        browser.management.getAll.mockResolvedValue([]);

        await handleRemoveTheme('t1', 'CATS');

        expect(fakeStorage.userThemes).toEqual([{ id: 't2', group: 'Dogs' }]);
    });

    test('does nothing if the theme id does not exist', async () => {
        setFakeStorage({ userThemes: [{ id: 't1', group: 'Cats' }] });
        browser.management.getAll.mockResolvedValue([]);

        await handleRemoveTheme('ghost-id', 'Cats');

        expect(fakeStorage.userThemes).toEqual([{ id: 't1', group: 'Cats' }]);
    });

    test('does not crash when there are no saved themes at all', async () => {
        setFakeStorage({}); // empty storage
        browser.management.getAll.mockResolvedValue([]);

        await expect(handleRemoveTheme('t1', 'Cats')).resolves.not.toThrow();
    });
});

// =============================================================================
// TESTS FOR: Drag and Drop
// =============================================================================
describe('Drag and Drop Mechanics', () => {
    let mockEvent;

    // Creates a fake drag event so Jest doesn't crash
    beforeEach(() => {
        mockEvent = {
            preventDefault: jest.fn(),
            dataTransfer: {
                data: {},
                setData: function(key, val) { this.data[key] = val; },
                getData: function(key) { return this.data[key] || null; }
            }
        };
    });

    test('dragstart and dragend update the button classes and dataTransfer', () => {
        const btn = buildMenuItem({ id: 'drag-id', name: 'Drag Theme' });

        // Simulate picking the theme up
        btn._listeners['dragstart'][0](mockEvent);
        expect(mockEvent.dataTransfer.getData('text/plain')).toBe('drag-id');
        expect(mockEvent.dataTransfer.getData('themeName')).toBe('Drag Theme');
        expect(btn.classList.add).toHaveBeenCalledWith('dragging');

        // Simulate letting the theme go
        btn._listeners['dragend'][0]();
        expect(btn.classList.remove).toHaveBeenCalledWith('dragging');
    });

    test('dragover and dragleave update folder classes', async () => {
        browser.management.getAll.mockResolvedValue([{ id: 't1', type: 'theme' }]);
        setFakeStorage({ userThemes: [{ id: 't1', group: 'Cats' }] });
        await initializePopup();

        const groupWrapper = fakeElements['popup-content'].children.find(el => el.className === 'group-container');

        // Simulate hovering a dragged item over the folder
        groupWrapper._listeners['dragover'][0](mockEvent);
        expect(mockEvent.preventDefault).toHaveBeenCalled();
        expect(groupWrapper.classList.add).toHaveBeenCalledWith('drag-over');

        // Simulate dragging it away without dropping
        groupWrapper._listeners['dragleave'][0](mockEvent);
        expect(groupWrapper.classList.remove).toHaveBeenCalledWith('drag-over');
    });

    test('dropping an existing theme moves it to the new folder', async () => {
        browser.management.getAll.mockResolvedValue([{ id: 't1', type: 'theme' }]);
        setFakeStorage({ userThemes: [{ id: 't1', group: 'Cats' }] });
        await initializePopup();

        const groupWrapper = fakeElements['popup-content'].children.find(el => el.className === 'group-container');

        mockEvent.dataTransfer.setData('text/plain', 't1');
        mockEvent.dataTransfer.setData('themeName', 'My Theme');

        // Simulate dropping it in the folder
        await groupWrapper._listeners['drop'][0](mockEvent);

        expect(mockEvent.preventDefault).toHaveBeenCalled();
        expect(groupWrapper.classList.remove).toHaveBeenCalledWith('drag-over');
        expect(fakeStorage.userThemes.find(t => t.id === 't1').group).toBe('CATS');
    });

    test('dropping a new ungrouped theme creates a new save entry in that folder', async () => {
        browser.management.getAll.mockResolvedValue([{ id: 't1', type: 'theme' }]);
        setFakeStorage({ userThemes: [{ id: 't1', group: 'Cats' }] });
        await initializePopup();

        const groupWrapper = fakeElements['popup-content'].children.find(el => el.className === 'group-container');

        mockEvent.dataTransfer.setData('text/plain', 'new-id');
        mockEvent.dataTransfer.setData('themeName', 'New Theme');

        await groupWrapper._listeners['drop'][0](mockEvent);

        expect(fakeStorage.userThemes).toContainEqual({
            id: 'new-id',
            name: 'New Theme',
            group: 'CATS'
        });
    });

    test('dropping with no theme id does nothing', async () => {
        browser.management.getAll.mockResolvedValue([{ id: 't1', type: 'theme' }]);
        setFakeStorage({ userThemes: [{ id: 't1', group: 'Cats' }] });
        await initializePopup();

        const groupWrapper = fakeElements['popup-content'].children.find(el => el.className === 'group-container');

        // Drop with no data
        await groupWrapper._listeners['drop'][0](mockEvent);

        // Storage shouldn't change
        expect(fakeStorage.userThemes.length).toBe(1);
    });
});

// =============================================================================
// TESTS FOR: reorderGroup()
// =============================================================================
describe('reorderGroup', () => {

    beforeEach(() => {
        browser.management.getAll.mockResolvedValue([]);
    });

    test('moves a group from one position to another', async () => {
        setFakeStorage({});
        await reorderGroup('B', 'C', ['A', 'B', 'C']);
        expect(fakeStorage.groupOrder).toEqual(['A', 'C', 'B']);
    });

    test('moves a group forward in the list', async () => {
        setFakeStorage({});
        await reorderGroup('A', 'C', ['A', 'B', 'C']);
        expect(fakeStorage.groupOrder).toEqual(['B', 'C', 'A']);
    });

    test('does nothing if the dragged group is not in the list', async () => {
        setFakeStorage({});
        await reorderGroup('X', 'A', ['A', 'B', 'C']);
        expect(fakeStorage.groupOrder).toBeUndefined();
    });

    test('does nothing if the target group is not in the list', async () => {
        setFakeStorage({});
        await reorderGroup('A', 'X', ['A', 'B', 'C']);
        expect(fakeStorage.groupOrder).toBeUndefined();
    });

    test('does nothing if dragged and target are the same group', async () => {
        setFakeStorage({});
        await reorderGroup('A', 'A', ['A', 'B', 'C']);
        expect(fakeStorage.groupOrder).toBeUndefined();
    });

    test('saves the new order to storage', async () => {
        setFakeStorage({});
        await reorderGroup('B', 'A', ['A', 'B', 'C']);
        expect(browser.storage.local.set).toHaveBeenCalledWith({ groupOrder: ['B', 'A', 'C'] });
    });
});

// =============================================================================
// TESTS FOR: reorderThemeInGroup()
// =============================================================================
describe('reorderThemeInGroup', () => {

    beforeEach(() => {
        browser.management.getAll.mockResolvedValue([]);
    });

    test('reorders themes within a group and saves to groupThemeOrder', async () => {
        setFakeStorage({ groupThemeOrder: {} });
        const themes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
        await reorderThemeInGroup('a', 'c', 'CATS', themes);
        expect(fakeStorage.groupThemeOrder['CATS']).toEqual(['b', 'c', 'a']);
    });

    test('moves a theme earlier in the list', async () => {
        setFakeStorage({ groupThemeOrder: {} });
        const themes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
        await reorderThemeInGroup('c', 'a', 'CATS', themes);
        expect(fakeStorage.groupThemeOrder['CATS']).toEqual(['c', 'a', 'b']);
    });

    test('does nothing if the dragged theme id is not found', async () => {
        setFakeStorage({});
        const themes = [{ id: 'a' }, { id: 'b' }];
        await reorderThemeInGroup('x', 'a', 'CATS', themes);
        expect(fakeStorage.groupThemeOrder).toBeUndefined();
    });

    test('does nothing if dragged and target are the same theme', async () => {
        setFakeStorage({});
        const themes = [{ id: 'a' }, { id: 'b' }];
        await reorderThemeInGroup('a', 'a', 'CATS', themes);
        expect(fakeStorage.groupThemeOrder).toBeUndefined();
    });

    test('preserves other groups when saving custom order', async () => {
        setFakeStorage({ groupThemeOrder: { DOGS: ['d1', 'd2'] } });
        const themes = [{ id: 'a' }, { id: 'b' }];
        await reorderThemeInGroup('b', 'a', 'CATS', themes);
        expect(fakeStorage.groupThemeOrder['DOGS']).toEqual(['d1', 'd2']);
        expect(fakeStorage.groupThemeOrder['CATS']).toEqual(['b', 'a']);
    });
});

// =============================================================================
// TESTS FOR: reorderUngroupedTheme()
// =============================================================================
describe('reorderUngroupedTheme', () => {

    beforeEach(() => {
        browser.management.getAll.mockResolvedValue([]);
    });

    test('reorders ungrouped themes and saves to ungroupedOrder', async () => {
        setFakeStorage({});
        const themes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
        await reorderUngroupedTheme('a', 'c', themes);
        expect(fakeStorage.ungroupedOrder).toEqual(['b', 'c', 'a']);
    });

    test('moves a theme earlier in the ungrouped list', async () => {
        setFakeStorage({});
        const themes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
        await reorderUngroupedTheme('c', 'a', themes);
        expect(fakeStorage.ungroupedOrder).toEqual(['c', 'a', 'b']);
    });

    test('does nothing if dragged theme is not found', async () => {
        setFakeStorage({});
        const themes = [{ id: 'a' }, { id: 'b' }];
        await reorderUngroupedTheme('x', 'a', themes);
        expect(fakeStorage.ungroupedOrder).toBeUndefined();
    });

    test('does nothing if dragged and target are the same theme', async () => {
        setFakeStorage({});
        const themes = [{ id: 'a' }, { id: 'b' }];
        await reorderUngroupedTheme('a', 'a', themes);
        expect(fakeStorage.ungroupedOrder).toBeUndefined();
    });

    test('saves the new order to storage', async () => {
        setFakeStorage({});
        const themes = [{ id: 'a' }, { id: 'b' }];
        await reorderUngroupedTheme('b', 'a', themes);
        expect(browser.storage.local.set).toHaveBeenCalledWith({ ungroupedOrder: ['b', 'a'] });
    });
});

// =============================================================================
// TESTS FOR: handleRenameGroup()
// =============================================================================
describe('handleRenameGroup', () => {

    beforeEach(() => {
        browser.management.getAll.mockResolvedValue([]);
        global.prompt = jest.fn();
    });

    test('updates the group name for all themes in that group', async () => {
        global.prompt.mockReturnValue('Dogs');
        setFakeStorage({
            userThemes: [
                { id: 't1', group: 'Cats' },
                { id: 't2', group: 'Cats' },
                { id: 't3', group: 'Birds' },
            ]
        });
        await handleRenameGroup('CATS');
        expect(fakeStorage.userThemes.filter(t => t.group === 'Dogs').length).toBe(2);
        expect(fakeStorage.userThemes.find(t => t.id === 't3').group).toBe('Birds');
    });

    test('does nothing if the user cancels the prompt', async () => {
        global.prompt.mockReturnValue(null);
        setFakeStorage({ userThemes: [{ id: 't1', group: 'Cats' }] });
        await handleRenameGroup('CATS');
        expect(browser.storage.local.set).not.toHaveBeenCalled();
    });

    test('does nothing if the user submits an empty string', async () => {
        global.prompt.mockReturnValue('   ');
        setFakeStorage({ userThemes: [{ id: 't1', group: 'Cats' }] });
        await handleRenameGroup('CATS');
        expect(browser.storage.local.set).not.toHaveBeenCalled();
    });

    test('does nothing if the new name is the same as the old name', async () => {
        global.prompt.mockReturnValue('cats');
        setFakeStorage({ userThemes: [{ id: 't1', group: 'CATS' }] });
        await handleRenameGroup('CATS');
        expect(browser.storage.local.set).not.toHaveBeenCalled();
    });

    test('also updates groupOrder if a custom group order exists', async () => {
        global.prompt.mockReturnValue('Hounds');
        setFakeStorage({
            userThemes: [{ id: 't1', group: 'Dogs' }],
            groupOrder: ['CATS', 'DOGS', 'BIRDS'],
        });
        await handleRenameGroup('DOGS');
        expect(fakeStorage.groupOrder).toEqual(['CATS', 'HOUNDS', 'BIRDS']);
    });

    test('leaves groupOrder unchanged if the group is not in it', async () => {
        global.prompt.mockReturnValue('Hounds');
        setFakeStorage({
            userThemes: [{ id: 't1', group: 'Dogs' }],
            groupOrder: ['CATS', 'BIRDS'],
        });
        await handleRenameGroup('DOGS');
        expect(fakeStorage.groupOrder).toEqual(['CATS', 'BIRDS']);
    });
});

// =============================================================================
// TESTS FOR: initializePopup — ungrouped custom order
// =============================================================================
describe('initializePopup — ungrouped custom order', () => {

    test('renders ungrouped themes in saved ungroupedOrder', async () => {
        browser.management.getAll.mockResolvedValue([
            makeTheme({ id: 'a', name: 'Alpha' }),
            makeTheme({ id: 'b', name: 'Beta' }),
            makeTheme({ id: 'c', name: 'Gamma' }),
        ]);
        setFakeStorage({ userThemes: [], ungroupedOrder: ['c', 'a', 'b'] });
        await initializePopup();

        const rows = fakeElements['popup-content'].children.filter(el => el.className === 'theme-item-row');
        const names = rows.map(r => r.children.find(c => c.className.includes('theme-button')).textContent);
        expect(names).toEqual(['Gamma', 'Alpha', 'Beta']);
    });

    test('shows a custom order tag when ungroupedOrder is set', async () => {
        browser.management.getAll.mockResolvedValue([
            makeTheme({ id: 'a', name: 'Alpha' }),
            makeTheme({ id: 'b', name: 'Beta' }),
        ]);
        setFakeStorage({ userThemes: [], ungroupedOrder: ['b', 'a'] });
        await initializePopup();

        // Tag lives inside the ungrouped-header-row div
        const headerRow = fakeElements['popup-content'].children.find(el => el.className === 'ungrouped-header-row');
        const customTag = headerRow && headerRow.children.find(el => el.className.includes('group-custom-tag'));
        expect(customTag).toBeTruthy();
        expect(customTag.textContent).toBe('Custom order');
    });

    test('does not show a custom order tag when no ungroupedOrder is saved', async () => {
        browser.management.getAll.mockResolvedValue([makeTheme({ id: 'a', name: 'Alpha' })]);
        setFakeStorage({ userThemes: [] });
        await initializePopup();

        const headerRow = fakeElements['popup-content'].children.find(el => el.className === 'ungrouped-header-row');
        const customTag = headerRow && headerRow.children.find(el => el.className.includes('group-custom-tag'));
        expect(customTag).toBeFalsy();
    });

    test('ungrouped row drop with same group triggers reorderUngroupedTheme path', async () => {
        browser.management.getAll.mockResolvedValue([
            makeTheme({ id: 'a', name: 'Alpha' }),
            makeTheme({ id: 'b', name: 'Beta' }),
            makeTheme({ id: 'c', name: 'Gamma' }),
        ]);
        // No custom order; default 'recent' reverses installed order → rendered as [c, b, a]
        setFakeStorage({ userThemes: [] });
        await initializePopup();

        const rows = fakeElements['popup-content'].children.filter(el => el.className === 'theme-item-row');
        // Drop 'a' (at rows[2]) onto 'b' (at rows[1]): fromIdx=2, toIdx=1 in [c,b,a] → result [c,a,b]
        const dropEvent = {
            preventDefault: jest.fn(),
            stopPropagation: jest.fn(),
            dataTransfer: {
                data: { 'text/plain': 'a', fromGroup: '__ungrouped__' },
                getData(k) { return this.data[k] || ''; },
            },
        };
        await rows[1]._listeners['drop'][0](dropEvent);
        expect(fakeStorage.ungroupedOrder).toEqual(['c', 'a', 'b']);
    });

    test('ungrouped row drop with groupDrag set does nothing', async () => {
        browser.management.getAll.mockResolvedValue([makeTheme({ id: 'a', name: 'Alpha' })]);
        setFakeStorage({ userThemes: [] });
        await initializePopup();

        const rows = fakeElements['popup-content'].children.filter(el => el.className === 'theme-item-row');
        const dropEvent = {
            preventDefault: jest.fn(),
            stopPropagation: jest.fn(),
            dataTransfer: {
                data: { groupDrag: 'CATS' },
                getData(k) { return this.data[k] || ''; },
            },
        };
        await rows[0]._listeners['drop'][0](dropEvent);
        expect(fakeStorage.ungroupedOrder).toBeUndefined();
    });
});

// =============================================================================
// TESTS FOR: initializePopup — group drag handle & within-group reorder
// =============================================================================
describe('initializePopup — group drag and within-group reorder', () => {

    test('group drag handle sets groupDrag data on dragstart', async () => {
        browser.management.getAll.mockResolvedValue([makeTheme({ id: 't1' })]);
        setFakeStorage({ userThemes: [{ id: 't1', group: 'cats' }] });
        await initializePopup();

        const groupWrapper = fakeElements['popup-content'].children.find(el => el.className === 'group-container');
        const headerContainer = groupWrapper.children.find(el => el.className === 'group-header-container');
        const dragHandle = headerContainer.children.find(el => el.className === 'group-drag-handle');

        const dragEvent = {
            dataTransfer: { data: {}, setData(k, v) { this.data[k] = v; }, getData(k) { return this.data[k]; }, setDragImage: jest.fn() },
            stopPropagation: jest.fn(),
        };
        dragHandle._listeners['dragstart'][0](dragEvent);
        expect(dragEvent.dataTransfer.getData('groupDrag')).toBe('CATS');
        expect(dragEvent.stopPropagation).toHaveBeenCalled();
    });

    test('group wrapper drop with groupDrag calls reorderGroup storage save', async () => {
        browser.management.getAll.mockResolvedValue([
            makeTheme({ id: 't1' }),
            makeTheme({ id: 't2', name: 'Theme 2' }),
        ]);
        setFakeStorage({
            userThemes: [
                { id: 't1', group: 'cats' },
                { id: 't2', group: 'dogs' },
            ],
        });
        await initializePopup();

        const groups = fakeElements['popup-content'].children.filter(el => el.className === 'group-container');
        const dogsWrapper = groups[1]; // second group rendered

        const dropEvent = {
            preventDefault: jest.fn(),
            dataTransfer: {
                data: { groupDrag: 'CATS' },
                getData(k) { return this.data[k] || ''; },
            },
        };
        dogsWrapper.classList.remove = jest.fn();
        await dogsWrapper._listeners['drop'][0](dropEvent);

        expect(fakeStorage.groupOrder).toBeDefined();
    });

    test('within-group theme row drop fires reorderThemeInGroup when same group', async () => {
        browser.management.getAll.mockResolvedValue([
            makeTheme({ id: 'ta', name: 'A Theme' }),
            makeTheme({ id: 'tb', name: 'B Theme' }),
        ]);
        setFakeStorage({
            userThemes: [
                { id: 'ta', group: 'cats' },
                { id: 'tb', group: 'cats' },
            ],
        });
        await initializePopup();

        const groupWrapper = fakeElements['popup-content'].children.find(el => el.className === 'group-container');
        const contentArea = groupWrapper.children.find(el => el.className === 'group-content');
        const rows = contentArea.children.filter(el => el.className === 'theme-item-row');

        const dropEvent = {
            preventDefault: jest.fn(),
            stopPropagation: jest.fn(),
            dataTransfer: {
                data: { 'text/plain': 'ta', themeName: 'A Theme', fromGroup: 'CATS' },
                getData(k) { return this.data[k] || ''; },
            },
        };
        // 'recent' sort renders [tb, ta]; drop 'ta' onto rows[0] (tb)
        // fromIdx=1, toIdx=0 in [tb,ta] → result [ta, tb]
        await rows[0]._listeners['drop'][0](dropEvent);
        expect(fakeStorage.groupThemeOrder).toBeDefined();
        expect(fakeStorage.groupThemeOrder['CATS']).toEqual(['ta', 'tb']);
    });

    test('shows custom order tag inside group when groupThemeOrder is set for that group', async () => {
        browser.management.getAll.mockResolvedValue([
            makeTheme({ id: 't1' }),
            makeTheme({ id: 't2', name: 'T2' }),
        ]);
        setFakeStorage({
            userThemes: [
                { id: 't1', group: 'cats' },
                { id: 't2', group: 'cats' },
            ],
            groupThemeOrder: { CATS: ['t2', 't1'] },
        });
        await initializePopup();

        const groupWrapper = fakeElements['popup-content'].children.find(el => el.className === 'group-container');
        const contentArea = groupWrapper.children.find(el => el.className === 'group-content');
        const customTag = contentArea.children.find(el => el.className === 'group-custom-tag');
        expect(customTag).toBeTruthy();
        expect(customTag.textContent).toBe('Custom order');
    });
});

// =============================================================================
// TESTS FOR: initializePopup — search query filtering
// =============================================================================
describe('initializePopup — search filtering', () => {

    test('keeps only groups whose name matches the query', async () => {
        browser.management.getAll.mockResolvedValue([
            makeTheme({ id: 't1', name: 'Alpha' }),
            makeTheme({ id: 't2', name: 'Beta' }),
        ]);
        setFakeStorage({
            userThemes: [
                { id: 't1', group: 'cats' },
                { id: 't2', group: 'dogs' },
            ]
        });
        setSearchQuery('cat');
        await initializePopup();

        const groups = fakeElements['popup-content'].children.filter(el => el.className === 'group-container');
        // only the 'cats' group matches
        expect(groups.length).toBe(1);
    });

    test('keeps a group and filters its themes when only the theme name matches', async () => {
        browser.management.getAll.mockResolvedValue([
            makeTheme({ id: 't1', name: 'Alpha' }),
            makeTheme({ id: 't2', name: 'Beta' }),
        ]);
        setFakeStorage({
            userThemes: [
                { id: 't1', group: 'cats' },
                { id: 't2', group: 'cats' },
            ]
        });
        setSearchQuery('alpha');
        await initializePopup();

        const groupWrapper = fakeElements['popup-content'].children.find(el => el.className === 'group-container');
        const contentArea = groupWrapper.children.find(el => el.className === 'group-content');
        // only the 'Alpha' theme row should appear
        const rows = contentArea.children.filter(el => el.className === 'theme-item-row');
        expect(rows.length).toBe(1);
    });

    test('removes a group entirely when no themes match the query', async () => {
        browser.management.getAll.mockResolvedValue([makeTheme({ id: 't1', name: 'Alpha' })]);
        setFakeStorage({ userThemes: [{ id: 't1', group: 'cats' }] });
        setSearchQuery('zzznomatch');
        await initializePopup();

        const groups = fakeElements['popup-content'].children.filter(el => el.className === 'group-container');
        expect(groups.length).toBe(0);
    });

    test('shows all groups again when query is cleared', async () => {
        browser.management.getAll.mockResolvedValue([
            makeTheme({ id: 't1', name: 'Alpha' }),
            makeTheme({ id: 't2', name: 'Beta' }),
        ]);
        setFakeStorage({
            userThemes: [
                { id: 't1', group: 'cats' },
                { id: 't2', group: 'dogs' },
            ]
        });
        // empty string query = no filter
        setSearchQuery('');
        await initializePopup();

        const groups = fakeElements['popup-content'].children.filter(el => el.className === 'group-container');
        expect(groups.length).toBe(2);
    });
});

// =============================================================================
// TESTS FOR: initializePopup — eye button hover preview
// =============================================================================
describe('initializePopup — eye button preview', () => {

    test('grouped eye button mouseenter previews the theme and saves the original', async () => {
        browser.management.getAll.mockResolvedValue([makeTheme({ id: 't1' })]);
        setFakeStorage({ userThemes: [{ id: 't1', group: 'cats' }] });
        await initializePopup();

        // second getAll call happens inside the mouseenter handler
        browser.management.getAll.mockResolvedValue([
            makeTheme({ id: 'other', name: 'Other', enabled: true }),
            makeTheme({ id: 't1', enabled: false }),
        ]);

        const groupWrapper = fakeElements['popup-content'].children.find(el => el.className === 'group-container');
        const contentArea = groupWrapper.children.find(el => el.className === 'group-content');
        const row = contentArea.children.find(el => el.className === 'theme-item-row');
        const eyeBtn = row.children.find(el => el.className === 'drag-handle');

        await eyeBtn._listeners['mouseenter'][0]();

        expect(browser.management.setEnabled).toHaveBeenCalledWith('t1', true);
        expect(getOriginalThemeId()).toBe('other');
    });

    test('grouped eye button mouseenter does not save original when it is already the hovered theme', async () => {
        browser.management.getAll.mockResolvedValue([makeTheme({ id: 't1', enabled: true })]);
        setFakeStorage({ userThemes: [{ id: 't1', group: 'cats' }] });
        await initializePopup();

        // the currently active theme IS the theme being hovered — no need to save it
        browser.management.getAll.mockResolvedValue([makeTheme({ id: 't1', enabled: true })]);

        const groupWrapper = fakeElements['popup-content'].children.find(el => el.className === 'group-container');
        const contentArea = groupWrapper.children.find(el => el.className === 'group-content');
        const row = contentArea.children.find(el => el.className === 'theme-item-row');
        const eyeBtn = row.children.find(el => el.className === 'drag-handle');

        await eyeBtn._listeners['mouseenter'][0]();

        // setEnabled still gets called to ensure theme is active
        expect(browser.management.setEnabled).toHaveBeenCalledWith('t1', true);
        // but originalThemeId should NOT be set to the same theme
        expect(getOriginalThemeId()).toBeNull();
    });

    test('grouped eye button mouseleave restores the original theme', async () => {
        browser.management.getAll.mockResolvedValue([makeTheme({ id: 't1' })]);
        setFakeStorage({ userThemes: [{ id: 't1', group: 'cats' }] });
        await initializePopup();

        setOriginalThemeId('saved-original');

        const groupWrapper = fakeElements['popup-content'].children.find(el => el.className === 'group-container');
        const contentArea = groupWrapper.children.find(el => el.className === 'group-content');
        const row = contentArea.children.find(el => el.className === 'theme-item-row');
        const eyeBtn = row.children.find(el => el.className === 'drag-handle');

        await eyeBtn._listeners['mouseleave'][0]();

        expect(browser.management.setEnabled).toHaveBeenCalledWith('saved-original', true);
    });

    test('grouped eye button mouseleave does nothing if no original was saved', async () => {
        browser.management.getAll.mockResolvedValue([makeTheme({ id: 't1' })]);
        setFakeStorage({ userThemes: [{ id: 't1', group: 'cats' }] });
        await initializePopup();

        // originalThemeId is null from beforeEach, leave it that way
        const groupWrapper = fakeElements['popup-content'].children.find(el => el.className === 'group-container');
        const contentArea = groupWrapper.children.find(el => el.className === 'group-content');
        const row = contentArea.children.find(el => el.className === 'theme-item-row');
        const eyeBtn = row.children.find(el => el.className === 'drag-handle');

        await eyeBtn._listeners['mouseleave'][0]();

        expect(browser.management.setEnabled).not.toHaveBeenCalled();
    });

    test('ungrouped eye button mouseenter previews the theme and saves original', async () => {
        browser.management.getAll.mockResolvedValue([makeTheme({ id: 'free', name: 'Free' })]);
        setFakeStorage({ userThemes: [] });
        await initializePopup();

        browser.management.getAll.mockResolvedValue([
            makeTheme({ id: 'other', name: 'Other', enabled: true }),
            makeTheme({ id: 'free', enabled: false }),
        ]);

        const rows = fakeElements['popup-content'].children.filter(el => el.className === 'theme-item-row');
        const eyeBtn = rows[0].children.find(el => el.className === 'drag-handle');

        await eyeBtn._listeners['mouseenter'][0]();

        expect(browser.management.setEnabled).toHaveBeenCalledWith('free', true);
        expect(getOriginalThemeId()).toBe('other');
    });

    test('ungrouped eye button mouseleave restores the original theme', async () => {
        browser.management.getAll.mockResolvedValue([makeTheme({ id: 'free', name: 'Free' })]);
        setFakeStorage({ userThemes: [] });
        await initializePopup();

        setOriginalThemeId('original-id');

        const rows = fakeElements['popup-content'].children.filter(el => el.className === 'theme-item-row');
        const eyeBtn = rows[0].children.find(el => el.className === 'drag-handle');

        await eyeBtn._listeners['mouseleave'][0]();

        expect(browser.management.setEnabled).toHaveBeenCalledWith('original-id', true);
    });
});

// =============================================================================
// TESTS FOR: initializePopup — grouped theme row drag events
// =============================================================================
describe('initializePopup — grouped row drag events', () => {

    test('grouped theme row dragstart marks the fromGroup in drag data', async () => {
        browser.management.getAll.mockResolvedValue([makeTheme({ id: 't1' })]);
        setFakeStorage({ userThemes: [{ id: 't1', group: 'cats' }] });
        await initializePopup();

        const groupWrapper = fakeElements['popup-content'].children.find(el => el.className === 'group-container');
        const contentArea = groupWrapper.children.find(el => el.className === 'group-content');
        const row = contentArea.children.find(el => el.className === 'theme-item-row');

        const dragEvent = {
            dataTransfer: { data: {}, setData(k, v) { this.data[k] = v; }, getData(k) { return this.data[k] || ''; } }
        };
        row._listeners['dragstart'][0](dragEvent);

        expect(dragEvent.dataTransfer.getData('fromGroup')).toBe('CATS');
    });

    test('dropping a theme from a different group onto a theme row moves it there', async () => {
        browser.management.getAll.mockResolvedValue([
            makeTheme({ id: 'ta', name: 'A' }),
            makeTheme({ id: 'tb', name: 'B' }),
        ]);
        setFakeStorage({
            userThemes: [
                { id: 'ta', group: 'cats' },
                { id: 'tb', group: 'dogs' },
            ]
        });
        await initializePopup();

        // groups render in insertion order: cats first, then dogs
        const groups = fakeElements['popup-content'].children.filter(el => el.className === 'group-container');
        const catsGroup = groups[0];
        const contentArea = catsGroup.children.find(el => el.className === 'group-content');
        // cats only has 'ta'
        const row = contentArea.children.find(el => el.className === 'theme-item-row');

        const dropEvent = {
            preventDefault: jest.fn(),
            stopPropagation: jest.fn(),
            dataTransfer: {
                data: { 'text/plain': 'tb', themeName: 'B', fromGroup: 'DOGS' },
                getData(k) { return this.data[k] || ''; },
            },
        };
        await row._listeners['drop'][0](dropEvent);

        // 'tb' should now be in the CATS group
        expect(fakeStorage.userThemes.find(t => t.id === 'tb').group).toBe('CATS');
    });

    test('dropping with no themeId onto a theme row does nothing', async () => {
        browser.management.getAll.mockResolvedValue([makeTheme({ id: 't1' })]);
        setFakeStorage({ userThemes: [{ id: 't1', group: 'cats' }] });
        await initializePopup();

        const groupWrapper = fakeElements['popup-content'].children.find(el => el.className === 'group-container');
        const contentArea = groupWrapper.children.find(el => el.className === 'group-content');
        const row = contentArea.children.find(el => el.className === 'theme-item-row');

        const dropEvent = {
            preventDefault: jest.fn(),
            stopPropagation: jest.fn(),
            dataTransfer: {
                data: {}, // no text/plain
                getData(k) { return this.data[k] || ''; },
            },
        };
        const initialLength = fakeStorage.userThemes.length;
        await row._listeners['drop'][0](dropEvent);

        expect(fakeStorage.userThemes.length).toBe(initialLength);
    });
});

// =============================================================================
// TESTS FOR: initializePopup — ungrouped row events and group dropdown
// =============================================================================
describe('initializePopup — ungrouped row events and dropdown', () => {

    test('ungrouped row dragstart marks fromGroup as __ungrouped__', async () => {
        browser.management.getAll.mockResolvedValue([makeTheme({ id: 'a', name: 'Alpha' })]);
        setFakeStorage({ userThemes: [] });
        await initializePopup();

        const rows = fakeElements['popup-content'].children.filter(el => el.className === 'theme-item-row');
        const dragEvent = {
            dataTransfer: { data: {}, setData(k, v) { this.data[k] = v; }, getData(k) { return this.data[k] || ''; } }
        };
        rows[0]._listeners['dragstart'][0](dragEvent);

        expect(dragEvent.dataTransfer.getData('fromGroup')).toBe('__ungrouped__');
    });

    test('clicking the ungrouped custom order tag resets ungroupedOrder to null', async () => {
        browser.management.getAll.mockResolvedValue([
            makeTheme({ id: 'a', name: 'Alpha' }),
            makeTheme({ id: 'b', name: 'Beta' }),
        ]);
        setFakeStorage({ userThemes: [], ungroupedOrder: ['b', 'a'] });
        await initializePopup();

        const headerRow = fakeElements['popup-content'].children.find(el => el.className === 'ungrouped-header-row');
        const customTag = headerRow.children.find(el => el.className.includes('group-custom-tag'));

        // need getAll ready for the internal initializePopup call after reset
        browser.management.getAll.mockResolvedValue([
            makeTheme({ id: 'a', name: 'Alpha' }),
            makeTheme({ id: 'b', name: 'Beta' }),
        ]);
        await customTag.onclick();

        expect(fakeStorage.ungroupedOrder).toBeNull();
    });

    test('addToGroupBtn opens a dropdown listing existing groups', async () => {
        browser.management.getAll.mockResolvedValue([
            makeTheme({ id: 'grouped' }),
            makeTheme({ id: 'free', name: 'Free' }),
        ]);
        setFakeStorage({ userThemes: [{ id: 'grouped', group: 'cats' }] });
        await initializePopup();

        const rows = fakeElements['popup-content'].children.filter(el => el.className === 'theme-item-row');
        const addBtn = rows[0].children.find(el => el.className === 'add-to-group-btn');
        addBtn.onclick({ stopPropagation: jest.fn() });

        // dropdown is appended to addBtn.parentElement (the row)
        const dropdown = rows[0].children.find(el => el.className === 'group-dropdown');
        expect(dropdown).toBeTruthy();
        const catItem = dropdown.children.find(c => c.textContent === 'CATS');
        expect(catItem).toBeTruthy();
    });

    test('addToGroupBtn dropdown shows "No groups yet" when no groups exist', async () => {
        browser.management.getAll.mockResolvedValue([makeTheme({ id: 'free', name: 'Free' })]);
        setFakeStorage({ userThemes: [] });
        await initializePopup();

        const rows = fakeElements['popup-content'].children.filter(el => el.className === 'theme-item-row');
        const addBtn = rows[0].children.find(el => el.className === 'add-to-group-btn');
        addBtn.onclick({ stopPropagation: jest.fn() });

        const dropdown = rows[0].children.find(el => el.className === 'group-dropdown');
        const disabled = dropdown.children.find(c => c.className === 'group-dropdown-item group-dropdown-disabled');
        expect(disabled).toBeTruthy();
        expect(disabled.textContent).toBe('No groups yet');
    });

    test('clicking a group item in the dropdown moves the theme into that group', async () => {
        browser.management.getAll.mockResolvedValue([
            makeTheme({ id: 'grouped' }),
            makeTheme({ id: 'free', name: 'Free' }),
        ]);
        setFakeStorage({ userThemes: [{ id: 'grouped', group: 'cats' }] });
        await initializePopup();

        const rows = fakeElements['popup-content'].children.filter(el => el.className === 'theme-item-row');
        const addBtn = rows[0].children.find(el => el.className === 'add-to-group-btn');
        addBtn.onclick({ stopPropagation: jest.fn() });

        const dropdown = rows[0].children.find(el => el.className === 'group-dropdown');
        const catItem = dropdown.children.find(c => c.textContent === 'CATS');

        // internal initializePopup call needs getAll ready
        browser.management.getAll.mockResolvedValue([
            makeTheme({ id: 'grouped' }),
            makeTheme({ id: 'free', name: 'Free' }),
        ]);
        await catItem.onclick();

        expect(fakeStorage.userThemes.find(t => t.id === 'free').group).toBe('CATS');
    });

    test('clicking "+ New group..." prompts for a name and saves the theme there', async () => {
        global.prompt = jest.fn(() => 'My New Group');
        browser.management.getAll.mockResolvedValue([makeTheme({ id: 'free', name: 'Free' })]);
        setFakeStorage({ userThemes: [] });
        await initializePopup();

        const rows = fakeElements['popup-content'].children.filter(el => el.className === 'theme-item-row');
        const addBtn = rows[0].children.find(el => el.className === 'add-to-group-btn');
        addBtn.onclick({ stopPropagation: jest.fn() });

        const dropdown = rows[0].children.find(el => el.className === 'group-dropdown');
        const newItem = dropdown.children.find(c => c.className === 'group-dropdown-item group-dropdown-new');

        browser.management.getAll.mockResolvedValue([makeTheme({ id: 'free', name: 'Free' })]);
        await newItem.onclick();

        expect(fakeStorage.userThemes).toContainEqual(
            expect.objectContaining({ id: 'free', group: 'My New Group' })
        );
    });

    test('clicking "+ New group..." with blank input does nothing', async () => {
        global.prompt = jest.fn(() => '   ');
        browser.management.getAll.mockResolvedValue([makeTheme({ id: 'free', name: 'Free' })]);
        setFakeStorage({ userThemes: [] });
        await initializePopup();

        const rows = fakeElements['popup-content'].children.filter(el => el.className === 'theme-item-row');
        const addBtn = rows[0].children.find(el => el.className === 'add-to-group-btn');
        addBtn.onclick({ stopPropagation: jest.fn() });

        const dropdown = rows[0].children.find(el => el.className === 'group-dropdown');
        const newItem = dropdown.children.find(c => c.className === 'group-dropdown-item group-dropdown-new');

        await newItem.onclick();

        // blank prompt = no save
        expect(fakeStorage.userThemes).toHaveLength(0);
    });

    test('dropdown also shows a "+ New group..." item', async () => {
        browser.management.getAll.mockResolvedValue([makeTheme({ id: 'free', name: 'Free' })]);
        setFakeStorage({ userThemes: [] });
        await initializePopup();

        const rows = fakeElements['popup-content'].children.filter(el => el.className === 'theme-item-row');
        const addBtn = rows[0].children.find(el => el.className === 'add-to-group-btn');
        addBtn.onclick({ stopPropagation: jest.fn() });

        const dropdown = rows[0].children.find(el => el.className === 'group-dropdown');
        const newItem = dropdown.children.find(c => c.className === 'group-dropdown-item group-dropdown-new');
        expect(newItem).toBeTruthy();
        expect(newItem.textContent).toBe('+ New group...');
    });
});