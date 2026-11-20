const { execFile } = require('child_process');
const { constants, promises: fs } = require('fs');
const os = require('os');
const path = require('path');

async function findExecutable(configuredPath) {
    if (configuredPath) {
        if (!path.isAbsolute(configuredPath)) {
            throw new Error('Set cryptor.sops.path to the absolute path of the SOPS executable.');
        }
        return configuredPath;
    }

    // Search PATH directly so the source file's directory cannot shadow SOPS on Windows.
    const executableName = process.platform === 'win32' ? 'sops.exe' : 'sops';
    for (const entry of (process.env.PATH || '').split(path.delimiter)) {
        const directory = entry.replace(/^"(.*)"$/, '$1');
        if (path.isAbsolute(directory)) {
            const candidate = path.join(directory, executableName);
            const stat = await fs.stat(candidate).catch(() => undefined);
            if (stat && stat.isFile() && await fs.access(candidate, constants.X_OK).then(() => true, () => false)) {
                return candidate;
            }
        }
    }

    throw new Error('SOPS was not found on PATH. Set cryptor.sops.path to its executable.');
}

function getOutputPath(operation, source) {
    const { dir, base, ext, name } = path.parse(source);
    // Keep the format suffix, including a bare .env file that path.extname treats as a dotfile.
    const format = base.toLowerCase() === '.env' ? base : ext;
    const stem = base.slice(0, base.length - format.length);
    if (operation === 'encrypt') {
        return path.join(dir, `${stem}.sops${format}`);
    }
    if (ext === '.sops') {
        return path.join(dir, `${name}.dec`);
    }
    return path.join(dir, `${stem.replace(/\.sops$/, '')}.dec${format}`);
}

function run(executable, operation, source, output) {
    const args = [`--${operation}`, '--output', output, '--', source];
    const options = { cwd: path.dirname(source), windowsHide: true };
    return new Promise((resolve, reject) => {
        execFile(executable, args, options, (error, stdout, stderr) => {
            if (error && error.code === 'ENOENT') {
                reject(new Error(`Could not run SOPS at ${executable}. Check cryptor.sops.path.`));
            } else if (error) {
                reject(new Error(stderr.trim() || error.message));
            } else {
                resolve(undefined);
            }
        });
    });
}

/**
 * @param {'encrypt' | 'decrypt'} operation
 * @param {string} source
 * @param {string} configuredPath
 */
async function transformFile(operation, source, configuredPath) {
    if (!(await fs.stat(source)).isFile()) {
        throw new Error('Select a file to run SOPS.');
    }

    const executable = await findExecutable(configuredPath);
    const output = getOutputPath(operation, source);
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cryptor-sops-'));
    const temporaryOutput = path.join(temporaryDirectory, 'output');
    try {
        await fs.writeFile(temporaryOutput, '', { flag: 'wx', mode: 0o600 });
        await run(executable, operation, source, temporaryOutput);
        await fs.copyFile(temporaryOutput, output, constants.COPYFILE_EXCL);
    } catch (error) {
        if (error.code === 'EEXIST' && error.dest === output) {
            throw new Error(`The output file already exists (${output}).`);
        }
        throw error;
    } finally {
        await fs.unlink(temporaryOutput).catch(error => {
            if (error.code !== 'ENOENT') throw error;
        });
        await fs.rmdir(temporaryDirectory);
    }

    return output;
}

module.exports = { transformFile };
