import { exec } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as process from 'node:process';
import * as path from 'node:path';
import * as util from 'node:util';
import { s as semverExports } from './semver.mjs';

const isFilePath = (cmd) => {
  return cmd.includes(path.sep) ? path.resolve(cmd) : void 0;
};
const access = async (filePath) => {
  try {
    await fs.access(filePath);
    return filePath;
  } catch (_error) {
    return void 0;
  }
};
const isExecutable = async (absPath, options = {}) => {
  const envVars = options.env || process.env;
  const extension = (envVars.PATHEXT || "").split(path.delimiter).concat("");
  const bins = await Promise.all(extension.map(async (ext) => access(absPath + ext.toLowerCase())));
  return bins.find((bin) => !!bin);
};
const getDirsToWalkThrough = (options) => {
  const envVars = options.env || process.env;
  const envName = process.platform === "win32" ? "Path" : "PATH";
  const envPath = envVars[envName] || "";
  return envPath.split(path.delimiter).concat(options.include || []).filter((p) => !(options.exclude || []).includes(p));
};
async function lookPath(command, opt = {}) {
  const directPath = isFilePath(command);
  if (directPath) return isExecutable(directPath, opt);
  const dirs = getDirsToWalkThrough(opt);
  const bins = await Promise.all(dirs.map(async (dir) => isExecutable(path.join(dir, command), opt)));
  return bins.find((bin) => !!bin);
}

class BuildAgentBase {
  get sourceDir() {
    return this.getVariableAsPath(this.sourceDirVariable)?.replace(/\\/g, "/");
  }
  get tempDir() {
    return this.getVariableAsPath(this.tempDirVariable);
  }
  get cacheDir() {
    return this.getVariableAsPath(this.cacheDirVariable);
  }
  addPath(inputPath) {
    const envName = process.platform === "win32" ? "Path" : "PATH";
    const newPath = inputPath + path.delimiter + process.env[envName];
    this.debug(`new Path: ${newPath}`);
    process.env[envName] = newPath;
    process.env.Path = newPath;
    this.info(`Updated PATH: ${process.env[envName]}`);
  }
  getInput(input, required) {
    const inputProp = input.replace(/ /g, "_").toUpperCase();
    const val = this.getVariable(`INPUT_${inputProp}`);
    if (required && !val) {
      throw new Error(`Input required and not supplied: ${inputProp}`);
    }
    return val.trim();
  }
  getBooleanInput(input, required) {
    const inputValue = this.getInput(input, required);
    return (inputValue || "false").toLowerCase() === "true";
  }
  getDelimitedInput(input, delimiter, required) {
    return this.getInput(input, required).split(delimiter).filter((x) => {
      if (x) {
        return x.trim();
      }
    });
  }
  getListInput(input, required) {
    return this.getDelimitedInput(input, "\n", required);
  }
  getVariable(name) {
    const value = (process.env[name] || "").trim();
    this.debug(`getVariable - ${name}: ${value}`);
    return value.trim();
  }
  getVariableAsPath(name) {
    return path.resolve(path.normalize(this.getVariable(name)));
  }
  /**
   * Replaces environment variable references in a string with their values.
   * Supports both $VAR and ${VAR} formats.
   * Ignores invalid patterns like ${} or non-existing variables (replaced with empty string).
   *
   * @param pattern - The input string containing env variable placeholders.
   * @returns The string with env variables expanded.
   */
  getExpandedString(pattern) {
    const expanded = pattern.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*|{([a-zA-Z_][a-zA-Z0-9_]*)})/g, (_, whole, braced) => {
      const name = braced ?? whole;
      const value = process.env[name.toUpperCase()];
      return value !== void 0 ? value : "";
    });
    this.debug(`getExpandedString - ${pattern}: ${expanded}`);
    return expanded;
  }
  async directoryExists(dir) {
    try {
      await fs.access(dir);
      return (await fs.stat(dir)).isDirectory();
    } catch (_error) {
      return false;
    }
  }
  async removeDirectory(dir) {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 1e3 });
  }
  async fileExists(file) {
    try {
      await fs.access(file);
      return (await fs.stat(file)).isFile();
    } catch (_error) {
      return false;
    }
  }
  async cacheToolDirectory(sourceDir, tool, version) {
    if (!tool) {
      throw new Error("tool is a required parameter");
    }
    if (!version) {
      throw new Error("version is a required parameter");
    }
    if (!sourceDir) {
      throw new Error("sourceDir is a required parameter");
    }
    const cacheRoot = this.cacheDir;
    if (!cacheRoot) {
      this.debug("cache root not set");
      return "";
    }
    version = semverExports.clean(version) || version;
    const destPath = path.join(cacheRoot, tool, version);
    if (await this.directoryExists(destPath)) {
      this.debug(`Destination directory ${destPath} already exists, removing`);
      await this.removeDirectory(destPath);
    }
    this.debug(`Copying ${sourceDir} to ${destPath}`);
    await fs.mkdir(destPath, { recursive: true });
    await fs.cp(sourceDir, destPath, { recursive: true, force: true });
    this.debug(`Caching ${tool}@${version} from ${sourceDir}`);
    return destPath;
  }
  async findLocalTool(toolName, versionSpec) {
    if (!toolName) {
      throw new Error("toolName is a required parameter");
    }
    if (!versionSpec) {
      throw new Error("versionSpec is a required parameter");
    }
    const cacheRoot = this.cacheDir;
    if (!cacheRoot) {
      this.debug("cache root not set");
      return null;
    }
    versionSpec = semverExports.clean(versionSpec) || versionSpec;
    this.info(`Looking for local tool ${toolName}@${versionSpec}`);
    const toolPath = path.join(cacheRoot, toolName, versionSpec);
    if (!await this.directoryExists(toolPath)) {
      this.info(`Directory ${toolPath} not found`);
      return null;
    } else {
      this.info(`Found tool ${toolName}@${versionSpec} at ${toolPath}`);
    }
    return toolPath;
  }
  async exec(cmd, args) {
    const exec$1 = util.promisify(exec);
    try {
      const commandOptions = { maxBuffer: 1024 * 1024 * 10 };
      const { stdout, stderr } = await exec$1(`${cmd} ${args.join(" ")}`, commandOptions);
      return {
        code: 0,
        error: null,
        stderr,
        stdout
      };
    } catch (e) {
      const error = e;
      return {
        code: error.code,
        error,
        stderr: error.stderr,
        stdout: error.stdout
      };
    }
  }
  async which(tool, _check) {
    this.debug(`looking for tool '${tool}' in PATH`);
    let toolPath = await lookPath(tool);
    if (toolPath) {
      toolPath = path.resolve(toolPath);
      this.debug(`found tool '${tool}' in PATH: ${toolPath}`);
      return toolPath;
    }
    throw new Error(`Unable to locate executable file: ${tool}`);
  }
}

export { BuildAgentBase as B };
//# sourceMappingURL=agents.mjs.map
