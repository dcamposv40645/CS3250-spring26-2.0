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
            return child;
        },

        // removes a child element
        removeChild(child) {
            this.children = this.children.filter(c => c !== child);
            this.firstChild = this.children[0] || null;
        },

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
    getLockedInTheme,
    getOriginalThemeId,
    setLockedInTheme,
    setOriginalThemeId,
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

    // Reset the two global variables in popup.js
    setLockedInTheme(null);
    setOriginalThemeId(null);
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