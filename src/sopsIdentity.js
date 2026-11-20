const path = require('path');
const vscode = require('vscode');

async function selectSopsAgeIdentity() {
    const input = vscode.window.createInputBox();
    input.title = 'SOPS needs a matching age identity';
    input.prompt = 'Paste your private age identity or use the folder button to choose an identity file.';
    input.placeholder = 'AGE-SECRET-KEY-1…';
    input.password = true;
    input.ignoreFocusOut = true;
    input.buttons = [{
        iconPath: new vscode.ThemeIcon('folder-opened'),
        tooltip: 'Choose an age identity file…',
    }];

    /** @type {{ key: string } | 'browse' | undefined} */
    const choice = await new Promise(resolve => {
        input.onDidAccept(() => {
            const key = input.value.trim();
            if (!/^AGE-SECRET-KEY-1[A-Z0-9]+$/.test(key)) {
                input.validationMessage = 'Enter a private age identity beginning with AGE-SECRET-KEY-1.';
                return;
            }
            resolve({ key });
            input.hide();
        });
        input.onDidChangeValue(() => { input.validationMessage = undefined; });
        input.onDidTriggerButton(() => {
            resolve('browse');
            input.hide();
        });
        input.onDidHide(() => resolve(undefined));
        input.show();
    });
    input.dispose();
    if (choice !== 'browse') return choice;

    const files = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: 'Use age identity file',
    });
    if (!files || !files.length) return;
    const file = files[0].fsPath;
    if (!path.isAbsolute(file)) {
        throw new Error('Choose an age identity file with an absolute path on the extension host.');
    }
    return { file };
}

module.exports = { selectSopsAgeIdentity };
