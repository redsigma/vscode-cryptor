const vscode = require('vscode');

/**
 * A manual entry label gives the picker a visible way to enter a secret.
 * Without that action, dismissing the picker opens the masked input.
 *
 * @template {vscode.QuickPickItem} T
 * @param {T[]} items
 * @param {vscode.QuickPickOptions} pickerOptions
 * @param {vscode.InputBoxOptions} inputOptions
 * @param {string} [manualEntryLabel]
 * @returns {Promise<{ item: T } | { value: string } | undefined>}
 */
async function pickOrEnterCredential(items, pickerOptions, inputOptions, manualEntryLabel) {
    if (items.length) {
        const manualEntry = manualEntryLabel && { label: manualEntryLabel, alwaysShow: true };
        const choices = manualEntry ? [...items, manualEntry] : items;
        const selected = await vscode.window.showQuickPick(choices, pickerOptions);
        if (selected && selected !== manualEntry) return { item: /** @type {T} */ (selected) };
        if (!selected && manualEntry) return;
    }

    const value = await vscode.window.showInputBox(Object.assign({}, inputOptions, { password: true }));
    if (value !== undefined) return { value };
}

module.exports = { pickOrEnterCredential };
