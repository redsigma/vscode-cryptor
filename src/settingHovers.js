const vscode = require('vscode');

/**
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @param {Map<string, Record<string, string>>} descriptions
 */
function provideHover(document, position, descriptions) {
    const range = document.getWordRangeAtPosition(position, /\$\{[^{}\r\n]+\}/g);
    if (!range) return;

    const placeholder = document.getText(range);
    const offset = document.offsetAt(range.start);
    // Scan JSONC tokens to handle comments and values on a different line from their key.
    const tokens = /\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:[^"\\\r\n]|\\.)*"|[^\s]/g;
    const text = document.getText();
    let previous = '';
    let key = '';
    let match;

    while ((match = tokens.exec(text)) && match.index <= offset) {
        const token = match[0];
        if (token.startsWith('//') || token.startsWith('/*')) continue;

        if (offset < tokens.lastIndex) {
            if (previous !== ':' || !token.startsWith('"') || !key.startsWith('"')) return;

            const variables = descriptions.get(key.slice(1, -1));
            const description = variables && variables[placeholder.slice(2, -1)];
            if (typeof description === 'string') {
                return new vscode.Hover(new vscode.MarkdownString(`\`${placeholder}\` ${description}`), range);
            }
            return;
        }

        key = previous;
        previous = token;
    }
}

/**
 * @param {Record<string, Record<string, string>>} placeholdersBySetting
 */
function registerSettingHovers(placeholdersBySetting) {
    const selector = { language: 'jsonc', pattern: '**/{settings,defaultSettings}.json' };
    const descriptions = new Map(Object.entries(placeholdersBySetting));
    return vscode.languages.registerHoverProvider(selector, {
        provideHover: (document, position) => provideHover(document, position, descriptions),
    });
}

module.exports = { registerSettingHovers };
