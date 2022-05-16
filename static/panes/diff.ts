// Copyright (c) 2017, Compiler Explorer Authors
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
//     * Redistributions of source code must retain the above copyright notice,
//       this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above copyright
//       notice, this list of conditions and the following disclaimer in the
//       documentation and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.

import * as monaco from 'monaco-editor';
import TomSelect from 'tom-select';

import { ga } from '../analytics';
import { Hub } from '../hub';
import { Container } from 'golden-layout';
import { MonacoPane } from './pane';
import { MonacoPaneState } from './pane.interfaces';
import { DiffState, DiffType } from './diff.interfaces';

// TODO: Type here is only partially correct for what's used here
type ResultEntry = { text: string };

type ResultType = {
    code: number;
    buildResult: unknown;
    asm: ResultEntry[];
    stdout: ResultEntry[];
    stderr: ResultEntry[];
    execResult: {
        stdout: ResultEntry[];
        stderr: ResultEntry[];
    };
    hasGnatDebugOutput: boolean;
    gnatDebugOutput: ResultEntry[];
    hasGnatDebugTreeOutput: boolean;
    gnatDebugTreeOutput: ResultEntry[];
};

class DiffStateObject {
    id: number | string;
    model: monaco.editor.ITextModel;
    compiler: unknown;
    result: ResultType | null;
    difftype: DiffType;

    constructor(id: number | string, model: monaco.editor.ITextModel, difftype: DiffType) {
        this.id = id;
        this.model = model;
        this.compiler = null;
        this.result = null;
        this.difftype = difftype;
    }

    update(id: number | string, compiler, result: ResultType) {
        if (this.id !== id) return false;
        this.compiler = compiler;
        this.result = result;
        this.refresh();

        return true;
    }

    refresh() {
        var output: ResultEntry[] = [];
        if (this.result) {
            switch (this.difftype) {
                case DiffType.DiffType_ASM:
                    output = this.result.asm || [];
                    break;
                case DiffType.DiffType_CompilerStdOut:
                    output = this.result.stdout || [];
                    break;
                case DiffType.DiffType_CompilerStdErr:
                    output = this.result.stderr || [];
                    break;
                case DiffType.DiffType_ExecStdOut:
                    if (this.result.execResult) output = this.result.execResult.stdout || [];
                    break;
                case DiffType.DiffType_ExecStdErr:
                    if (this.result.execResult) output = this.result.execResult.stderr || [];
                    break;
                case DiffType.DiffType_GNAT_ExpandedCode:
                    if (this.result.hasGnatDebugOutput) output = this.result.gnatDebugOutput || [];
                    break;
                case DiffType.DiffType_GNAT_Tree:
                    if (this.result.hasGnatDebugTreeOutput) output = this.result.gnatDebugTreeOutput || [];
                    break;
            }
        }
        this.model.setValue(output.map(x => x.text).join('\n'));
    }
}

function getItemDisplayTitle(item) {
    if (typeof item.id === 'string') {
        var p = item.id.indexOf('_exec');
        if (p !== -1) {
            return 'Executor #' + item.id.substr(0, p);
        }
    }

    return 'Compiler #' + item.id;
}

type CompilerEntry = {
    id: number | string;
    name: string;
    options: unknown;
    editorId: number;
    treeId: number;
    compiler: unknown;
};

type SelectizeType = {
    lhs: TomSelect;
    rhs: TomSelect;
    lhsdifftype: TomSelect;
    rhsdifftype: TomSelect;
};

export class Diff extends MonacoPane<monaco.editor.IStandaloneDiffEditor, DiffState> {
    compilers: Record<string, CompilerEntry> = {};
    lhs: DiffStateObject;
    rhs: DiffStateObject;
    selectize: SelectizeType = {} as any; // will be filled in by the constructor
    constructor(hub: Hub, container: Container, state: MonacoPaneState & DiffState) {
        super(hub, container, state);

        this.lhs = new DiffStateObject(state.lhs, monaco.editor.createModel('', 'asm'), state.lhsdifftype || DiffType.DiffType_ASM);
        this.rhs = new DiffStateObject(state.rhs, monaco.editor.createModel('', 'asm'), state.rhsdifftype || DiffType.DiffType_ASM);
        this.editor.setModel({original: this.lhs.model, modified: this.rhs.model});

        this.domRoot[0].querySelectorAll('.difftype-picker').forEach(
            picker => {
                if (!(picker instanceof HTMLSelectElement)) {
                    throw new Error('.difftype-picker is not an HTMLSelectElement');
                }
                var instance = new TomSelect(picker, {
                    sortField: 'name',
                    valueField: 'id',
                    labelField: 'name',
                    searchField: ['name'],
                    options: [
                        {id: DiffType.DiffType_ASM, name: 'Assembly'},
                        {id: DiffType.DiffType_CompilerStdOut, name: 'Compiler stdout'},
                        {id: DiffType.DiffType_CompilerStdErr, name: 'Compiler stderr'},
                        {id: DiffType.DiffType_ExecStdOut, name: 'Execution stdout'},
                        {id: DiffType.DiffType_ExecStdErr, name: 'Execution stderr'},
                        {id: DiffType.DiffType_GNAT_ExpandedCode, name: 'GNAT Expanded Code'},
                        {id: DiffType.DiffType_GNAT_Tree, name: 'GNAT Tree Code'},
                    ],
                    items: [],
                    render: {
                        option: (item, escape) => {
                            return `<div>${escape(item.name)}</div>`;
                        },
                    },
                    dropdownParent: 'body',
                    plugins: ['input_autogrow'],
                    onChange: value => {
                        if (picker.classList.contains('lhsdifftype')) {
                            this.lhs.difftype = parseInt(value as any as string);
                            this.lhs.refresh();
                        } else {
                            this.rhs.difftype = parseInt(value as any as string);
                            this.rhs.refresh();
                        }
                        this.updateState();
                    },
                });

                if (picker.classList.contains('lhsdifftype')) {
                    this.selectize.lhsdifftype = instance;
                } else {
                    this.selectize.rhsdifftype = instance;
                }
            }
        );

        this.domRoot[0].querySelectorAll('.diff-picker').forEach(
            picker => {
                if (!(picker instanceof HTMLSelectElement)) {
                    throw new Error('.difftype-picker is not an HTMLSelectElement');
                }
                var instance = new TomSelect(picker, {
                    sortField: 'name',
                    valueField: 'id',
                    labelField: 'name',
                    searchField: ['name'],
                    options: [],
                    items: [],
                    render: {
                        option: function (item, escape) {
                            var origin = item.editorId !== false ? 'Editor #' + item.editorId : 'Tree #' + item.treeId;
                            return (
                                '<div>' +
                                `<span class="compiler">${escape(item.compiler.name)}</span>` +
                                `<span class="options">${escape(item.options)}</span>` +
                                '<ul class="meta">' +
                                `<li class="editor">${escape(origin)}</li>` +
                                `<li class="compilerId">${escape(getItemDisplayTitle(item))}</li>` +
                                '</ul>' +
                                '</div>'
                            );
                        },
                    },
                    dropdownParent: 'body',
                    plugins: ['input_autogrow'],
                    onChange: value => {
                        var compiler = this.compilers[value as any as string];
                        if (!compiler) return;
                        if (picker.classList.contains('lhs')) {
                            this.lhs.compiler = compiler;
                            this.lhs.id = compiler.id;
                        } else {
                            this.rhs.compiler = compiler;
                            this.rhs.id = compiler.id;
                        }
                        this.onDiffSelect(compiler.id);
                    },
                });

                if (picker.classList.contains('lhs')) {
                    this.selectize.lhs = instance;
                } else {
                    this.selectize.rhs = instance;
                }
            }
        );

        this.requestResendResult(this.lhs.id);
        this.requestResendResult(this.rhs.id);

        this.eventHub.emit('findCompilers');
        this.eventHub.emit('findExecutors');

        this.eventHub.emit('requestTheme');
        this.eventHub.emit('requestSettings');

        this.updateTitle();
        this.updateCompilers();
    }

    override registerOpeningAnalyticsEvent(): void {
        ga.proxy('send', {
            hitType: 'event',
            eventCategory: 'OpenViewPane',
            eventAction: 'Diff',
        });
    }

    override getInitialHTML() {
        return $('#diff').html();
    }

    override createEditor(editorRoot: HTMLElement) {
        return monaco.editor.createDiffEditor(editorRoot, {
            fontFamily: 'Consolas, "Liberation Mono", Courier, monospace',
            scrollBeyondLastLine: true,
            readOnly: true,
            //language: 'asm', // TODO TODO TODO
        });
    }

    onDiffSelect(id: number | string) {
        this.requestResendResult(id);
        this.updateTitle();
        this.updateState();
    }

    onCompileResult(id: number | string, compiler: unknown, result: ResultType) {
        // both sides must be updated, don't be tempted to rewrite this as
        // var changes = lhs.update() || rhs.update();
        var lhsChanged = this.lhs.update(id, compiler, result);
        var rhsChanged = this.rhs.update(id, compiler, result);
        if (lhsChanged || rhsChanged) {
            this.updateTitle();
        }
    }

    onExecuteResult(id: number, compiler: unknown, result: ResultType) {
        const compileResult: any = Object.assign({}, result.buildResult);
        compileResult.execResult = {
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
        };

        this.onCompileResult(id + '_exec', compiler, compileResult);
    }

    override registerCallbacks() {
        this.eventHub.on('executeResult', this.onExecuteResult, this);
        this.eventHub.on('executor', this.onExecutor, this);
        this.eventHub.on('executorClose', this.onExecutorClose, this);
    }

    requestResendResult(id: number | string) {
        if (typeof id === 'string') {
            const p = id.indexOf('_exec');
            if (p !== -1) {
                const execId = parseInt(id.substr(0, p));
                this.eventHub.emit('resendExecution', execId);
            }
        } else {
            this.eventHub.emit('resendCompilation', id);
        }
    }

    override onCompiler(id: number | string, compiler: any, options: unknown, editorId: number, treeId: number) {
        if (!compiler) return;
        options = options || '';
        let name = compiler.name + ' ' + options;
        // TODO: selectize doesn't play nicely with CSS tricks for truncation; this is the best I can do
        // There's a plugin at: http://www.benbybenjacobs.com/blog/2014/04/09/no-wrap-plugin-for-selectize-dot-js
        // but it doesn't look easy to integrate.
        const maxLength = 30;
        if (name.length > maxLength - 3) name = name.substr(0, maxLength - 3) + '...';
        this.compilers[id] = {
            id: id,
            name: name,
            options: options,
            editorId: editorId,
            treeId: treeId,
            compiler: compiler,
        };
        if (!this.lhs.id) {
            this.lhs.compiler = this.compilers[id];
            this.lhs.id = id;
            this.onDiffSelect(id);
        } if (!this.rhs.id) {
            this.rhs.compiler = this.compilers[id];
            this.rhs.id = id;
            this.onDiffSelect(id);
        }
        this.updateCompilers();
    }

    onExecutor(id: number, compiler: any, options: unknown, editorId: number, treeId: number) {
        this.onCompiler(id + '_exec', compiler, options, editorId, treeId);
    }

    override onCompilerClose(id: number | string) {
        delete this.compilers[id];
        this.updateCompilers();
    }

    onExecutorClose(id: number) {
        this.onCompilerClose(id + '_exec');
    }

    override getDefaultPaneName() {
        return 'Diff Viewer';
    }

    override getPaneTag() {
        return "xxx"; //return this.lhs.compiler.name + ' vs ' + this.rhs.compiler.name;
    }

    updateCompilersFor(selectize: TomSelect, id: number | string) {
        selectize.clearOptions();
        for(let [_, compiler] of Object.entries(this.compilers)) {
            selectize.addOption(compiler);
        }
        if (this.compilers[id]) {
            selectize.setValue(id.toString());
        }
    }

    updateCompilers() {
        this.updateCompilersFor(this.selectize.lhs, this.lhs.id);
        this.updateCompilersFor(this.selectize.rhs, this.rhs.id);

        this.selectize.lhsdifftype.setValue((this.lhs.difftype || DiffType.DiffType_ASM) as any as string);
        this.selectize.rhsdifftype.setValue((this.rhs.difftype || DiffType.DiffType_ASM) as any as string);
    };

    override getCurrentState() {
        const parent = super.getCurrentState();
        return {
            lhs: this.lhs.id,
            rhs: this.rhs.id,
            lhsdifftype: this.lhs.difftype,
            rhsdifftype: this.rhs.difftype,
            ...parent,
        }
    }

    close() {
        this.eventHub.unsubscribe();
        this.editor.dispose();
    }
}
