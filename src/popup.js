'use strict';

/**
 * @file popup.js
 * @description
 * Controls the Firefox extension popup UI for Anonymous Theme Switcher.
 *
 * Responsibilities:
 * - Load installed themes (via browser.management).
 * - Load/save grouped theme data (via browser.storage.local under "userThemes").
 * - Render an accordion UI of theme groups into #popup-content.
 * - Preview themes on hover, lock-in a theme on click, and save it to a group.
 * - Delete an entire group or remove a single theme entry from a group.
 *
 * @requires browser.management
 * @requires browser.storage.local
 * @requires popup.html elements: #popup-content, #save-btn, #shutdown, #theme-name, #group-name
 * @requires popup.css classes: .group-container, .group-header, .group-content, .theme-button,
 *   .delete-group-btn, .remove-item-btn, .theme-item-row, .status
 */

/**
 * GLOBAL VARIABLES
 * These stay outside the functions so they don't get "forgotten" between clicks.
 */
let originalThemeId = null; // Remembers what theme you had before you started hovering
let lockedInTheme = null;   // Remembers what theme you actually clicked
// eslint-disable-next-line prefer-const
let currentSort = 'recent'; // Tracks the active sort order for themes inside groups
let searchQuery = ''; // Tracks the current search filter

/**
 * Initializes the popup by clearing the UI and re-rendering the grouped themes list.
 *
 * Data sources:
 * - Installed themes come from browser.management.getAll().
 * - Saved group mappings come from browser.storage.local key "userThemes".
 *
 * UI output:
 * - Builds an accordion list of groups inside the #popup-content element.
 * - Adds "Ungrouped Themes" (installed themes not in storage) at the bottom.
 *
 * @async
 * @returns {Promise<void>} Resolves after the UI has been fully rebuilt.
 */
// this function has some asistance from ai
//Prompt: whats the best way to check and access themes that we own in firefox
async function initializePopup() {
    const scrollTop = document.documentElement.scrollTop || document.body.scrollTop || 0;
    const currentDiv = document.getElementById('popup-content');
    if (!currentDiv) return;

    // 1. Fetch ALL data before touching the DOM — every await after a DOM clear
    //    gives the browser a chance to render the empty popup (causing the flash).
    const allAddons = await browser.management.getAll();
    const storageData = await browser.storage.local.get('userThemes');
    const groupOrderData = await browser.storage.local.get('groupOrder');
    const groupThemeOrderData = await browser.storage.local.get('groupThemeOrder');
    const ungroupedOrderData = await browser.storage.local.get('ungroupedOrder');

    const installedThemes = allAddons.filter(addon => addon.type === 'theme');
    const activeTheme = installedThemes.find(t => t.enabled);
    const savedThemes = storageData.userThemes || [];
    const savedGroupOrder = groupOrderData.groupOrder || null;
    const groupThemeOrder = groupThemeOrderData.groupThemeOrder || {};
    const ungroupedOrder = ungroupedOrderData.ungroupedOrder || null;

    // 2. Remember which groups were open, then clear and rebuild — all synchronous from here
    const openGroups = new Set();
    currentDiv.querySelectorAll('.group-content').forEach((el, i) => {
        if (el.style.display !== 'none') {
            openGroups.add(i);
        }
    });

    while (currentDiv.firstChild) {
        currentDiv.removeChild(currentDiv.firstChild);
    }

    // 3. Create a Sorting Object (The "Group Map")
    // { [GROUPNAME_UPPER]: [themeAddOnObj, themeAddOnObj, ...] }
    /** @type {Record<string, Array<Object>>} */
    const themeGroups = {};
    savedThemes.forEach(savedItem => {
        const groupName = savedItem.group.toUpperCase();
        const match = installedThemes.find(t => t.id === savedItem.id);

        // Only create the folder array if the theme is actually installed!
        if (match) {
            if (!themeGroups[groupName]) {
                themeGroups[groupName] = [];
            }
            themeGroups[groupName].push(match);
        }
    });

    // Filter groups and themes based on search query
    const q = searchQuery.trim().toLowerCase();
    if (q) {
        for (const groupName of Object.keys(themeGroups)) {
            const groupMatches = groupName.toLowerCase().includes(q);
            if (!groupMatches) {
                themeGroups[groupName] = themeGroups[groupName].filter(t => t.name.toLowerCase().includes(q));
                if (themeGroups[groupName].length === 0) delete themeGroups[groupName];
            }
        }
    }

    // Sort themes inside each group — use per-group custom order if set, otherwise global sort
    for (const g in themeGroups) {
        if (groupThemeOrder[g]) {
            const customOrder = groupThemeOrder[g];
            themeGroups[g].sort((a, b) => {
                const ai = customOrder.indexOf(a.id);
                const bi = customOrder.indexOf(b.id);
                if (ai === -1) return 1;
                if (bi === -1) return -1;
                return ai - bi;
            });
        } else {
            themeGroups[g].sort((a, b) => {
                if (currentSort === 'az') return a.name.localeCompare(b.name);
                if (currentSort === 'oldest') return savedThemes.findIndex(s => s.id === a.id) - savedThemes.findIndex(s => s.id === b.id);
                return savedThemes.findIndex(s => s.id === b.id) - savedThemes.findIndex(s => s.id === a.id);
            });
        }
    }

    // Determine group rendering order: custom if dragged, otherwise insertion order
    let orderedGroupNames = Object.keys(themeGroups);
    if (savedGroupOrder) {
        orderedGroupNames = [
            ...savedGroupOrder.filter(n => themeGroups[n] !== undefined),
            ...orderedGroupNames.filter(n => !savedGroupOrder.includes(n))
        ];
    }

    // 4. Build the Expandable UI (Accordion)
    if (Object.keys(themeGroups).length === 0) {
        const emptyMsg = document.createElement('p');
        emptyMsg.className = 'status';
        emptyMsg.textContent = "No saved groups yet!";
        currentDiv.appendChild(emptyMsg);
    }

    // Build the sort bar so the user can switch between Recent, Oldest, and A-Z
    const sortBar = document.createElement('div');
    sortBar.className = 'sort-bar';

    ['Recent', 'Oldest', 'A-Z'].forEach(label => {
        const key = label === 'A-Z' ? 'az' : label.toLowerCase();
        const btn = document.createElement('button');
        btn.textContent = label;
        btn.className = 'sort-btn' + (currentSort === key && !savedGroupOrder ? ' sort-active' : '');
        btn.onclick = () => { currentSort = key; initializePopup(); };
        sortBar.appendChild(btn);
    });

    if (savedGroupOrder) {
        const customBtn = document.createElement('button');
        customBtn.textContent = 'Custom';
        customBtn.className = 'sort-btn sort-active';
        customBtn.title = 'Groups are in custom order — click to reset';
        customBtn.onclick = async () => {
            await browser.storage.local.remove('groupOrder');
            initializePopup();
        };
        sortBar.appendChild(customBtn);
    }

    currentDiv.appendChild(sortBar);

    for (const groupName of orderedGroupNames) {
        const groupWrapper = document.createElement('div');
        groupWrapper.className = 'group-container';

        // prompted claude to guide me on how to implement a drag and drop feature
        // lets the group folder act as a drop target when dragging themes around
        groupWrapper.addEventListener('dragover', (e) => {
            e.preventDefault();
            groupWrapper.classList.add('drag-over');
        });

        groupWrapper.addEventListener('dragleave', () => {
            groupWrapper.classList.remove('drag-over');
        });

        groupWrapper.addEventListener('drop', async (e) => {
            e.preventDefault();
            groupWrapper.classList.remove('drag-over');

            const draggedGroup = e.dataTransfer.getData('groupDrag');
            if (draggedGroup && draggedGroup !== groupName) {
                await reorderGroup(draggedGroup, groupName, orderedGroupNames);
                return;
            }

            const themeId = e.dataTransfer.getData('text/plain');
            const themeName = e.dataTransfer.getData('themeName');

            if (themeId) {
                await moveThemeToGroup(themeId, themeName, groupName);
            }
        });

        // Header Container for Title + Delete Group Button
        const headerContainer = document.createElement('div');
        headerContainer.className = 'group-header-container';
        headerContainer.style.display = "flex"; // Puts them on the same line

        const header = document.createElement('button');
        header.className = 'group-header';
        header.style.flex = "1"; // Makes the title take up the most space
        header.textContent = groupName + " (" + themeGroups[groupName].length + ")";

        // Inside your initializePopup loop
        const delGroupBtn = document.createElement('button');
        delGroupBtn.textContent = "×"; // Changed from "DELETE GROUP" to just "×"
        delGroupBtn.className = 'delete-group-btn';
        // used gemini for the next couple lines
        delGroupBtn.onclick = (e) => {
            e.stopPropagation(); // Stops the folder from toggling
            handleDeleteGroup(groupName);
        };

        // Pencil button to rename the group
        const renameBtn = document.createElement('button');
        renameBtn.textContent = '✎';
        renameBtn.className = 'rename-group-btn';
        renameBtn.title = 'Rename group';
        renameBtn.onclick = (e) => {
            e.stopPropagation();
            handleRenameGroup(groupName);
        };

        const contentArea = document.createElement('div');
        contentArea.className = 'group-content';
        contentArea.style.display = openGroups.has(Object.keys(themeGroups).indexOf(groupName)) ? "block" : "none";

        if (groupThemeOrder[groupName]) {
            const customTag = document.createElement('button');
            customTag.textContent = 'Custom order';
            customTag.className = 'group-custom-tag';
            customTag.title = 'Themes are in custom order — click to reset';
            customTag.onclick = async () => {
                const d = await browser.storage.local.get('groupThemeOrder');
                const gto = d.groupThemeOrder || {};
                delete gto[groupName];
                await browser.storage.local.set({ groupThemeOrder: gto });
                initializePopup();
            };
            contentArea.appendChild(customTag);
        }

        // Loop that adds drag handle + Theme + Remove "x" Button
        themeGroups[groupName].forEach(theme => {
            const row = document.createElement('div');
            row.className = 'theme-item-row';

            const eyeBtn = document.createElement('span');
            eyeBtn.className = 'drag-handle';
            eyeBtn.title = 'Preview theme';
            eyeBtn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#888" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
        <circle cx="12" cy="12" r="3"></circle>
    </svg>
`;
            // HOVER: Preview is now handled by the eye icon on the left of each row
            eyeBtn.addEventListener('mouseenter', async () => {
                try {
                    const allAddons = await browser.management.getAll();
                    const currentActive = allAddons.find(a => a.type === 'theme' && a.enabled);
                    if (currentActive && currentActive.id !== theme.id) {
                        originalThemeId = currentActive.id;
                    }
                    await browser.management.setEnabled(theme.id, true);
                } catch (_err) {
                    // theme cannot be previewed, skip it
                }
            });

            eyeBtn.addEventListener('mouseleave', async () => {
                try {
                    if (originalThemeId) {
                        await browser.management.setEnabled(originalThemeId, true);
                    }
                } catch (_err) {
                    // restore failed, skip it
                }
            });
            const themeBtn = buildMenuItem(theme, activeTheme && activeTheme.id === theme.id);
            themeBtn.style.flex = "1";

            const removeBtn = document.createElement('button');
            removeBtn.textContent = "×";
            removeBtn.className = 'remove-item-btn';
            removeBtn.onclick = () => handleRemoveTheme(theme.id, groupName);

            row.appendChild(eyeBtn);
            row.appendChild(themeBtn);
            row.appendChild(removeBtn);
            const tooltip = document.createElement('span');
            tooltip.className = 'drag-tooltip';
            tooltip.textContent = 'drag to move between groups';
            row.appendChild(tooltip);

            // Tag each row with its group so drop handler knows where the drag started
            row.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('fromGroup', groupName);
            });
            row.addEventListener('dragover', (e) => { e.preventDefault(); });
            row.addEventListener('drop', async (e) => {
                e.preventDefault();
                if (e.dataTransfer.getData('groupDrag')) return; // let groupWrapper handle group reorders
                e.stopPropagation();
                const themeId = e.dataTransfer.getData('text/plain');
                const themeName = e.dataTransfer.getData('themeName');
                const fromGroup = e.dataTransfer.getData('fromGroup');
                if (!themeId || themeId === theme.id) return;
                if (fromGroup === groupName) {
                    await reorderThemeInGroup(themeId, theme.id, groupName, themeGroups[groupName]);
                } else {
                    await moveThemeToGroup(themeId, themeName, groupName);
                }
            });

            contentArea.appendChild(row);
        });

        // Click to Toggle Logic
        header.addEventListener('click', () => {
            if (contentArea.style.display === "none") {
                contentArea.style.display = "block";
                header.textContent = groupName;
            } else {
                contentArea.style.display = "none";
                header.textContent = groupName + " (" + themeGroups[groupName].length + ")";
            }
        });

        const groupDragHandle = document.createElement('span');
        groupDragHandle.className = 'group-drag-handle';
        groupDragHandle.innerHTML = '⠿';
        groupDragHandle.title = 'Drag to reorder group';
        groupDragHandle.draggable = true;
        groupDragHandle.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('groupDrag', groupName);
            e.dataTransfer.setDragImage(groupWrapper, 15, 15);
            e.stopPropagation();
        });

        headerContainer.appendChild(groupDragHandle);
        headerContainer.appendChild(header);
        headerContainer.appendChild(renameBtn);
        headerContainer.appendChild(delGroupBtn);
        groupWrapper.appendChild(headerContainer);
        groupWrapper.appendChild(contentArea);
        currentDiv.appendChild(groupWrapper);
    }

    // 5. Add "Ungrouped" themes at the bottom
    const ungroupedHeaderRow = document.createElement('div');
    ungroupedHeaderRow.className = 'ungrouped-header-row';
    const otherHeader = document.createElement('h3');
    otherHeader.textContent = "Ungrouped Themes";
    ungroupedHeaderRow.appendChild(otherHeader);

    const ungroupedThemes = installedThemes.filter(theme => {
        if (savedThemes.some(s => s.id === theme.id)) return false;
        return !q || theme.name.toLowerCase().includes(q);
    });

    // Sort ungrouped themes — use custom order if set, otherwise global sort
    if (ungroupedOrder) {
        ungroupedThemes.sort((a, b) => {
            const ai = ungroupedOrder.indexOf(a.id);
            const bi = ungroupedOrder.indexOf(b.id);
            if (ai === -1) return 1;
            if (bi === -1) return -1;
            return ai - bi;
        });
    } else {
        ungroupedThemes.sort((a, b) => {
            if (currentSort === 'az') return a.name.localeCompare(b.name);
            if (currentSort === 'oldest') return installedThemes.indexOf(a) - installedThemes.indexOf(b);
            return installedThemes.indexOf(b) - installedThemes.indexOf(a);
        });
    }

    if (ungroupedOrder) {
        const ungroupedCustomTag = document.createElement('button');
        ungroupedCustomTag.textContent = 'Custom order';
        ungroupedCustomTag.className = 'group-custom-tag ungrouped-custom-tag';
        ungroupedCustomTag.title = 'Ungrouped themes are in custom order — click to reset';
        ungroupedCustomTag.onclick = async () => {
            await browser.storage.local.set({ ungroupedOrder: null });
            initializePopup();
        };
        ungroupedHeaderRow.appendChild(ungroupedCustomTag);
    }

    currentDiv.appendChild(ungroupedHeaderRow);

    ungroupedThemes.forEach(theme => {
        const row = document.createElement('div');
        row.className = 'theme-item-row';

        const eyeBtn = document.createElement('span');
        eyeBtn.className = 'drag-handle';
        eyeBtn.title = 'Preview theme';
        eyeBtn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#888" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
        <circle cx="12" cy="12" r="3"></circle>
    </svg>
`;
        // HOVER: Preview is now handled by the eye icon on the left of each row
        eyeBtn.addEventListener('mouseenter', async () => {
            try {
                const allAddons = await browser.management.getAll();
                const currentActive = allAddons.find(a => a.type === 'theme' && a.enabled);
                if (currentActive && currentActive.id !== theme.id) {
                    originalThemeId = currentActive.id;
                }
                await browser.management.setEnabled(theme.id, true);
            } catch (_err) {
                // theme cannot be previewed, skip it
            }
        });

        eyeBtn.addEventListener('mouseleave', async () => {
            try {
                if (originalThemeId) {
                    await browser.management.setEnabled(originalThemeId, true);
                }
            } catch (_err) {
                // restore failed, skip it
            }
        });
        const themeBtn = buildMenuItem(theme, activeTheme && activeTheme.id === theme.id);
        themeBtn.style.flex = "1";

        const addToGroupBtn = document.createElement('span');
        addToGroupBtn.textContent = '+';
        addToGroupBtn.className = 'add-to-group-btn';
        addToGroupBtn.title = 'Add to group';
        addToGroupBtn.onclick = (e) => {
            e.stopPropagation();
            showGroupDropdown(theme, addToGroupBtn, Object.keys(themeGroups));
        };

        row.appendChild(eyeBtn);
        row.appendChild(themeBtn);
        row.appendChild(addToGroupBtn);
        const tooltip = document.createElement('span');
        tooltip.className = 'drag-tooltip';
        tooltip.textContent = 'drag to reorder';
        row.appendChild(tooltip);

        row.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('fromGroup', '__ungrouped__');
        });
        row.addEventListener('dragover', (e) => { e.preventDefault(); });
        row.addEventListener('drop', async (e) => {
            e.preventDefault();
            if (e.dataTransfer.getData('groupDrag')) return;
            e.stopPropagation();
            const draggedId = e.dataTransfer.getData('text/plain');
            const fromGroup = e.dataTransfer.getData('fromGroup');
            if (!draggedId || draggedId === theme.id) return;
            if (fromGroup === '__ungrouped__') {
                await reorderUngroupedTheme(draggedId, theme.id, ungroupedThemes);
            }
        });

        currentDiv.appendChild(row);

    });

    document.documentElement.scrollTop = scrollTop;
    document.body.scrollTop = scrollTop;
}

/**
 * Creates a clickable theme button with hover-preview and click-lock behavior.
 *
 * Behavior:
 * - mouseenter: temporarily enables the hovered theme (preview).
 * - mouseleave: restores the previously active theme (unless user clicked to lock).
 * - click: locks the selected theme and autofills #theme-name for saving.
 *
 * @param {Object} theme - A theme add-on object from browser.management.getAll().
 * @param {string} theme.id - The add-on ID for the theme.
 * @param {string} theme.name - The display name of the theme.
 * @returns {HTMLButtonElement} The button element representing the theme.
 */
function buildMenuItem(theme, isActive = false) {
    const btn = document.createElement('button');
    btn.textContent = theme.name;
    btn.className = 'theme-button' + (isActive ? ' active-theme' : '');

    // prompted claude to guide me on how to implement a drag and drop feature
    // drag setup - stores the theme id so the drop target knows what got dragged
    btn.draggable = true;

    btn.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', theme.id);
        e.dataTransfer.setData('themeName', theme.name);
        btn.classList.add('dragging');
    });

    btn.addEventListener('dragend', () => {
        btn.classList.remove('dragging');
    });

    // HOVER: Preview is now handled by the eye icon on the left of each row


    // CLICK: Lock it in permanently
    btn.addEventListener('click', async () => {
        originalThemeId = null; // Clear the memory so 'mouseleave' doesn't undo the click
        lockedInTheme = theme;

        await browser.management.setEnabled(theme.id, true);

        // Autofill the name box for easy saving
        const themeNameInput = document.getElementById('theme-name');
        if (themeNameInput) themeNameInput.value = theme.name;

        initializePopup();
    });

    return btn;
}

/**
 * Saves the currently locked-in theme to a group in browser local storage.
 *
 * Storage format:
 * - Key: "userThemes"
 * - Value: Array of objects like: { id, name, group }
 *
 * UI effects:
 * - Updates the first .status element with a success/error message.
 * - Rebuilds the popup UI by calling initializePopup().
 *
 * @async
 * @returns {Promise<void>} Resolves after saving and refreshing the UI.
 */
async function saveTheme() {
    const groupInput = document.getElementById('group-name').value;
    const groupName = groupInput || "General";
    const statusMsg = document.querySelector('.status');

    if (!lockedInTheme) {
        statusMsg.textContent = "Click a theme button first!";
        return;
    }

    const data = await browser.storage.local.get('userThemes');
    const savedList = data.userThemes || [];

    const newEntry = {
        id: lockedInTheme.id,
        name: lockedInTheme.name,
        group: groupName
    };

    savedList.push(newEntry);
    await browser.storage.local.set({ userThemes: savedList }); //

    statusMsg.textContent = "Saved to " + groupName + "!";
    const panel = document.getElementById('add-group-panel');
    const toggle = document.getElementById('add-group-toggle');
    if (panel) panel.style.display = 'none';
    if (toggle) toggle.classList.remove('active');
    initializePopup(); // Refresh the list immediately
}

/**
 * EVENT LISTENERS
 * Connects the buttons in your HTML to the JS logic above.
 */
document.addEventListener('DOMContentLoaded', initializePopup);

const saveBtn = document.getElementById('save-btn');
if (saveBtn) {
    saveBtn.addEventListener('click', saveTheme);
}

const shutdown = document.getElementById('shutdown');
if (shutdown) {
    shutdown.addEventListener('click', () => window.close());
}

const searchToggle = document.getElementById('search-toggle');
const searchPanel = document.getElementById('search-panel');
if (searchToggle && searchPanel) {
    searchToggle.addEventListener('click', () => {
        const isOpen = searchPanel.style.display === 'flex';
        searchPanel.style.display = isOpen ? 'none' : 'flex';
        searchToggle.classList.toggle('active', !isOpen);
        if (!isOpen) {
            // focus the input when the bar opens
            const input = document.getElementById('search-input');
            if (input) input.focus();
        } else {
            // clear the search when the bar closes
            searchQuery = '';
            const input = document.getElementById('search-input');
            if (input) input.value = '';
            initializePopup();
        }
    });
}

const searchInput = document.getElementById('search-input');
if (searchInput) {
    searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value;
        initializePopup();
    });
}

const addGroupToggle = document.getElementById('add-group-toggle');
const addGroupPanel = document.getElementById('add-group-panel');
if (addGroupToggle && addGroupPanel) {
    addGroupToggle.addEventListener('click', () => {
        const isOpen = addGroupPanel.style.display === 'block';
        addGroupPanel.style.display = isOpen ? 'none' : 'block';
        addGroupToggle.classList.toggle('active', !isOpen);
    });
}

/**
 * Deletes all saved themes belonging to the provided group name.
 * Prompts the user for confirmation before deletion.
 *
 * @async
 * @param {string} groupName - The group/category name (usually uppercase in your UI).
 * @returns {Promise<void>} Resolves after updating storage and refreshing the UI.
 */
async function handleDeleteGroup(groupName) {
    // A simple pop-up to make sure you don't delete your hard work by accident
    const check = confirm("Delete the " + groupName + " group?");

    if (check) {
        // Step 1: Get the current list from Firefox storage
        const data = await browser.storage.local.get('userThemes');
        const savedThemes = data.userThemes || [];

        // Step 2: Sift through the list and keep only the themes in OTHER groups
        // This effectively "deletes" the group you clicked
        const updatedList = savedThemes.filter(function (theme) {
            return theme.group.toUpperCase() !== groupName.toUpperCase();
        });

        // Step 3: Save the new, smaller list back to storage
        await browser.storage.local.set({ userThemes: updatedList });

        // Step 4: Redraw the popup so the group disappears instantly
        initializePopup();
    }
}
/**
 * Renames an existing group by updating all themes that belong to it.
 *
 * @async
 * @param {string} groupName - The current group name to rename.
 * @returns {Promise<void>} Resolves after updating storage and refreshing the UI.
 */
async function handleRenameGroup(groupName) {
    const newName = prompt('Rename "' + groupName + '" to:', groupName);
    if (!newName || newName.trim() === '' || newName.trim().toUpperCase() === groupName.toUpperCase()) return;

    // Step 1: Grab the saved list
    const data = await browser.storage.local.get('userThemes');
    const savedThemes = data.userThemes || [];

    // Step 2: Update the group name on every theme that belongs to this group
    savedThemes.forEach(theme => {
        if (theme.group.toUpperCase() === groupName.toUpperCase()) {
            theme.group = newName.trim();
        }
    });

    // Step 3: Save and refresh the UI (also update groupOrder if the group is in a custom order)
    const gOrder = await browser.storage.local.get('groupOrder');
    if (gOrder.groupOrder) {
        const updatedOrder = gOrder.groupOrder.map(n => n === groupName ? newName.trim().toUpperCase() : n);
        await browser.storage.local.set({ groupOrder: updatedOrder });
    }
    await browser.storage.local.set({ userThemes: savedThemes });
    initializePopup();
}
/**
 * Removes a single theme entry from a specific group.
 * This only removes the matching (themeId + groupName) pair.
 *
 * @async
 * @param {string} themeId - The theme add-on ID to remove from storage.
 * @param {string} groupName - The group/category name that theme belongs to.
 * @returns {Promise<void>} Resolves after updating storage and refreshing the UI.
 */
async function handleRemoveTheme(themeId, groupName) {
    // Step 1: Grab the saved list
    const data = await browser.storage.local.get('userThemes');
    const savedThemes = data.userThemes || [];

    // Step 2: Use .filter to remove ONLY the match for this ID and this Group
    // It says: "Keep the theme if it's a different ID OR in a different group"
    const updatedList = savedThemes.filter(function (theme) {
        const sameId = (theme.id === themeId);
        const sameGroup = (theme.group.toUpperCase() === groupName.toUpperCase());

        // Only return true if it's NOT the exact one we want to remove
        return !(sameId && sameGroup);
    });

    // Step 3: Save and refresh the UI
    await browser.storage.local.set({ userThemes: updatedList });
    initializePopup();
}

/**
 * Moves a theme to a different group, or adds it to the target group if not yet saved.
 *
 * @async
 * @param {string} themeId - The add-on ID of the theme being moved.
 * @param {string} themeName - The display name of the theme being moved.
 * @param {string} targetGroupName - The group name to move the theme into.
 * @returns {Promise<void>} Resolves after updating storage and refreshing the UI.
 */
/**
 * Shows a dropdown on an ungrouped theme row listing existing groups to add to.
 *
 * @param {Object} theme - The theme object being added.
 * @param {HTMLElement} anchor - The button that was clicked (used for positioning).
 * @param {string[]} groupNames - List of existing group names.
 */
function showGroupDropdown(theme, anchor, groupNames) {
    document.querySelectorAll('.group-dropdown').forEach(d => d.remove());

    const dropdown = document.createElement('div');
    dropdown.className = 'group-dropdown';

    if (groupNames.length === 0) {
        const none = document.createElement('div');
        none.className = 'group-dropdown-item group-dropdown-disabled';
        none.textContent = 'No groups yet';
        dropdown.appendChild(none);
    }

    groupNames.forEach(name => {
        const item = document.createElement('div');
        item.className = 'group-dropdown-item';
        item.textContent = name;
        item.onclick = async () => {
            await moveThemeToGroup(theme.id, theme.name, name);
            dropdown.remove();
        };
        dropdown.appendChild(item);
    });

    const newGroupItem = document.createElement('div');
    newGroupItem.className = 'group-dropdown-item group-dropdown-new';
    newGroupItem.textContent = '+ New group...';
    newGroupItem.onclick = async () => {
        dropdown.remove();
        const newName = prompt('Group name:');
        if (newName && newName.trim()) {
            await moveThemeToGroup(theme.id, theme.name, newName.trim());
        }
    };
    dropdown.appendChild(newGroupItem);

    anchor.parentElement.appendChild(dropdown);

    setTimeout(() => {
        document.addEventListener('click', function handler(e) {
            if (!dropdown.contains(e.target)) {
                dropdown.remove();
                document.removeEventListener('click', handler);
            }
        });
    }, 0);
}

/**
 * Saves a new group order to storage after a group drag-drop reorder.
 *
 * @async
 * @param {string} draggedGroupName - The group that was dragged.
 * @param {string} targetGroupName - The group it was dropped onto.
 * @param {string[]} currentOrder - The current ordered list of group names.
 * @returns {Promise<void>}
 */
async function reorderGroup(draggedGroupName, targetGroupName, currentOrder) {
    const order = [...currentOrder];
    const fromIdx = order.indexOf(draggedGroupName);
    const toIdx = order.indexOf(targetGroupName);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
    order.splice(fromIdx, 1);
    order.splice(toIdx, 0, draggedGroupName);
    await browser.storage.local.set({ groupOrder: order });
    initializePopup();
}

/**
 * Reorders a theme within its group after a drag-drop, saving a custom order for that group.
 *
 * @async
 * @param {string} draggedThemeId - The theme that was dragged.
 * @param {string} targetThemeId - The theme it was dropped onto.
 * @param {string} groupName - The group both themes belong to.
 * @param {Object[]} currentGroupThemes - The currently rendered theme objects for the group.
 * @returns {Promise<void>}
 */
async function reorderThemeInGroup(draggedThemeId, targetThemeId, groupName, currentGroupThemes) {
    const data = await browser.storage.local.get('groupThemeOrder');
    const groupThemeOrder = data.groupThemeOrder || {};
    const order = currentGroupThemes.map(t => t.id);
    const fromIdx = order.indexOf(draggedThemeId);
    const toIdx = order.indexOf(targetThemeId);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
    order.splice(fromIdx, 1);
    order.splice(toIdx, 0, draggedThemeId);
    groupThemeOrder[groupName] = order;
    await browser.storage.local.set({ groupThemeOrder });
    initializePopup();
}

/**
 * Reorders a theme in the ungrouped section after a drag-drop.
 *
 * @async
 * @param {string} draggedThemeId - The theme that was dragged.
 * @param {string} targetThemeId - The theme it was dropped onto.
 * @param {Object[]} currentUngrouped - The currently rendered ungrouped theme objects.
 * @returns {Promise<void>}
 */
async function reorderUngroupedTheme(draggedThemeId, targetThemeId, currentUngrouped) {
    const order = currentUngrouped.map(t => t.id);
    const fromIdx = order.indexOf(draggedThemeId);
    const toIdx = order.indexOf(targetThemeId);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
    order.splice(fromIdx, 1);
    order.splice(toIdx, 0, draggedThemeId);
    await browser.storage.local.set({ ungroupedOrder: order });
    initializePopup();
}

// move theme drop handler
async function moveThemeToGroup(themeId, themeName, targetGroupName) {
    const data = await browser.storage.local.get('userThemes');
    const savedThemes = data.userThemes || [];

    const existingIndex = savedThemes.findIndex(t => t.id === themeId);

    if (existingIndex !== -1) {
        savedThemes[existingIndex].group = targetGroupName;
    } else {
        savedThemes.push({
            id: themeId,
            name: themeName,
            group: targetGroupName
        });
    }

    await browser.storage.local.set({ userThemes: savedThemes });
    initializePopup();
}
// AI prompt: jest isn't using the popup.js for my test file what do I need?
/* eslint-disable no-undef */
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        initializePopup, buildMenuItem, saveTheme, handleDeleteGroup, handleRemoveTheme, handleRenameGroup, reorderGroup, reorderThemeInGroup, reorderUngroupedTheme,
        getOriginalThemeId: () => originalThemeId,
        getLockedInTheme: () => lockedInTheme,
        setOriginalThemeId: (v) => { originalThemeId = v; },
        setLockedInTheme: (v) => { lockedInTheme = v; },
        setSearchQuery: (v) => { searchQuery = v; },
    };
}
/* eslint-enable no-undef */