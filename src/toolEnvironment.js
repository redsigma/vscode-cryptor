const os = require('os');
const path = require('path');

function withWorkspaceFolder(resolve) {
    return (context, name) => {
        const folder = name === undefined
            ? context.workspaceFolder
            : context.folders.find(item => item.name === name);
        if (name !== undefined && !folder) return undefined;
        return resolve(folder && folder.uri.fsPath, context);
    };
}

const workspaceFolder = withWorkspaceFolder(folderPath => folderPath);
const workspaceFolderBasename = withWorkspaceFolder(folderPath => folderPath && path.basename(folderPath));
const pathSeparator = () => path.sep;

// The build checks these names against VS Code's published predefined-variable table.
const predefinedVariables = new Map(Object.entries({
    userHome: () => os.homedir(),
    workspaceFolder,
    workspaceFolderBasename,
    file: ({ uri }) => uri.fsPath,
    fileWorkspaceFolder: ({ fileFolderPath }) => fileFolderPath,
    relativeFile: withWorkspaceFolder((folderPath, { uri }) => folderPath ? path.relative(folderPath, uri.fsPath) : uri.fsPath),
    relativeFileDirname: withWorkspaceFolder((folderPath, { file }) => folderPath ? path.relative(folderPath, file.dir) || '.' : file.dir),
    fileBasename: ({ file }) => file.base,
    fileBasenameNoExtension: ({ file }) => file.name,
    fileExtname: ({ file }) => file.ext,
    fileDirname: ({ file }) => file.dir,
    fileDirnameBasename: ({ file }) => path.basename(file.dir),
    cwd: withWorkspaceFolder(folderPath => folderPath || process.cwd()),
    lineNumber: ({ selection }) => selection && String(selection.end.line + 1),
    columnNumber: ({ selection }) => selection && String(selection.end.character + 1),
    selectedText: ({ editor, selection }) => selection && !selection.isEmpty ? editor.document.getText(selection) : undefined,
    execPath: () => process.env.VSCODE_EXEC_PATH,
    defaultBuildTask: resolveDefaultBuildTask,
    pathSeparator,
    '/': pathSeparator,
}));

const additionalVariables = new Map(Object.entries({
    workspaceRoot: workspaceFolder,
    workspaceRootFolderName: workspaceFolderBasename,
    fileWorkspaceFolderBasename: ({ fileFolderPath }) => fileFolderPath && path.basename(fileFolderPath),
    execInstallFolder: ({ vscode }) => vscode.env.appRoot,
    env: (context, name) => name ? process.env[name] || '' : undefined,
    config: ({ vscode, uri }, name) => {
        if (!name) return undefined;
        const value = vscode.workspace.getConfiguration(undefined, uri).get(name);
        if (['string', 'number', 'boolean'].includes(typeof value)) return String(value);
    },
    extensionInstallFolder: ({ vscode }, id) => {
        const extension = id && vscode.extensions.getExtension(id);
        return extension ? extension.extensionPath : undefined;
    },
}));

function resolveVariable(name, context) {
    const separator = name.indexOf(':');
    const kind = separator < 0 ? name : name.slice(0, separator);
    const argument = separator < 0 ? undefined : name.slice(separator + 1);
    const resolve = predefinedVariables.get(kind) || additionalVariables.get(kind);
    return resolve && resolve(context, argument);
}

/**
 * @param {import('vscode').Uri} uri
 * @returns {(value: string, location: string) => Promise<string>}
 */
function createVariableExpander(uri) {
    const vscode = require('vscode');
    const folders = vscode.workspace.workspaceFolders || [];
    const fileFolder = vscode.workspace.getWorkspaceFolder(uri);
    const editor = vscode.window.activeTextEditor;
    const context = {
        vscode,
        uri,
        folders,
        workspaceFolder: fileFolder || (folders.length === 1 ? folders[0] : undefined),
        fileFolderPath: fileFolder && fileFolder.uri.fsPath,
        file: path.parse(uri.fsPath),
        editor,
        selection: editor && editor.selection,
    };

    const variablePattern = /\$\{[^{}]+\}/g;
    const replacements = new Map();
    return async (value, location) => {
        for (const token of value.match(variablePattern) || []) {
            if (replacements.has(token)) continue;
            const resolved = await resolveVariable(token.slice(2, -1), context);
            if (resolved === undefined) {
                throw new Error(`Cannot resolve ${token} in ${location}.`);
            }
            replacements.set(token, resolved);
        }
        return value.replace(variablePattern, token => replacements.get(token));
    };
}

/**
 * @param {Record<string, string>} configured
 * @param {import('vscode').Uri} uri
 * @param {string} setting
 */
async function resolveToolEnvironment(configured, uri, setting) {
    if (!configured || typeof configured !== 'object' || Array.isArray(configured)) {
        throw new Error(`${setting} must be an object with string values.`);
    }

    const result = Object.create(null);
    const entries = Object.entries(configured);
    if (!entries.length) return result;

    const expand = createVariableExpander(uri);
    for (const [name, value] of entries) {
        if (!name || /[=\0]/.test(name) || typeof value !== 'string') {
            throw new Error(`${setting} must map valid environment variable names to strings.`);
        }

        const expanded = await expand(value, `${setting} for ${name}`);
        if (expanded.includes('\0')) throw new Error(`${setting} contains an invalid value for ${name}.`);
        result[name] = expanded;
    }

    return result;
}

async function resolveDefaultBuildTask({ vscode }) {
    const tasks = await vscode.tasks.fetchTasks();
    const builds = tasks.filter(task => task.group && task.group.id === vscode.TaskGroup.Build.id);
    const defaults = builds.filter(task => task.group.isDefault);
    if (defaults.length === 1) return defaults[0].name;

    const candidates = defaults.length ? defaults : builds;
    if (!candidates.length) return undefined;

    const selected = await vscode.window.showQuickPick(
        candidates.map(task => ({ label: task.name, description: task.source })),
        { placeHolder: 'Select the build task' }
    );
    return selected && selected.label;
}

/** @param {Record<string, string>} overrides */
function mergeToolEnvironment(overrides) {
    const env = Object.create(null);
    for (const [name, value] of Object.entries(process.env).concat(Object.entries(overrides))) {
        env[process.platform === 'win32' ? name.toUpperCase() : name] = value;
    }
    return env;
}

module.exports = { createVariableExpander, resolveToolEnvironment, mergeToolEnvironment, predefinedVariableNames: Object.freeze([...predefinedVariables.keys()]) };
