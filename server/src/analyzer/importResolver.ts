/*
* importResolver.ts
* Copyright (c) Microsoft Corporation.
* Licensed under the MIT license.
* Author: Eric Traut
*
* Provides the logic for resolving imports according to the
* runtime rules of Python.
*/

import * as fs from 'fs';

import { ConfigOptions, ExecutionEnvironment } from '../common/configOptions';
import { combinePaths, getDirectoryPath, getFileExtension, getFileSystemEntries, isDirectory,
    isFile, stripFileExtension, stripTrailingDirectorySeparator } from '../common/pathUtils';
import { versionToString } from '../common/pythonVersion';
import { ImplicitImport, ImportResult, ImportType } from './importResult';
import { PythonPathUtils } from './pythonPathUtils';

export interface ImportedModuleDescriptor {
    leadingDots: number;
    nameParts: string[];
    hasTrailingDot?: boolean;
    importedSymbols: string[] | undefined;
}

export class ImportResolver {
    private _sourceFilePath: string;
    private _configOptions: ConfigOptions;
    private _executionEnvironment: ExecutionEnvironment;
    private _cachedPythonSearchPaths: string[] | undefined;

    constructor(sourceFilePath: string, configOptions: ConfigOptions, execEnv: ExecutionEnvironment) {
        this._sourceFilePath = sourceFilePath;
        this._configOptions = configOptions;
        this._executionEnvironment = execEnv;
    }

    // Resolves the import and returns the path if it exists, otherwise
    // returns undefined.
    resolveImport(moduleDescriptor: ImportedModuleDescriptor): ImportResult {
        const importName = this._formatImportName(moduleDescriptor);
        const importFailureInfo: string[] = [];

        // If we haven't already cached search paths, do so now.
        this._cachePythonSearchPaths(importFailureInfo);

        // Is it a relative import?
        if (moduleDescriptor.leadingDots > 0) {
            const relativeImport = this._resolveRelativeImport(moduleDescriptor,
                importName, importFailureInfo);
            if (relativeImport) {
                return relativeImport;
            }
        } else {
            // First check for a typeshed file.
            if (moduleDescriptor.nameParts.length > 0) {
                const builtInImport = this._findTypeshedPath(moduleDescriptor, importName,
                    true, importFailureInfo);
                if (builtInImport) {
                    builtInImport.isTypeshedFile = true;
                    return builtInImport;
                }
            }

            let bestResultSoFar: ImportResult | undefined;

            // Look for it in the root directory of the execution environment.
            importFailureInfo.push(`Looking in root directory of execution environment ` +
                `'${ this._executionEnvironment.root }'`);
            let localImport = this._resolveAbsoluteImport(
                this._executionEnvironment.root, moduleDescriptor, importName, importFailureInfo);
            if (localImport && localImport.importFound) {
                return localImport;
            }
            bestResultSoFar = localImport;

            for (let extraPath of this._executionEnvironment.extraPaths) {
                importFailureInfo.push(`Looking in extraPath '${ extraPath }'`);
                localImport = this._resolveAbsoluteImport(extraPath, moduleDescriptor,
                    importName, importFailureInfo);
                if (localImport && localImport.importFound) {
                    return localImport;
                }

                if (localImport && (bestResultSoFar === undefined ||
                        localImport.resolvedPaths.length > bestResultSoFar.resolvedPaths.length)) {
                    bestResultSoFar = localImport;
                }
            }

            // Check for a typings file.
            if (this._configOptions.typingsPath) {
                importFailureInfo.push(`Looking in typingsPath '${ this._configOptions.typingsPath }'`);
                const typingsImport = this._resolveAbsoluteImport(
                    this._configOptions.typingsPath, moduleDescriptor, importName, importFailureInfo);
                if (typingsImport && typingsImport.importFound) {
                    return typingsImport;
                }
            }

            // Check for a typeshed file.
            importFailureInfo.push(`Looking for typeshed path`);
            const typeshedImport = this._findTypeshedPath(moduleDescriptor, importName,
                false, importFailureInfo);
            if (typeshedImport) {
                typeshedImport.isTypeshedFile = true;
                return typeshedImport;
            }

            // Look for the import in the list of third-party packages.
            if (this._cachedPythonSearchPaths && this._cachedPythonSearchPaths.length > 0) {
                for (let searchPath of this._cachedPythonSearchPaths) {
                    // Allow partial resolution because some third-party packages
                    // use tricks to populate their package namespaces.
                    importFailureInfo.push(`Looking in python search path '${ searchPath }'`);
                    const thirdPartyImport = this._resolveAbsoluteImport(
                        searchPath, moduleDescriptor, importName, importFailureInfo, true);
                    if (thirdPartyImport) {
                        thirdPartyImport.importType = ImportType.ThirdParty;

                        if (thirdPartyImport.importFound) {
                            return thirdPartyImport;
                        }

                        if (bestResultSoFar === undefined ||
                                thirdPartyImport.resolvedPaths.length > bestResultSoFar.resolvedPaths.length) {
                            bestResultSoFar = thirdPartyImport;
                        }
                    }
                }
            } else {
                importFailureInfo.push('No python interpreter search path');
            }

            // We weren't able to find an exact match, so return the best
            // partial match.
            if (bestResultSoFar) {
                return bestResultSoFar;
            }
        }

        return {
            importName,
            importFound: false,
            importFailureInfo,
            resolvedPaths: [],
            importType: ImportType.Local,
            isNamespacePackage: false,
            isStubFile: false,
            implicitImports: []
        };
    }

    getCompletionSuggestions(moduleDescriptor: ImportedModuleDescriptor): string[] {
        const importFailureInfo: string[] = [];
        const suggestions: string[] = [];

        // If we haven't already cached search paths, do so now.
        this._cachePythonSearchPaths(importFailureInfo);

        // Is it a relative import?
        if (moduleDescriptor.leadingDots > 0) {
            this._getCompletionSuggestsionsRelative(moduleDescriptor, suggestions);
        } else {
            // First check for a typeshed file.
            if (moduleDescriptor.nameParts.length > 0) {
                this._getCompletionSuggestionsTypeshedPath(moduleDescriptor, true, suggestions);
            }

            // Look for it in the root directory of the execution environment.
            this._getCompletionSuggestionsAbsolute(this._executionEnvironment.root,
                moduleDescriptor, suggestions);

            for (let extraPath of this._executionEnvironment.extraPaths) {
                this._getCompletionSuggestionsAbsolute(extraPath, moduleDescriptor,
                    suggestions);
            }

            // Check for a typings file.
            if (this._configOptions.typingsPath) {
                this._getCompletionSuggestionsAbsolute(this._configOptions.typingsPath,
                    moduleDescriptor, suggestions);
            }

            // Check for a typeshed file.
            this._getCompletionSuggestionsTypeshedPath(moduleDescriptor, false, suggestions);

            // Look for the import in the list of third-party packages.
            if (this._cachedPythonSearchPaths && this._cachedPythonSearchPaths.length > 0) {
                for (let searchPath of this._cachedPythonSearchPaths) {
                    this._getCompletionSuggestionsAbsolute(searchPath,
                        moduleDescriptor, suggestions);
                }
            }
        }

        return suggestions;
    }

    private _cachePythonSearchPaths(importFailureInfo: string[]) {
        // Find the site packages for the configured virtual environment.
        if (this._cachedPythonSearchPaths === undefined) {
            this._cachedPythonSearchPaths = PythonPathUtils.findPythonSearchPaths(
                this._configOptions, this._executionEnvironment, importFailureInfo);
        }
    }

    private _findTypeshedPath(moduleDescriptor: ImportedModuleDescriptor, importName: string,
            isStdLib: boolean, importFailureInfo: string[]): ImportResult | undefined {

        importFailureInfo.push(`Looking for typeshed ${ isStdLib ? 'stdlib' : 'third_party' } path`);

        const typeshedPath = this._getTypeshedPath(isStdLib);
        if (!typeshedPath) {
            return undefined;
        }

        const pythonVersion = this._executionEnvironment.pythonVersion;
        let minorVersion = pythonVersion & 0xFF;

        // Search for module starting at "3.x" down to "3.1", then "3", then "2and3".
        while (true) {
            const pythonVersionString = minorVersion > 0 ? versionToString(0x300 + minorVersion) :
                minorVersion === 0 ? '3' : '2and3';
            const testPath = combinePaths(typeshedPath, pythonVersionString);
            if (fs.existsSync(testPath)) {
                let importInfo = this._resolveAbsoluteImport(testPath, moduleDescriptor,
                    importName, importFailureInfo);
                if (importInfo && importInfo.importFound) {
                    if (isStdLib) {
                        importInfo.importType = ImportType.BuiltIn;
                    }
                    return importInfo;
                }
            }

            // We use -1 to indicate "2and3", which is searched after "3.0".
            if (minorVersion === -1) {
                break;
            }
            minorVersion--;
        }

        importFailureInfo.push(`Typeshed path not found`);
        return undefined;
    }

    private _getCompletionSuggestionsTypeshedPath(moduleDescriptor: ImportedModuleDescriptor,
            isStdLib: boolean, suggestions: string[]) {

        const typeshedPath = this._getTypeshedPath(isStdLib);
        if (!typeshedPath) {
            return;
        }

        const pythonVersion = this._executionEnvironment.pythonVersion;
        let minorVersion = pythonVersion & 0xFF;

        // Search for module starting at "3.x" down to "3.1", then "3", then "2and3".
        while (true) {
            const pythonVersionString = minorVersion > 0 ? versionToString(0x300 + minorVersion) :
                minorVersion === 0 ? '3' : '2and3';
            const testPath = combinePaths(typeshedPath, pythonVersionString);
            if (fs.existsSync(testPath)) {
                this._getCompletionSuggestionsAbsolute(testPath, moduleDescriptor, suggestions);
            }

            // We use -1 to indicate "2and3", which is searched after "3.0".
            if (minorVersion === -1) {
                break;
            }
            minorVersion--;
        }
    }

    private _getTypeshedPath(isStdLib: boolean) {
        let typeshedPath = '';

        // Did the user specify a typeshed path? If not, we'll look in the
        // python search paths, then in the typeshed-fallback directory.
        if (this._configOptions.typeshedPath) {
            const possibleTypeshedPath = this._configOptions.typeshedPath;
            if (fs.existsSync(possibleTypeshedPath) && isDirectory(possibleTypeshedPath)) {
                typeshedPath = possibleTypeshedPath;
            }
        } else if (this._cachedPythonSearchPaths) {
            for (let searchPath of this._cachedPythonSearchPaths) {
                const possibleTypeshedPath = combinePaths(searchPath, 'typeshed');
                if (fs.existsSync(possibleTypeshedPath) && isDirectory(possibleTypeshedPath)) {
                    typeshedPath = possibleTypeshedPath;
                    break;
                }
            }
        }

        // If typeshed directory wasn't found in other locations, use the fallback.
        if (!typeshedPath) {
            typeshedPath = PythonPathUtils.getTypeShedFallbackPath() || '';
        }

        typeshedPath = PythonPathUtils.getTypeshedSubdirectory(typeshedPath, isStdLib);

        if (!fs.existsSync(typeshedPath) || !isDirectory(typeshedPath)) {
            return undefined;
        }

        return typeshedPath;
    }

    private _resolveRelativeImport(moduleDescriptor: ImportedModuleDescriptor,
            importName: string, importFailureInfo: string[]): ImportResult | undefined {

        importFailureInfo.push('Attempting to resolve relative import');

        // Determine which search path this file is part of.
        let curDir = getDirectoryPath(this._sourceFilePath);
        for (let i = 1; i < moduleDescriptor.leadingDots; i++) {
            if (curDir === '') {
                importFailureInfo.push(`Invalid relative path '${ importName }'`);
                return undefined;
            }
            curDir = getDirectoryPath(curDir);
        }

        // Now try to match the module parts from the current directory location.
        return this._resolveAbsoluteImport(curDir, moduleDescriptor,
            importName, importFailureInfo);
    }

    private _getCompletionSuggestsionsRelative(moduleDescriptor: ImportedModuleDescriptor,
            suggestions: string[]) {

        // Determine which search path this file is part of.
        let curDir = getDirectoryPath(this._sourceFilePath);
        for (let i = 1; i < moduleDescriptor.leadingDots; i++) {
            if (curDir === '') {
                return;
            }
            curDir = getDirectoryPath(curDir);
        }

        // Now try to match the module parts from the current directory location.
        this._getCompletionSuggestionsAbsolute(curDir, moduleDescriptor, suggestions);
    }

    // Follows import resolution algorithm defined in PEP-420:
    // https://www.python.org/dev/peps/pep-0420/
    private _resolveAbsoluteImport(rootPath: string, moduleDescriptor: ImportedModuleDescriptor,
            importName: string, importFailureInfo: string[], allowPartial = false): ImportResult | undefined {

        importFailureInfo.push(`Attempting to resolve using root path '${ rootPath }'`);

        // Starting at the specified path, walk the file system to find the
        // specified module.
        let resolvedPaths: string[] = [];
        let dirPath = rootPath;
        let isNamespacePackage = false;
        let isStubFile = false;
        let implicitImports: ImplicitImport[] = [];

        // Handle the "from . import XXX" case.
        if (moduleDescriptor.nameParts.length === 0) {
            const pyFilePath = combinePaths(dirPath, '__init__.py');
            const pyiFilePath = pyFilePath + 'i';

            if (fs.existsSync(pyiFilePath) && isFile(pyiFilePath)) {
                importFailureInfo.push(`Resolved import with file '${ pyiFilePath }'`);
                resolvedPaths.push(pyiFilePath);
                isStubFile = true;
            } else if (fs.existsSync(pyFilePath) && isFile(pyFilePath)) {
                importFailureInfo.push(`Resolved import with file '${ pyFilePath }'`);
                resolvedPaths.push(pyFilePath);
            } else {
                importFailureInfo.push(`Partially resolved import with directory '${ dirPath }'`);
                resolvedPaths.push(dirPath);
                isNamespacePackage = true;
            }

            implicitImports = this._findImplicitImports(
                dirPath, [pyFilePath, pyiFilePath], moduleDescriptor.importedSymbols);
        } else {
            for (let i = 0; i < moduleDescriptor.nameParts.length; i++) {
                dirPath = combinePaths(dirPath, moduleDescriptor.nameParts[i]);
                if (!fs.existsSync(dirPath) || !isDirectory(dirPath)) {
                    importFailureInfo.push(`Could not find directory '${ dirPath }'`);

                    // We weren't able to find the subdirectory. See if we can
                    // find a ".py" or ".pyi" file with this name.
                    const pyFilePath = stripTrailingDirectorySeparator(dirPath) + '.py';
                    const pyiFilePath = pyFilePath + 'i';

                    if (fs.existsSync(pyiFilePath) && isFile(pyiFilePath)) {
                        importFailureInfo.push(`Resolved import with file '${ pyiFilePath }'`);
                        resolvedPaths.push(pyiFilePath);
                        isStubFile = true;
                    } else if (fs.existsSync(pyFilePath) && isFile(pyFilePath)) {
                        importFailureInfo.push(`Resolved import with file '${ pyFilePath }'`);
                        resolvedPaths.push(pyFilePath);
                    } else {
                        importFailureInfo.push(`Did not find file '${ pyiFilePath }' or '${ pyFilePath }'`);
                    }
                    break;
                }

                const pyFilePath = combinePaths(dirPath, '__init__.py');
                const pyiFilePath = pyFilePath + 'i';

                if (fs.existsSync(pyiFilePath) && isFile(pyiFilePath)) {
                    importFailureInfo.push(`Resolved import with file '${ pyiFilePath }'`);
                    resolvedPaths.push(pyiFilePath);
                    isStubFile = true;
                } else if (fs.existsSync(pyFilePath) && isFile(pyFilePath)) {
                    importFailureInfo.push(`Resolved import with file '${ pyFilePath }'`);
                    resolvedPaths.push(pyFilePath);
                } else {
                    importFailureInfo.push(`Partially resolved import with directory '${ dirPath }'`);
                    resolvedPaths.push(dirPath);
                    if (i === moduleDescriptor.nameParts.length - 1) {
                        isNamespacePackage = true;
                    }
                }

                if (i === moduleDescriptor.nameParts.length - 1) {
                    implicitImports = this._findImplicitImports(
                        dirPath, [pyFilePath, pyiFilePath], moduleDescriptor.importedSymbols);
                }
            }
        }

        let importFound: boolean;
        if (allowPartial) {
            importFound = resolvedPaths.length > 0;
        } else {
            importFound = resolvedPaths.length >= moduleDescriptor.nameParts.length;

            // Empty namespace packages are not allowed.
            if (isNamespacePackage && implicitImports.length === 0) {
                importFound = false;
            }
        }

        return {
            importName,
            importFound,
            importFailureInfo,
            importType: ImportType.Local,
            resolvedPaths,
            searchPath: rootPath,
            isNamespacePackage,
            isStubFile,
            implicitImports
        };
    }

    private _getCompletionSuggestionsAbsolute(rootPath: string,
            moduleDescriptor: ImportedModuleDescriptor, suggestions: string[]) {

        // Starting at the specified path, walk the file system to find the
        // specified module.
        let dirPath = rootPath;

        // Copy the nameParts into a new directory and add an extra empty
        // part if there is a trailing dot.
        let nameParts = moduleDescriptor.nameParts.map(name => name);
        if (moduleDescriptor.hasTrailingDot) {
            nameParts.push('');
        }

        // Handle the case where the user has typed the first
        // dot (or multiple) in a relative path.
        if (nameParts.length === 0) {
            this._addFilteredSuggestions(dirPath, '', suggestions);
        } else {
            for (let i = 0; i < nameParts.length; i++) {
                // Provide completions only if we're on the last part
                // of the name.
                if (i === nameParts.length - 1) {
                    this._addFilteredSuggestions(dirPath,
                        nameParts[i], suggestions);
                }

                dirPath = combinePaths(dirPath, nameParts[i]);
                if (!fs.existsSync(dirPath) || !isDirectory(dirPath)) {
                    break;
                }
            }
        }
    }

    private _addFilteredSuggestions(dirPath: string, filter: string, suggestions: string[]) {
        const entries = getFileSystemEntries(dirPath);
        entries.files.forEach(file => {
            const fileWithoutExtension = stripFileExtension(file);
            const fileExtension = getFileExtension(file);

            if (fileExtension === '.py' || fileExtension === '.pyi') {
                if (fileWithoutExtension !== '__init__') {
                    if (!filter || fileWithoutExtension.startsWith(filter)) {
                        this._addUniqueSuggestion(fileWithoutExtension, suggestions);
                    }
                }
            }
        });

        entries.directories.forEach(dir => {
            if (!filter || dir.startsWith(filter)) {
                this._addUniqueSuggestion(dir, suggestions);
            }
        });
    }

    private _addUniqueSuggestion(suggestionToAdd: string, suggestions: string[]) {
        if (suggestions.some(s => s === suggestionToAdd)) {
            return;
        }

        suggestions.push(suggestionToAdd);
    }

    private _findImplicitImports(dirPath: string, exclusions: string[],
            importedSymbols: string[] | undefined): ImplicitImport[] {

        const implicitImportMap: { [name: string]: ImplicitImport } = {};
        const importAll = importedSymbols === undefined || importedSymbols.length === 0;
        const shouldImportFile = (strippedFileName: string) => {
            if (importAll) {
                return true;
            }

            return importedSymbols!.some(sym => sym === strippedFileName);
        };

        // Enumerate all of the files and directories in the path.
        let entries = getFileSystemEntries(dirPath);

        // Add implicit file-based modules.
        for (let fileName of entries.files) {
            if (fileName.endsWith('.py') || fileName.endsWith('.pyi')) {
                let filePath = combinePaths(dirPath, fileName);

                if (!exclusions.find(exclusion => exclusion === filePath)) {
                    const strippedFileName = stripFileExtension(fileName);
                    if (shouldImportFile(strippedFileName)) {
                        const implicitImport: ImplicitImport = {
                            isStubFile: fileName.endsWith('.pyi'),
                            name: strippedFileName,
                            path: filePath
                        };

                        // Always prefer stub files over non-stub files.
                        if (!implicitImportMap[implicitImport.name] ||
                                !implicitImportMap[implicitImport.name].isStubFile) {
                            implicitImportMap[implicitImport.name] = implicitImport;
                        }
                    }
                }
            }
        }

        // Add implicit directory-based modules.
        for (let dirName of entries.directories) {
            const pyFilePath = combinePaths(dirPath, dirName, '__init__.py');
            const pyiFilePath = pyFilePath + 'i';
            let isStubFile = false;
            let path = '';

            if (fs.existsSync(pyiFilePath) && isFile(pyiFilePath)) {
                isStubFile = true;
                path = pyiFilePath;
            } else if (fs.existsSync(pyFilePath) && isFile(pyFilePath)) {
                path = pyFilePath;
            }

            if (path) {
                if (!exclusions.find(exclusion => exclusion === path)) {
                    if (shouldImportFile(dirName)) {
                        let implicitImport: ImplicitImport = {
                            isStubFile,
                            name: dirName,
                            path
                        };

                        implicitImportMap[implicitImport.name] = implicitImport;
                    }
                }
            }
        }

        return Object.keys(implicitImportMap).map(key => implicitImportMap[key]);
    }

    private _formatImportName(moduleDescriptor: ImportedModuleDescriptor) {
        let name = '';
        for (let i = 0; i < moduleDescriptor.leadingDots; i++) {
            name += '.';
        }

        return name + moduleDescriptor.nameParts.map(iden => iden).join('.');
    }
}
