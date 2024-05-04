import os from 'os';
import path from 'path';

import fs from 'fs-extra';
import temp from 'temp';

import {BuildResult, ExecutionOptions, ExecutionParams} from '../../types/compilation/compilation.interfaces.js';
import {
    BasicExecutionResult,
    ConfiguredRuntimeTool,
    ConfiguredRuntimeTools,
    ExecutableExecutionOptions,
    RuntimeToolType,
    UnprocessedExecResult,
} from '../../types/execution/execution.interfaces.js';
import {assert, unwrap} from '../assert.js';
import {CompilationEnvironment} from '../compilation-env.js';
import * as exec from '../exec.js';
import {logger} from '../logger.js';
import {Packager} from '../packager.js';
import {propsFor} from '../properties.js';
import {HeaptrackWrapper} from '../runtime-tools/heaptrack-wrapper.js';
import * as utils from '../utils.js';

import {IExecutionEnvironment} from './execution-env.interfaces.js';

export class LocalExecutionEnvironment implements IExecutionEnvironment {
    protected packager: Packager;
    protected dirPath: string;
    protected buildResult: BuildResult | undefined;
    protected environment: CompilationEnvironment;
    protected timeoutMs: number;
    protected sandboxType: string;
    protected useSanitizerEnvHints: boolean;
    protected maxExecOutputSize: number;

    static get key() {
        return 'local';
    }

    constructor(environment: CompilationEnvironment) {
        this.environment = environment;
        this.timeoutMs = this.environment.ceProps('binaryExecTimeoutMs', 2000);
        this.maxExecOutputSize = this.environment.ceProps('max-executable-output-size', 32 * 1024);

        this.useSanitizerEnvHints = true;

        const execProps = propsFor('execution');
        this.sandboxType = execProps('sandboxType', 'none');

        this.packager = new Packager();
        this.dirPath = 'not initialized';
    }

    protected async executableGet(hash: string, destinationFolder: string) {
        const result = await this.environment.executableCache.get(hash);
        if (!result.hit) return null;
        const filepath = destinationFolder + '/' + hash;
        await fs.writeFile(filepath, unwrap(result.data));
        return filepath;
    }

    protected async loadPackageWithExecutable(hash: string, dirPath: string): Promise<BuildResult> {
        const compilationResultFilename = 'compilation-result.json';
        try {
            const startTime = process.hrtime.bigint();
            const outputFilename = await this.executableGet(hash, dirPath);
            if (outputFilename) {
                logger.debug(`Using cached package ${outputFilename}`);
                await this.packager.unpack(outputFilename, dirPath);
                const buildResultsBuf = await fs.readFile(path.join(dirPath, compilationResultFilename));
                const buildResults = JSON.parse(buildResultsBuf.toString('utf8'));
                // logger.info(hash + ' => ' + JSON.stringify(buildResults));
                const endTime = process.hrtime.bigint();

                let inputFilename = '';
                if (buildResults.inputFilename) {
                    inputFilename = path.join(dirPath, path.basename(buildResults.inputFilename));
                }

                let executableFilename = '';
                if (buildResults.executableFilename) {
                    const execPath = utils.maskRootdir(buildResults.executableFilename);
                    executableFilename = path.join(dirPath, execPath);
                }

                return Object.assign({}, buildResults, {
                    code: 0,
                    inputFilename: inputFilename,
                    dirPath: dirPath,
                    executableFilename: executableFilename,
                    packageDownloadAndUnzipTime: ((endTime - startTime) / BigInt(1000000)).toString(),
                });
            } else {
                throw new Error('Tried to get executable from cache, but got a cache miss');
            }
        } catch (err) {
            throw new Error('Tried to get executable from cache, but got an error: ' + JSON.stringify(err));
        }
    }

    async downloadExecutablePackage(hash: string): Promise<void> {
        this.dirPath = await temp.mkdir({prefix: utils.ce_temp_prefix, dir: os.tmpdir()});

        this.buildResult = await this.loadPackageWithExecutable(hash, this.dirPath);
    }

    protected getDefaultExecOptions(params: ExecutionParams): ExecutionOptions & {env: Record<string, string>} {
        const env: Record<string, string> = {};
        env.PATH = '';

        if (params.runtimeTools) {
            const runtimeEnv = params.runtimeTools.find(tool => tool.name === RuntimeToolType.env);
            if (runtimeEnv) {
                for (const opt of runtimeEnv.options) {
                    env[(opt.name = opt.value)];
                }
            }
        }

        // todo: what to do about the rest of the runtimeTools?

        if (
            this.buildResult &&
            this.buildResult.defaultExecOptions &&
            this.buildResult.defaultExecOptions.env &&
            this.buildResult.defaultExecOptions.env.PATH
        ) {
            if (env.PATH.length > 0)
                env.PATH = env.PATH + path.delimiter + this.buildResult.defaultExecOptions.env.PATH;
            else env.PATH = this.buildResult.defaultExecOptions.env.PATH;
        }

        const execOptions: ExecutionOptions & {env: Record<string, string>} = {
            env,
        };

        if (this.buildResult && this.buildResult.preparedLdPaths) {
            execOptions.ldPath = this.buildResult.preparedLdPaths;
        }

        return execOptions;
    }

    async execute(params: ExecutionParams): Promise<UnprocessedExecResult> {
        assert(this.buildResult);

        return await exec.sandbox(
            this.buildResult.executableFilename,
            typeof params.args === 'string' ? utils.splitArguments(params.args) : params.args || [],
            this.getDefaultExecOptions(params),
        );
    }

    protected setEnvironmentVariablesFromRuntime(
        configuredTools: ConfiguredRuntimeTools,
        execOptions: ExecutionOptions,
    ) {
        for (const runtime of configuredTools) {
            if (runtime.name === RuntimeToolType.env) {
                for (const env of runtime.options) {
                    if (!execOptions.env) execOptions.env = {};

                    execOptions.env[env.name] = env.value;
                }
            }
        }
    }

    async execBinary(
        executable: string,
        executeParameters: ExecutableExecutionOptions,
        homeDir: string,
        extraConfiguration?: any,
    ): Promise<BasicExecutionResult> {
        try {
            const execOptions: ExecutionOptions = {
                maxOutput: this.maxExecOutputSize,
                timeoutMs: this.timeoutMs,
                ldPath: [...executeParameters.ldPath],
                input: executeParameters.stdin,
                customCwd: homeDir,
                appHome: homeDir,
            };

            if (this.useSanitizerEnvHints) {
                execOptions.env = {
                    ASAN_OPTIONS: 'color=always',
                    UBSAN_OPTIONS: 'color=always',
                    MSAN_OPTIONS: 'color=always',
                    LSAN_OPTIONS: 'color=always',
                    ...executeParameters.env,
                };
            } else {
                execOptions.env = {
                    ...executeParameters.env,
                };
            }

            return this.execBinaryMaybeWrapped(
                executable,
                executeParameters.args,
                execOptions,
                executeParameters,
                homeDir,
            );
        } catch (err: UnprocessedExecResult | any) {
            if (err.code && err.stderr) {
                return utils.processExecutionResult(err);
            } else {
                return {
                    ...utils.getEmptyExecutionResult(),
                    stdout: err.stdout ? utils.parseOutput(err.stdout) : [],
                    stderr: err.stderr ? utils.parseOutput(err.stderr) : [],
                    code: err.code === undefined ? -1 : err.code,
                };
            }
        }
    }

    protected async execBinaryMaybeWrapped(
        executable: string,
        args: string[],
        execOptions: ExecutionOptions,
        executeParameters: ExecutableExecutionOptions,
        homeDir: string,
    ): Promise<BasicExecutionResult> {
        let runWithHeaptrack: ConfiguredRuntimeTool | undefined = undefined;

        if (!execOptions.env) execOptions.env = {};

        if (executeParameters.runtimeTools) {
            this.setEnvironmentVariablesFromRuntime(executeParameters.runtimeTools, execOptions);

            for (const runtime of executeParameters.runtimeTools) {
                if (runtime.name === RuntimeToolType.heaptrack) {
                    runWithHeaptrack = runtime;
                }
            }
        }

        if (runWithHeaptrack && HeaptrackWrapper.isSupported(this.environment)) {
            const wrapper = new HeaptrackWrapper(
                homeDir,
                exec.sandbox,
                exec.execute,
                runWithHeaptrack.options,
                this.environment.ceProps,
                this.sandboxType,
            );
            const execResult: UnprocessedExecResult = await wrapper.exec(executable, args, execOptions);
            return this.processUserExecutableExecutionResult(execResult, [utils.LineParseOption.AtFileLine]);
        } else {
            const execResult: UnprocessedExecResult = await exec.sandbox(executable, args, execOptions);
            return this.processUserExecutableExecutionResult(execResult, []);
        }
    }

    processUserExecutableExecutionResult(
        input: UnprocessedExecResult,
        stdErrlineParseOptions: utils.LineParseOptions,
    ): BasicExecutionResult {
        const start = performance.now();
        const stdout = utils.parseOutput(input.stdout, undefined, undefined, []);
        const stderr = utils.parseOutput(input.stderr, undefined, undefined, stdErrlineParseOptions);
        const end = performance.now();
        return {
            ...input,
            stdout,
            stderr,
            processExecutionResultTime: end - start,
        };
    }
}
