const { predefinedVariableNames } = require('../../src/toolEnvironment.js');

const variablesReference = 'https://raw.githubusercontent.com/microsoft/vscode-docs/main/docs/reference/variables-reference.md';

function comparePredefinedVariables(markdown) {
    const section = markdown.split(/^## Predefined variables[ \t]*\r?$/m)[1];
    const table = section && section.split(/^#{1,6} /m)[0];
    const names = new Set();

    for (const row of (table || '').matchAll(/^\|([^|\r\n]+)\|/gm)) {
        const variable = /\$\{([^{}]+)\}/.exec(row[1]);
        if (variable) names.add(variable[1]);
    }
    if (!names.size) throw new Error('Could not read the predefined-variable table.');

    const supported = new Set(predefinedVariableNames);
    return {
        added: [...names].filter(name => !supported.has(name)),
        removed: [...supported].filter(name => !names.has(name)),
    };
}

async function checkPredefinedVariables() {
    const response = await fetch(variablesReference, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`VS Code documentation returned HTTP ${response.status}.`);

    const { added, removed } = comparePredefinedVariables(await response.text());
    if (added.length) console.warn(`::warning::New VS Code predefined variables to review: ${added.join(', ')}`);
    if (removed.length) console.warn(`::warning::Variables missing from the VS Code table: ${removed.join(', ')}`);

    if (added.length || removed.length) process.exitCode = 1;
    else console.log('Cryptor matches the VS Code predefined-variable table.');
}

if (require.main === module) {
    checkPredefinedVariables().catch(error => {
        console.warn(`::warning::Could not check VS Code variables: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { comparePredefinedVariables };
